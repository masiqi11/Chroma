import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import electronPath from "electron";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifactDirectory = path.join(root, "artifacts", "performance");
const artifactFile = path.join(artifactDirectory, "report.json");
const require = createRequire(import.meta.url);
const electronVersion = (() => {
  try {
    return require("electron/package.json").version;
  } catch {
    return "unavailable";
  }
})();
const tabCount = 8;
const settleMilliseconds = 1_000;
const sampleIntervalMilliseconds = 200;
const sampleCount = 5;
const cdpOpenTimeoutMilliseconds = 10_000;
const cdpCommandTimeoutMilliseconds = 20_000;
const cleanupTimeoutMilliseconds = 10_000;
const thresholds = Object.freeze({
  maxShellReadyMs: 20_000,
  maxFirstLocalPageReadyMs: 25_000,
  maxIdleRssMiB: 900,
  maxEightTabsRssMiB: 1_800,
  maxEightTabsDeltaRssMiB: 1_100,
});
const fatalLogPatterns = Object.freeze([
  ["uncaught-exception", /Uncaught Exception/i],
  ["app-load-error", /App threw an error during load/i],
  ["render-process-gone", /render-process-gone/i],
  ["unhandled-rejection", /unhandled(?:[\s_-]*promise)?[\s_-]*rejection/i],
  ["epipe", /\bEPIPE\b/i],
  ["object-destroyed", /Object (?:has been )?destroyed/i],
  ["shell-preload-failed", /Shell preload failed/i],
  [
    "sandboxed-renderer-script-failed",
    /sandboxed_renderer\.bundle\.js script failed to run/i,
  ],
]);

let child;
let fixtureServer;
let shellClient;
let userData;
let runResult;
let runError;
const output = [];
const cleanupErrors = [];
const startedAt = new Date().toISOString();

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || String(error),
  };
}

async function withTimeout(operation, milliseconds, label) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
          milliseconds
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveGitMetadata() {
  try {
    const [{ stdout: commit }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        timeout: 3_000,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync(
        "git",
        [
          "status",
          "--porcelain",
          "--",
          ".",
          ":(exclude)artifacts/performance/report.json",
        ],
        {
          cwd: root,
          timeout: 3_000,
          maxBuffer: 4 * 1024 * 1024,
        }
      ),
    ]);
    return {
      commit: commit.trim(),
      dirty: Boolean(status.trim()),
    };
  } catch {
    return "unavailable";
  }
}

async function writeReport(report) {
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(artifactFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function fatalMatches(logs) {
  return fatalLogPatterns
    .filter(([, pattern]) => pattern.test(logs))
    .map(([name]) => name);
}

const initialMetadata = {
  schemaVersion: 1,
  timestamp: startedAt,
  startedAt,
  git: "unavailable",
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  node: process.versions.node,
  electron: electronVersion,
  mode: "headless-electron-performance-smoke",
};

// Overwrite any previous passing artifact before performing git discovery,
// allocating temporary state, or launching Electron. An interrupted run can
// therefore never leave a stale `passed: true` result behind.
await writeReport({
  ...initialMetadata,
  passed: false,
  status: "starting",
  tabCount,
  thresholds,
});
const reportMetadata = {
  ...initialMetadata,
  git: await resolveGitMetadata(),
};
await writeReport({
  ...reportMetadata,
  passed: false,
  status: "running",
  tabCount,
  thresholds,
});

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(callback, timeout = 30_000) {
  const started = performance.now();
  let lastError;
  while (performance.now() - started < timeout) {
    const fatalOutput = fatalMatches(output.join(""));
    if (fatalOutput.length) {
      throw new Error(
        `performance smoke emitted fatal log patterns: ${fatalOutput.join(", ")}`
      );
    }
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error(`Timed out after ${timeout}ms`);
}

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error(`DevTools endpoint returned ${response.status}`);
  return response.json();
}

class CdpClient {
  #socket;
  #nextId = 0;
  #pending = new Map();

  constructor(url) {
    this.#socket = new WebSocket(url);
    this.#socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
    this.#socket.onclose = () => {
      const error = new Error("DevTools connection closed");
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.#pending.clear();
    };
  }

  async open(timeoutMilliseconds = cdpOpenTimeoutMilliseconds) {
    if (this.#socket.readyState === WebSocket.OPEN) return;
    if (
      this.#socket.readyState === WebSocket.CLOSING ||
      this.#socket.readyState === WebSocket.CLOSED
    ) {
      throw new Error("DevTools connection closed before it opened");
    }
    await new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        this.#socket.removeEventListener("open", handleOpen);
        this.#socket.removeEventListener("error", handleError);
        this.#socket.removeEventListener("close", handleClose);
      };
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = event => {
        cleanup();
        reject(new Error(event?.message || "DevTools connection failed to open"));
      };
      const handleClose = () => {
        cleanup();
        reject(new Error("DevTools connection closed before it opened"));
      };
      timeout = setTimeout(() => {
        cleanup();
        try {
          this.#socket.close();
        } catch {
          // The timeout is already the actionable failure.
        }
        reject(
          new Error(`DevTools connection open timed out after ${timeoutMilliseconds}ms`)
        );
      }, timeoutMilliseconds);
      timeout.unref?.();
      this.#socket.addEventListener("open", handleOpen, { once: true });
      this.#socket.addEventListener("error", handleError, { once: true });
      this.#socket.addEventListener("close", handleClose, { once: true });
    });
  }

  send(
    method,
    params = {},
    timeoutMilliseconds = cdpCommandTimeoutMilliseconds
  ) {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error(`DevTools ${method} cannot be sent before the connection is open`)
      );
    }
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(`DevTools ${method} timed out after ${timeoutMilliseconds}ms`)
        );
      }, timeoutMilliseconds);
      timeout.unref?.();
      this.#pending.set(id, { resolve, reject, timeout });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description || "Renderer evaluation failed"
      );
    }
    return result.result.value;
  }

  async close() {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => {
      this.#socket.addEventListener("close", resolve, { once: true });
    });
    try {
      this.#socket.close();
    } catch {
      return;
    }
    await withTimeout(closed, 1_000, "DevTools connection close").catch(() => {});
  }
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

