import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const userData = await mkdtemp(path.join(os.tmpdir(), "chroma-smoke-"));
const port = 9300 + Math.floor(Math.random() * 300);
const output = [];
let child;
let report;
let testServer;
let overlayClient;
const adaptiveRequests = new Map();
let explicitHangRequests = 0;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
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

async function targets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`DevTools endpoint returned ${response.status}`);
  return response.json();
}

async function waitForTabViewport(client, id, url) {
  let lastState;
  let lastViewports;
  return waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    lastState = state;
    const tab = state.tabs.find(candidate => candidate.id === id);
    if (!tab || tab.url !== url) return false;
    const viewports = await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    );
    lastViewports = viewports;
    const viewport = viewports[id];
    return viewport?.url === url && viewport.width > 0 && viewport.height > 0
      ? viewport
      : false;
  }).catch(error => {
    throw new Error(
      `${error.message}; tab=${JSON.stringify(lastState?.tabs?.find(tab => tab.id === id) || null)}; viewport=${JSON.stringify(lastViewports?.[id] || null)}; runtime=${JSON.stringify(lastState?.runtime || null)}`,
      { cause: error }
    );
  });
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
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
    this.#socket.onclose = () => {
      const error = new Error("DevTools connection closed");
      for (const pending of this.#pending.values()) pending.reject(error);
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
    const promise = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || "Renderer evaluation failed");
    }
    return result.result.value;
  }

  async close() {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve =>
      this.#socket.addEventListener("close", resolve, { once: true })
    );
    this.#socket.close();
    await Promise.race([closed, delay(1_000)]);
  }
}

