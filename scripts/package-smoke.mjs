import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { extractFile, listPackage } from "@electron/asar";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const reportDirectory = path.join(root, "artifacts", "package");
const requiredEntries = [
  "package.json",
  "src/main/main.mjs",
  "src/main/browser-controller.mjs",
  "src/main/download-service.mjs",
  "src/main/history-service.mjs",
  "src/main/internal-pages.mjs",
  "src/main/process-output.mjs",
  "src/main/state-store.mjs",
  "src/preload/shell-preload.cjs",
  "src/renderer/index.html",
  "src/renderer/shell.mjs",
  "src/renderer/styles.css",
  "src/shared/appearance.mjs",
  "src/shared/channels.mjs",
  "src/shared/command-search.mjs",
  "src/shared/layout.mjs",
  "src/shared/model.mjs",
  "src/shared/navigation.mjs",
  "src/shared/split-ratios.mjs",
  "src/shared/state-invariants.mjs",
];
const forbiddenRoots = [
  ".git",
  "artifacts",
  "browser-state.json",
  "coverage",
  "docs",
  "scripts",
  "test",
];
const requiredLicenseResources = [
  "Chroma-LICENSE.txt",
  "Chroma-NOTICE.md",
  "THIRD_PARTY_NOTICES.md",
  "Electron-LICENSE.txt",
  "LICENSES.chromium.html",
];
const fatalOutputPatterns = [
  /A JavaScript error occurred/i,
  /Cannot find module/i,
  /ERR_MODULE_NOT_FOUND/i,
  /Error launching app/i,
  /Object has been destroyed/i,
  /preload[^\n]*(?:error|failed)/i,
  /Uncaught Exception/i,
  /Unable to find Electron app/i,
];

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(callback, timeout = 25_000) {
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

async function findApplicationBundles(directory) {
  const bundles = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === "Chroma.app") {
        bundles.push(entryPath);
        continue;
      }
      await visit(entryPath);
    }
  }
  await visit(directory);
  return bundles;
}

async function selectApplicationBundle() {
  const candidates = await findApplicationBundles(dist);
  assert.ok(candidates.length > 0, "No packaged Chroma.app was found under dist/");
  const ranked = await Promise.all(candidates.map(async appPath => {
    const metadata = await stat(appPath);
    const architectureMatch = appPath.includes(`${path.sep}mac-${process.arch}${path.sep}`);
    const genericMacMatch = appPath.includes(`${path.sep}mac${path.sep}`);
    return {
      appPath,
      score: (architectureMatch ? 2 : genericMacMatch ? 1 : 0),
      mtimeMs: metadata.mtimeMs,
    };
  }));
  ranked.sort((left, right) => right.score - left.score || right.mtimeMs - left.mtimeMs);
  return ranked[0].appPath;
}

async function plistValue(infoPath, key) {
  const { stdout } = await execFileAsync(
    "plutil",
    ["-extract", key, "raw", "-o", "-", infoPath],
    { encoding: "utf8" }
  );
  return stdout.trim();
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
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

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    const killed = once(child, "exit");
    child.kill("SIGKILL");
    await Promise.race([killed, delay(2_000)]);
  }
}

const profile = await mkdtemp(path.join(os.tmpdir(), "chroma-package-smoke-"));
const output = [];
let child;
let client;

