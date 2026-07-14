const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  getState: "chroma:get-state",
  smokeViewports: "chroma:smoke-viewports",
  stateChanged: "chroma:state-changed",
  layoutChanged: "chroma:layout-changed",
  sidebarOverlayChanged: "chroma:sidebar-overlay-changed",
  chromeModalChanged: "chroma:chrome-modal-changed",
  tabDragChanged: "chroma:tab-drag-changed",
  windowDragStart: "chroma:window-drag-start",
  windowDragMove: "chroma:window-drag-move",
  windowDragEnd: "chroma:window-drag-end",
  windowControl: "chroma:window-control",
  invoke: "chroma:invoke",
});

const commandNames = new Set([
  "tab:create",
  "tab:select",
  "tab:close",
  "tab:reopen",
  "tab:reorder",
  "navigation:go",
  "navigation:back",
  "navigation:forward",
  "navigation:reload",
  "navigation:stop",
  "tab:toggle-mute",
  "tab:toggle-essential",
  "workspace:create",
  "workspace:select",
  "workspace:rename",
  "split:active",
  "split:tabs",
  "split:detach",
  "split:remove",
  "folder:create",
  "folder:toggle",
  "sidebar:toggle",
  "sidebar:set-width",
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
    getSmokeViewports: () => ipcRenderer.invoke(channels.smokeViewports),
    command: (name, payload = {}) => {
      if (!commandNames.has(name)) {
        return Promise.reject(new Error(`Unknown browser command: ${name}`));
      }
      return ipcRenderer.invoke(channels.invoke, name, clonePayload(payload));
    },
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
  })
);
