const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  getState: "chroma:get-state",
  smokeViewports: "chroma:smoke-viewports",
  stateChanged: "chroma:state-changed",
  layoutChanged: "chroma:layout-changed",
  sidebarOverlayChanged: "chroma:sidebar-overlay-changed",
  chromeModalChanged: "chroma:chrome-modal-changed",
  tabDragChanged: "chroma:tab-drag-changed",
  splitRatioPreview: "chroma:split-ratio-preview",
  windowDragStart: "chroma:window-drag-start",
  windowDragMove: "chroma:window-drag-move",
  windowDragEnd: "chroma:window-drag-end",
  windowControl: "chroma:window-control",
  openHistory: "chroma:open-history",
  openDownloads: "chroma:open-downloads",
  openCommandPalette: "chroma:open-command-palette",
  invoke: "chroma:invoke",
});

const commandNames = new Set([
  "tab:create",
  "tab:select",
  "tab:close",
  "tab:recover",
  "tab:discard",
  "tab:reopen",
  "tab:reorder",
  "navigation:go",
  "navigation:back",
  "navigation:forward",
  "navigation:reload",
  "navigation:reload-ignore-cache",
  "navigation:stop",
  "tab:toggle-mute",
  "media:toggle-playback",
  "media:toggle-pip",
  "media:now-playing",
  "tab:toggle-pin",
  "tab:toggle-essential",
  "essential:reset",
  "tab:set-ua-mode",
  "bookmark:toggle",
  "tab:select-next",
  "tab:select-previous",
  "bookmark:remove",
  "bookmark:rename",
  "bookmark:move",
  "bookmark:import",
  "bookmark:export",
  "bookmarkFolder:create",
  "bookmarkFolder:toggle",
  "bookmarkFolder:rename",
  "bookmarkFolder:delete",
  "bookmarkFolder:move",
  "liveFolder:create",
  "liveFolder:toggle",
  "liveFolder:rename",
  "liveFolder:delete",
  "liveFolder:refresh",
  "history:query",
  "history:suggest",
  "history:remove",
  "history:clear",
  "history:set-preferences",
  "history:open",
  "download:pause",
  "download:resume",
  "download:cancel",
  "download:open",
  "download:reveal",
  "download:remove",
  "download:clear-finished",
  "workspace:create",
  "workspace:select",
  "workspace:rename",
  "workspace:delete",
  "workspace:reorder",
  "tab:move-to-workspace",
  "workspace:next",
  "workspace:previous",
  "split:active",
  "split:tabs",
  "split:detach",
  "split:remove",
  "split:set-ratio",
  "split:set-preset",
  "folder:create",
  "folder:toggle",
  "folder:rename",
  "folder:delete",
  "container:create",
  "container:rename",
  "container:delete",
  "container:set-color",
  "container:set-proxy",
  "container:set-ua",
  "container:reopen-tab",
  "site:clear-data",
  "auth:submit",
  "auth:cancel",
  "glance:open",
  "glance:close",
  "glance:promote",
  "extension:open-popup",
  "extension:close-popup",
  "extension:install",
  "extension:remove",
  "extension:reload",
  "sidebar:toggle",
  "sidebar:set-width",
  "settings:set-appearance",
  "page:zoom-in",
  "page:zoom-out",
  "page:zoom-reset",
  "downloads:open",
  "developer:open-tools",
]);

function clonePayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  return structuredClone(payload);
}

