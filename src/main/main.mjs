import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow, Menu, ipcMain, nativeTheme } from "electron";

import { BrowserController } from "./browser-controller.mjs";
import {
  installInternalProtocol,
  registerInternalScheme,
} from "./internal-pages.mjs";
import { StateStore } from "./state-store.mjs";
import { installProcessOutputGuards } from "./process-output.mjs";
import { channels, commandNames, commands } from "../shared/channels.mjs";
import { menuAcceleratorForAction } from "../shared/shortcut-registry.mjs";

installProcessOutputGuards();

const directory = path.dirname(fileURLToPath(import.meta.url));
const shellDocumentUrl = pathToFileURL(
  path.join(directory, "../renderer/index.html")
).href;
const sidebarOverlayDocumentUrl = `${shellDocumentUrl}?mode=sidebar-overlay`;
const controllers = new Map();
const cleanupPromises = new WeakMap();
const pendingCleanups = new Set();
const windowDragSessions = new Map();
const pendingPageUrls = [];
let pendingPageUrlDrain = Promise.resolve();
let creationPromise = null;
let nextPendingPageUrlId = 0;
let injectWindowCreationFailure =
  process.env.CHROMA_HEADLESS_SMOKE === "1" &&
  process.env.CHROMA_FAIL_WINDOW_CREATION_ONCE === "1";
let quitting = false;

const DARK_WINDOW_BACKGROUND = "#17141d";
const LIGHT_WINDOW_BACKGROUND = "#ece9ef";

function currentWindowBackground() {
  return nativeTheme.shouldUseDarkColors
    ? DARK_WINDOW_BACKGROUND
    : LIGHT_WINDOW_BACKGROUND;
}

function refreshWindowBackgrounds() {
  const background = currentWindowBackground();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(background);
  }
}

function applyWindowAppearance(window, appearance) {
  const theme = ["system", "light", "dark"].includes(appearance?.theme)
    ? appearance.theme
    : "system";
  nativeTheme.themeSource = theme;
  if (!window.isDestroyed()) window.setBackgroundColor(currentWindowBackground());
}

nativeTheme.on("updated", refreshWindowBackgrounds);

function runDetached(operation, context) {
  if (!operation || typeof operation.then !== "function") return;
  void operation.catch(error => {
    if (
      quitting ||
      error?.code === "ERR_ABORTED" ||
      String(error?.message || "").includes("Browser window is closing")
    ) {
      return;
    }
    console.warn(`${context}:`, error);
  });
}

function pageUrlsFromArguments(argumentsList) {
  const urls = [];
  for (const argument of argumentsList) {
    if (typeof argument !== "string") continue;
    try {
      const url = new URL(argument);
      if (url.protocol === "http:" || url.protocol === "https:") {
        urls.push(url.href);
      }
    } catch {
      // Non-URL command-line arguments belong to Electron/Chromium.
    }
  }
  return urls;
}

function enqueuePageUrls(urls) {
  for (const url of urls) {
    pendingPageUrls.push({ id: ++nextPendingPageUrlId, url });
  }
}

enqueuePageUrls(pageUrlsFromArguments(process.argv));

function isPristineStartupState(state) {
  const workspace = state.workspaces?.[0];
  const tab = state.tabs?.[0];
  return (
    state.workspaces?.length === 1 &&
    state.tabs?.length === 1 &&
    state.activeWorkspaceId === workspace?.id &&
    state.activeTabId === tab?.id &&
    workspace?.name === "Personal" &&
    workspace?.icon === "sparkles" &&
    workspace?.color === "#e4a8ff" &&
    tab?.workspaceId === workspace?.id &&
    tab?.url === "chroma://newtab/" &&
    !tab.essential &&
    !tab.pinned &&
    !state.folders?.length &&
    !state.splitGroups?.length &&
    !state.bookmarks?.length &&
    !state.history?.entries?.length &&
    state.settings?.sidebarWidth === 228 &&
    state.settings?.sidebarCollapsed === false &&
    state.settings?.compactMode === false
  );
}

function trackControllerCleanup(controller) {
  const existing = cleanupPromises.get(controller);
  if (existing) return existing;
  const cleanup = controller.destroy().finally(() => pendingCleanups.delete(cleanup));
  cleanupPromises.set(controller, cleanup);
  pendingCleanups.add(cleanup);
  return cleanup;
}

async function waitForPendingCleanups() {
  while (pendingCleanups.size) {
    const results = await Promise.allSettled([...pendingCleanups]);
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("Unable to clean up a browser window:", result.reason);
      }
    }
  }
}