async function processTreeRss(rootPid) {
  if (process.platform === "win32") {
    throw new Error("performance-smoke RSS sampling currently requires ps (macOS/Linux)");
  }
  const { stdout } = await execFileAsync(
    "ps",
    ["-axo", "pid=,ppid=,rss="],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  const rows = stdout
    .split("\n")
    .map(line => line.trim().split(/\s+/).map(Number))
    .filter(parts => parts.length === 3 && parts.every(Number.isFinite))
    .map(([pid, ppid, rssKiB]) => ({ pid, ppid, rssKiB }));
  const byPid = new Map(rows.map(row => [row.pid, row]));
  assert.ok(byPid.has(rootPid), `Electron root process ${rootPid} is not running`);
  const children = new Map();
  for (const row of rows) {
    const list = children.get(row.ppid) || [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const processIds = [];
  const pending = [rootPid];
  const visited = new Set();
  while (pending.length) {
    const pid = pending.pop();
    if (visited.has(pid)) continue;
    visited.add(pid);
    processIds.push(pid);
    pending.push(...(children.get(pid) || []));
  }
  const rssKiB = processIds.reduce(
    (total, pid) => total + (byPid.get(pid)?.rssKiB || 0),
    0
  );
  return { processCount: processIds.length, rssMiB: round(rssKiB / 1024) };
}

async function sampleSettledRss(rootPid) {
  await delay(settleMilliseconds);
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await processTreeRss(rootPid));
    if (index + 1 < sampleCount) await delay(sampleIntervalMilliseconds);
  }
  const rssValues = samples.map(sample => sample.rssMiB);
  return {
    medianMiB: median(rssValues),
    peakMiB: Math.max(...rssValues),
    rssMiB: rssValues,
    processCounts: samples.map(sample => sample.processCount),
  };
}

async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  try {
    child.kill("SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  await withTimeout(exited, 5_000, "Electron SIGTERM shutdown").catch(() => {});
  if (child.exitCode === null && child.signalCode === null) {
    const killed = once(child, "exit");
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await withTimeout(killed, 2_000, "Electron SIGKILL shutdown").catch(() => {});
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("Electron process remained alive after SIGKILL");
  }
}

async function closeFixtureServer() {
  if (!fixtureServer?.listening) return;
  fixtureServer.closeAllConnections?.();
  await withTimeout(
    new Promise((resolve, reject) => {
      fixtureServer.close(error => {
        if (error) reject(error);
        else resolve();
      });
    }),
    2_000,
    "fixture server close"
  );
}

async function cleanup() {
  const operations = [
    ["DevTools client close", () => shellClient?.close()],
    ["Electron process stop", stopChild],
    ["fixture server close", closeFixtureServer],
    [
      "temporary user-data removal",
      () => userData && rm(userData, { recursive: true, force: true }),
    ],
  ];
  for (const [label, operation] of operations) {
    try {
      await withTimeout(
        Promise.resolve().then(operation),
        cleanupTimeoutMilliseconds,
        label
      );
    } catch (error) {
      cleanupErrors.push({ label, ...serializeError(error) });
    }
  }
}

try {
  userData = await mkdtemp(path.join(os.tmpdir(), "chroma-performance-smoke-"));
  fixtureServer = createServer((request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const tab = Math.max(1, Number.parseInt(requestUrl.searchParams.get("tab"), 10) || 1);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'"
    );
    response.end(`<!doctype html><meta name="viewport" content="width=device-width">
      <title>Performance Fixture ${tab}</title>
      <main>Local performance fixture ${tab}</main>
      <script>globalThis.__chromaPerformanceReady = ${tab};</script>`);
  });
  fixtureServer.listen(0, "127.0.0.1");
  await once(fixtureServer, "listening");
  const fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
  const devToolsPort = await reservePort();
  const launchStarted = performance.now();

  child = spawn(
    electronPath,
    ["--no-error-dialogs", `--remote-debugging-port=${devToolsPort}`, "."],
    {
      cwd: root,
      env: {
        ...process.env,
        CHROMA_CHROMIUM_USER_DATA: userData,
        CHROMA_DISABLE_SINGLE_INSTANCE: "1",
        CHROMA_HEADLESS_SMOKE: "1",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child.stdout.on("data", chunk => output.push(String(chunk)));
  child.stderr.on("data", chunk => output.push(String(chunk)));
  child.on("error", error => output.push(`${error.stack || error}\n`));

  const shellTarget = await waitFor(async () => {
    const targets = await listTargets(devToolsPort);
    return targets.find(target =>
      target.type === "page" &&
      target.url.endsWith("/src/renderer/index.html")
    );
  });
  shellClient = new CdpClient(shellTarget.webSocketDebuggerUrl);
  await shellClient.open();
  const shellState = await waitFor(async () => {
    const snapshot = await shellClient.evaluate(`(async () => {
      if (!window.chromaBrowser || !document.querySelector('#app')) return null;
      const state = await window.chromaBrowser.getState();
      return state.runtime?.managedViewCount === 1 && state.tabs?.length === 1
        ? state
        : null;
    })()`);
    return snapshot || false;
  });
  const shellReadyMs = round(performance.now() - launchStarted);
  const firstTabId = shellState.activeTabId;
  const firstPageUrl = `${fixtureOrigin}/page?tab=1`;
  assert.equal(
    await shellClient.evaluate(
      `window.chromaBrowser.command('navigation:go', { id: ${JSON.stringify(firstTabId)}, input: ${JSON.stringify(firstPageUrl)} })`
    ),
    true
  );

  const firstPageTarget = await waitFor(async () => {
    const state = await shellClient.evaluate("window.chromaBrowser.getState()");
    const tab = state.tabs.find(item => item.id === firstTabId);
    const viewport = (
      await shellClient.evaluate("window.chromaBrowser.getSmokeViewports()")
    )[firstTabId];
    if (
      tab?.loading ||
      tab?.url !== firstPageUrl ||
      tab?.title !== "Performance Fixture 1" ||
      viewport?.nativeVisible !== true ||
      viewport?.url !== firstPageUrl ||
      viewport.width <= 0 ||
      viewport.height <= 0
    ) {
      return false;
    }
    const targets = await listTargets(devToolsPort);
    return targets.find(target => target.type === "page" && target.url === firstPageUrl) || false;
  });
  const firstPageClient = new CdpClient(firstPageTarget.webSocketDebuggerUrl);
  await firstPageClient.open();
  assert.equal(
    await firstPageClient.evaluate(
      "document.readyState === 'complete' && globalThis.__chromaPerformanceReady === 1"
    ),
    true
  );
  await firstPageClient.close();
  const firstLocalPageReadyMs = round(performance.now() - launchStarted);
  const idleRss = await sampleSettledRss(child.pid);

  const tabIds = [firstTabId];
  const expectedUrls = [firstPageUrl];
  for (let index = 2; index <= tabCount; index += 1) {
    const url = `${fixtureOrigin}/page?tab=${index}`;
    const id = await shellClient.evaluate(
      `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(url)} })`
    );
    assert.ok(id, `unable to create performance tab ${index}`);
    tabIds.push(id);
    expectedUrls.push(url);
  }
  await waitFor(async () => {
    const state = await shellClient.evaluate("window.chromaBrowser.getState()");
    if (
      state.tabs.length !== tabCount ||
      state.runtime.managedViewCount !== tabCount ||
      tabIds.some((id, index) => {
        const tab = state.tabs.find(item => item.id === id);
        return !tab ||
          tab.loading ||
          tab.url !== expectedUrls[index] ||
          tab.title !== `Performance Fixture ${index + 1}`;
      })
    ) {
      return false;
    }
    const targets = await listTargets(devToolsPort);
    const targetUrls = new Set(
      targets.filter(target => target.type === "page").map(target => target.url)
    );
    return expectedUrls.every(url => targetUrls.has(url));
  });
  const eightTabsRss = await sampleSettledRss(child.pid);
  const eightTabsDeltaRssMiB = round(eightTabsRss.medianMiB - idleRss.medianMiB);
  const measurements = {
    shellReadyMs,
    firstLocalPageReadyMs,
    firstLocalPageAfterShellMs: round(firstLocalPageReadyMs - shellReadyMs),
    idleRssMiB: idleRss.medianMiB,
    idleRssPeakMiB: idleRss.peakMiB,
    eightTabsRssMiB: eightTabsRss.medianMiB,
    eightTabsRssPeakMiB: eightTabsRss.peakMiB,
    eightTabsDeltaRssMiB,
  };

  assert.ok(
    measurements.shellReadyMs <= thresholds.maxShellReadyMs,
    `shell-ready ${measurements.shellReadyMs}ms exceeded ${thresholds.maxShellReadyMs}ms`
  );
  assert.ok(
    measurements.firstLocalPageReadyMs <= thresholds.maxFirstLocalPageReadyMs,
    `first local page ${measurements.firstLocalPageReadyMs}ms exceeded ${thresholds.maxFirstLocalPageReadyMs}ms`
  );
  assert.ok(
    measurements.idleRssMiB <= thresholds.maxIdleRssMiB,
    `idle RSS ${measurements.idleRssMiB}MiB exceeded ${thresholds.maxIdleRssMiB}MiB`
  );
  assert.ok(
    measurements.eightTabsRssMiB <= thresholds.maxEightTabsRssMiB,
    `8-tab RSS ${measurements.eightTabsRssMiB}MiB exceeded ${thresholds.maxEightTabsRssMiB}MiB`
  );
  assert.ok(
    measurements.eightTabsDeltaRssMiB <= thresholds.maxEightTabsDeltaRssMiB,
    `8-tab RSS delta ${measurements.eightTabsDeltaRssMiB}MiB exceeded ${thresholds.maxEightTabsDeltaRssMiB}MiB`
  );
  // Chromium can legitimately consolidate same-site tabs into fewer renderer
  // processes. Process counts are diagnostic only; the ownership invariant is
  // asserted through managed live views above.
  assert.ok(Math.min(...idleRss.processCounts) >= 3);
  assert.ok(Math.min(...eightTabsRss.processCounts) >= 3);

  runResult = {
    chromium: shellState.runtime.chromiumVersion,
    measurements,
    samples: {
      idleRssMiB: idleRss.rssMiB,
      idleProcessCounts: idleRss.processCounts,
      eightTabsRssMiB: eightTabsRss.rssMiB,
      eightTabsProcessCounts: eightTabsRss.processCounts,
    },
  };
} catch (error) {
  runError = error;
} finally {
  await cleanup();
}

const logs = output.join("");
const fatalLogMatches = fatalMatches(logs);
if (!runError && fatalLogMatches.length) {
  runError = new Error(
    `performance smoke emitted fatal log patterns: ${fatalLogMatches.join(", ")}`
  );
}
if (!runError && cleanupErrors.length) {
  runError = new Error(
    `performance smoke cleanup failed: ${cleanupErrors
      .map(error => `${error.label}: ${error.message}`)
      .join("; ")}`
  );
}

const finishedAt = new Date().toISOString();
const finalReport = {
  ...reportMetadata,
  timestamp: finishedAt,
  finishedAt,
  passed: !runError,
  status: runError ? "failed" : "passed",
  chromium: runResult?.chromium || "unavailable",
  tabCount,
  thresholds,
  ...(runResult || {}),
  fatalLogMatches,
  cleanupErrors,
  ...(runError
    ? {
        error: serializeError(runError),
        outputTail: logs.slice(-16_000),
      }
    : {}),
};

try {
  await writeReport(finalReport);
} catch (artifactError) {
  process.stderr.write(
    `Unable to write performance report ${artifactFile}:\n${artifactError.stack || artifactError}\n`
  );
  process.exitCode = 1;
}

if (runError) {
  process.stderr.write(`${logs}${logs ? "\n" : ""}${runError.stack || runError}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ ...finalReport, artifactFile })}\n`);
}