contextBridge.exposeInMainWorld(
  "chromaBrowser",
  Object.freeze({
    getState: () => ipcRenderer.invoke(channels.getState),
    getSmokeViewports: options => ipcRenderer.invoke(channels.smokeViewports, {
      forceCrashTabId: typeof options?.forceCrashTabId === "string"
        ? options.forceCrashTabId.slice(0, 199)
        : null,
    }),
    command: (name, payload = {}) => {
      if (!commandNames.has(name)) {
        return Promise.reject(new Error(`Unknown browser command: ${name}`));
      }
      return ipcRenderer.invoke(channels.invoke, name, clonePayload(payload));
    },
    requestOpenHistory: () =>
      ipcRenderer.invoke(channels.invoke, "history:open", {}),
    requestOpenCommandPalette: () =>
      ipcRenderer.send(channels.openCommandPalette),
    setContentBounds: bounds => {
      const safeBounds = {
        x: Number(bounds?.x) || 0,
        y: Number(bounds?.y) || 0,
        width: Number(bounds?.width) || 1,
        height: Number(bounds?.height) || 1,
      };
      ipcRenderer.send(channels.layoutChanged, safeBounds);
    },
    updateSidebarOverlay: options => {
      const bounds = options?.bounds && typeof options.bounds === "object"
        ? {
            x: Number(options.bounds.x) || 0,
            y: Number(options.bounds.y) || 0,
            width: Number(options.bounds.width) || 1,
            height: Number(options.bounds.height) || 1,
          }
        : undefined;
      ipcRenderer.send(channels.sidebarOverlayChanged, {
        ...(typeof options?.open === "boolean" ? { open: options.open } : {}),
        ...(bounds ? { bounds } : {}),
        focusAddress: options?.focusAddress === true,
        ...(typeof options?.keepOpen === "boolean"
          ? { keepOpen: options.keepOpen }
          : {}),
      });
    },
    setChromeModalOpen: open => {
      ipcRenderer.send(channels.chromeModalChanged, open === true);
    },
    setTabDragActive: active => {
      ipcRenderer.send(channels.tabDragChanged, active === true);
    },
    previewSplitRatio: options => {
      const groupId = typeof options?.groupId === "string"
        ? options.groupId.slice(0, 200)
        : "";
      const pathCandidate = Array.isArray(options?.path) ? options.path : null;
      const path = pathCandidate &&
        pathCandidate.length <= 8 &&
        pathCandidate.every(part => part === "first" || part === "second")
        ? [...pathCandidate]
        : null;
      const ratio = options?.ratio;
      ipcRenderer.send(channels.splitRatioPreview, {
        groupId,
        ...(path ? { path } : {}),
        ...(typeof ratio === "number" && Number.isFinite(ratio) ? { ratio } : {}),
        cancel: options?.cancel === true,
      });
    },
    startWindowDrag: point => {
      ipcRenderer.send(channels.windowDragStart, {
        screenX: Number(point?.screenX) || 0,
        screenY: Number(point?.screenY) || 0,
      });
    },
    updateWindowDrag: point => {
      ipcRenderer.send(channels.windowDragMove, {
        screenX: Number(point?.screenX) || 0,
        screenY: Number(point?.screenY) || 0,
      });
    },
    endWindowDrag: () => {
      ipcRenderer.send(channels.windowDragEnd);
    },
    windowControl: action => {
      if (!["close", "minimize", "maximize"].includes(action)) return;
      ipcRenderer.send(channels.windowControl, action);
    },
    onStateChanged: listener => {
      if (typeof listener !== "function") return () => {};
      const handler = (_event, state) => listener(state);
      ipcRenderer.on(channels.stateChanged, handler);
      return () => ipcRenderer.removeListener(channels.stateChanged, handler);
    },
    onFocusAddress: listener => {
      if (typeof listener !== "function") return () => {};
      const handler = () => listener();
      ipcRenderer.on("chroma:focus-address", handler);
      return () => ipcRenderer.removeListener("chroma:focus-address", handler);
    },
    onOpenHistory: listener => {
      if (typeof listener !== "function") return () => {};
      const handler = () => listener();
      ipcRenderer.on(channels.openHistory, handler);
      return () => ipcRenderer.removeListener(channels.openHistory, handler);
    },
    onOpenDownloads: listener => {
      if (typeof listener !== "function") return () => {};
      const handler = () => listener();
      ipcRenderer.on(channels.openDownloads, handler);
      return () => ipcRenderer.removeListener(channels.openDownloads, handler);
    },
    onOpenCommandPalette: listener => {
      if (typeof listener !== "function") return () => {};
      const handler = () => listener();
      ipcRenderer.on(channels.openCommandPalette, handler);
      return () => ipcRenderer.removeListener(channels.openCommandPalette, handler);
    },
  })
);
