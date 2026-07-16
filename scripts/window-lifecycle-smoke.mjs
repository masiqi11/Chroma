import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureHits = new Map();
const SECONDARY_EXIT_TIMEOUT_MS = 30_000;
let fixtureServer;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function trace(message) {
  if (process.env.CHROMA_WINDOW_SMOKE_DEBUG === "1") {
    process.stderr.write(`[window-lifecycle-smoke] ${message}\n`);
  }
}

async function waitFor(callback, timeout = 20_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
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

function isShellTarget(target) {
  return target.type === "page" &&
    target.url.endsWith("/src/renderer/index.html");
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

  async open() {
    if (this.#socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.#socket.onopen = resolve;
      this.#socket.onerror = reject;
    });
  }

  send(method, params = {}) {
    const id = ++this.#nextId;
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`DevTools ${method} timed out`));
      }, 20_000);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    this.#socket.send(JSON.stringify({ id, method, params }));
    return result;
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
    this.#socket.close();
    await Promise.race([closed, delay(1_000)]);
  }
}

function startPrimary({ userData, port, failOnce = false }) {
  const output = [];
  const env = {
    ...process.env,
    CHROMA_CHROMIUM_USER_DATA: userData,
    CHROMA_HEADLESS_SMOKE: "1",
    CHROMA_WINDOW_CREATION_DELAY_MS: "1800",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    ...(failOnce ? { CHROMA_FAIL_WINDOW_CREATION_ONCE: "1" } : {}),
  };
  delete env.CHROMA_DISABLE_SINGLE_INSTANCE;
  const child = spawn(
    electronPath,
    ["--no-error-dialogs", `--remote-debugging-port=${port}`, "."],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout.on("data", chunk => output.push(String(chunk)));
  child.stderr.on("data", chunk => output.push(String(chunk)));
  child.on("error", error => output.push(`${error.stack || error}\n`));
  return { child, env, output, port, userData };
}

async function openSecondary(primary, url) {
  const output = [];
  const child = spawn(electronPath, ["--no-error-dialogs", ".", url], {
    cwd: root,
    env: primary.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => output.push(String(chunk)));
  child.stderr.on("data", chunk => output.push(String(chunk)));

  const result = await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    // Eight Electron helpers start together to exercise the real single-instance
    // race. On a loaded macOS host, process startup can legitimately exceed ten
    // seconds before requestSingleInstanceLock() returns; keep a bounded timeout
    // without turning normal scheduler pressure into a false lifecycle failure.
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ timeout: true });
    }, SECONDARY_EXIT_TIMEOUT_MS);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  if (result.timeout) {
    child.kill("SIGKILL");
    throw new Error(`Secondary instance timed out for ${url}\n${output.join("")}`);
  }
  assert.equal(
    result.code,
    0,
    `Secondary instance failed for ${url} (${result.signal || "no signal"})\n${output.join("")}`
  );
}

async function stopPrimary(primary) {
  if (!primary || primary.child.exitCode !== null || primary.child.signalCode !== null) return;
  const exited = once(primary.child, "exit");
  primary.child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (primary.child.exitCode === null && primary.child.signalCode === null) {
    const killed = once(primary.child, "exit");
    primary.child.kill("SIGKILL");
    await Promise.race([killed, delay(2_000)]);
  }
}

async function waitForCreationWindow(primary) {
  return waitFor(async () => {
    if (primary.child.exitCode !== null || primary.child.signalCode !== null) {
      throw new Error(`Primary exited during creation\n${primary.output.join("")}`);
    }
    return primary.output.join("").includes("Chroma smoke: window creation delayed");
  });
}

async function connectShell(primary) {
  const target = await waitFor(async () => {
    const targets = await listTargets(primary.port);
    const shellTargets = targets.filter(isShellTarget);
    return shellTargets.length === 1 ? shellTargets[0] : false;
  });
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  await waitFor(() => client.evaluate("Boolean(window.chromaBrowser)"));
  return client;
}

function assertUrlsExactlyOnce(state, urls) {
  for (const url of urls) {
    const tabs = state.tabs.filter(tab => tab.url === url);
    assert.equal(tabs.length, 1, `Expected exactly one tab for ${url}`);
    assert.equal(tabs[0].loading, false, `Tab still loading for ${url}`);
  }
}

async function waitForUrls(client, urls) {
  return waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    return urls.every(url => {
      const tabs = state.tabs.filter(tab => tab.url === url);
      return tabs.length === 1 && tabs[0].loading === false;
    }) ? state : false;
  });
}

async function assertStableTopology(primary, urls) {
  for (let sample = 0; sample < 8; sample += 1) {
    if (primary.child.exitCode !== null || primary.child.signalCode !== null) {
      throw new Error("Primary exited while checking target topology");
    }
    const targets = await waitFor(() => listTargets(primary.port), 3_000);
    const pageTargets = targets.filter(target => target.type === "page");
    assert.equal(pageTargets.filter(isShellTarget).length, 1);
    assert.equal(
      pageTargets.filter(target => target.url.includes("?mode=sidebar-overlay")).length,
      1
    );
    assert.equal(pageTargets.filter(target => target.url === "about:blank").length, 0);
    for (const url of urls) {
      assert.equal(pageTargets.filter(target => target.url === url).length, 1);
    }
    assert.equal(pageTargets.length, urls.length + 2);
    await delay(100);
  }
}