try {
  testServer = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; frame-src 'self'"
    );
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (request.url === "/slow") {
      response.write("<!doctype html><title>Slow page</title><h1>Still loading</h1>");
      return;
    }
    if (request.url === "/explicit-hang") {
      explicitHangRequests += 1;
      return;
    }
    if (request.url === "/isolation") {
      response.end(`<!doctype html><title>Isolation pending</title><script>
        document.title = [
          "isolation",
          typeof process,
          typeof require,
          navigator.userAgent.includes("Electron/")
        ].join(":");
      </script>`);
      return;
    }
    if (request.url === "/parent") {
      response.end('<!doctype html><title>Parent page</title><iframe src="/child"></iframe>');
      return;
    }
    if (request.url === "/child") {
      response.end(`<!doctype html><title>Child frame</title><script>
        history.pushState({}, "", "/child#spoofed-address");
      </script>`);
      return;
    }
    if (requestUrl.pathname === "/adaptive-responsive") {
      const mobile = /\bMobile\b/i.test(
        String(request.headers["user-agent"] || "")
      );
      const mode = mobile ? "mobile" : "desktop";
      const pane = requestUrl.searchParams.get("pane");
      const requests = adaptiveRequests.get(pane) || [];
      requests.push(mode);
      adaptiveRequests.set(pane, requests);
      response.setHeader("Vary", "User-Agent");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'"
      );
      const adaptiveDocument = `<!doctype html>
        <html data-chroma-smoke-layout="${mode}">
          <head>
            ${mobile
              ? '<meta name="viewport" content="width=device-width, initial-scale=1">'
              : ""}
            <title>Adaptive ${mode} ${pane}</title>
            <style>
              html, body { margin: 0; }
              body { font: 18px/1.5 system-ui, sans-serif; }
              ${mobile
                ? `html, body { min-width: 0; max-width: 100%; }
                   main { box-sizing: border-box; width: 100%; padding: 24px;
                          overflow-wrap: anywhere; }`
                : `html, body, main { min-width: 1400px; }
                   main { width: 1400px; }`}
            </style>
          </head>
          <body><main>Adaptive ${mode} content</main></body>
        </html>`;
      if (["pending-target", "pending-nav-target"].includes(pane) && mobile) {
        setTimeout(() => {
          if (!response.destroyed) response.end(adaptiveDocument);
        }, 600);
        return;
      }
      if (pane === "stop-target" && mobile) {
        // Keep the navigation provisional until the test invokes Stop. The
        // client abort closes this response, so it cannot hold server teardown.
        return;
      }
      response.end(adaptiveDocument);
      return;
    }
    if (request.url?.startsWith("/responsive")) {
      const pane = requestUrl.searchParams.get("pane");
      response.end(`<!doctype html><meta name="viewport" content="width=device-width">
        <title>Responsive pane ${pane}</title><script>
        globalThis.__chromaSmokeResizeCount = 0;
        addEventListener("resize", () => { globalThis.__chromaSmokeResizeCount += 1; });
      </script>`);
      return;
    }
    response.end("<!doctype html><title>Example Domain</title><h1>Example Domain</h1>");
  });
  testServer.listen(0, "127.0.0.1");
  await once(testServer, "listening");
  const baseUrl = `http://127.0.0.1:${testServer.address().port}`;

  child = spawn(electronPath, ["--no-error-dialogs", `--remote-debugging-port=${port}`, "."], {
    cwd: root,
    env: {
      ...process.env,
      CHROMA_CHROMIUM_USER_DATA: userData,
      CHROMA_DISABLE_SINGLE_INSTANCE: "1",
      CHROMA_HEADLESS_SMOKE: "1",
      CHROMA_SEARCH_URL: `${baseUrl}/search`,
      ELECTRON_ENABLE_LOGGING: "1",
      ELECTRON_ENABLE_STACK_DUMPING: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => output.push(String(chunk)));
  child.stderr.on("data", chunk => output.push(String(chunk)));

  const shellTarget = await waitFor(async () => {
    const list = await targets();
    return list.find(target => target.url.endsWith("/src/renderer/index.html"));
  });

  const client = new CdpClient(shellTarget.webSocketDebuggerUrl);
  await client.open();
  const initial = await client.evaluate("window.chromaBrowser.getState()");
  assert.equal(initial.tabs.length, 1);
  assert.ok(initial.runtime.chromiumVersion);
  const originalTabId = initial.activeTabId;

  await client.evaluate(`(() => {
    window.chromaBrowser.startWindowDrag({ screenX: 100, screenY: 100 });
    window.chromaBrowser.updateWindowDrag({ screenX: 118, screenY: 112 });
    window.chromaBrowser.endWindowDrag();
    return true;
  })()`);
  const draggedWindowState = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return (candidate.runtime.windowBounds.x !== initial.runtime.windowBounds.x ||
      candidate.runtime.windowBounds.y !== initial.runtime.windowBounds.y)
      ? candidate
      : false;
  });
  assert.ok(draggedWindowState.runtime.windowBounds);

  const testTabId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(`${baseUrl}/example`)} })`
  );
  assert.ok(testTabId);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === testTabId);
    return tab && !tab.loading && tab.title === "Example Domain";
  });

  await client.evaluate(
    "document.querySelector('[data-action=\"workspace-menu\"]').click()"
  );
  await waitFor(async () => {
    const popoverOpen = await client.evaluate(
      "document.querySelector('#popover-layer').childElementCount > 0"
    );
    const viewport = (await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    ))[testTabId];
    return popoverOpen && viewport?.nativeVisible === false;
  });
  await client.evaluate(
    "document.querySelector('[data-action=\"toggle-sidebar\"]').click()"
  );
  const collapsedLayout = await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const geometry = await client.evaluate(`(() => {
      const app = document.querySelector('#app');
      const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
      const viewport = document.querySelector('#content-viewport').getBoundingClientRect();
      const trigger = document.querySelector('#sidebar-peek-trigger');
      return {
        collapsed: app.classList.contains('is-collapsed'),
        appWidth: app.getBoundingClientRect().width,
        macos: app.classList.contains('is-macos'),
        sidebarDisplay: getComputedStyle(document.querySelector('#sidebar')).display,
        sidebarWidth: sidebar.width,
        viewportLeft: viewport.left,
        viewportWidth: viewport.width,
        triggerDisplay: getComputedStyle(trigger).display,
        triggerWidth: trigger.getBoundingClientRect().width,
        trafficVisible: document.querySelector('.traffic-lights').getBoundingClientRect().width > 0,
      };
    })()`);
    const nativeBounds = state.runtime.viewBounds[testTabId];
    const pageViewport = (await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    ))[testTabId];
    return state.settings.sidebarCollapsed &&
      geometry.collapsed &&
      geometry.macos === (state.runtime.platform === "darwin") &&
      geometry.sidebarDisplay === "none" &&
      geometry.sidebarWidth === 0 &&
      geometry.triggerDisplay !== "none" &&
      geometry.triggerWidth <= 8.5 &&
      geometry.trafficVisible === false &&
      Math.abs(geometry.viewportLeft - 10) <= 1 &&
      geometry.viewportWidth >= geometry.appWidth - 21 &&
      Math.abs(state.runtime.contentBounds.x - geometry.viewportLeft) <= 1 &&
      Math.abs(state.runtime.contentBounds.width - geometry.viewportWidth) <= 1 &&
      Math.abs(nativeBounds.x - geometry.viewportLeft) <= 1 &&
      Math.abs(nativeBounds.width - geometry.viewportWidth) <= 1 &&
      pageViewport?.nativeVisible === true &&
      Math.abs(pageViewport.width - geometry.viewportWidth) <= 1 &&
      !state.runtime.sidebarOverlayOpen &&
      !state.runtime.sidebarOverlayVisible
      ? { state, geometry, nativeBounds }
      : false;
  }, 5_000);
  assert.equal(collapsedLayout.geometry.sidebarWidth, 0);

  await client.evaluate(`(() => {
    const trigger = document.querySelector('#sidebar-peek-trigger');
    trigger.dispatchEvent(new PointerEvent('pointerenter', {
      bubbles: false,
      cancelable: false,
      pointerType: 'mouse',
    }));
    window.chromaBrowser.updateSidebarOverlay({
      open: true,
      bounds: {
        x: 0,
        y: 0,
        width: Number.parseFloat(getComputedStyle(document.querySelector('#app')).getPropertyValue('--sidebar-width')) + 15,
        height: innerHeight,
      },
    });
    return true;
  })()`);
  let lastRevealState;
  let lastRevealViewports;
  const revealedOverlay = await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const viewports = await client.evaluate("window.chromaBrowser.getSmokeViewports()");
    lastRevealState = state;
    lastRevealViewports = viewports;
    const nativeBounds = state.runtime.viewBounds[testTabId];
    return state.runtime.sidebarOverlayOpen &&
      state.runtime.sidebarOverlayVisible &&
      state.runtime.sidebarOverlayReady &&
      state.runtime.sidebarOverlayBounds?.x === 0 &&
      state.runtime.sidebarOverlayBounds.width === state.settings.sidebarWidth + 15 &&
      viewports[testTabId]?.nativeVisible === true &&
      nativeBounds.x === collapsedLayout.nativeBounds.x &&
      nativeBounds.width === collapsedLayout.nativeBounds.width
      ? state
      : false;
  }, 5_000).catch(error => {
    throw new Error(
      `${error.message}; overlayRuntime=${JSON.stringify(lastRevealState?.runtime || null)}; viewport=${JSON.stringify(lastRevealViewports?.[testTabId] || null)}`,
      { cause: error }
    );
  });
  assert.equal(revealedOverlay.runtime.sidebarOverlayBounds.x, 0);

  const overlayTarget = await waitFor(async () => {
    const list = await targets();
    return list.find(target =>
      target.url.endsWith("/src/renderer/index.html?mode=sidebar-overlay")
    );
  });
  overlayClient = new CdpClient(overlayTarget.webSocketDebuggerUrl);
  await overlayClient.open();
  const overlayGeometry = await overlayClient.evaluate(`(() => {
    const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
    const closeElement = document.querySelector('.traffic-light.is-close');
    const closeBounds = closeElement.getBoundingClientRect();
    const close = getComputedStyle(closeElement);
    const minimize = getComputedStyle(document.querySelector('.traffic-light.is-minimize'));
    const maximize = getComputedStyle(document.querySelector('.traffic-light.is-maximize'));
    const sidebarStyle = getComputedStyle(document.querySelector('#sidebar'));
    return {
      overlayMode: document.querySelector('#app').classList.contains('is-sidebar-overlay'),
      sidebarWidth: sidebar.width,
      sidebarHeight: sidebar.height,
      closeCenter: { x: closeBounds.left + closeBounds.width / 2, y: closeBounds.top + closeBounds.height / 2 },
      lightBackgrounds: [close.backgroundColor, minimize.backgroundColor, maximize.backgroundColor],
      lightBorders: [close.borderColor, minimize.borderColor, maximize.borderColor],
      lightBorderWidths: [close.borderWidth, minimize.borderWidth, maximize.borderWidth],
      sidebarBackground: sidebarStyle.backgroundColor,
      sidebarBackgroundImage: sidebarStyle.backgroundImage,
      sidebarBorderWidth: sidebarStyle.borderWidth,
      sidebarBorderRadius: sidebarStyle.borderRadius,
      sidebarBackdrop: sidebarStyle.backdropFilter,
      sidebarShadow: sidebarStyle.boxShadow,
      documentBackgrounds: [
        getComputedStyle(document.documentElement).backgroundColor,
        getComputedStyle(document.body).backgroundColor,
        getComputedStyle(document.querySelector('#app')).backgroundColor,
      ],
      windowMaterialDisplay: getComputedStyle(document.querySelector('.window-material')).display,
      contentShellDisplay: getComputedStyle(document.querySelector('.content-shell')).display,
    };
  })()`);
  assert.equal(overlayGeometry.overlayMode, true);
  assert.equal(Math.round(overlayGeometry.sidebarWidth), revealedOverlay.settings.sidebarWidth);
  assert.ok(overlayGeometry.sidebarHeight > 400);
  assert.equal(new Set(overlayGeometry.lightBackgrounds).size, 1);
  assert.deepEqual(overlayGeometry.lightBorders, [
    "rgb(163, 75, 88)",
    "rgb(157, 125, 37)",
    "rgb(50, 128, 84)",
  ]);
  assert.deepEqual(overlayGeometry.lightBorderWidths, ["1.5px", "1.5px", "1.5px"]);
  assert.notEqual(overlayGeometry.lightBackgrounds[0], "rgb(255, 95, 87)");
  assert.notEqual(overlayGeometry.sidebarBackgroundImage, "none");
  assert.equal(overlayGeometry.sidebarBorderWidth, "1px");
  assert.equal(overlayGeometry.sidebarBorderRadius, "15px");
  assert.notEqual(overlayGeometry.sidebarBackdrop, "none");
  assert.notEqual(overlayGeometry.sidebarShadow, "none");
  assert.ok(overlayGeometry.documentBackgrounds.every(color => color === "rgba(0, 0, 0, 0)"));
  assert.equal(overlayGeometry.windowMaterialDisplay, "none");
  assert.equal(overlayGeometry.contentShellDisplay, "none");
  await overlayClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: overlayGeometry.closeCenter.x,
    y: overlayGeometry.closeCenter.y,
  });
  // Off-screen macOS smoke windows do not reliably update :hover from CDP.
  // Dispatch the production pointer event so the same renderer state and CSS
  // rule used by a visible window are still exercised here.
  await overlayClient.evaluate(`document.querySelector('.traffic-light.is-close').dispatchEvent(
    new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' })
  )`);
  const trafficHoverStyle = await waitFor(async () => {
    const value = await overlayClient.evaluate(`(() => {
      const close = document.querySelector('.traffic-light.is-close');
      const minimize = document.querySelector('.traffic-light.is-minimize');
      const maximize = document.querySelector('.traffic-light.is-maximize');
      close.getAnimations().forEach(animation => animation.finish());
      return {
        closeClass: close.className,
        colors: [close, minimize, maximize].map(light => getComputedStyle(light).backgroundColor),
      };
    })()`);
    return value.colors[0] === "rgb(255, 95, 87)" &&
      value.colors[1] === overlayGeometry.lightBackgrounds[1] &&
      value.colors[2] === overlayGeometry.lightBackgrounds[2]
      ? value
      : false;
  }, 2_000).catch(async error => {
    const value = await overlayClient.evaluate(`(() => {
      const close = document.querySelector('.traffic-light.is-close');
      const minimize = document.querySelector('.traffic-light.is-minimize');
      const maximize = document.querySelector('.traffic-light.is-maximize');
      close.getAnimations().forEach(animation => animation.finish());
      return {
        closeClass: close.className,
        colors: [close, minimize, maximize].map(light => getComputedStyle(light).backgroundColor),
      };
    })()`);
    throw new Error(`${error.message}; trafficHover=${JSON.stringify(value)}`, { cause: error });
  });
  assert.equal(trafficHoverStyle.colors[0], "rgb(255, 95, 87)");

  await overlayClient.evaluate(`(() => {
    const row = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(testTabId)}]');
    const rowBounds = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rowBounds.right - 4,
      clientY: rowBounds.top + rowBounds.height / 2,
    }));
    return true;
  })()`);
  const contextMenuGeometry = await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const geometry = await overlayClient.evaluate(`(() => {
      const popover = document.querySelector('#popover-layer .popover');
      if (!popover) return null;
      const menu = popover.getBoundingClientRect();
      return { menuLeft: menu.left, menuRight: menu.right, windowWidth: innerWidth };
    })()`);
    const viewports = await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    );
    return state.runtime.chromeModalOpen &&
      geometry?.menuLeft >= 0 &&
      geometry?.menuRight <= geometry?.windowWidth &&
      viewports[testTabId]?.nativeVisible === true
      ? geometry
      : false;
  }, 5_000);
  assert.ok(contextMenuGeometry.menuRight <= contextMenuGeometry.windowWidth);
  await overlayClient.evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    return true;
  })()`);
  await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const menuOpen = await overlayClient.evaluate(
      "Boolean(document.querySelector('#popover-layer .popover'))"
    );
    const viewports = await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    );
    return !state.runtime.chromeModalOpen &&
      !menuOpen &&
      viewports[testTabId]?.nativeVisible === true;
  }, 5_000);

  await client.evaluate("window.chromaBrowser.updateSidebarOverlay({ open: false })");
  await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    return !state.runtime.sidebarOverlayOpen &&
      !state.runtime.sidebarOverlayVisible &&
      state.runtime.viewBounds[testTabId].x === collapsedLayout.nativeBounds.x;
  }, 5_000);

  await client.evaluate("window.chromaBrowser.command('sidebar:toggle')");
  await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const geometry = await client.evaluate(`(() => {
      const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
      const viewport = document.querySelector('#content-viewport').getBoundingClientRect();
      return { sidebarWidth: sidebar.width, viewportLeft: viewport.left };
    })()`);
    return !state.settings.sidebarCollapsed &&
      Math.abs(geometry.sidebarWidth - state.settings.sidebarWidth) <= 1 &&
      Math.abs(geometry.viewportLeft - state.settings.sidebarWidth) <= 1 &&
      !state.runtime.sidebarOverlayVisible &&
      Math.abs(state.runtime.contentBounds.x - geometry.viewportLeft) <= 1;
  }, 5_000);

  const splitTabId = await client.evaluate(
    "window.chromaBrowser.command('split:active', { direction: 'row' })"
  );
  assert.ok(splitTabId);
  const splitState = await client.evaluate("window.chromaBrowser.getState()");
  assert.equal(splitState.tabs.length, 3);
  assert.equal(splitState.splitGroups.length, 1);
  assert.deepEqual(splitState.splitGroups[0].tabIds, [testTabId, splitTabId]);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const splitTab = candidate.tabs.find(tab => tab.id === splitTabId);
    return splitTab && !splitTab.loading;
  });

  const twoPaneSwapPoint = await client.evaluate(`(() => {
    const source = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(testTabId)}]');
    const target = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(splitTabId)}]');
    const sourceBounds = source.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    source.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 63,
      button: 0,
      buttons: 1,
      clientX: sourceBounds.left + sourceBounds.width / 2,
      clientY: sourceBounds.top + sourceBounds.height / 2,
    }));
    const point = {
      x: targetBounds.left + targetBounds.width / 2,
      y: targetBounds.top + targetBounds.height / 2,
    };
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 63,
      button: 0,
      buttons: 1,
      clientX: point.x,
      clientY: point.y,
    }));
    return point;
  })()`);
  const twoPaneSwapPreview = await waitFor(() => client.evaluate(`(() => {
    const group = document.querySelector('.split-tab-group[data-count="2"]');
    const source = group?.querySelector('.tab-row[data-tab-id=${JSON.stringify(testTabId)}]');
    const target = group?.querySelector('.tab-row[data-tab-id=${JSON.stringify(splitTabId)}]');
    if (!group || !source || !target) return false;
    const groupBounds = group.getBoundingClientRect();
    const sourceBounds = source.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    return source.classList.contains('is-swap-preview') &&
      target.classList.contains('is-swap-preview') &&
      !target.classList.contains('is-split-before') &&
      !target.classList.contains('is-split-after') &&
      Math.abs(sourceBounds.width - targetBounds.width) <= 1 &&
      groupBounds.height <= 40 &&
      getComputedStyle(source).transform !== 'none' &&
      getComputedStyle(target).transform !== 'none'
      ? {
          groupWidth: groupBounds.width,
          sourceWidth: sourceBounds.width,
          targetWidth: targetBounds.width,
        }
      : false;
  })()`));
  assert.ok(twoPaneSwapPreview.sourceWidth > twoPaneSwapPreview.groupWidth * .4);
  await client.evaluate(`document.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    pointerId: 63,
    button: 0,
    buttons: 0,
    clientX: ${twoPaneSwapPoint.x},
    clientY: ${twoPaneSwapPoint.y},
  }))`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.tabIds.includes(testTabId));
    const domOrder = await client.evaluate(
      "[...document.querySelectorAll('.split-tab-group[data-count=\"2\"] > .tab-row')].map(row => row.dataset.tabId)"
    );
    return group &&
      JSON.stringify(group.tabIds) === JSON.stringify([splitTabId, testTabId]) &&
      JSON.stringify(domOrder) === JSON.stringify(group.tabIds);
  });

  const paneCards = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const geometry = await client.evaluate(`(() => ({
      frames: [...document.querySelectorAll('#pane-frame-layer .pane-frame')].map(frame => {
        const bounds = frame.getBoundingClientRect();
        return {
          id: frame.dataset.tabId,
          active: frame.classList.contains('is-active'),
          color: getComputedStyle(frame).backgroundColor,
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        };
      }),
      splitGroups: [...document.querySelectorAll('.split-tab-group')].map(group => ({
        count: Number(group.dataset.count),
        rows: group.querySelectorAll('.tab-row').length,
        activeRows: group.querySelectorAll('.tab-item.is-active').length,
      })),
    }))()`);
    if (
      geometry.frames.length !== 2 ||
      geometry.frames.filter(frame => frame.active).length !== 1 ||
      geometry.splitGroups.length !== 1 ||
      geometry.splitGroups[0].count !== 2 ||
      geometry.splitGroups[0].rows !== 2 ||
      geometry.splitGroups[0].activeRows !== 1
    ) {
      return false;
    }
    for (const frame of geometry.frames) {
      const native = candidate.runtime.viewBounds[frame.id];
      if (
        !native ||
        Math.abs(native.x - frame.bounds.x - 2) > 1 ||
        Math.abs(native.y - frame.bounds.y - 2) > 1 ||
        Math.abs(native.width - frame.bounds.width + 4) > 1 ||
        Math.abs(native.height - frame.bounds.height + 4) > 1
      ) {
        return false;
      }
    }
    const activeFrame = geometry.frames.find(frame => frame.active);
    const inactiveFrame = geometry.frames.find(frame => !frame.active);
    return activeFrame?.id === candidate.activeTabId &&
      inactiveFrame &&
      activeFrame.color === inactiveFrame.color &&
      activeFrame.color !== "rgb(61, 69, 255)"
      ? { candidate, geometry }
      : false;
  }, 5_000);
  assert.equal(paneCards.geometry.frames.length, 2);

  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(testTabId)} })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const activeFrameId = await client.evaluate(
      "document.querySelector('#pane-frame-layer .pane-frame.is-active')?.dataset.tabId"
    );
    return candidate.activeTabId === testTabId && activeFrameId === testTabId;
  }, 5_000);

  await client.evaluate(
    `window.chromaBrowser.command('split:detach', { id: ${JSON.stringify(splitTabId)} })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const frameCount = await client.evaluate(
      "document.querySelectorAll('#pane-frame-layer .pane-frame').length"
    );
    const native = candidate.runtime.viewBounds[splitTabId];
    const content = candidate.runtime.contentBounds;
    return candidate.splitGroups.length === 0 &&
      candidate.activeTabId === splitTabId &&
      frameCount === 0 &&
      native.x === content.x &&
      native.y === content.y &&
      native.width === content.width &&
      native.height === content.height;
  }, 5_000);
  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(testTabId)} })`
  );
  await client.evaluate(`window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(splitTabId)} })`);
  await client.evaluate(`window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(testTabId)} })`);
  await client.evaluate(`window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(originalTabId)} })`);
  let lastFinalState;
  const finalState = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    lastFinalState = candidate;
    return candidate.runtime.managedViewCount === 1 &&
      candidate.runtime.liveWebContentsCount === candidate.runtime.managedViewCount + 2
      ? candidate
      : false;
  }, 5_000).catch(error => {
    return targets().then(liveTargets => {
      throw new Error(
        `${error.message}; final runtime=${JSON.stringify(lastFinalState?.runtime || null)}; targets=${JSON.stringify(liveTargets.map(target => ({ type: target.type, url: target.url })))}`,
        { cause: error }
      );
    });
  });
  assert.equal(finalState.tabs.length, 1);
  assert.equal(finalState.splitGroups.length, 0);
  assert.equal(finalState.activeTabId, originalTabId);
  assert.equal(finalState.runtime.managedViewCount, 1);
  assert.equal(
    finalState.runtime.liveWebContentsCount,
    finalState.runtime.managedViewCount + 2
  );

  // Exercise the harder close path while the renderer is still navigating.
  const slowTabId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(`${baseUrl}/slow`)} })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === slowTabId);
    return tab?.loading === true && tab.url === `${baseUrl}/slow`;
  });
  await client.evaluate(
    `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(slowTabId)} })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return candidate.runtime.managedViewCount === 1 &&
      candidate.runtime.liveWebContentsCount === candidate.runtime.managedViewCount + 2;
  }, 5_000);

  const parentTabId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(`${baseUrl}/parent`)} })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === parentTabId);
    return tab && !tab.loading && tab.title === "Parent page";
  });
  await delay(300);
  const frameState = await client.evaluate("window.chromaBrowser.getState()");
  assert.equal(
    frameState.tabs.find(tab => tab.id === parentTabId)?.url,
    `${baseUrl}/parent`,
    "a child-frame history update replaced the top-level address"
  );
  await client.evaluate(
    `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(parentTabId)} })`
  );

  // A local page reports isolation through its title, avoiding a direct CDP
  // attachment that can itself retain page targets in Electron 43.
  const isolationTabId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(`${baseUrl}/isolation`)} })`
  );
  const isolationState = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === isolationTabId);
    return tab && !tab.loading && tab.title.startsWith("isolation:") ? candidate : false;
  });
  const isolationTab = isolationState.tabs.find(tab => tab.id === isolationTabId);
  assert.equal(isolationTab.crashed, false);
  assert.equal(
    isolationTab.title,
    "isolation:undefined:undefined:false",
    `unexpected content isolation result: ${isolationTab.title}`
  );
  await client.evaluate(
    `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(isolationTabId)} })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return candidate.runtime.managedViewCount === 1 &&
      candidate.runtime.liveWebContentsCount === candidate.runtime.managedViewCount + 2;
  }, 5_000);

  const newTabTarget = await waitFor(async () => {
    const list = await targets();
    return list.find(target => target.url === "chroma://newtab/");
  });
  const newTabClient = new CdpClient(newTabTarget.webSocketDebuggerUrl);
  await newTabClient.open();
  await newTabClient.evaluate(`(() => {
    const input = document.querySelector('input[name="q"]');
    input.value = 'chroma smoke query';
    input.form.requestSubmit();
    return true;
  })()`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return candidate.tabs.some(tab =>
      tab.url.startsWith(`${baseUrl}/search?q=chroma+smoke+query`)
    );
  });
  await newTabClient.close();

  await client.evaluate(
    "document.querySelector('[data-action=\"new-workspace\"]').click()"
  );
  await waitFor(() => client.evaluate("document.querySelector('#text-prompt').open"));
  await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const viewports = await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    );
    return state.runtime.chromeModalOpen &&
      viewports[state.activeTabId]?.nativeVisible === false;
  });
  await client.evaluate(
    "document.querySelector('#text-prompt-input').click()"
  );
  await delay(150);
  assert.equal(
    (await client.evaluate("window.chromaBrowser.getState()")).runtime.chromeModalOpen,
    true
  );
  await client.evaluate(`(() => {
    document.querySelector('#text-prompt-input').value = 'Smoke Space';
    document.querySelector('#text-prompt-form').requestSubmit();
    return true;
  })()`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return !candidate.runtime.chromeModalOpen &&
      candidate.workspaces.some(workspace => workspace.name === "Smoke Space");
  });

  await client.evaluate(
    "document.querySelector('[data-action=\"new-folder\"]').click()"
  );
  await waitFor(() => client.evaluate("document.querySelector('#text-prompt').open"));
  await client.evaluate(`(() => {
    document.querySelector('#text-prompt-input').value = 'Smoke Folder';
    document.querySelector('#text-prompt-form').requestSubmit();
    return true;
  })()`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return candidate.folders.some(folder => folder.name === "Smoke Folder");
  });

  const smokeFolderId = await client.evaluate(
    "window.chromaBrowser.getState().then(state => state.folders.find(folder => folder.name === 'Smoke Folder').id)"
  );
  const folderDragTabId = await client.evaluate(
    "window.chromaBrowser.command('tab:create', { url: 'chroma://newtab/' })"
  );
  await waitFor(() => client.evaluate(
    `Boolean(document.querySelector('.tab-row[data-tab-id=${JSON.stringify(folderDragTabId)}]'))`
  ));
  await client.evaluate(`(() => {
    const source = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(folderDragTabId)}]');
    const header = document.querySelector('.folder[data-folder-id=${JSON.stringify(smokeFolderId)}] > .folder-header');
    const sourceBounds = source.getBoundingClientRect();
    const headerBounds = header.getBoundingClientRect();
    source.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 61,
      button: 0,
      buttons: 1,
      clientX: sourceBounds.left + sourceBounds.width / 2,
      clientY: sourceBounds.top + sourceBounds.height / 2,
    }));
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 61,
      button: 0,
      buttons: 1,
      clientX: headerBounds.left + headerBounds.width / 2,
      clientY: headerBounds.top + headerBounds.height / 2,
    }));
    document.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      pointerId: 61,
      button: 0,
      buttons: 0,
      clientX: headerBounds.left + headerBounds.width / 2,
      clientY: headerBounds.top + headerBounds.height / 2,
    }));
    return true;
  })()`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const folder = candidate.folders.find(item => item.id === smokeFolderId);
    const domFolderId = await client.evaluate(
      `document.querySelector('.tab-row[data-tab-id=${JSON.stringify(folderDragTabId)}]')?.closest('.folder')?.dataset.folderId || null`
    );
    return folder?.expanded &&
      folder.tabIds.includes(folderDragTabId) &&
      domFolderId === smokeFolderId &&
      !candidate.runtime.tabDragActive;
  });

  await client.evaluate(`(() => {
    const source = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(folderDragTabId)}]');
    const ungrouped = document.querySelector('.ungrouped-tabs');
    const sourceBounds = source.getBoundingClientRect();
    const targetBounds = ungrouped.getBoundingClientRect();
    const dropX = targetBounds.left + targetBounds.width / 2;
    const dropY = targetBounds.bottom - 12;
    source.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 62,
      button: 0,
      buttons: 1,
      clientX: sourceBounds.left + sourceBounds.width / 2,
      clientY: sourceBounds.top + sourceBounds.height / 2,
    }));
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 62,
      button: 0,
      buttons: 1,
      clientX: dropX,
      clientY: dropY,
    }));
    document.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      pointerId: 62,
      button: 0,
      buttons: 0,
      clientX: dropX,
      clientY: dropY,
    }));
    return true;
  })()`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const folder = candidate.folders.find(item => item.id === smokeFolderId);
    const inUngroupedZone = await client.evaluate(
      `Boolean(document.querySelector('.ungrouped-tabs > .tab-row[data-tab-id=${JSON.stringify(folderDragTabId)}]'))`
    );
    return folder &&
      !folder.tabIds.includes(folderDragTabId) &&
      inUngroupedZone &&
      !candidate.runtime.tabDragActive;
  });
  await client.evaluate(
    `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(folderDragTabId)} })`
  );

  const beforeSnap = await client.evaluate("window.chromaBrowser.getState()");
  const snapTargetId = beforeSnap.activeTabId;
  const targetResponsiveUrl = `${baseUrl}/adaptive-responsive?pane=target`;
  const responsiveNavigationStarted = await client.evaluate(
    `window.chromaBrowser.command('navigation:go', { id: ${JSON.stringify(snapTargetId)}, input: ${JSON.stringify(targetResponsiveUrl)} })`
  );
  assert.equal(responsiveNavigationStarted, true);
  const targetBeforeSplit = await waitForTabViewport(
    client,
    snapTargetId,
    targetResponsiveUrl
  );
  assert.equal(targetBeforeSplit.layoutMode, "desktop");
  assert.doesNotMatch(targetBeforeSplit.userAgent, /\bMobile\b/i);
  assert.ok(targetBeforeSplit.scrollWidth >= 1400);
  assert.equal(targetBeforeSplit.splitFitZoom, 1);
  assert.equal(targetBeforeSplit.pageZoomFactor, 1);
  const sourceResponsiveUrl = `${baseUrl}/adaptive-responsive?pane=source`;
  const snapSourceId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(sourceResponsiveUrl)} })`
  );
  const sourceBeforeSplit = await waitForTabViewport(
    client,
    snapSourceId,
    sourceResponsiveUrl
  );
  assert.equal(sourceBeforeSplit.layoutMode, "desktop");
  assert.doesNotMatch(sourceBeforeSplit.userAgent, /\bMobile\b/i);
  assert.ok(sourceBeforeSplit.scrollWidth >= 1400);
  const nativeBeforeSplit = await client.evaluate("window.chromaBrowser.getState()");
  const targetNativeBeforeSplit = nativeBeforeSplit.runtime.viewBounds[snapTargetId];
  const sourceNativeBeforeSplit = nativeBeforeSplit.runtime.viewBounds[snapSourceId];
  assert.ok(targetNativeBeforeSplit);
  assert.ok(sourceNativeBeforeSplit);
  await waitFor(() => client.evaluate(
    `Boolean(document.querySelector('.tab-row[data-tab-id=${JSON.stringify(snapSourceId)}]'))`
  ));
  await client.evaluate(`(() => {
    const source = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(snapSourceId)}]');
    const sourceBounds = source.getBoundingClientRect();
    source.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 71,
      button: 0,
      buttons: 1,
      clientX: sourceBounds.left + sourceBounds.width / 2,
      clientY: sourceBounds.top + sourceBounds.height / 2,
    }));
    return true;
  })()`);
  await client.evaluate(`(() => {
    const source = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(snapSourceId)}]');
    const sourceBounds = source.getBoundingClientRect();
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 71,
      button: 0,
      buttons: 1,
      clientX: sourceBounds.left + sourceBounds.width / 2 + 10,
      clientY: sourceBounds.top + sourceBounds.height / 2,
    }));
    return true;
  })()`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const draggingClass = await client.evaluate(
      "document.body.classList.contains('is-tab-dragging')"
    );
    return candidate.runtime.tabDragActive && draggingClass;
  });
  await client.evaluate(`(() => {
    const viewportBounds = document.querySelector('#content-viewport').getBoundingClientRect();
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 71,
      button: 0,
      buttons: 1,
      clientX: viewportBounds.right - 2,
      clientY: viewportBounds.top + viewportBounds.height / 2,
    }));
    return true;
  })()`);
  await waitFor(() => client.evaluate(`(() => {
    const overlay = document.querySelector('#split-drop-overlay');
    return !overlay.hidden && overlay.dataset.edge === 'right';
  })()`));
  await client.evaluate(`(() => {
    const viewportBounds = document.querySelector('#content-viewport').getBoundingClientRect();
    document.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      pointerId: 71,
      button: 0,
      buttons: 0,
      clientX: viewportBounds.right - 2,
      clientY: viewportBounds.top + viewportBounds.height / 2,
    }));
    return true;
  })()`);
  let lastSnapCandidate;
  const snappedState = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    lastSnapCandidate = candidate;
    const group = candidate.splitGroups.find(item =>
      item.tabIds.includes(snapTargetId) && item.tabIds.includes(snapSourceId)
    );
    const viewportState = await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    );
    const targetViewport = viewportState[snapTargetId];
    const sourceViewport = viewportState[snapSourceId];
    const targetNative = candidate.runtime.viewBounds[snapTargetId];
    const sourceNative = candidate.runtime.viewBounds[snapSourceId];
    return group &&
      targetNative?.width < targetNativeBeforeSplit.width &&
      sourceNative?.width < sourceNativeBeforeSplit.width &&
      targetViewport?.width < targetBeforeSplit.width &&
      sourceViewport?.width < sourceBeforeSplit.width
      ? candidate
      : false;
  }).catch(error => {
    throw new Error(
      `${error.message}; before=${JSON.stringify({ targetBeforeSplit, sourceBeforeSplit })}; runtime=${JSON.stringify(lastSnapCandidate?.runtime || null)}; groups=${JSON.stringify(lastSnapCandidate?.splitGroups || [])}`,
      { cause: error }
    );
  });
  assert.equal(snappedState.tabs.length, beforeSnap.tabs.length + 1);
  assert.equal(snappedState.runtime.tabDragActive, false);

  let lastAdaptiveViewport;
  const adaptedViewport = await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const viewports = await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    );
    const viewport = viewports[snapTargetId];
    const tab = state.tabs.find(item => item.id === snapTargetId);
    lastAdaptiveViewport = viewport;
    return tab &&
      !tab.loading &&
      viewport?.url === targetResponsiveUrl &&
      viewport.layoutMode === "mobile" &&
      viewport.adaptiveMode === "mobile" &&
      viewport.adaptivePendingMode === null &&
      /\bMobile\b/i.test(viewport.userAgent)
      ? viewport
      : false;
  }, 15_000).catch(error => {
    throw new Error(
      `${error.message}; adaptiveViewport=${JSON.stringify(lastAdaptiveViewport || null)}`,
      { cause: error }
    );
  });
  assert.ok(adaptedViewport.width < targetBeforeSplit.width);
  assert.ok(adaptedViewport.scrollWidth <= adaptedViewport.width + 2);
  assert.equal(adaptedViewport.splitFitZoom, 1);
  assert.equal(adaptedViewport.pageZoomFactor, 1);
  assert.ok(adaptedViewport.bodyFontSize >= 16);
  const adaptedSourceViewport = await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const viewports = await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    );
    const viewport = viewports[snapSourceId];
    const tab = state.tabs.find(item => item.id === snapSourceId);
    return tab &&
      !tab.loading &&
      viewport?.layoutMode === "mobile" &&
      viewport.adaptiveMode === "mobile" &&
      viewport.adaptivePendingMode === null &&
      /\bMobile\b/i.test(viewport.userAgent)
      ? viewport
      : false;
  }, 15_000);
  assert.ok(adaptedSourceViewport.scrollWidth <= adaptedSourceViewport.width + 2);
  assert.equal(adaptedSourceViewport.pageZoomFactor, 1);

  // Restore while the two panes still have active compositor surfaces. Later
  // pointer-sort coverage deliberately hides every native view, which macOS can
  // leave occluded while this smoke window is inactive or the screen is locked.
  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(snapTargetId)} })`
  );
  await client.evaluate("window.chromaBrowser.command('split:remove')");
  let lastRestoredAdaptiveState;
  let lastRestoredAdaptiveViewports;
  const restoredAdaptiveViews = await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const viewports = await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    );
    lastRestoredAdaptiveState = state;
    lastRestoredAdaptiveViewports = viewports;
    const targetViewport = viewports[snapTargetId];
    const sourceViewport = viewports[snapSourceId];
    const targetTab = state.tabs.find(item => item.id === snapTargetId);
    const sourceTab = state.tabs.find(item => item.id === snapSourceId);
    return targetTab &&
      sourceTab &&
      !targetTab.loading &&
      !sourceTab.loading &&
      targetViewport?.layoutMode === "desktop" &&
      sourceViewport?.layoutMode === "desktop" &&
      targetViewport.adaptiveMode === "desktop" &&
      sourceViewport.adaptiveMode === "desktop" &&
      targetViewport.adaptivePendingMode === null &&
      sourceViewport.adaptivePendingMode === null &&
      !/\bMobile\b/i.test(targetViewport.userAgent) &&
      !/\bMobile\b/i.test(sourceViewport.userAgent) &&
      targetViewport.scrollWidth >= 1400 &&
      targetViewport.bounds.width >= targetNativeBeforeSplit.width - 1 &&
      (targetViewport.visibilityState !== "visible" ||
        targetViewport.width >= targetBeforeSplit.width - 1)
      ? { targetViewport, sourceViewport }
      : false;
  }, 15_000).catch(error => {
    throw new Error(
      `${error.message}; state=${JSON.stringify(lastRestoredAdaptiveState || null)}; viewports=${JSON.stringify(lastRestoredAdaptiveViewports || null)}`,
      { cause: error }
    );
  });
  const restoredViewport = restoredAdaptiveViews.targetViewport;
  assert.equal(restoredViewport.splitFitZoom, 1);
  assert.equal(restoredViewport.pageZoomFactor, 1);
  if (restoredViewport.visibilityState === "visible") {
    assert.ok(restoredViewport.width > adaptedViewport.width);
    assert.ok(restoredViewport.width >= targetBeforeSplit.width - 1);
  }
  assert.ok(restoredViewport.scrollWidth >= 1400);
  assert.ok(restoredViewport.bounds.width >= targetNativeBeforeSplit.width - 1);
  assert.deepEqual(adaptiveRequests.get("target"), [
    "desktop",
    "mobile",
    "desktop",
  ]);
  assert.deepEqual(adaptiveRequests.get("source"), [
    "desktop",
    "mobile",
    "desktop",
  ]);

  const raceMateUrl = `${baseUrl}/responsive?pane=race-mate`;
  await client.evaluate(
    `window.chromaBrowser.command('navigation:go', { id: ${JSON.stringify(snapSourceId)}, input: ${JSON.stringify(raceMateUrl)} })`
  );
  await waitForTabViewport(client, snapSourceId, raceMateUrl);

  // Unsplitting while the delayed mobile response is still provisional must
  // wait for that load to settle, then perform one desktop follow-up reload.
  const pendingTargetUrl = `${baseUrl}/adaptive-responsive?pane=pending-target`;
  await client.evaluate(
    `window.chromaBrowser.command('navigation:go', { id: ${JSON.stringify(snapTargetId)}, input: ${JSON.stringify(pendingTargetUrl)} })`
  );
  await waitForTabViewport(client, snapTargetId, pendingTargetUrl);
  await client.evaluate(
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(snapSourceId)}, targetId: ${JSON.stringify(snapTargetId)}, direction: 'row', placement: 'after' })`
  );
  await waitFor(() => adaptiveRequests.get("pending-target")?.at(-1) === "mobile");
  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(snapTargetId)} })`
  );
  await client.evaluate("window.chromaBrowser.command('split:remove')");
  await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const viewport = (await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    ))[snapTargetId];
    const tab = state.tabs.find(item => item.id === snapTargetId);
    return tab &&
      !tab.loading &&
      viewport?.layoutMode === "desktop" &&
      viewport.adaptiveMode === "desktop" &&
      viewport.adaptivePendingMode === null &&
      !/\bMobile\b/i.test(viewport.userAgent) &&
      adaptiveRequests.get("pending-target")?.at(-1) === "desktop";
  }, 15_000);
  assert.deepEqual(adaptiveRequests.get("pending-target"), [
    "desktop",
    "mobile",
    "desktop",
  ]);

  // Reload while the mobile document is provisional must supersede it with a
  // desktop request. Stopping the next adaptive attempt must then roll back and
  // suppress retries for the unchanged URL/pane signature.
  const stopTargetUrl = `${baseUrl}/adaptive-responsive?pane=stop-target`;
  await client.evaluate(
    `window.chromaBrowser.command('navigation:go', { id: ${JSON.stringify(snapTargetId)}, input: ${JSON.stringify(stopTargetUrl)} })`
  );
  await waitForTabViewport(client, snapTargetId, stopTargetUrl);
  await client.evaluate(
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(snapSourceId)}, targetId: ${JSON.stringify(snapTargetId)}, direction: 'row', placement: 'after' })`
  );
  await waitFor(() => adaptiveRequests.get("stop-target")?.at(-1) === "mobile");
  await client.evaluate(
    `window.chromaBrowser.command('navigation:reload', { id: ${JSON.stringify(snapTargetId)} })`
  );
  await waitFor(() => adaptiveRequests.get("stop-target")?.length >= 4);
  assert.deepEqual(adaptiveRequests.get("stop-target"), [
    "desktop",
    "mobile",
    "desktop",
    "mobile",
  ]);
  await client.evaluate(
    `window.chromaBrowser.command('navigation:stop', { id: ${JSON.stringify(snapTargetId)} })`
  );
  await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const viewport = (await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    ))[snapTargetId];
    const tab = state.tabs.find(item => item.id === snapTargetId);
    return tab &&
      !tab.loading &&
      viewport?.layoutMode === "desktop" &&
      viewport.adaptiveMode === "desktop" &&
      viewport.adaptivePendingMode === null &&
      !/\bMobile\b/i.test(viewport.userAgent);
  }, 15_000);
  await delay(700);
  assert.deepEqual(adaptiveRequests.get("stop-target"), [
    "desktop",
    "mobile",
    "desktop",
    "mobile",
  ]);
  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(snapTargetId)} })`
  );
  await client.evaluate("window.chromaBrowser.command('split:remove')");

  // A typed address supersedes an in-flight adaptive reload. The late mobile
  // response must not replace the explicitly requested desktop navigation.
  const pendingNavigationUrl =
    `${baseUrl}/adaptive-responsive?pane=pending-nav-target`;
  await client.evaluate(
    `window.chromaBrowser.command('navigation:go', { id: ${JSON.stringify(snapTargetId)}, input: ${JSON.stringify(pendingNavigationUrl)} })`
  );
  await waitForTabViewport(client, snapTargetId, pendingNavigationUrl);
  await client.evaluate(
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(snapSourceId)}, targetId: ${JSON.stringify(snapTargetId)}, direction: 'row', placement: 'after' })`
  );
  await waitFor(() =>
    adaptiveRequests.get("pending-nav-target")?.at(-1) === "mobile"
  );
  const explicitNavigationUrl = `${baseUrl}/responsive?pane=explicit-navigation`;
  await client.evaluate(
    `window.chromaBrowser.command('navigation:go', { id: ${JSON.stringify(snapTargetId)}, input: ${JSON.stringify(explicitNavigationUrl)} })`
  );
  await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const viewport = (await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    ))[snapTargetId];
    const tab = state.tabs.find(item => item.id === snapTargetId);
    return tab?.url === explicitNavigationUrl &&
      !tab.loading &&
      viewport?.url === explicitNavigationUrl &&
      viewport.hasViewportMeta &&
      viewport.adaptiveMode === "desktop" &&
      viewport.adaptivePendingMode === null &&
      !/\bMobile\b/i.test(viewport.userAgent);
  }, 15_000);
  await delay(700);
  assert.deepEqual(adaptiveRequests.get("pending-nav-target"), [
    "desktop",
    "mobile",
  ]);
  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(snapTargetId)} })`
  );
  await client.evaluate("window.chromaBrowser.command('split:remove')");

  // A desktop navigation started from a committed mobile DOM is itself a
  // transition. If that explicit request is stopped before commit, the old
  // mobile DOM, adaptive mode, and per-page UA must be restored together.
  const stableMobileUrl =
    `${baseUrl}/adaptive-responsive?pane=stable-mobile-target`;
  await client.evaluate(
    `window.chromaBrowser.command('navigation:go', { id: ${JSON.stringify(snapTargetId)}, input: ${JSON.stringify(stableMobileUrl)} })`
  );
  await waitForTabViewport(client, snapTargetId, stableMobileUrl);
  await client.evaluate(
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(snapSourceId)}, targetId: ${JSON.stringify(snapTargetId)}, direction: 'row', placement: 'after' })`
  );
  await waitFor(async () => {
    const viewport = (await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    ))[snapTargetId];
    return viewport?.layoutMode === "mobile" &&
      viewport.adaptiveMode === "mobile" &&
      viewport.adaptivePendingMode === null;
  }, 15_000);
  const explicitHangUrl = `${baseUrl}/explicit-hang`;
  await client.evaluate(
    `window.chromaBrowser.command('navigation:go', { id: ${JSON.stringify(snapTargetId)}, input: ${JSON.stringify(explicitHangUrl)} })`
  );
  await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const tab = state.tabs.find(item => item.id === snapTargetId);
    return explicitHangRequests === 1 &&
      tab?.url === explicitHangUrl &&
      tab.loading;
  }, 15_000);
  await client.evaluate(
    `window.chromaBrowser.command('navigation:stop', { id: ${JSON.stringify(snapTargetId)} })`
  );
  await waitFor(async () => {
    const state = await client.evaluate("window.chromaBrowser.getState()");
    const viewport = (await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    ))[snapTargetId];
    const tab = state.tabs.find(item => item.id === snapTargetId);
    return tab &&
      !tab.loading &&
      tab.url === stableMobileUrl &&
      tab.title === "Adaptive mobile stable-mobile-target" &&
      viewport?.url === stableMobileUrl &&
      viewport.layoutMode === "mobile" &&
      viewport.adaptiveMode === "mobile" &&
      viewport.adaptivePendingMode === null &&
      /\bMobile\b/i.test(viewport.userAgent);
  }, 15_000);
  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(snapTargetId)} })`
  );
  await client.evaluate("window.chromaBrowser.command('split:remove')");
  await waitFor(async () => {
    const viewport = (await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    ))[snapTargetId];
    return viewport?.layoutMode === "desktop" &&
      viewport.adaptiveMode === "desktop" &&
      viewport.adaptivePendingMode === null &&
      !/\bMobile\b/i.test(viewport.userAgent);
  }, 15_000);
  assert.deepEqual(adaptiveRequests.get("stable-mobile-target"), [
    "desktop",
    "mobile",
    "desktop",
  ]);

  const targetGridUrl = `${baseUrl}/responsive?pane=target-grid`;
  await client.evaluate(
    `window.chromaBrowser.command('navigation:go', { id: ${JSON.stringify(snapTargetId)}, input: ${JSON.stringify(targetGridUrl)} })`
  );
  await waitForTabViewport(client, snapTargetId, targetGridUrl);
  const sourceGridUrl = `${baseUrl}/responsive?pane=source-grid`;
  await client.evaluate(
    `window.chromaBrowser.command('navigation:go', { id: ${JSON.stringify(snapSourceId)}, input: ${JSON.stringify(sourceGridUrl)} })`
  );
  await waitForTabViewport(client, snapSourceId, sourceGridUrl);
  await client.evaluate(
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(snapSourceId)}, targetId: ${JSON.stringify(snapTargetId)}, direction: 'row', placement: 'after' })`
  );

  const thirdResponsiveUrl = `${baseUrl}/responsive?pane=3`;
  const thirdPaneId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(thirdResponsiveUrl)} })`
  );
  const thirdBeforeSplit = await waitForTabViewport(
    client,
    thirdPaneId,
    thirdResponsiveUrl
  );
  await client.evaluate(
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(thirdPaneId)}, targetId: ${JSON.stringify(snapTargetId)}, direction: 'row', placement: 'after' })`
  );
  const fourthResponsiveUrl = `${baseUrl}/responsive?pane=4`;
  const fourthPaneId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(fourthResponsiveUrl)} })`
  );
  const fourthBeforeSplit = await waitForTabViewport(
    client,
    fourthPaneId,
    fourthResponsiveUrl
  );
  await client.evaluate(
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(fourthPaneId)}, targetId: ${JSON.stringify(snapTargetId)}, direction: 'row', placement: 'after' })`
  );
  let lastFourPaneCandidate;
  let lastFourPaneViewports;
  const fourPaneState = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    lastFourPaneCandidate = candidate;
    const group = candidate.splitGroups.find(item => item.tabIds.includes(snapTargetId));
    if (group?.tabIds.length !== 4) return false;
    const viewportState = await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    );
    lastFourPaneViewports = viewportState;
    const viewportBaselines = [
      [snapTargetId, targetBeforeSplit],
      [snapSourceId, sourceBeforeSplit],
      [thirdPaneId, thirdBeforeSplit],
      [fourthPaneId, fourthBeforeSplit],
    ];
    return viewportBaselines.every(([id, baseline]) => {
      const viewport = viewportState[id];
      const nativeBounds = candidate.runtime.viewBounds[id];
      return viewport &&
        nativeBounds?.width < baseline.bounds.width &&
        nativeBounds?.height < baseline.bounds.height &&
        viewport.width <= nativeBounds.width + 1 &&
        viewport.width < baseline.width;
    })
      ? candidate
      : false;
  }).catch(error => {
    throw new Error(
      `${error.message}; groups=${JSON.stringify(lastFourPaneCandidate?.splitGroups || [])}; viewports=${JSON.stringify(lastFourPaneViewports || null)}`,
      { cause: error }
    );
  });
  const fourPaneGroup = fourPaneState.splitGroups.find(group =>
    group.tabIds.includes(snapTargetId)
  );
  assert.equal(fourPaneGroup.tabIds.length, 4);
  assert.equal(fourPaneGroup.direction, "grid");

  const fourCapsuleGeometry = await client.evaluate(`(() => {
    const group = document.querySelector('.split-tab-group[data-count="4"]');
    const groupBounds = group.getBoundingClientRect();
    const rows = [...group.querySelectorAll(':scope > .tab-row')].map(row => {
      const bounds = row.getBoundingClientRect();
      return {
        id: row.dataset.tabId,
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      };
    });
    return {
      groupHeight: groupBounds.height,
      groupWidth: groupBounds.width,
      rows,
    };
  })()`);
  assert.ok(fourCapsuleGeometry.groupHeight >= 64);
  assert.deepEqual(
    fourCapsuleGeometry.rows.map(row => row.id),
    fourPaneGroup.tabIds
  );
  assert.ok(fourCapsuleGeometry.rows.every(row =>
    Math.abs(row.width - fourCapsuleGeometry.rows[0].width) <= 1 &&
    Math.abs(row.height - fourCapsuleGeometry.rows[0].height) <= 1
  ));
  assert.ok(Math.abs(fourCapsuleGeometry.rows[0].top - fourCapsuleGeometry.rows[1].top) <= 1);
  assert.ok(Math.abs(fourCapsuleGeometry.rows[2].top - fourCapsuleGeometry.rows[3].top) <= 1);
  assert.ok(fourCapsuleGeometry.rows[2].top > fourCapsuleGeometry.rows[0].top);
  assert.ok(Math.abs(fourCapsuleGeometry.rows[0].left - fourCapsuleGeometry.rows[2].left) <= 1);
  assert.ok(Math.abs(fourCapsuleGeometry.rows[1].left - fourCapsuleGeometry.rows[3].left) <= 1);
  assert.ok(fourCapsuleGeometry.rows[1].left > fourCapsuleGeometry.rows[0].left);

  const fourPaneSwapPoint = await client.evaluate(`(() => {
    const source = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(fourthPaneId)}]');
    const target = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(snapTargetId)}]');
    const sourceBounds = source.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    source.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 72,
      button: 0,
      buttons: 1,
      clientX: sourceBounds.left + sourceBounds.width / 2,
      clientY: sourceBounds.top + sourceBounds.height / 2,
    }));
    const point = {
      x: targetBounds.left + targetBounds.width / 2,
      y: targetBounds.top + targetBounds.height / 2,
    };
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 72,
      button: 0,
      buttons: 1,
      clientX: point.x,
      clientY: point.y,
    }));
    return point;
  })()`);
  const fourPaneSwapPreview = await waitFor(() => client.evaluate(`(() => {
    const group = document.querySelector('.split-tab-group[data-count="4"]');
    const source = group?.querySelector('.tab-row[data-tab-id=${JSON.stringify(fourthPaneId)}]');
    const target = group?.querySelector('.tab-row[data-tab-id=${JSON.stringify(snapTargetId)}]');
    if (!group || !source || !target) return false;
    const rows = [...group.querySelectorAll(':scope > .tab-row')].map(row => row.getBoundingClientRect());
    return source.classList.contains('is-swap-preview') &&
      target.classList.contains('is-swap-preview') &&
      !target.classList.contains('is-split-before') &&
      !target.classList.contains('is-split-after') &&
      rows.every(row => Math.abs(row.width - rows[0].width) <= 1)
      ? { widths: rows.map(row => row.width) }
      : false;
  })()`));
  assert.equal(new Set(fourPaneSwapPreview.widths.map(width => Math.round(width))).size, 1);
  await client.evaluate(`document.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    pointerId: 72,
    button: 0,
    buttons: 0,
    clientX: ${fourPaneSwapPoint.x},
    clientY: ${fourPaneSwapPoint.y},
  }))`);
  const sortedState = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item =>
      item.tabIds.includes(fourthPaneId) && item.tabIds.includes(snapTargetId)
    );
    return group?.tabIds[0] === fourthPaneId && group.tabIds[1] === snapTargetId
      ? candidate
      : false;
  });
  const sortedGroup = sortedState.splitGroups.find(group =>
    group.tabIds.includes(fourthPaneId)
  );
  assert.deepEqual(sortedGroup.tabIds.slice(0, 2), [fourthPaneId, snapTargetId]);

  await client.evaluate(`(() => {
    const source = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(fourthPaneId)}]');
    const sourceBounds = source.getBoundingClientRect();
    const viewportBounds = document.querySelector('#content-viewport').getBoundingClientRect();
    const dropX = viewportBounds.left + viewportBounds.width / 2;
    const dropY = viewportBounds.top + viewportBounds.height / 2;
    source.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 73,
      button: 0,
      buttons: 1,
      clientX: sourceBounds.left + sourceBounds.width / 2,
      clientY: sourceBounds.top + sourceBounds.height / 2,
    }));
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 73,
      button: 0,
      buttons: 1,
      clientX: dropX,
      clientY: dropY,
    }));
    document.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      pointerId: 73,
      button: 0,
      buttons: 0,
      clientX: dropX,
      clientY: dropY,
    }));
    return true;
  })()`);
  const detachedState = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item =>
      item.tabIds.includes(snapTargetId)
    );
    const native = candidate.runtime.viewBounds[fourthPaneId];
    const content = candidate.runtime.contentBounds;
    return candidate.activeTabId === fourthPaneId &&
      group?.tabIds.length === 3 &&
      !group.tabIds.includes(fourthPaneId) &&
      native?.x === content.x &&
      native?.y === content.y &&
      native?.width === content.width &&
      native?.height === content.height
      ? candidate
      : false;
  });
  assert.equal(detachedState.splitGroups[0].tabIds.length, 3);
  const threeCapsuleGeometry = await client.evaluate(`(() => {
    const group = document.querySelector('.split-tab-group[data-count="3"]');
    const groupBounds = group.getBoundingClientRect();
    const rows = [...group.querySelectorAll(':scope > .tab-row')].map(row => {
      const bounds = row.getBoundingClientRect();
      return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    });
    return { groupHeight: groupBounds.height, groupWidth: groupBounds.width, rows };
  })()`);
  assert.ok(threeCapsuleGeometry.groupHeight <= 40);
  assert.ok(threeCapsuleGeometry.rows.every(row =>
    Math.abs(row.width - threeCapsuleGeometry.rows[0].width) <= 1
  ));
  assert.ok(threeCapsuleGeometry.rows[0].height > threeCapsuleGeometry.rows[1].height * 1.8);
  assert.ok(Math.abs(threeCapsuleGeometry.rows[1].height - threeCapsuleGeometry.rows[2].height) <= 1);
  assert.ok(Math.abs(threeCapsuleGeometry.rows[0].top - threeCapsuleGeometry.rows[1].top) <= 1);
  assert.ok(threeCapsuleGeometry.rows[2].top > threeCapsuleGeometry.rows[1].top);
  assert.ok(Math.abs(threeCapsuleGeometry.rows[1].left - threeCapsuleGeometry.rows[2].left) <= 1);
  assert.ok(threeCapsuleGeometry.rows[1].left > threeCapsuleGeometry.rows[0].left);

  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(snapTargetId)} })`
  );
  const expandedThreeCapsuleGeometry = await waitFor(() => client.evaluate(`(() => {
    const group = document.querySelector('.split-tab-group[data-count="3"].is-current');
    if (!group) return false;
    const groupBounds = group.getBoundingClientRect();
    const rows = [...group.querySelectorAll(':scope > .tab-row')].map(row => {
      const bounds = row.getBoundingClientRect();
      return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    });
    return groupBounds.height >= 64 ? { groupHeight: groupBounds.height, rows } : false;
  })()`));
  assert.ok(expandedThreeCapsuleGeometry.rows[0].height > 60);
  assert.ok(expandedThreeCapsuleGeometry.rows[1].height >= 28);
  assert.ok(expandedThreeCapsuleGeometry.rows[2].height >= 28);
  assert.ok(
    Math.abs(
      expandedThreeCapsuleGeometry.rows[1].height -
      expandedThreeCapsuleGeometry.rows[2].height
    ) <= 1
  );

  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(fourthPaneId)} })`
  );
  const collapsedThreeCapsuleHeight = await waitFor(() => client.evaluate(`(() => {
    const group = document.querySelector('.split-tab-group[data-count="3"]:not(.is-current)');
    if (!group) return false;
    const height = group.getBoundingClientRect().height;
    return height <= 40 ? height : false;
  })()`));
  assert.ok(collapsedThreeCapsuleHeight <= 40);

  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(snapTargetId)} })`
  );
  await client.evaluate("window.chromaBrowser.command('split:remove')");
  const closeRaceGroupId = await client.evaluate(
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(snapSourceId)}, targetId: ${JSON.stringify(snapTargetId)}, direction: 'row', placement: 'after' })`
  );
  assert.ok(closeRaceGroupId);

  report = {
    chromium: initial.runtime.chromiumVersion,
    bridge: true,
    webNavigation: true,
    tabLifecycle: true,
    splitView: true,
    stateRestoreModel: true,
    contentSandbox: true,
    viewCleanup: true,
    cleanWindowClose: true,
    newTabSearch: true,
    workspaceUi: true,
    folderUi: true,
    folderDragMove: true,
    snapDragSplit: true,
    fourPaneSplit: true,
    mainFrameAddressIntegrity: true,
    addressBarWindowDrag: true,
    tabDragSort: true,
    splitCapsuleReorder: true,
    splitCapsuleGeometry: true,
    splitDetachDrag: true,
    collapsedTrafficLightSafe: true,
    arcAutoHideSidebar: true,
    arcTrafficLightHover: true,
    transparentOverlayBackdrop: true,
    arcBaseplateFrame: true,
    sidebarContextMenuLayering: true,
    splitPaneCards: true,
    neutralSplitSelection: true,
    responsivePaneResize: true,
    adaptiveReadableSplit: true,
    adaptiveDesktopRestore: true,
    adaptivePendingReverse: true,
    adaptiveStopSuppression: true,
    adaptiveNavigationSupersede: true,
    adaptiveExplicitStopRollback: true,
    adaptiveCloseRace: true,
  };

  // Exercise BrowserWindow's `closed` handler—the path that previously read a
  // destroyed webContents and displayed a native JavaScript error dialog.
  await Promise.race([
    client.send("Page.close").catch(() => null),
    delay(1_000),
  ]);
  await waitFor(async () => {
    if (child.exitCode !== null) return true;
    try {
      const list = await targets();
      return !list.some(target => target.url.endsWith("/src/renderer/index.html"));
    } catch {
      return child.exitCode !== null;
    }
  }, 5_000);
  await delay(300);
} catch (error) {
  process.stderr.write(`${output.join("")}\n${error.stack}\n`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), delay(1_500)]);
  }
  if (testServer?.listening) {
    testServer.closeAllConnections();
    await new Promise(resolve => testServer.close(resolve));
  }
  if (child && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), delay(1_500)]);
  }
  await waitFor(async () => {
    try {
      await rm(userData, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (error?.code === "ENOTEMPTY" || error?.code === "EBUSY") return false;
      throw error;
    }
  }, 3_000);
}

if (report) {
  const logs = output.join("");
  assert.doesNotMatch(
    logs,
    /Uncaught Exception|Object has been destroyed|Shell preload failed|sandboxed_renderer\.bundle\.js script failed to run|prompt\(\) is not supported/,
    `runtime emitted a fatal renderer/main-process error:\n${logs}`
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
