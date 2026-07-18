import { EventEmitter } from "node:events";

let nextContentsId = 1;

class MockProtocol {
  #handled = new Set();

  isProtocolHandled(scheme) {
    return this.#handled.has(scheme);
  }

  handle(scheme) {
    this.#handled.add(scheme);
  }
}

class MockSession extends EventEmitter {
  protocol = new MockProtocol();
  #userAgent = "MockBrowser/1.0 Electron/43.1.0";

  constructor(partition = "") {
    super();
    this.partition = partition;
    this.clearStorageDataCalls = 0;
    const loadedExtensions = new Map();
    let nextExtensionId = 1;
    this.extensions = {
      loaded: loadedExtensions,
      failNextLoad: null,
      loadExtension: async directory => {
        if (this.extensions.failNextLoad) {
          const failure = this.extensions.failNextLoad;
          this.extensions.failNextLoad = null;
          throw new Error(failure);
        }
        const extension = {
          id: `mock-extension-${nextExtensionId++}`,
          name: `Mock Extension ${nextExtensionId - 1}`,
          version: "1.0.0",
          path: directory,
        };
        loadedExtensions.set(extension.id, extension);
        return extension;
      },
      removeExtension: id => {
        loadedExtensions.delete(id);
      },
      getAllExtensions: () => [...loadedExtensions.values()],
    };
  }

  getUserAgent() {
    return this.#userAgent;
  }

  setUserAgent(value) {
    this.#userAgent = value;
  }

  setPermissionRequestHandler(handler) {
    this.permissionRequestHandler = handler;
  }

  setPermissionCheckHandler(handler) {
    this.permissionCheckHandler = handler;
  }

  setDevicePermissionHandler(handler) {
    this.devicePermissionHandler = handler;
  }

  async clearStorageData() {
    this.clearStorageDataCalls += 1;
  }

  async setProxy(config) {
    this.proxyCalls ??= [];
    this.proxyCalls.push(structuredClone(config));
  }

  async clearCache() {}
}

const sessionsByPartition = new Map();

function sessionForPartition(partition = "") {
  let candidate = sessionsByPartition.get(partition);
  if (!candidate) {
    candidate = new MockSession(partition);
    sessionsByPartition.set(partition, candidate);
  }
  return candidate;
}

class MockWebContents extends EventEmitter {
  constructor(partition = "") {
    super();
    this.id = nextContentsId++;
    this.session = sessionForPartition(partition);
    this.navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => {},
      goForward: () => {},
    };
    this.destroyed = false;
    this.url = "about:blank";
    this.title = "";
    this.userAgentCalls = [];
    this.sent = [];
    this.audioMuted = false;
    this.reloadCalls = 0;
    this.reloadIgnoringCacheCalls = 0;
    this.zoomFactor = 1;
    this.devToolsCalls = 0;
    this.windowOpenHandler = null;
    this.beforeClose = null;
    this.executeJavaScriptCalls = [];
    this.executeJavaScriptResult = {};
  }

  isDestroyed() {
    return this.destroyed;
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }

  setUserAgent(value) {
    this.userAgentCalls.push(value);
  }

  setAudioMuted(value) {
    this.audioMuted = Boolean(value);
  }

  isAudioMuted() {
    return this.audioMuted;
  }

  getURL() {
    return this.url;
  }

  getTitle() {
    return this.title;
  }

  getZoomFactor() {
    return this.zoomFactor;
  }

  setZoomFactor(value) {
    this.zoomFactor = value;
  }

  loadURL(url) {
    this.url = url;
    return Promise.resolve();
  }

  executeJavaScript(code, userGesture = false) {
    this.executeJavaScriptCalls.push({ code, userGesture });
    if (this.executeJavaScriptResult instanceof Error) {
      return Promise.reject(this.executeJavaScriptResult);
    }
    return Promise.resolve(this.executeJavaScriptResult);
  }

  focus() {}

  stop() {}

  reload() {
    this.reloadCalls += 1;
  }

  reloadIgnoringCache() {
    this.reloadIgnoringCacheCalls += 1;
  }

  inspectElement() {}

  openDevTools() {
    this.devToolsCalls += 1;
  }

  send(channel, payload) {
    this.sent.push({ channel, payload });
  }

  close() {
    if (this.destroyed) return;
    this.beforeClose?.();
    this.destroyed = true;
    this.emit("destroyed");
  }
}