try {
  const appPath = await selectApplicationBundle();
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const asarPath = path.join(resourcesPath, "app.asar");
  const bundleIdentifier = await plistValue(infoPath, "CFBundleIdentifier");
  const executableName = await plistValue(infoPath, "CFBundleExecutable");
  const iconName = await plistValue(infoPath, "CFBundleIconFile");
  const executablePath = path.join(appPath, "Contents", "MacOS", executableName);
  const packagedIconPath = path.join(resourcesPath, iconName);
  const sourceIconPath = path.join(root, "build", "icon.icns");
  const licensesPath = path.join(resourcesPath, "licenses");

  assert.equal(bundleIdentifier, "com.masiqi.chroma");
  await stat(executablePath);
  await stat(asarPath);
  assert.equal(iconName, "icon.icns");
  assert.equal(
    await sha256(packagedIconPath),
    await sha256(sourceIconPath),
    "Packaged app must contain the original Chroma icon"
  );
  for (const licenseName of requiredLicenseResources) {
    const licensePath = path.join(licensesPath, licenseName);
    const licenseStat = await stat(licensePath);
    assert.ok(licenseStat.size > 0, `Packaged notice is empty: ${licenseName}`);
  }

  const entries = listPackage(asarPath).map(entry => entry.replace(/^[/\\]+/, ""));
  const entrySet = new Set(entries);
  for (const entry of requiredEntries) {
    assert.ok(entrySet.has(entry), `Packaged app is missing ${entry}`);
  }
  for (const rootName of forbiddenRoots) {
    const leakedEntry = entries.find(entry =>
      entry === rootName || entry.startsWith(`${rootName}/`)
    );
    assert.equal(leakedEntry, undefined, `Development content leaked into app.asar: ${leakedEntry}`);
  }

  const packagedManifest = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
  assert.equal(packagedManifest.name, "chroma-browser");
  assert.equal(packagedManifest.productName, "Chroma");
  assert.equal(packagedManifest.main, "src/main/main.mjs");

  let signed = true;
  let signingStatus = "signed";
  try {
    await execFileAsync("codesign", ["--verify", "--deep", "--strict", appPath]);
  } catch (error) {
    signed = false;
    signingStatus = `${error.stderr || error.message}`.trim().split("\n")[0];
  }
  assert.equal(signed, false, "Local package unexpectedly carries a valid code signature");

  const port = await reservePort();
  const env = {
    ...process.env,
    CHROMA_CHROMIUM_USER_DATA: profile,
    CHROMA_DISABLE_SINGLE_INSTANCE: "1",
    CHROMA_HEADLESS_SMOKE: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  };
  child = spawn(
    executablePath,
    ["--no-error-dialogs", `--remote-debugging-port=${port}`],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout.on("data", chunk => output.push(String(chunk)));
  child.stderr.on("data", chunk => output.push(String(chunk)));
  child.on("error", error => output.push(`${error.stack || error}\n`));

  const shellTarget = await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Packaged app exited before startup completed\n${output.join("")}`);
    }
    const targets = await listTargets(port);
    return targets.find(target =>
      target.type === "page" && target.url.endsWith("/src/renderer/index.html")
    );
  });

  client = new CdpClient(shellTarget.webSocketDebuggerUrl);
  await client.open();
  const runtime = await waitFor(async () => {
    const value = await client.evaluate(`(async () => ({
      bridgeAvailable: typeof window.chromaBrowser?.getState === "function",
      state: await window.chromaBrowser?.getState?.()
    }))()`);
    return value.bridgeAvailable && value.state?.tabs?.length > 0 ? value : false;
  });

  await delay(500);
  const combinedOutput = output.join("");
  const fatalPattern = fatalOutputPatterns.find(pattern => pattern.test(combinedOutput));
  assert.equal(
    fatalPattern,
    undefined,
    `Packaged app emitted fatal startup output matching ${fatalPattern}\n${combinedOutput}`
  );

  const report = {
    appPath: path.relative(root, appPath),
    architecture: process.arch,
    bundleIdentifier,
    entryCount: entries.length,
    requiredEntries: requiredEntries.length,
    forbiddenRootsAbsent: true,
    preloadBridgeAvailable: runtime.bridgeAvailable,
    initialTabCount: runtime.state.tabs.length,
    runtimeElectronVersion: runtime.state.runtime?.electronVersion || null,
    signing: {
      signed,
      status: signingStatus,
    },
    icon: {
      file: iconName,
      source: path.relative(root, sourceIconPath),
      sha256: await sha256(packagedIconPath),
      branded: true,
    },
    licenseResources: requiredLicenseResources,
    fatalStartupOutput: false,
  };
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    path.join(reportDirectory, "package-smoke.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (output.length > 0) process.stderr.write(output.join(""));
  throw error;
} finally {
  await client?.close().catch(() => {});
  await stopChild(child);
  await rm(profile, { recursive: true, force: true });
}
