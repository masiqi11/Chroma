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
}

const sharedSession = new MockSession();

class MockWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = nextContentsId++;
    this.session = sharedSession;
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
    this.windowOpenHandler = null;
    this.beforeClose = null;
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
    return 1;
  }

  loadURL(url) {
    this.url = url;
    return Promise.resolve();
  }

  executeJavaScript() {
    return Promise.resolve({});
  }

  focus() {}

  stop() {}

  reload() {}

  inspectElement() {}

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
  constructor() {
    this.webContents = new MockWebContents();
    this.visible = false;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };
    electronMock.views.push(this);
    electronMock.contents.push(this.webContents);
    setImmediate(() => {
      if (!this.webContents.isDestroyed()) this.webContents.emit("dom-ready");
    });
  }

  setVisible(value) {
    this.visible = Boolean(value);
  }

  getVisible() {
    return this.visible;
  }

  setBounds(bounds) {
    this.bounds = { ...bounds };
  }

  getBounds() {
    return { ...this.bounds };
  }

  setBorderRadius() {}
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

export const electronMock = {
  views: [],
  contents: [],
  reset() {
    this.views.length = 0;
    this.contents.length = 0;
    nextContentsId = 1;
  },
};

export const Menu = {
  buildFromTemplate: () => ({ popup: () => {} }),
};
export const clipboard = { writeText: () => {} };
export const dialog = {
  showMessageBox: async () => ({ response: 1 }),
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