export class WebContentsView {
  constructor(options = {}) {
    this.partition = options?.webPreferences?.partition || "";
    this._webContents = new MockWebContents(this.partition);
    this.throwOnWebContentsAccess = false;
    this.throwOnNativeAccess = false;
    this.visible = false;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };
    electronMock.views.push(this);
    electronMock.contents.push(this._webContents);
    setImmediate(() => {
      if (!this._webContents.isDestroyed()) this._webContents.emit("dom-ready");
    });
  }

  get webContents() {
    if (this.throwOnWebContentsAccess) {
      throw new TypeError("Object has been destroyed");
    }
    return this._webContents;
  }

  get unsafeWebContents() {
    return this._webContents;
  }

  assertNativeUsable() {
    if (this.throwOnNativeAccess) {
      throw new TypeError("Object has been destroyed");
    }
  }

  setVisible(value) {
    this.assertNativeUsable();
    this.visible = Boolean(value);
  }

  getVisible() {
    this.assertNativeUsable();
    return this.visible;
  }

  setBounds(bounds) {
    this.assertNativeUsable();
    this.bounds = { ...bounds };
  }

  getBounds() {
    this.assertNativeUsable();
    return { ...this.bounds };
  }

  setBorderRadius() {}

  setBackgroundColor() {}
}

export class MockBrowserWindow {
  constructor() {
    this.destroyed = false;
    this.shellContents = new MockWebContents();
    this.contentView = {
      children: [],
      addChildView: view => {
        if (!this.contentView.children.includes(view)) {
          this.contentView.children.push(view);
        }
      },
      removeChildView: view => {
        this.contentView.children = this.contentView.children.filter(
          candidate => candidate !== view
        );
      },
    };
  }

  get webContents() {
    return this.shellContents;
  }

  isDestroyed() {
    return this.destroyed;
  }

  getContentBounds() {
    return { x: 0, y: 0, width: 1200, height: 800 };
  }

  getBounds() {
    return this.getContentBounds();
  }
}

const registeredGlobalShortcuts = new Map();

export const electronMock = {
  views: [],
  contents: [],
  sessions: sessionsByPartition,
  globalShortcuts: registeredGlobalShortcuts,
  triggerGlobalShortcut(accelerator) {
    registeredGlobalShortcuts.get(accelerator)?.();
  },
  reset() {
    this.views.length = 0;
    this.contents.length = 0;
    sessionsByPartition.clear();
    registeredGlobalShortcuts.clear();
    nextContentsId = 1;
  },
};

export const globalShortcut = {
  register(accelerator, callback) {
    registeredGlobalShortcuts.set(accelerator, callback);
    return true;
  },
  unregister(accelerator) {
    registeredGlobalShortcuts.delete(accelerator);
  },
  isRegistered(accelerator) {
    return registeredGlobalShortcuts.has(accelerator);
  },
};

export const session = {
  fromPartition: partition => sessionForPartition(partition),
};

export const Menu = {
  buildFromTemplate: () => ({ popup: () => {} }),
};
export const clipboard = { writeText: () => {} };
export const dialog = {
  showMessageBox: async () => ({ response: 1 }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: "" }),
};
export const shell = {
  openExternal: async () => {},
  openPath: async () => "",
  showItemInFolder: () => {},
};
export const screen = {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
};
export const webContents = {
  getAllWebContents: () => electronMock.contents,
};
export const protocol = {
  registerSchemesAsPrivileged: () => {},
};
