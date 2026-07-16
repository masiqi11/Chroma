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
const userData = await mkdtemp(path.join(os.tmpdir(), "chroma-session-smoke-"));
const stateFile = path.join(userData, "browser-state.json");
const launches = [];
let fixtureServer;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function trace(message) {
  if (process.env.CHROMA_SESSION_SMOKE_DEBUG === "1") {
    process.stderr.write(`[session-smoke] ${message}\n`);
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

async function launchBrowser(startupUrl = null) {
  const port = await reservePort();
  const output = [];
  const args = [
    "--no-error-dialogs",
    `--remote-debugging-port=${port}`,
    ".",
    ...(startupUrl ? [startupUrl] : []),
  ];
  const child = spawn(electronPath, args, {
    cwd: root,
    env: {
      ...process.env,
      CHROMA_CHROMIUM_USER_DATA: userData,
      CHROMA_DISABLE_SINGLE_INSTANCE: "1",
      CHROMA_HEADLESS_SMOKE: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => output.push(String(chunk)));
  child.stderr.on("data", chunk => output.push(String(chunk)));
  child.on("error", error => output.push(`${error.stack || error}\n`));

  const launch = { child, client: null, output, port };
  launches.push(launch);
  try {
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) return false;
      const targets = await response.json();
      return targets.find(item => item.url.endsWith("/src/renderer/index.html"));
    });
    launch.client = new CdpClient(target.webSocketDebuggerUrl);
    await launch.client.open();
    await waitFor(() => launch.client.evaluate("Boolean(window.chromaBrowser)"));
    trace(`launched on DevTools port ${port}`);
    return launch;
  } catch (error) {
    throw new Error(
      `Unable to launch Chroma session smoke round:\n${output.join("")}\n${error.message}`,
      { cause: error }
    );
  }
}

async function stopLaunch(launch) {
  if (!launch) return;
  await launch.client?.close().catch(() => {});
  const { child } = launch;
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    const killed = once(child, "exit");
    child.kill("SIGKILL");
    await Promise.race([killed, delay(2_000)]);
  }
}

function command(client, name, payload = {}) {
  return client.evaluate(
    `window.chromaBrowser.command(${JSON.stringify(name)}, ${JSON.stringify(payload)})`
  );
}

function getState(client) {
  return client.evaluate("window.chromaBrowser.getState()");
}

function getAppearanceSnapshot(client, workspaceId) {
  return client.evaluate(`(async () => {
    const state = await window.chromaBrowser.getState();
    const workspace = state.workspaces.find(
      item => item.id === ${JSON.stringify(workspaceId)}
    );
    const root = document.documentElement;
    const app = document.querySelector('#app');
    return {
      schemaVersion: state.schemaVersion,
      publicTheme: state.settings?.appearance?.theme,
      publicReduceTransparency: state.settings?.appearance?.reduceTransparency,
      workspaceColor: workspace?.color,
      rootTheme: root.dataset.theme,
      rootReduceTransparency: root.dataset.reduceTransparency,
      appTheme: app?.dataset.theme,
      appReduceTransparency: app?.dataset.reduceTransparency,
      reducedTransparencyClass: app?.classList.contains('reduced-transparency'),
      colorScheme: root.style.colorScheme,
      prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
      prefersLight: matchMedia('(prefers-color-scheme: light)').matches,
      renderedAccent: app
        ? getComputedStyle(app).getPropertyValue('--chroma-accent').trim().toLowerCase()
        : '',
    };
  })()`);
}

function appearanceSnapshotMatches(snapshot, expected) {
  const expectedColorScheme = expected.theme === "system"
    ? "light dark"
    : expected.theme;
  const nativeThemeMatches = expected.theme === "dark"
    ? snapshot.prefersDark === true && snapshot.prefersLight === false
    : expected.theme === "light"
      ? snapshot.prefersDark === false && snapshot.prefersLight === true
      : snapshot.prefersDark !== snapshot.prefersLight;
  return snapshot.schemaVersion === 6 &&
    snapshot.publicTheme === expected.theme &&
    snapshot.publicReduceTransparency === expected.reduceTransparency &&
    snapshot.workspaceColor === expected.workspaceColor &&
    snapshot.rootTheme === expected.theme &&
    snapshot.rootReduceTransparency === String(expected.reduceTransparency) &&
    snapshot.appTheme === expected.theme &&
    snapshot.appReduceTransparency === String(expected.reduceTransparency) &&
    snapshot.reducedTransparencyClass === expected.reduceTransparency &&
    snapshot.colorScheme === expectedColorScheme &&
    snapshot.renderedAccent === expected.workspaceColor &&
    nativeThemeMatches;
}