async function waitForPersistedUrls(primary, urls) {
  const statePath = path.join(primary.userData, "browser-state.json");
  return waitFor(async () => {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      return urls.every(url => state.tabs.filter(tab => tab.url === url).length === 1)
        ? state
        : false;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
}

function assertFixtureHits(urls) {
  for (const url of urls) {
    const { pathname } = new URL(url);
    assert.ok((fixtureHits.get(pathname) || 0) >= 1, `Fixture was not requested: ${url}`);
  }
}

function assertNoFatalLog(primary, { allowInjectedFailure = false } = {}) {
  const log = primary.output.join("");
  assert.doesNotMatch(log, /Uncaught Exception|Object has been destroyed|Shell preload failed/i);
  if (!allowInjectedFailure) assert.doesNotMatch(log, /Unable to create browser window/i);
}

async function runConcurrentRound(baseUrl) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "chroma-window-concurrent-"));
  const port = await reservePort();
  const primary = startPrimary({ userData, port });
  let client;
  try {
    await waitForCreationWindow(primary);
    trace("concurrent round reached delayed creation window");
    const urls = Array.from(
      { length: 8 },
      (_, index) => new URL(`/concurrent/${index + 1}`, baseUrl).href
    );
    await Promise.all(urls.map(url => openSecondary(primary, url)));
    trace("concurrent round secondary instances exited");
    client = await connectShell(primary);
    trace("concurrent round connected to shell");
    const state = await waitForUrls(client, urls);
    trace("concurrent round loaded every URL");
    assertUrlsExactlyOnce(state, urls);
    assertFixtureHits(urls);
    await assertStableTopology(primary, urls);
    trace("concurrent round topology stable");
    await waitForPersistedUrls(primary, urls);
    trace("concurrent round state persisted");
    assertNoFatalLog(primary);
    return urls.length;
  } catch (error) {
    throw new Error(
      `Concurrent window lifecycle round failed (exit=${primary.child.exitCode}, signal=${primary.child.signalCode}):\n${primary.output.join("")}\n${error.message}`,
      { cause: error }
    );
  } finally {
    await client?.close().catch(() => {});
    await stopPrimary(primary);
    await rm(userData, { recursive: true, force: true });
  }
}

async function runFailureRound(baseUrl) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "chroma-window-failure-"));
  const port = await reservePort();
  const primary = startPrimary({ userData, port, failOnce: true });
  let client;
  try {
    await waitForCreationWindow(primary);
    trace("failure round reached delayed creation window");
    const queuedUrls = Array.from(
      { length: 3 },
      (_, index) => new URL(`/failure/queued-${index + 1}`, baseUrl).href
    );
    await Promise.all(queuedUrls.map(url => openSecondary(primary, url)));
    trace("failure round queued secondary instances exited");
    await waitFor(() => primary.output.join("").includes("Injected window creation failure"));
    await waitFor(async () => {
      const targets = await listTargets(primary.port);
      return targets.filter(target => target.type === "page").length === 0;
    });
    assert.equal(primary.child.exitCode, null);
    assert.equal(primary.child.signalCode, null);
    trace("failure round cleaned failed window");

    const recoveryUrl = new URL("/failure/recovery", baseUrl).href;
    await openSecondary(primary, recoveryUrl);
    trace("failure round recovery request sent");
    const urls = [...queuedUrls, recoveryUrl];
    client = await connectShell(primary);
    const state = await waitForUrls(client, urls);
    trace("failure round loaded queued URLs");
    assertUrlsExactlyOnce(state, urls);
    assertFixtureHits(urls);
    await assertStableTopology(primary, urls);
    await waitForPersistedUrls(primary, urls);
    assertNoFatalLog(primary, { allowInjectedFailure: true });
    return true;
  } catch (error) {
    throw new Error(
      `Failed-creation lifecycle round failed (exit=${primary.child.exitCode}, signal=${primary.child.signalCode}):\n${primary.output.join("")}\n${error.message}`,
      { cause: error }
    );
  } finally {
    await client?.close().catch(() => {});
    await stopPrimary(primary);
    await rm(userData, { recursive: true, force: true });
  }
}

try {
  fixtureServer = createServer((request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    fixtureHits.set(requestUrl.pathname, (fixtureHits.get(requestUrl.pathname) || 0) + 1);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(
      `<!doctype html><meta name="viewport" content="width=device-width">` +
      `<title>Lifecycle ${requestUrl.pathname}</title><h1>${requestUrl.pathname}</h1>`
    );
  });
  fixtureServer.listen(0, "127.0.0.1");
  await once(fixtureServer, "listening");
  const baseUrl = `http://127.0.0.1:${fixtureServer.address().port}`;

  const concurrentUrls = await runConcurrentRound(baseUrl);
  const failedCreationCleanup = await runFailureRound(baseUrl);
  process.stdout.write(`${JSON.stringify({
    concurrentUrls,
    singleWindow: true,
    failedCreationCleanup,
    queuedUrlsSurviveFailure: true,
  })}\n`);
} finally {
  if (fixtureServer) {
    fixtureServer.closeAllConnections?.();
    await new Promise(resolve => fixtureServer.close(resolve));
  }
}