function forgetControllerMappings(contentsIds) {
  for (const contentsId of contentsIds) {
    controllers.delete(contentsId);
    windowDragSessions.delete(contentsId);
  }
  contentsIds.clear();
}

function readyBrowserWindow() {
  return BrowserWindow.getAllWindows().find(window =>
    !window.isDestroyed() && controllers.has(window.webContents.id)
  ) || null;
}

function focusBrowserWindow(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function removePendingPageUrl(entry) {
  if (pendingPageUrls[0]?.id !== entry.id) {
    throw new Error("Pending page URL delivery order changed");
  }
  pendingPageUrls.shift();
}

function drainPendingPageUrls(window) {
  const operation = pendingPageUrlDrain.then(async () => {
    if (!window || window.isDestroyed()) return 0;
    const controller = controllers.get(window.webContents.id);
    if (!controller) return 0;

    let delivered = 0;
    while (pendingPageUrls.length && !window.isDestroyed()) {
      const entry = pendingPageUrls[0];
      await controller.dispatch(commands.createTab, { url: entry.url });
      removePendingPageUrl(entry);
      delivered += 1;
    }
    return delivered;
  });
  pendingPageUrlDrain = operation.catch(() => {});
  return operation;
}

async function delayWindowCreationForSmoke() {
  if (process.env.CHROMA_HEADLESS_SMOKE !== "1") return;
  const requestedDelay = Number(process.env.CHROMA_WINDOW_CREATION_DELAY_MS);
  if (!Number.isFinite(requestedDelay) || requestedDelay <= 0) return;
  const delay = Math.min(5_000, Math.round(requestedDelay));
  console.info(`Chroma smoke: window creation delayed ${delay}ms`);
  await new Promise(resolve => {
    setTimeout(resolve, delay);
  });
}

function failWindowCreationOnceForSmoke() {
  if (!injectWindowCreationFailure) return;
  injectWindowCreationFailure = false;
  throw new Error("Injected window creation failure");
}

registerInternalScheme();
if (process.env.CHROMA_HEADLESS_SMOKE === "1") {
  // Repeated off-screen smoke runs can trip macOS shared-image teardown races;
  // viewport/layout behavior does not depend on GPU acceleration.
  app.disableHardwareAcceleration();
}
app.setName("Chroma");
app.userAgentFallback = app.userAgentFallback.replace(/\sElectron\/[\d.]+/i, "");
if (process.env.CHROMA_CHROMIUM_USER_DATA) {
  app.setPath("userData", path.resolve(process.env.CHROMA_CHROMIUM_USER_DATA));
}

const hasSingleInstanceLock =
  process.env.CHROMA_DISABLE_SINGLE_INSTANCE === "1" || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

function controllerForEvent(event) {
  const frame = event.senderFrame;
  if (
    !frame ||
    frame !== event.sender.mainFrame ||
    (frame.url !== shellDocumentUrl && frame.url !== sidebarOverlayDocumentUrl)
  ) {
    return null;
  }
  const controller = controllers.get(event.sender.id);
  return controller || null;
}

function requireControllerForEvent(event) {
  const controller = controllerForEvent(event);
  if (!controller) throw new Error("Browser window is no longer available");
  return controller;
}

function isSidebarOverlayEvent(event) {
  return event.senderFrame?.url === sidebarOverlayDocumentUrl;
}

ipcMain.handle(channels.getState, event =>
  requireControllerForEvent(event).getPublicState()
);
if (process.env.CHROMA_HEADLESS_SMOKE === "1") {
  ipcMain.handle(channels.smokeViewports, (event, options) =>
    requireControllerForEvent(event).getSmokeViewports(options)
  );
}
ipcMain.handle(channels.invoke, (event, command, payload) => {
  if (!commandNames.has(command)) throw new Error("Browser command is not allowed");
  return requireControllerForEvent(event).dispatch(command, payload);
});
ipcMain.on(channels.layoutChanged, (event, bounds) => {
  controllerForEvent(event)?.setContentBounds(bounds);
});
ipcMain.on(channels.sidebarOverlayChanged, (event, options) => {
  controllerForEvent(event)?.updateSidebarOverlay(options);
});
ipcMain.on(channels.chromeModalChanged, (event, open) => {
  controllerForEvent(event)?.setChromeModalOpen(
    open === true,
    isSidebarOverlayEvent(event)
  );
});
ipcMain.on(channels.tabDragChanged, (event, active) => {
  controllerForEvent(event)?.setTabDragActive(
    active === true,
    isSidebarOverlayEvent(event)
  );
});
ipcMain.on(channels.splitRatioPreview, (event, options) => {
  controllerForEvent(event)?.previewSplitRatio(options);
});
ipcMain.on(channels.windowDragStart, (event, point) => {
  if (!controllerForEvent(event)) return;
  const window = BrowserWindow.fromWebContents(event.sender);
  const screenX = Number(point?.screenX);
  const screenY = Number(point?.screenY);
  if (
    !window ||
    window.isDestroyed() ||
    window.isFullScreen() ||
    !Number.isFinite(screenX) ||
    !Number.isFinite(screenY)
  ) {
    return;
  }
  const [windowX, windowY] = window.getPosition();
  windowDragSessions.set(event.sender.id, { window, screenX, screenY, windowX, windowY });
});
ipcMain.on(channels.windowDragMove, (event, point) => {
  if (!controllerForEvent(event)) return;
  const drag = windowDragSessions.get(event.sender.id);
  const screenX = Number(point?.screenX);
  const screenY = Number(point?.screenY);
  if (
    !drag ||
    drag.window.isDestroyed() ||
    !Number.isFinite(screenX) ||
    !Number.isFinite(screenY)
  ) {
    return;
  }
  const deltaX = Math.max(-10_000, Math.min(10_000, screenX - drag.screenX));
  const deltaY = Math.max(-10_000, Math.min(10_000, screenY - drag.screenY));
  drag.window.setPosition(
    Math.round(drag.windowX + deltaX),
    Math.round(drag.windowY + deltaY),
    false
  );
});
ipcMain.on(channels.windowDragEnd, event => {
  if (controllerForEvent(event)) windowDragSessions.delete(event.sender.id);
});
ipcMain.on(channels.windowControl, (event, action) => {
  controllerForEvent(event)?.windowControl(action);
});
ipcMain.on(channels.openCommandPalette, event => {
  controllerForEvent(event)?.openCommandPalette();
});

function installApplicationMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Tab",
          accelerator: menuAcceleratorForAction("tab:create", process.platform),
          registerAccelerator: false,
          click: (_item, window) => runDetached(
            controllers.get(window?.webContents.id)?.dispatch(commands.createTab),
            "Unable to create tab from application menu"
          ),
        },
        {
          label: "Reopen Closed Tab",
          accelerator: menuAcceleratorForAction("tab:reopen", process.platform),
          registerAccelerator: false,
          click: (_item, window) => runDetached(
            controllers.get(window?.webContents.id)?.dispatch(commands.reopenTab),
            "Unable to reopen tab from application menu"
          ),
        },
        { type: "separator" },
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    {
      label: "View",
      submenu: [
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "Toggle Sidebar",
          accelerator: menuAcceleratorForAction("sidebar:toggle", process.platform),
          registerAccelerator: false,
          click: (_item, window) => runDetached(
            controllers.get(window?.webContents.id)?.dispatch(commands.toggleSidebar),
            "Unable to toggle sidebar from application menu"
          ),
        },
        {
          label: "Developer Tools",
          accelerator: menuAcceleratorForAction(
            "developer:open-tools",
            process.platform
          ),
          registerAccelerator: false,
          click: (_item, window) => runDetached(
            controllers.get(window?.webContents.id)?.dispatch(commands.openDevTools),
            "Unable to open developer tools from application menu"
          ),
        },
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, ...(process.platform === "darwin" ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createBrowserWindowOnce() {
  await waitForPendingCleanups();
  if (quitting) return null;
  const platformOptions =
    process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 13, y: 14 },
          vibrancy: "under-window",
          visualEffectState: "active",
        }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden",
            titleBarOverlay: { color: "#00000000", symbolColor: "#f4eff8", height: 38 },
            backgroundMaterial: "mica",
          }
        : { titleBarStyle: "hidden" };

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: DARK_WINDOW_BACKGROUND,
    autoHideMenuBar: true,
    ...platformOptions,
    webPreferences: {
      preload: path.join(directory, "../preload/shell-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const shellWebContentsIds = new Set();
  let controller = null;
  let completed = false;

  try {
    if (process.platform === "darwin") {
      window.setWindowButtonVisibility(false);
    }
    await delayWindowCreationForSmoke();

    const store = new StateStore(path.join(app.getPath("userData"), "browser-state.json"));
    const state = await store.load();
    if (quitting || window.isDestroyed()) return null;
    const reusablePageUrl = isPristineStartupState(state)
      ? pendingPageUrls[0] || null
      : null;

    controller = new BrowserController(window, state, store, {
      registerShellWebContents(contents) {
        shellWebContentsIds.add(contents.id);
        controllers.set(contents.id, controller);
      },
      unregisterShellWebContents(contentsId) {
        shellWebContentsIds.delete(contentsId);
        controllers.delete(contentsId);
        windowDragSessions.delete(contentsId);
      },
      applyAppearance(appearance) {
        applyWindowAppearance(window, appearance);
      },
    });
    // Cache this while the BrowserWindow is alive. Electron invalidates the
    // webContents accessor before emitting `closed`.
    const windowWebContentsId = window.webContents.id;
    shellWebContentsIds.add(windowWebContentsId);
    controllers.set(windowWebContentsId, controller);

    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.webContents.on("preload-error", (_event, preloadPath, error) => {
      console.error(`Shell preload failed (${preloadPath}):`, error);
    });
    window.webContents.on("console-message", event => {
      if (event?.level === "error") console.error("Shell renderer:", event.message);
    });
    window.webContents.on("did-finish-load", () => {
      if (!window.isDestroyed()) {
        window.webContents.send("chroma:state-changed", controller.getPublicState());
      }
    });

    window.on("closed", () => {
      forgetControllerMappings(shellWebContentsIds);
      void trackControllerCleanup(controller).catch(error => {
        console.warn("Unable to clean up closed browser window:", error);
      });
    });

    await controller.initialize();
    if (quitting || window.isDestroyed()) return null;
    failWindowCreationOnceForSmoke();

    if (reusablePageUrl && pendingPageUrls[0]?.id === reusablePageUrl.id) {
      const navigated = await controller.dispatch(commands.navigate, {
        id: state.activeTabId,
        input: reusablePageUrl.url,
      });
      if (!navigated) throw new Error("Unable to open the startup page");
      removePendingPageUrl(reusablePageUrl);
    }
    await drainPendingPageUrls(window);
    if (quitting || window.isDestroyed()) return null;

    await window.loadFile(path.join(directory, "../renderer/index.html"));
    if (quitting || window.isDestroyed()) return null;
    if (process.env.CHROMA_HEADLESS_SMOKE === "1") {
      // Keep a real compositor surface for viewport/resize tests without flashing
      // the smoke-test window on the user's desktop. Transparent windows can be
      // treated as occluded and lose Chromium compositor surfaces on macOS, so
      // keep the test window opaque and place it well outside the visible screen.
      window.setSkipTaskbar(true);
      window.setPosition(-10_000, -10_000, false);
      window.showInactive();
    } else {
      window.show();
    }
    completed = true;
    return window;
  } finally {
    if (!completed) {
      forgetControllerMappings(shellWebContentsIds);
      if (controller) {
        await trackControllerCleanup(controller).catch(error => {
          console.warn("Unable to clean up failed browser window:", error);
        });
      }
      if (!window.isDestroyed()) window.destroy();
    }
  }
}

async function createBrowserWindow({ focus = false } = {}) {
  if (quitting) return null;

  let window;
  if (creationPromise) {
    window = await creationPromise;
  } else {
    window = readyBrowserWindow();
    if (!window) {
      const attempt = createBrowserWindowOnce();
      const trackedAttempt = attempt.finally(() => {
        if (creationPromise === trackedAttempt) creationPromise = null;
      });
      creationPromise = trackedAttempt;
      window = await trackedAttempt;
    }
  }

  if (!window || window.isDestroyed()) return null;
  await drainPendingPageUrls(window);
  if (focus) focusBrowserWindow(window);
  return window;
}

if (hasSingleInstanceLock) {
  app.whenReady()
    .then(async () => {
      installInternalProtocol();
      installApplicationMenu();
      nativeTheme.themeSource = "system";
      await createBrowserWindow();
    })
    .catch(error => {
      if (!quitting) console.error("Unable to create browser window:", error);
    });

  app.on("second-instance", (_event, commandLine) => {
    enqueuePageUrls(pageUrlsFromArguments(commandLine));
    void createBrowserWindow({ focus: true }).catch(error => {
      if (!quitting) console.error("Unable to open browser window:", error);
    });
  });

  app.on("activate", () => {
    void createBrowserWindow({ focus: true }).catch(error => {
      if (!quitting) console.error("Unable to reactivate browser window:", error);
    });
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    const requestedUrls = pageUrlsFromArguments([url]);
    if (!requestedUrls.length) return;
    enqueuePageUrls(requestedUrls);
    if (!app.isReady()) return;
    void createBrowserWindow({ focus: true }).catch(error => {
      if (!quitting) console.error("Unable to open URL in browser window:", error);
    });
  });

  app.on("before-quit", event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    for (const controller of controllers.values()) trackControllerCleanup(controller);
    void waitForPendingCleanups()
      .finally(() => app.quit());
  });

  app.on("window-all-closed", () => {
    if (
      process.platform !== "darwin" &&
      !creationPromise &&
      !pendingPageUrls.length
    ) {
      app.quit();
    }
  });
}