async function waitForAppearance(client, expected) {
  return waitFor(async () => {
    const snapshot = await getAppearanceSnapshot(client, expected.workspaceId);
    return appearanceSnapshotMatches(snapshot, expected) ? snapshot : false;
  });
}

async function waitForPersistedAppearance(expected) {
  return waitFor(async () => {
    try {
      const state = await readPersistedState();
      const workspace = findById(state.workspaces || [], expected.workspaceId);
      return state.schemaVersion === 6 &&
        state.settings?.appearance?.theme === expected.theme &&
        state.settings.appearance.reduceTransparency === expected.reduceTransparency &&
        workspace?.color === expected.workspaceColor
        ? state
        : false;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
}

async function setAndPersistAppearance(client, expected) {
  assert.equal(
    await command(client, "settings:set-appearance", {
      theme: expected.theme,
      reduceTransparency: expected.reduceTransparency,
      workspaceId: expected.workspaceId,
      workspaceColor: expected.workspaceColor,
    }),
    true
  );
  const snapshot = await waitForAppearance(client, expected);
  const persisted = await waitForPersistedAppearance(expected);
  assert.equal(persisted.schemaVersion, 6);
  assert.deepEqual(persisted.settings.appearance, {
    theme: expected.theme,
    reduceTransparency: expected.reduceTransparency,
  });
  return snapshot;
}

async function waitForLoadedTab(client, id, url) {
  return waitFor(async () => {
    const state = await getState(client);
    const tab = state.tabs.find(item => item.id === id);
    return tab?.url === url && !tab.loading ? tab : false;
  });
}

async function readPersistedState() {
  return JSON.parse(await readFile(stateFile, "utf8"));
}

function findById(items, id) {
  return items.find(item => item.id === id);
}

try {
  fixtureServer = createServer((request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const pageName = requestUrl.pathname.slice(1) || "home";
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(
      `<!doctype html><meta name="viewport" content="width=device-width">` +
      `<title>Session ${pageName}</title><h1>Session ${pageName}</h1>`
    );
  });
  fixtureServer.listen(0, "127.0.0.1");
  await once(fixtureServer, "listening");
  const baseUrl = `http://127.0.0.1:${fixtureServer.address().port}`;

  const firstLaunch = await launchBrowser();
  const firstClient = firstLaunch.client;
  const initial = await getState(firstClient);
  trace("first launch state loaded");
  assert.equal(initial.schemaVersion, 6);
  assert.equal(initial.workspaces.length, 1);
  assert.equal(initial.tabs.length, 1);
  assert.deepEqual(initial.settings.appearance, {
    theme: "system",
    reduceTransparency: false,
  });

  const originalWorkspaceId = initial.activeWorkspaceId;
  const originalTabId = initial.activeTabId;
  const originalWorkspaceColor = findById(
    initial.workspaces,
    originalWorkspaceId
  ).color;
  const darkAppearance = {
    theme: "dark",
    reduceTransparency: true,
    workspaceId: originalWorkspaceId,
    workspaceColor: "#5b8def",
  };
  const lightAppearance = {
    theme: "light",
    reduceTransparency: false,
    workspaceId: originalWorkspaceId,
    workspaceColor: "#d98f72",
  };
  const systemAppearance = {
    theme: "system",
    reduceTransparency: true,
    workspaceId: originalWorkspaceId,
    workspaceColor: "#8a78ff",
  };
  const initialSystemSnapshot = await waitForAppearance(firstClient, {
    theme: "system",
    reduceTransparency: false,
    workspaceId: originalWorkspaceId,
    workspaceColor: originalWorkspaceColor,
  });
  trace("default system appearance verified");
  const originalUrl = new URL("/restored-active", baseUrl).href;
  const splitPeerUrl = new URL("/split-peer", baseUrl).href;
  const folderTabUrl = new URL("/folder-tab", baseUrl).href;
  const workspaceTabUrl = new URL("/workspace-tab", baseUrl).href;

  assert.equal(
    await command(firstClient, "workspace:rename", {
      id: originalWorkspaceId,
      name: "Restored Personal",
    }),
    true
  );
  assert.equal(
    await command(firstClient, "navigation:go", {
      id: originalTabId,
      input: originalUrl,
    }),
    true
  );
  await waitForLoadedTab(firstClient, originalTabId, originalUrl);
  trace("restored active tab prepared");

  const splitPeerId = await command(firstClient, "tab:create", {
    url: splitPeerUrl,
    workspaceId: originalWorkspaceId,
  });
  await waitForLoadedTab(firstClient, splitPeerId, splitPeerUrl);
  const folderTabId = await command(firstClient, "tab:create", {
    url: folderTabUrl,
    workspaceId: originalWorkspaceId,
  });
  await waitForLoadedTab(firstClient, folderTabId, folderTabUrl);
  trace("first workspace tabs prepared");
  const folderId = await command(firstClient, "folder:create", {
    name: "Restored Folder",
    tabIds: [folderTabId],
  });
  assert.ok(folderId);
  const emptyFolderId = await command(firstClient, "folder:create", {
    name: "Empty Folder Draft",
    tabIds: [],
  });
  assert.ok(emptyFolderId);
  assert.equal(
    await command(firstClient, "folder:rename", {
      id: emptyFolderId,
      name: "Restored Empty Folder",
    }),
    true
  );

  const secondWorkspaceId = await command(firstClient, "workspace:create", {
    name: "Session Space",
    icon: "book",
    color: "#8dd7ff",
  });
  assert.ok(secondWorkspaceId);
  const afterWorkspaceCreation = await getState(firstClient);
  const workspaceTabId = afterWorkspaceCreation.activeTabId;
  assert.equal(
    await command(firstClient, "navigation:go", {
      id: workspaceTabId,
      input: workspaceTabUrl,
    }),
    true
  );
  await waitForLoadedTab(firstClient, workspaceTabId, workspaceTabUrl);
  trace("second workspace prepared");

  assert.equal(
    await command(firstClient, "workspace:select", { id: originalWorkspaceId }),
    true
  );
  const splitId = await command(firstClient, "split:tabs", {
    sourceId: splitPeerId,
    targetId: originalTabId,
    direction: "row",
    placement: "after",
  });
  assert.ok(splitId);
  assert.equal(
    await command(firstClient, "sidebar:set-width", { width: 316 }),
    true
  );
  assert.equal(await command(firstClient, "sidebar:toggle"), true);
  const firstDarkSnapshot = await setAndPersistAppearance(
    firstClient,
    darkAppearance
  );
  assert.equal(firstDarkSnapshot.prefersDark, true);
  assert.equal(firstDarkSnapshot.prefersLight, false);
  trace("dark appearance prepared and persisted");

  const expected = await waitFor(async () => {
    const state = await getState(firstClient);
    const folder = findById(state.folders, folderId);
    const emptyFolder = findById(state.folders, emptyFolderId);
    const split = findById(state.splitGroups, splitId);
    const workspace = findById(state.workspaces, originalWorkspaceId);
    return state.activeWorkspaceId === originalWorkspaceId &&
      state.activeTabId === splitPeerId &&
      state.workspaces.length === 2 &&
      state.tabs.length === 4 &&
      folder?.name === "Restored Folder" &&
      folder?.expanded === true &&
      emptyFolder?.name === "Restored Empty Folder" &&
      emptyFolder?.expanded === true &&
      emptyFolder?.tabIds?.length === 0 &&
      split?.direction === "row" &&
      split?.tabIds.join(",") === [originalTabId, splitPeerId].join(",") &&
      state.settings.sidebarWidth === 316 &&
      state.settings.sidebarCollapsed === true &&
      state.settings.appearance?.theme === darkAppearance.theme &&
      state.settings.appearance.reduceTransparency === darkAppearance.reduceTransparency &&
      workspace?.color === darkAppearance.workspaceColor
      ? state
      : false;
  });
  trace("session topology prepared");

  await waitFor(async () => {
    try {
      const state = await readPersistedState();
      return state.activeWorkspaceId === expected.activeWorkspaceId &&
        state.activeTabId === expected.activeTabId &&
        state.tabs.length === expected.tabs.length &&
        findById(state.folders, folderId)?.tabIds?.[0] === folderTabId &&
        findById(state.folders, emptyFolderId)?.name === "Restored Empty Folder" &&
        findById(state.folders, emptyFolderId)?.expanded === true &&
        findById(state.folders, emptyFolderId)?.tabIds?.length === 0 &&
        findById(state.splitGroups, splitId)?.tabIds?.join(",") ===
          [originalTabId, splitPeerId].join(",") &&
        state.settings?.sidebarWidth === 316 &&
        state.settings?.sidebarCollapsed === true &&
        state.schemaVersion === 6 &&
        state.settings?.appearance?.theme === darkAppearance.theme &&
        state.settings.appearance.reduceTransparency === darkAppearance.reduceTransparency &&
        findById(state.workspaces, originalWorkspaceId)?.color ===
          darkAppearance.workspaceColor;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  trace("session state persisted");
  await stopLaunch(firstLaunch);
  trace("first launch stopped");

  const startupUrl = new URL("/startup-external", baseUrl).href;
  const secondLaunch = await launchBrowser(startupUrl);
  trace("second launch started with external URL");
  const restored = await waitFor(async () => {
    const state = await getState(secondLaunch.client);
    const startupTabs = state.tabs.filter(tab => tab.url === startupUrl);
    return startupTabs.length === 1 && !startupTabs[0].loading
      ? { state, startupTab: startupTabs[0] }
      : false;
  });

  const restoredState = restored.state;
  const expectedTabs = new Map(expected.tabs.map(tab => [tab.id, tab.url]));
  assert.equal(restoredState.tabs.length, expected.tabs.length + 1);
  for (const [id, url] of expectedTabs) {
    assert.equal(findById(restoredState.tabs, id)?.url, url);
  }
  assert.ok(!expectedTabs.has(restored.startupTab.id));
  assert.equal(restoredState.activeTabId, restored.startupTab.id);
  assert.equal(restored.startupTab.workspaceId, originalWorkspaceId);
  assert.equal(findById(restoredState.tabs, splitPeerId)?.url, splitPeerUrl);
  assert.deepEqual(restoredState.workspaces, expected.workspaces);
  assert.deepEqual(
    findById(restoredState.folders, folderId),
    findById(expected.folders, folderId)
  );
  assert.deepEqual(
    findById(restoredState.folders, emptyFolderId),
    findById(expected.folders, emptyFolderId)
  );
  assert.deepEqual(
    findById(restoredState.splitGroups, splitId),
    findById(expected.splitGroups, splitId)
  );
  assert.equal(restoredState.settings.sidebarWidth, 316);
  assert.equal(restoredState.settings.sidebarCollapsed, true);
  assert.equal(restoredState.schemaVersion, 6);
  assert.deepEqual(restoredState.settings.appearance, {
    theme: darkAppearance.theme,
    reduceTransparency: darkAppearance.reduceTransparency,
  });
  const restoredDarkSnapshot = await waitForAppearance(
    secondLaunch.client,
    darkAppearance
  );
  assert.equal(restoredDarkSnapshot.prefersDark, true);
  assert.equal(restoredDarkSnapshot.prefersLight, false);
  trace("restored session verified");

  const combinedFolderId = await command(
    secondLaunch.client,
    "folder:create",
    {
      name: "Restored Folder Project",
      tabIds: [folderTabId, originalTabId],
    }
  );
  assert.ok(combinedFolderId);
  const combinedFolderMemberIds = [folderTabId, originalTabId, splitPeerId];
  const combinedFolderState = await waitFor(async () => {
    const state = await getState(secondLaunch.client);
    const originalFolder = findById(state.folders, folderId);
    const emptyFolder = findById(state.folders, emptyFolderId);
    const combinedFolder = findById(state.folders, combinedFolderId);
    const split = findById(state.splitGroups, splitId);
    return originalFolder?.tabIds?.length === 0 &&
      originalFolder?.expanded === true &&
      emptyFolder?.name === "Restored Empty Folder" &&
      emptyFolder?.expanded === true &&
      emptyFolder?.tabIds?.length === 0 &&
      combinedFolder?.name === "Restored Folder Project" &&
      combinedFolder?.expanded === true &&
      JSON.stringify(combinedFolder.tabIds) ===
        JSON.stringify(combinedFolderMemberIds) &&
      JSON.stringify(split?.tabIds) ===
        JSON.stringify([originalTabId, splitPeerId])
      ? state
      : false;
  });
  const splitTopologyBeforeFolderDelete = structuredClone(
    findById(combinedFolderState.splitGroups, splitId)
  );
  const tabTopologyBeforeFolderDelete = combinedFolderState.tabs.map(tab => ({
    id: tab.id,
    workspaceId: tab.workspaceId,
    url: tab.url,
  }));
  await waitFor(async () => {
    try {
      const state = await readPersistedState();
      return findById(state.folders, folderId)?.tabIds?.length === 0 &&
        findById(state.folders, emptyFolderId)?.tabIds?.length === 0 &&
        JSON.stringify(findById(state.folders, combinedFolderId)?.tabIds) ===
          JSON.stringify(combinedFolderMemberIds) &&
        JSON.stringify(findById(state.splitGroups, splitId)) ===
          JSON.stringify(splitTopologyBeforeFolderDelete);
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  trace("empty and populated folder topology persisted on second launch");

  const secondLightSnapshot = await setAndPersistAppearance(
    secondLaunch.client,
    lightAppearance
  );
  assert.equal(secondLightSnapshot.prefersDark, false);
  assert.equal(secondLightSnapshot.prefersLight, true);
  trace("light appearance persisted on second launch");
  await stopLaunch(secondLaunch);

  const thirdLaunch = await launchBrowser();
  const restoredLightSnapshot = await waitForAppearance(
    thirdLaunch.client,
    lightAppearance
  );
  assert.equal(restoredLightSnapshot.prefersDark, false);
  assert.equal(restoredLightSnapshot.prefersLight, true);
  trace("light appearance restored on third launch");

  const restoredFolderTopology = await waitFor(async () => {
    const state = await getState(thirdLaunch.client);
    const originalFolder = findById(state.folders, folderId);
    const emptyFolder = findById(state.folders, emptyFolderId);
    const combinedFolder = findById(state.folders, combinedFolderId);
    const split = findById(state.splitGroups, splitId);
    return originalFolder?.name === "Restored Folder" &&
      originalFolder?.expanded === true &&
      originalFolder?.tabIds?.length === 0 &&
      emptyFolder?.name === "Restored Empty Folder" &&
      emptyFolder?.expanded === true &&
      emptyFolder?.tabIds?.length === 0 &&
      combinedFolder?.name === "Restored Folder Project" &&
      combinedFolder?.expanded === true &&
      JSON.stringify(combinedFolder.tabIds) ===
        JSON.stringify(combinedFolderMemberIds) &&
      JSON.stringify(split) === JSON.stringify(splitTopologyBeforeFolderDelete) &&
      JSON.stringify(state.tabs.map(tab => ({
        id: tab.id,
        workspaceId: tab.workspaceId,
        url: tab.url,
      }))) === JSON.stringify(tabTopologyBeforeFolderDelete)
      ? state
      : false;
  });
  assert.equal(
    await command(thirdLaunch.client, "folder:delete", { id: folderId }),
    true
  );
  await waitFor(async () => {
    const state = await getState(thirdLaunch.client);
    return !findById(state.folders, folderId) &&
      JSON.stringify(findById(state.folders, combinedFolderId)?.tabIds) ===
        JSON.stringify(combinedFolderMemberIds) &&
      JSON.stringify(findById(state.splitGroups, splitId)) ===
        JSON.stringify(splitTopologyBeforeFolderDelete) &&
      JSON.stringify(state.tabs.map(tab => ({
        id: tab.id,
        workspaceId: tab.workspaceId,
        url: tab.url,
      }))) === JSON.stringify(tabTopologyBeforeFolderDelete);
  });
  await waitFor(async () => {
    try {
      const state = await readPersistedState();
      return !findById(state.folders, folderId) &&
        JSON.stringify(findById(state.folders, combinedFolderId)?.tabIds) ===
          JSON.stringify(combinedFolderMemberIds) &&
        JSON.stringify(findById(state.splitGroups, splitId)) ===
          JSON.stringify(splitTopologyBeforeFolderDelete);
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  assert.ok(restoredFolderTopology);
  trace("empty folder deletion persisted without changing tabs or split topology");

  await setAndPersistAppearance(thirdLaunch.client, systemAppearance);
  trace("system appearance persisted on third launch");
  await stopLaunch(thirdLaunch);

  const fourthLaunch = await launchBrowser();
  const restoredSystemSnapshot = await waitForAppearance(
    fourthLaunch.client,
    systemAppearance
  );
  assert.equal(
    restoredSystemSnapshot.prefersDark,
    initialSystemSnapshot.prefersDark
  );
  assert.equal(
    restoredSystemSnapshot.prefersLight,
    initialSystemSnapshot.prefersLight
  );
  const finalState = await getState(fourthLaunch.client);
  assert.equal(finalState.schemaVersion, 6);
  assert.deepEqual(finalState.settings.appearance, {
    theme: systemAppearance.theme,
    reduceTransparency: systemAppearance.reduceTransparency,
  });
  assert.equal(
    findById(finalState.workspaces, originalWorkspaceId)?.color,
    systemAppearance.workspaceColor
  );
  assert.equal(findById(finalState.folders, folderId), undefined);
  assert.deepEqual(findById(finalState.folders, emptyFolderId), {
    ...findById(expected.folders, emptyFolderId),
    tabIds: [],
  });
  assert.deepEqual(findById(finalState.folders, combinedFolderId), {
    id: combinedFolderId,
    workspaceId: originalWorkspaceId,
    name: "Restored Folder Project",
    tabIds: combinedFolderMemberIds,
    expanded: true,
  });
  assert.deepEqual(
    findById(finalState.splitGroups, splitId),
    splitTopologyBeforeFolderDelete
  );
  assert.deepEqual(
    finalState.tabs.map(tab => ({
      id: tab.id,
      workspaceId: tab.workspaceId,
      url: tab.url,
    })),
    tabTopologyBeforeFolderDelete
  );
  trace("system appearance restored on fourth launch");

  process.stdout.write(`${JSON.stringify({
    sessionRestore: true,
    externalUrlCreatesTab: true,
    restoredWorkspaces: expected.workspaces.length,
    restoredTabs: expected.tabs.length,
    restoredFolders: finalState.folders.length,
    restoredSplits: expected.splitGroups.length,
    restoredEmptyFolder: true,
    restoredFolderMembership: true,
    removedFolderStayedDeleted: true,
    folderDeletePreservedTabAndSplitTopology: true,
    restoredSidebar: true,
    appearanceSchema: 6,
    restoredAppearanceThemes: ["dark", "light", "system"],
    restoredNativeColorScheme: true,
    restoredTransparency: true,
    restoredWorkspaceColors: true,
  })}\n`);
} catch (error) {
  for (const [index, launch] of launches.entries()) {
    if (launch.output.length) {
      process.stderr.write(`Session smoke launch ${index + 1}:\n${launch.output.join("")}\n`);
    }
  }
  throw error;
} finally {
  for (const launch of launches.reverse()) {
    await stopLaunch(launch).catch(() => {});
  }
  if (fixtureServer) {
    await new Promise(resolve => fixtureServer.close(resolve));
  }
  await rm(userData, { recursive: true, force: true });
}
