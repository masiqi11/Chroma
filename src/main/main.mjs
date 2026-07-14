import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow, Menu, ipcMain, nativeTheme } from "electron";

import { BrowserController } from "./browser-controller.mjs";
import {
  installInternalProtocol,
  registerInternalScheme,
} from "./internal-pages.mjs";
import { StateStore } from "./state-store.mjs";
import { channels, commandNames, commands } from "../shared/channels.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const shellDocumentUrl = pathToFileURL(
  path.join(directory, "../renderer/index.html")
).href;
const sidebarOverlayDocumentUrl = `${shellDocumentUrl}?mode=sidebar-overlay`;
const controllers = new Map();
const cleanupPromises = new WeakMap();
const pendingCleanups = new Set();
const windowDragSessions = new Map();
let quitting = false;

function pageUrlFromArguments(argumentsList) {
  for (const argument of argumentsList) {
    if (typeof argument !== "string") continue;
    try {
      const url = new URL(argument);
      if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch {
      // Non-URL command-line arguments belong to Electron/Chromium.
    }
  }
  return null;
}

let pendingPageUrl = pageUrlFromArguments(process.argv);

function consumePendingPageUrl() {
  const url = pendingPageUrl;
  pendingPageUrl = null;
  return url;
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
  if (!pendingCleanups.size) return;
  const results = await Promise.allSettled([...pendingCleanups]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("Unable to clean up a browser window:", result.reason);
    }
  }
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
  ipcMain.handle(channels.smokeViewports, event =>
    requireControllerForEvent(event).getSmokeViewports()
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
          accelerator: "CmdOrCtrl+T",
          click: (_item, window) => void controllers.get(window?.webContents.id)?.dispatch(commands.createTab),
        },
        {
          label: "Reopen Closed Tab",
          accelerator: "CmdOrCtrl+Shift+T",
          click: (_item, window) => void controllers.get(window?.webContents.id)?.dispatch(commands.reopenTab),
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
          accelerator: "CmdOrCtrl+Shift+S",
          click: (_item, window) => void controllers.get(window?.webContents.id)?.dispatch(commands.toggleSidebar),
        },
        {
          label: "Developer Tools",
          accelerator: process.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
          click: (_item, window) => void controllers.get(window?.webContents.id)?.dispatch(commands.openDevTools),
        },
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, ...(process.platform === "darwin" ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createBrowserWindow(startupPageUrl = consumePendingPageUrl()) {
  await waitForPendingCleanups();
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
    backgroundColor: "#17141d",
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
  if (process.platform === "darwin") {
    window.setWindowButtonVisibility(false);
  }

  const store = new StateStore(path.join(app.getPath("userData"), "browser-state.json"));
  const state = await store.load();
  if (quitting || window.isDestroyed()) {
    if (!window.isDestroyed()) window.destroy();
    return null;
  }
  if (startupPageUrl) {
    const startupTab = state.tabs.find(tab => tab.id === state.activeTabId);
    if (startupTab) {
      startupTab.url = startupPageUrl;
      startupTab.title = "Loading…";
      startupTab.loading = true;
    }
  }
  const shellWebContentsIds = new Set();
  let controller;
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
    window.webContents.send("chroma:state-changed", controller.getPublicState());
  });

  window.on("closed", () => {
    for (const contentsId of shellWebContentsIds) {
      controllers.delete(contentsId);
      windowDragSessions.delete(contentsId);
    }
    shellWebContentsIds.clear();
    void trackControllerCleanup(controller).catch(error => {
      console.warn("Unable to clean up closed browser window:", error);
    });
  });

  await controller.initialize();
  if (quitting || window.isDestroyed()) return null;
  await window.loadFile(path.join(directory, "../renderer/index.html"));
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
    const requestedUrl = pageUrlFromArguments(commandLine);
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) {
      void createBrowserWindow(requestedUrl).catch(error => {
        if (!quitting) console.error("Unable to open browser window:", error);
      });
      return;
    }
    if (requestedUrl && !window.isDestroyed()) {
      void controllers
        .get(window.webContents.id)
        ?.dispatch(commands.createTab, { url: requestedUrl });
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) {
      void createBrowserWindow().catch(error => {
        if (!quitting) console.error("Unable to reactivate browser window:", error);
      });
    }
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    const requestedUrl = pageUrlFromArguments([url]);
    if (!requestedUrl) return;
    const window = BrowserWindow.getAllWindows()[0];
    if (!app.isReady() || !window) {
      pendingPageUrl = requestedUrl;
      if (app.isReady()) {
        void createBrowserWindow().catch(error => {
          if (!quitting) console.error("Unable to open URL in browser window:", error);
        });
      }
      return;
    }
    void controllers
      .get(window.webContents.id)
      ?.dispatch(commands.createTab, { url: requestedUrl });
    window.show();
    window.focus();
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
    if (process.platform !== "darwin") app.quit();
  });
}
