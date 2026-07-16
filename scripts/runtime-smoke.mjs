import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";
import { splitLayoutRects } from "../src/shared/split-ratios.mjs";

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

function splitRectsByPaneId(layout) {
  const geometry = splitLayoutRects(
    { x: 0, y: 0, width: 1_000, height: 1_000 },
    layout,
    { gap: 0, inset: 0 }
  );
  return new Map(geometry.paneIds.map((id, index) => [
    id,
    geometry.frameRects[index],
  ]));
}

function assertCapsuleMatchesSplitLayout(capsule, layout, tolerance = .08) {
  const expectedById = splitRectsByPaneId(layout);
  assert.equal(capsule.rows.length, expectedById.size);
  for (const row of capsule.rows) {
    const expected = expectedById.get(row.id);
    assert.ok(expected, `capsule contains unexpected pane ${row.id}`);
    const actualNormalized = {
      x: (row.left - capsule.groupLeft) / capsule.groupWidth,
      y: (row.top - capsule.groupTop) / capsule.groupHeight,
      width: row.width / capsule.groupWidth,
      height: row.height / capsule.groupHeight,
    };
    const expectedNormalized = {
      x: expected.x / 1_000,
      y: expected.y / 1_000,
      width: expected.width / 1_000,
      height: expected.height / 1_000,
    };
    for (const key of ["x", "y", "width", "height"]) {
      assert.ok(
        Math.abs(actualNormalized[key] - expectedNormalized[key]) <= tolerance,
        `${row.id} capsule ${key} does not match the persisted split layout`
      );
    }
  }
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
    if (requestUrl.pathname === "/download-slow") {
      const totalBytes = 64 * 1024 * 1024;
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Disposition", 'attachment; filename="chroma-smoke.bin"');
      response.setHeader("Content-Length", String(totalBytes));
      response.setHeader("Accept-Ranges", "bytes");
      let sent = 0;
      const chunk = Buffer.alloc(64 * 1024, 0x43);
      const timer = setInterval(() => {
        if (response.destroyed || response.writableEnded) {
          clearInterval(timer);
          return;
        }
        const remaining = totalBytes - sent;
        if (remaining <= 0) {
          clearInterval(timer);
          response.end();
          return;
        }
        const next = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
        response.write(next);
        sent += next.length;
      }, 40);
      timer.unref();
      response.once("close", () => clearInterval(timer));
      return;
    }
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
    const historyFixtureTitles = new Map([
      ["/history-alpha", "Alpha History Fixture"],
      ["/history-beta", "Beta History Fixture"],
      ["/history-gamma", "Gamma History Fixture"],
      ["/history-paused", "Paused History Fixture"],
      ["/history-resumed", "Resumed History Fixture"],
    ]);
    if (historyFixtureTitles.has(requestUrl.pathname)) {
      response.end(`<!doctype html><title>${historyFixtureTitles.get(requestUrl.pathname)}</title><h1>${historyFixtureTitles.get(requestUrl.pathname)}</h1>`);
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

  const stdoutClosed = once(child.stdout, "close");
  child.stdout.destroy();
  await stdoutClosed;
  await client.evaluate(`console.info(${JSON.stringify(
    "Chroma smoke: the parent stdout pipe is closed"
  )})`);
  await delay(250);
  assert.equal(child.exitCode, null);
  assert.equal(
    (await client.evaluate("window.chromaBrowser.getState()")).activeTabId,
    originalTabId
  );

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

  const paletteShortcut = initial.runtime.platform === "darwin"
    ? { metaKey: true }
    : { ctrlKey: true };
  await client.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'p',
    code: 'KeyP',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...${JSON.stringify(paletteShortcut)},
  }))`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const palette = await client.evaluate(`(() => {
      const panel = document.querySelector('#command-palette');
      const input = document.querySelector('#command-palette-input');
      const bounds = panel?.querySelector('.command-palette-surface')?.getBoundingClientRect();
      return {
        hidden: panel?.hidden,
        focused: document.activeElement === input,
        optionCount: panel?.querySelectorAll('[role="option"]').length || 0,
        visible: Boolean(bounds && bounds.width > 400 && bounds.height > 100),
      };
    })()`);
    const viewport = (
      await client.evaluate("window.chromaBrowser.getSmokeViewports()")
    )[originalTabId];
    return candidate.runtime.chromeModalOpen &&
      palette.hidden === false &&
      palette.focused &&
      palette.optionCount >= 5 &&
      palette.visible &&
      viewport?.nativeVisible === false;
  });
  await client.evaluate(`(() => {
    const input = document.querySelector('#command-palette-input');
    input.value = '历史记录';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(() => client.evaluate(`(() => {
    const options = [...document.querySelectorAll('#command-palette-results [role="option"]')];
    return options.length === 1 && options[0].textContent.includes('Open history');
  })()`));
  await client.evaluate(`document.querySelector('#command-palette-input').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  )`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const ui = await client.evaluate(`(() => ({
      paletteHidden: document.querySelector('#command-palette').hidden,
      historyHidden: document.querySelector('#history-panel').hidden,
      historyState: document.querySelector('#history-panel').dataset.state,
    }))()`);
    return candidate.runtime.chromeModalOpen &&
      ui.paletteHidden &&
      !ui.historyHidden &&
      ["ready", "empty"].includes(ui.historyState);
  });
  await client.evaluate(
    "document.querySelector('#history-panel [data-action=\"close-history\"]').click()"
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const viewport = (
      await client.evaluate("window.chromaBrowser.getSmokeViewports()")
    )[originalTabId];
    return !candidate.runtime.chromeModalOpen &&
      viewport?.nativeVisible === true &&
      await client.evaluate("document.querySelector('#history-panel').hidden");
  });

  const exampleUrl = new URL(`${baseUrl}/example`).href;
  const testTabId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(exampleUrl)} })`
  );
  assert.ok(testTabId);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === testTabId);
    return tab && !tab.loading && tab.title === "Example Domain";
  });

  const initialBookmarkUi = await client.evaluate(`(() => {
    const button = document.querySelector('[data-action="toggle-bookmark"]');
    const bounds = button?.getBoundingClientRect();
    return button ? {
      visible: bounds.width > 0 && bounds.height > 0 && getComputedStyle(button).display !== 'none',
      disabled: button.disabled,
      pressed: button.getAttribute('aria-pressed'),
      bookmarked: button.classList.contains('is-bookmarked'),
      itemCount: document.querySelectorAll('[data-bookmark-id]').length,
    } : null;
  })()`);
  assert.deepEqual(initialBookmarkUi, {
    visible: true,
    disabled: false,
    pressed: "false",
    bookmarked: false,
    itemCount: 0,
  });

  await client.evaluate(
    "document.querySelector('[data-action=\"toggle-bookmark\"]').click()"
  );
  const bookmarkedPage = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const bookmark = candidate.bookmarks?.find(item => item.url === exampleUrl);
    if (!bookmark) return false;
    const ui = await client.evaluate(`(() => {
      const button = document.querySelector('[data-action="toggle-bookmark"]');
      const item = document.querySelector('.bookmark-item');
      const open = item?.querySelector('[data-action="open-bookmark"]');
      const remove = item?.querySelector('[data-action="remove-bookmark"]');
      return {
        pressed: button?.getAttribute('aria-pressed'),
        bookmarked: button?.classList.contains('is-bookmarked'),
        itemId: item?.dataset.bookmarkId,
        openUrl: open?.dataset.url,
        removeId: remove?.dataset.bookmarkId,
      };
    })()`);
    return ui.pressed === "true" &&
      ui.bookmarked === true &&
      ui.itemId === bookmark.id &&
      ui.openUrl === bookmark.url &&
      ui.removeId === bookmark.id
      ? { state: candidate, bookmark, ui }
      : false;
  });
  assert.equal(bookmarkedPage.bookmark.url, exampleUrl);
  assert.equal(bookmarkedPage.bookmark.title, "Example Domain");
  assert.ok(bookmarkedPage.bookmark.id);
  assert.ok(Number.isFinite(bookmarkedPage.bookmark.createdAt));

  const stateFile = path.join(userData, "browser-state.json");
  const persistedBookmark = await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      return persisted.bookmarks?.find(item => item.id === bookmarkedPage.bookmark.id) || false;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  assert.equal(persistedBookmark.url, exampleUrl);
  assert.equal(persistedBookmark.title, "Example Domain");

  // Exercise ordinary pinned tabs through the real shell and native page
  // lifecycle. Pinning must promote the tab out of folder/ordinary topology,
  // keep its active treatment neutral, persist to disk, and survive reopen.
  const pinnedUrl = new URL(`${baseUrl}/pinned-smoke`).href;
  const pinnedTabId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(pinnedUrl)} })`
  );
  assert.ok(pinnedTabId);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === pinnedTabId);
    return tab &&
      !tab.loading &&
      tab.url === pinnedUrl &&
      tab.title === "Example Domain" &&
      tab.pinned === false &&
      tab.essential === false;
  });

  const pinnedSmokeFolderId = await client.evaluate(
    `window.chromaBrowser.command('folder:create', { name: 'Pinned Smoke Folder', tabIds: [${JSON.stringify(pinnedTabId)}] })`
  );
  assert.ok(pinnedSmokeFolderId);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const folder = candidate.folders.find(item => item.id === pinnedSmokeFolderId);
    const folderRowId = await client.evaluate(
      `document.querySelector('.tab-row[data-tab-id=${JSON.stringify(pinnedTabId)}]')?.closest('.folder')?.dataset.folderId || null`
    );
    return folder?.expanded &&
      folder.tabIds.includes(pinnedTabId) &&
      folderRowId === pinnedSmokeFolderId;
  });

  const pinMenuOpened = await client.evaluate(`(() => {
    const row = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(pinnedTabId)}]');
    if (!row) return false;
    const bounds = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
    }));
    return true;
  })()`);
  assert.equal(pinMenuOpened, true);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const label = await client.evaluate(
      `document.querySelector('#popover-layer [data-action="context-pin"]')?.textContent?.trim() || null`
    );
    return candidate.runtime.chromeModalOpen && label === "Pin tab";
  });
  const pinClicked = await client.evaluate(`(() => {
    const action = document.querySelector('#popover-layer [data-action="context-pin"]');
    if (!action) return false;
    action.click();
    return true;
  })()`);
  assert.equal(pinClicked, true);

  const pinnedPage = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === pinnedTabId);
    const ui = await client.evaluate(`(() => {
      const section = document.querySelector('#pinned-section');
      const grid = document.querySelector('#pinned-grid');
      const item = document.querySelector('.pinned-tab[data-tab-id=${JSON.stringify(pinnedTabId)}]');
      const main = item?.querySelector('.pinned-tab-main[data-action="select-tab"]');
      const itemStyle = item ? getComputedStyle(item) : null;
      const mainStyle = main ? getComputedStyle(main) : null;
      const activeFrame = document.querySelector('#pane-frame-layer .pane-frame.is-active');
      return {
        sectionHidden: section?.hidden,
        gridRole: grid?.getAttribute('role'),
        itemPresent: Boolean(item),
        active: item?.classList.contains('is-active'),
        selected: main?.getAttribute('aria-selected'),
        role: main?.getAttribute('role'),
        title: main?.getAttribute('title'),
        label: main?.getAttribute('aria-label'),
        ordinaryPresent: Boolean(document.querySelector('#tabs-list .tab-row[data-tab-id=${JSON.stringify(pinnedTabId)}]')),
        folderId: document.querySelector('.tab-row[data-tab-id=${JSON.stringify(pinnedTabId)}]')?.closest('.folder')?.dataset.folderId || null,
        activeFrameId: activeFrame?.dataset.tabId || null,
        outlineStyle: mainStyle?.outlineStyle || null,
        outlineWidth: mainStyle?.outlineWidth || null,
        borderWidths: itemStyle ? [
          itemStyle.borderTopWidth,
          itemStyle.borderRightWidth,
          itemStyle.borderBottomWidth,
          itemStyle.borderLeftWidth,
        ] : [],
        neutralPaint: itemStyle && mainStyle ? [
          itemStyle.backgroundColor,
          itemStyle.boxShadow,
          itemStyle.borderTopColor,
          mainStyle.backgroundColor,
          mainStyle.boxShadow,
        ].join('|') : '',
        accentChannels: getComputedStyle(document.documentElement)
          .getPropertyValue('--chroma-accent-rgb')
          .trim(),
      };
    })()`);
    return tab?.pinned === true &&
      tab.essential === false &&
      candidate.activeTabId === pinnedTabId &&
      candidate.folders.every(folder => !folder.tabIds.includes(pinnedTabId)) &&
      candidate.folders.find(folder => folder.id === pinnedSmokeFolderId)
        ?.tabIds.length === 0 &&
      ui.sectionHidden === false &&
      ui.gridRole === "tablist" &&
      ui.itemPresent &&
      ui.active &&
      ui.selected === "true" &&
      ui.role === "tab" &&
      ui.title === "Example Domain" &&
      ui.label === "Example Domain" &&
      !ui.ordinaryPresent &&
      ui.folderId === null
      ? { state: candidate, tab, ui }
      : false;
  });
  assert.equal(pinnedPage.ui.activeFrameId, null);
  assert.equal(pinnedPage.ui.outlineStyle, "none");
  assert.equal(pinnedPage.ui.outlineWidth, "0px");
  assert.deepEqual(pinnedPage.ui.borderWidths, ["0px", "0px", "0px", "0px"]);
  assert.ok(pinnedPage.ui.accentChannels);
  assert.equal(
    pinnedPage.ui.neutralPaint.replaceAll(" ", "").includes(
      pinnedPage.ui.accentChannels.replaceAll(" ", "")
    ),
    false,
    "the active pinned tab must not paint an accent/blue selection frame"
  );

  const persistedPinnedTab = await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      const tab = persisted.tabs?.find(item => item.id === pinnedTabId);
      return tab?.pinned === true && tab.essential === false ? tab : false;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  assert.equal(persistedPinnedTab.url, pinnedUrl);

  assert.equal(
    await client.evaluate(
      `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(pinnedTabId)} })`
    ),
    true
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const pinnedItemPresent = await client.evaluate(
      `Boolean(document.querySelector('.pinned-tab[data-tab-id=${JSON.stringify(pinnedTabId)}]'))`
    );
    return !candidate.tabs.some(tab => tab.id === pinnedTabId) && !pinnedItemPresent;
  });

  const reopenedPinnedTabId = await client.evaluate(
    "window.chromaBrowser.command('tab:reopen')"
  );
  assert.ok(reopenedPinnedTabId);
  assert.notEqual(reopenedPinnedTabId, pinnedTabId);
  const reopenedPinnedPage = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === reopenedPinnedTabId);
    const ui = await client.evaluate(`(() => {
      const item = document.querySelector('.pinned-tab[data-tab-id=${JSON.stringify(reopenedPinnedTabId)}]');
      const main = item?.querySelector('.pinned-tab-main');
      return {
        active: item?.classList.contains('is-active'),
        selected: main?.getAttribute('aria-selected'),
        ordinaryPresent: Boolean(document.querySelector('#tabs-list .tab-row[data-tab-id=${JSON.stringify(reopenedPinnedTabId)}]')),
      };
    })()`);
    return tab &&
      !tab.loading &&
      tab.url === pinnedUrl &&
      tab.title === "Example Domain" &&
      tab.pinned === true &&
      tab.essential === false &&
      candidate.activeTabId === reopenedPinnedTabId &&
      ui.active &&
      ui.selected === "true" &&
      !ui.ordinaryPresent
      ? { state: candidate, tab, ui }
      : false;
  });
  assert.equal(reopenedPinnedPage.tab.url, pinnedUrl);
  const persistedReopenedPinnedTab = await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      const tab = persisted.tabs?.find(item => item.id === reopenedPinnedTabId);
      return tab?.pinned === true && tab.essential === false ? tab : false;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  assert.equal(persistedReopenedPinnedTab.url, pinnedUrl);

  assert.equal(
    await client.evaluate(
      `window.chromaBrowser.command('tab:toggle-essential', { id: ${JSON.stringify(reopenedPinnedTabId)} })`
    ),
    true
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === reopenedPinnedTabId);
    const ui = await client.evaluate(`(() => ({
      essentialPresent: Boolean(document.querySelector('#essentials-grid .essential-item[data-tab-id=${JSON.stringify(reopenedPinnedTabId)}]')),
      pinnedPresent: Boolean(document.querySelector('.pinned-tab[data-tab-id=${JSON.stringify(reopenedPinnedTabId)}]')),
      ordinaryPresent: Boolean(document.querySelector('#tabs-list .tab-row[data-tab-id=${JSON.stringify(reopenedPinnedTabId)}]')),
    }))()`);
    return tab?.essential === true &&
      tab.pinned === true &&
      ui.essentialPresent &&
      !ui.pinnedPresent &&
      !ui.ordinaryPresent;
  });
  assert.equal(
    await client.evaluate(
      `window.chromaBrowser.command('tab:toggle-pin', { id: ${JSON.stringify(reopenedPinnedTabId)} })`
    ),
    false,
    "Essential tabs must reject toggle-pin"
  );
  const essentialAfterRejectedPin = await client.evaluate(
    "window.chromaBrowser.getState()"
  );
  assert.equal(
    essentialAfterRejectedPin.tabs.find(tab => tab.id === reopenedPinnedTabId)?.essential,
    true
  );
  assert.equal(
    essentialAfterRejectedPin.tabs.find(tab => tab.id === reopenedPinnedTabId)?.pinned,
    true
  );

  assert.equal(
    await client.evaluate(
      `window.chromaBrowser.command('tab:toggle-essential', { id: ${JSON.stringify(reopenedPinnedTabId)} })`
    ),
    false
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === reopenedPinnedTabId);
    const pinnedItemPresent = await client.evaluate(
      `Boolean(document.querySelector('.pinned-tab[data-tab-id=${JSON.stringify(reopenedPinnedTabId)}]'))`
    );
    return tab?.essential === false && tab.pinned === true && pinnedItemPresent;
  });

  const unpinMenuOpened = await client.evaluate(`(() => {
    const item = document.querySelector('.pinned-tab[data-tab-id=${JSON.stringify(reopenedPinnedTabId)}]');
    if (!item) return false;
    const bounds = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
    }));
    return true;
  })()`);
  assert.equal(unpinMenuOpened, true);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const label = await client.evaluate(
      `document.querySelector('#popover-layer [data-action="context-pin"]')?.textContent?.trim() || null`
    );
    return candidate.runtime.chromeModalOpen && label === "Unpin tab";
  });
  assert.equal(await client.evaluate(`(() => {
    const action = document.querySelector('#popover-layer [data-action="context-pin"]');
    if (!action) return false;
    action.click();
    return true;
  })()`), true);

  const unpinnedPage = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === reopenedPinnedTabId);
    const ui = await client.evaluate(`(() => ({
      pinnedPresent: Boolean(document.querySelector('.pinned-tab[data-tab-id=${JSON.stringify(reopenedPinnedTabId)}]')),
      ordinaryPresent: Boolean(document.querySelector('.ungrouped-tabs > .tab-row[data-tab-id=${JSON.stringify(reopenedPinnedTabId)}]')),
      folderId: document.querySelector('.tab-row[data-tab-id=${JSON.stringify(reopenedPinnedTabId)}]')?.closest('.folder')?.dataset.folderId || null,
    }))()`);
    return tab?.pinned === false &&
      tab.essential === false &&
      candidate.folders.every(folder => !folder.tabIds.includes(reopenedPinnedTabId)) &&
      !ui.pinnedPresent &&
      ui.ordinaryPresent &&
      ui.folderId === null
      ? { state: candidate, tab, ui }
      : false;
  });
  assert.equal(unpinnedPage.tab.url, pinnedUrl);
  const persistedUnpinnedTab = await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      const tab = persisted.tabs?.find(item => item.id === reopenedPinnedTabId);
      return tab?.pinned === false && tab.essential === false ? tab : false;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  assert.equal(persistedUnpinnedTab.url, pinnedUrl);
  assert.equal(
    await client.evaluate(
      `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(reopenedPinnedTabId)} })`
    ),
    true
  );
  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(testTabId)} })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return candidate.activeTabId === testTabId &&
      !candidate.tabs.some(tab => tab.id === reopenedPinnedTabId);
  });
  assert.equal(
    await client.evaluate(
      `window.chromaBrowser.command('folder:delete', { id: ${JSON.stringify(pinnedSmokeFolderId)} })`
    ),
    true
  );

  const appearanceWorkspaceId = initial.activeWorkspaceId;
  const appearanceWorkspace = initial.workspaces.find(
    item => item.id === appearanceWorkspaceId
  );
  const originalAppearance = {
    theme: initial.settings?.appearance?.theme || "system",
    reduceTransparency: Boolean(
      initial.settings?.appearance?.reduceTransparency
    ),
    workspaceColor: appearanceWorkspace?.color,
  };
  const appearanceColor = "#5b8def";
  const appearanceOpened = await client.evaluate(`(() => {
    const button = document.querySelector('#appearance-button[data-action="appearance"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(appearanceOpened, true);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const ui = await client.evaluate(`(() => {
      const button = document.querySelector('#appearance-button[data-action="appearance"]');
      const popover = document.querySelector('.appearance-popover[data-popover-kind="appearance"]');
      const form = document.querySelector('#appearance-form');
      const bounds = popover?.getBoundingClientRect();
      return {
        expanded: button?.getAttribute('aria-expanded'),
        visible: Boolean(bounds && bounds.width >= 250 && bounds.height >= 180),
        formPresent: Boolean(form),
        theme: form?.querySelector('[name="theme"]:checked')?.value,
        color: form?.querySelector('#appearance-space-color')?.value,
        reduceTransparency: form?.querySelector('#appearance-reduce-transparency')?.checked,
      };
    })()`);
    return candidate.runtime.chromeModalOpen &&
      ui.expanded === "true" &&
      ui.visible &&
      ui.formPresent &&
      ui.theme === "system" &&
      ui.color === initial.workspaces.find(item => item.id === appearanceWorkspaceId)?.color &&
      ui.reduceTransparency === false;
  });

  const submittedLightAppearance = await client.evaluate(`(() => {
    const form = document.querySelector('#appearance-form');
    const light = form?.querySelector('[name="theme"][value="light"]');
    const color = form?.querySelector('#appearance-space-color');
    const reduceTransparency = form?.querySelector('#appearance-reduce-transparency');
    if (!form || !light || !color || !reduceTransparency) return false;
    light.checked = true;
    light.dispatchEvent(new Event('change', { bubbles: true }));
    color.value = ${JSON.stringify(appearanceColor)};
    color.dispatchEvent(new Event('input', { bubbles: true }));
    color.dispatchEvent(new Event('change', { bubbles: true }));
    reduceTransparency.checked = true;
    reduceTransparency.dispatchEvent(new Event('change', { bubbles: true }));
    form.requestSubmit();
    return true;
  })()`);
  assert.equal(submittedLightAppearance, true);
  const lightAppearanceState = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const workspace = candidate.workspaces.find(item => item.id === appearanceWorkspaceId);
    const ui = await client.evaluate(`(() => {
      const app = document.querySelector('#app');
      return {
        popoverClosed: !document.querySelector('.appearance-popover[data-popover-kind="appearance"]'),
        documentTheme: document.documentElement.dataset.theme,
        colorScheme: document.documentElement.style.colorScheme,
        prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
        reducedClass: app?.classList.contains('reduced-transparency'),
        accent: getComputedStyle(app).getPropertyValue('--chroma-accent').trim().toLowerCase(),
      };
    })()`);
    return candidate.settings.appearance?.theme === "light" &&
      candidate.settings.appearance.reduceTransparency === true &&
      workspace?.color === appearanceColor &&
      !candidate.runtime.chromeModalOpen &&
      ui.popoverClosed &&
      ui.documentTheme === "light" &&
      ui.colorScheme === "light" &&
      ui.prefersDark === false &&
      ui.reducedClass &&
      ui.accent === appearanceColor
      ? candidate
      : false;
  });
  assert.equal(lightAppearanceState.settings.appearance.theme, "light");

  const persistedLightAppearance = await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      const workspace = persisted.workspaces?.find(item => item.id === appearanceWorkspaceId);
      return persisted.settings?.appearance?.theme === "light" &&
        persisted.settings.appearance.reduceTransparency === true &&
        workspace?.color === appearanceColor
        ? { appearance: persisted.settings.appearance, workspace }
        : false;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  assert.deepEqual(persistedLightAppearance.appearance, {
    theme: "light",
    reduceTransparency: true,
  });
  assert.equal(persistedLightAppearance.workspace.color, appearanceColor);

  await client.evaluate(
    `document.querySelector('#appearance-button[data-action="appearance"]').click()`
  );
  const reducedAppearanceSurface = await waitFor(() => client.evaluate(`(() => {
    const popover = document.querySelector('.appearance-popover[data-popover-kind="appearance"]');
    const form = document.querySelector('#appearance-form');
    if (!popover || !form) return false;
    const style = getComputedStyle(popover);
    const color = style.backgroundColor;
    const alphaMatch = color.match(/rgba?\\([^)]*?(?:,|\\/)\\s*([\\d.]+)\\s*\\)$/);
    const solidColor = color.startsWith('rgb(') || Number(alphaMatch?.[1]) === 1;
    const opaqueGradient = style.backgroundImage !== 'none' &&
      !style.backgroundImage.includes('rgba');
    const backdropDisabled = [style.backdropFilter, style.webkitBackdropFilter]
      .filter(Boolean)
      .every(value => value === 'none');
    const bounds = popover.getBoundingClientRect();
    return form.querySelector('[name="theme"]:checked')?.value === 'light' &&
      form.querySelector('#appearance-space-color')?.value === ${JSON.stringify(appearanceColor)} &&
      form.querySelector('#appearance-reduce-transparency')?.checked === true &&
      bounds.width >= 250 &&
      bounds.height >= 180 &&
      Number.parseFloat(style.borderRadius) >= 10 &&
      backdropDisabled &&
      (solidColor || opaqueGradient)
      ? {
          borderRadius: style.borderRadius,
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
        }
      : false;
  })()`));
  assert.ok(Number.parseFloat(reducedAppearanceSurface.borderRadius) >= 10);

  const submittedDarkAppearance = await client.evaluate(`(() => {
    const form = document.querySelector('#appearance-form');
    const dark = form?.querySelector('[name="theme"][value="dark"]');
    if (!form || !dark) return false;
    dark.checked = true;
    dark.dispatchEvent(new Event('change', { bubbles: true }));
    form.requestSubmit();
    return true;
  })()`);
  assert.equal(submittedDarkAppearance, true);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const runtime = await client.evaluate(`(() => ({
      documentTheme: document.documentElement.dataset.theme,
      colorScheme: document.documentElement.style.colorScheme,
      prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
      reducedClass: document.querySelector('#app')?.classList.contains('reduced-transparency'),
    }))()`);
    return candidate.settings.appearance?.theme === "dark" &&
      candidate.settings.appearance.reduceTransparency === true &&
      runtime.documentTheme === "dark" &&
      runtime.colorScheme === "dark" &&
      runtime.prefersDark === true &&
      runtime.reducedClass &&
      !candidate.runtime.chromeModalOpen &&
      !await client.evaluate("Boolean(document.querySelector('.appearance-popover[data-popover-kind=\"appearance\"]'))");
  });
  await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      return persisted.settings?.appearance?.theme === "dark" &&
        persisted.settings.appearance.reduceTransparency === true &&
        persisted.workspaces?.find(item => item.id === appearanceWorkspaceId)?.color === appearanceColor;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });

  await client.evaluate(`window.chromaBrowser.command('settings:set-appearance', {
    theme: ${JSON.stringify(originalAppearance.theme)},
    reduceTransparency: ${JSON.stringify(originalAppearance.reduceTransparency)},
    workspaceId: ${JSON.stringify(appearanceWorkspaceId)},
    workspaceColor: ${JSON.stringify(originalAppearance.workspaceColor)},
  })`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const workspace = candidate.workspaces.find(
      item => item.id === appearanceWorkspaceId
    );
    const runtime = await client.evaluate(`(() => ({
      documentTheme: document.documentElement.dataset.theme,
      reducedClass: document.querySelector('#app')?.classList.contains('reduced-transparency'),
    }))()`);
    let persisted;
    try {
      persisted = JSON.parse(await readFile(stateFile, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
    const persistedWorkspace = persisted.workspaces?.find(
      item => item.id === appearanceWorkspaceId
    );
    return candidate.settings.appearance?.theme === originalAppearance.theme &&
      candidate.settings.appearance.reduceTransparency === originalAppearance.reduceTransparency &&
      workspace?.color === originalAppearance.workspaceColor &&
      runtime.documentTheme === originalAppearance.theme &&
      runtime.reducedClass === originalAppearance.reduceTransparency &&
      persisted.settings?.appearance?.theme === originalAppearance.theme &&
      persisted.settings.appearance.reduceTransparency === originalAppearance.reduceTransparency &&
      persistedWorkspace?.color === originalAppearance.workspaceColor;
  });

  await client.evaluate(
    "document.querySelector('[data-action=\"open-bookmark\"]').click()"
  );
  const openedBookmarkTab = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === candidate.activeTabId);
    return candidate.tabs.length === bookmarkedPage.state.tabs.length + 1 &&
      tab?.id !== testTabId &&
      tab?.url === exampleUrl &&
      tab?.title === "Example Domain" &&
      !tab.loading
      ? tab
      : false;
  });
  assert.ok(openedBookmarkTab.id);

  const closedBookmarkTab = await client.evaluate(`(() => {
    const button = document.querySelector(
      '.tab-row[data-tab-id=${JSON.stringify(openedBookmarkTab.id)}] [data-action="close-tab"]'
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(closedBookmarkTab, true);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return candidate.activeTabId === testTabId &&
      !candidate.tabs.some(tab => tab.id === openedBookmarkTab.id)
      ? candidate
      : false;
  });

  const removedBookmark = await client.evaluate(`(() => {
    const button = document.querySelector(
      '[data-action="remove-bookmark"][data-bookmark-id=${JSON.stringify(bookmarkedPage.bookmark.id)}]'
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(removedBookmark, true);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const ui = await client.evaluate(`(() => {
      const button = document.querySelector('[data-action="toggle-bookmark"]');
      return {
        pressed: button?.getAttribute('aria-pressed'),
        bookmarked: button?.classList.contains('is-bookmarked'),
        itemCount: document.querySelectorAll('.bookmark-item').length,
      };
    })()`);
    return candidate.bookmarks?.length === 0 &&
      ui.pressed === "false" &&
      ui.bookmarked === false &&
      ui.itemCount === 0;
  });
  await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      return Array.isArray(persisted.bookmarks) && persisted.bookmarks.length === 0;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });

  const downloadUrl = new URL(`${baseUrl}/download-slow`).href;
  const downloadTabId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(downloadUrl)} })`
  );
  assert.ok(downloadTabId);
  const activeDownload = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const download = candidate.downloads.find(item => item.url === downloadUrl);
    return download && !download.terminal && download.state === "progressing"
      ? download
      : false;
  });
  assert.equal(activeDownload.filename, "chroma-smoke.bin");
  assert.equal(activeDownload.totalBytes, 64 * 1024 * 1024);
  assert.equal(
    await client.evaluate(`(() => {
      const button = document.querySelector('[data-action="downloads"]');
      if (!button) return false;
      button.click();
      return true;
    })()`),
    true
  );
  await waitFor(() => client.evaluate(`(() => {
    const popover = document.querySelector('[data-popover-kind="downloads"]');
    const row = popover?.querySelector('[data-download-state="progressing"]');
    return Boolean(
      popover &&
      row?.textContent.includes('chroma-smoke.bin') &&
      row.querySelector('[data-action="download-pause"]') &&
      row.querySelector('[data-action="download-cancel"]')
    );
  })()`));
  await client.evaluate(`document.querySelector(
    '[data-action="download-pause"][data-download-id=${JSON.stringify(activeDownload.id)}]'
  ).click()`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const download = candidate.downloads.find(item => item.id === activeDownload.id);
    const hasResume = await client.evaluate(`Boolean(document.querySelector(
      '[data-action="download-resume"][data-download-id=${JSON.stringify(activeDownload.id)}]'
    ))`);
    return download?.paused && download.state === "paused" && hasResume;
  });
  const persistedWhileActive = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(
    persistedWhileActive.downloads?.some(item => item.id === activeDownload.id),
    false,
    "active downloads must not be persisted"
  );
  await client.evaluate(`document.querySelector(
    '[data-action="download-resume"][data-download-id=${JSON.stringify(activeDownload.id)}]'
  ).click()`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const download = candidate.downloads.find(item => item.id === activeDownload.id);
    return download && !download.paused && download.state === "progressing";
  });
  await client.evaluate(`document.querySelector(
    '[data-action="download-cancel"][data-download-id=${JSON.stringify(activeDownload.id)}]'
  ).click()`);
  const cancelledDownload = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const download = candidate.downloads.find(item => item.id === activeDownload.id);
    const removable = await client.evaluate(`Boolean(document.querySelector(
      '[data-action="download-remove"][data-download-id=${JSON.stringify(activeDownload.id)}]'
    ))`);
    return download?.terminal && download.state === "cancelled" && removable
      ? download
      : false;
  });
  assert.equal(cancelledDownload.canResume, false);
  const persistedDownload = await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      return persisted.downloads?.find(item => item.id === activeDownload.id) || false;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  assert.equal(persistedDownload.state, "cancelled");
  assert.equal(persistedDownload.url, downloadUrl);
  assert.equal(Object.hasOwn(persistedDownload, "terminal"), false);
  await client.evaluate(
    "document.querySelector('[data-action=\"download-clear-finished\"]').click()"
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return !candidate.downloads.some(item => item.id === activeDownload.id) &&
      await client.evaluate(
        "document.querySelector('[data-popover-kind=\"downloads\"]')?.textContent.includes('No downloads yet')"
      );
  });
  await waitFor(async () => {
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    return !persisted.downloads?.some(item => item.id === activeDownload.id);
  });
  await client.evaluate("document.body.click()");
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return !candidate.runtime.chromeModalOpen &&
      await client.evaluate(
        "document.querySelector('[data-popover-kind=\"downloads\"]') === null"
      );
  });
  await client.evaluate(
    `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(downloadTabId)} })`
  );

  const historyFixtures = [
    {
      pathname: "/history-alpha?privacy=query-kept#private-fragment",
      title: "Alpha History Fixture",
    },
    { pathname: "/history-beta?source=address-suggestion", title: "Beta History Fixture" },
    { pathname: "/history-gamma?source=url-search", title: "Gamma History Fixture" },
  ];
  for (const fixture of historyFixtures) {
    const requestedUrl = new URL(fixture.pathname, baseUrl).href;
    const expectedUrl = new URL(requestedUrl);
    expectedUrl.username = "";
    expectedUrl.password = "";
    expectedUrl.hash = "";
    fixture.requestedUrl = requestedUrl;
    fixture.expectedUrl = expectedUrl.href;
    fixture.tabId = await client.evaluate(
      `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(requestedUrl)} })`
    );
    assert.ok(fixture.tabId);
    await waitFor(async () => {
      const candidate = await client.evaluate("window.chromaBrowser.getState()");
      const tab = candidate.tabs.find(item => item.id === fixture.tabId);
      if (!tab || tab.loading || tab.title !== fixture.title) return false;
      const result = await client.evaluate(
        `window.chromaBrowser.command('history:query', { query: ${JSON.stringify(fixture.pathname.split("?")[0].slice(1))}, range: 'all', limit: 20 })`
      );
      const item = result.items.find(entry => entry.url === fixture.expectedUrl);
      return item?.title === fixture.title ? item : false;
    });
  }

  const historyFixtureQuery = await client.evaluate(
    "window.chromaBrowser.command('history:query', { query: 'History Fixture', range: 'all', limit: 20 })"
  );
  for (const fixture of historyFixtures) {
    fixture.entry = historyFixtureQuery.items.find(item => item.url === fixture.expectedUrl);
    assert.ok(fixture.entry, `missing history fixture for ${fixture.expectedUrl}`);
    assert.equal(fixture.entry.title, fixture.title);
  }
  assert.ok(
    historyFixtureQuery.items.indexOf(historyFixtures[2].entry) <
      historyFixtureQuery.items.indexOf(historyFixtures[1].entry)
  );
  assert.ok(
    historyFixtureQuery.items.indexOf(historyFixtures[1].entry) <
      historyFixtureQuery.items.indexOf(historyFixtures[0].entry)
  );

  const historyPublicState = await client.evaluate("window.chromaBrowser.getState()");
  assert.equal(Object.hasOwn(historyPublicState, "history"), false);
  assert.ok(Number.isSafeInteger(historyPublicState.historyRevision));
  assert.ok(historyPublicState.historyCount >= historyFixtures.length);
  assert.deepEqual(Object.keys(historyPublicState.historyPreferences).sort(), [
    "clearOnExit",
    "recordingEnabled",
    "retentionDays",
  ]);

  const persistedHistoryFixtures = await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      const entries = persisted.history?.entries;
      return historyFixtures.every(fixture =>
        entries?.some(entry => entry.id === fixture.entry.id && entry.url === fixture.expectedUrl)
      )
        ? persisted.history
        : false;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  const persistedAlpha = persistedHistoryFixtures.entries.find(
    item => item.id === historyFixtures[0].entry.id
  );
  const persistedAlphaUrl = new URL(persistedAlpha.url);
  assert.equal(persistedAlphaUrl.hash, "");
  assert.equal(persistedAlphaUrl.username, "");
  assert.equal(persistedAlphaUrl.password, "");
  assert.equal(persistedAlphaUrl.searchParams.get("privacy"), "query-kept");

  const historyActiveTabId = historyFixtures[2].tabId;
  const historyViewportBeforeOpen = (
    await client.evaluate("window.chromaBrowser.getSmokeViewports()")
  )[historyActiveTabId];
  assert.equal(historyViewportBeforeOpen.nativeVisible, true);
  // CDP-injected page key events bypass Electron's `before-input-event`, so
  // exercise the same controller-to-shell notification path used by the
  // hardware shortcut without claiming synthetic keyboard coverage.
  const historyOpenRequested = await client.evaluate(
    "window.chromaBrowser.command('history:open', {})"
  );
  assert.equal(historyOpenRequested, true);
  const openedHistoryPanel = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const ui = await client.evaluate(`(() => {
      const panel = document.querySelector('#history-panel');
      const surface = panel?.querySelector('.history-surface');
      const titles = [...document.querySelectorAll('.history-row-title')].map(item => item.textContent);
      const groups = [...document.querySelectorAll('.history-date-group > h2')].map(item => item.textContent);
      const bounds = surface?.getBoundingClientRect();
      return {
        hidden: panel?.hidden,
        panelState: panel?.dataset.state,
        titles,
        groups,
        surfaceVisible: Boolean(bounds && bounds.width > 0 && bounds.height > 0),
      };
    })()`);
    const viewport = (
      await client.evaluate("window.chromaBrowser.getSmokeViewports()")
    )[historyActiveTabId];
    return candidate.activeTabId === historyActiveTabId &&
      candidate.runtime.chromeModalOpen === true &&
      ui.hidden === false &&
      ui.panelState === "ready" &&
      ui.surfaceVisible &&
      historyFixtures.every(fixture => ui.titles.includes(fixture.title)) &&
      ui.groups.length > 0 &&
      viewport?.nativeVisible === false
      ? { state: candidate, ui, viewport }
      : false;
  });
  assert.ok(
    openedHistoryPanel.ui.titles.indexOf(historyFixtures[2].title) <
      openedHistoryPanel.ui.titles.indexOf(historyFixtures[1].title)
  );
  assert.ok(
    openedHistoryPanel.ui.titles.indexOf(historyFixtures[1].title) <
      openedHistoryPanel.ui.titles.indexOf(historyFixtures[0].title)
  );

  await client.evaluate(`(() => {
    const input = document.querySelector('#history-search');
    input.value = 'Alpha History';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(() => client.evaluate(`(() => {
    const panel = document.querySelector('#history-panel');
    const titles = [...document.querySelectorAll('.history-row-title')].map(item => item.textContent);
    return panel?.dataset.state === 'ready' &&
      titles.includes('Alpha History Fixture') &&
      !titles.includes('Beta History Fixture') &&
      !titles.includes('Gamma History Fixture');
  })()`));

  await client.evaluate(`(() => {
    const input = document.querySelector('#history-search');
    input.value = 'history-gamma';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  await waitFor(() => client.evaluate(`(() => {
    const panel = document.querySelector('#history-panel');
    const rows = [...document.querySelectorAll('.history-row')];
    return panel?.dataset.state === 'ready' && rows.length === 1 &&
      rows[0].querySelector('.history-row-title')?.textContent === 'Gamma History Fixture';
  })()`));

  await client.evaluate("document.querySelector('[data-action=\"clear-history-search\"]').click()");
  await waitFor(() => client.evaluate(`(() => {
    const titles = [...document.querySelectorAll('.history-row-title')].map(item => item.textContent);
    return document.querySelector('#history-panel')?.dataset.state === 'ready' &&
      ['Alpha History Fixture', 'Beta History Fixture', 'Gamma History Fixture'].every(title => titles.includes(title));
  })()`));

  const betaHistoryId = historyFixtures[1].entry.id;
  const clickedHistoryRemove = await client.evaluate(`(() => {
    const button = document.querySelector(
      '[data-action="remove-history-item"][data-history-id=${JSON.stringify(betaHistoryId)}]'
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clickedHistoryRemove, true);
  await waitFor(async () => {
    const betaQuery = await client.evaluate(
      "window.chromaBrowser.command('history:query', { query: 'history-beta', range: 'all', limit: 20 })"
    );
    const betaSuggestion = await client.evaluate(
      "window.chromaBrowser.command('history:suggest', { query: 'history-beta', limit: 5 })"
    );
    const rowExists = await client.evaluate(
      `Boolean(document.querySelector('[data-history-id=${JSON.stringify(betaHistoryId)}]'))`
    );
    return betaQuery.items.length === 0 && betaSuggestion.items.length === 0 && !rowExists;
  });
  await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      return persisted.history?.entries?.every(item => item.id !== betaHistoryId) &&
        persisted.history.entries.some(item => item.id === historyFixtures[0].entry.id);
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });

  await client.evaluate("document.querySelector('[data-action=\"close-history\"]').click()");
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const hidden = await client.evaluate("document.querySelector('#history-panel').hidden");
    const viewport = (
      await client.evaluate("window.chromaBrowser.getSmokeViewports()")
    )[historyActiveTabId];
    return hidden &&
      candidate.activeTabId === historyActiveTabId &&
      candidate.runtime.chromeModalOpen === false &&
      viewport?.nativeVisible === true &&
      viewport.width === historyViewportBeforeOpen.width &&
      viewport.height === historyViewportBeforeOpen.height;
  });

  await client.evaluate(`(() => {
    const input = document.querySelector('#address-input');
    input.focus();
    input.value = 'history-beta';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(350);
  const deletedHistorySuggestionVisible = await client.evaluate(`
    [...document.querySelectorAll('.address-result-url')]
      .some(item => item.textContent.includes('history-beta'))
  `);
  assert.equal(deletedHistorySuggestionVisible, false);
  await client.evaluate("document.querySelector('#address-input').blur()");

  await client.evaluate("document.querySelector('[data-action=\"open-history\"]').click()");
  await waitFor(() => client.evaluate(
    "document.querySelector('#history-panel')?.dataset.state === 'ready'"
  ));
  const alphaVisitedAt = historyFixtures[0].entry.visitedAt;
  const toLocalDateTime = timestamp => {
    const date = new Date(timestamp);
    const local = new Date(timestamp - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 23);
  };
  await client.evaluate("document.querySelector('[data-action=\"open-history-clear\"]').click()");
  await waitFor(() => client.evaluate("document.querySelector('#history-clear-dialog').open"));
  await client.evaluate(`(() => {
    const radio = document.querySelector('input[name="history-clear-range"][value="custom"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#history-clear-from').value = ${JSON.stringify(toLocalDateTime(alphaVisitedAt))};
    document.querySelector('#history-clear-to').value = ${JSON.stringify(toLocalDateTime(alphaVisitedAt + 1))};
    document.querySelector('#history-clear-form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
  })()`);
  await waitFor(async () => {
    const alphaQuery = await client.evaluate(
      "window.chromaBrowser.command('history:query', { query: 'history-alpha', range: 'all', limit: 20 })"
    );
    const dialogOpen = await client.evaluate("document.querySelector('#history-clear-dialog').open");
    return !dialogOpen && alphaQuery.items.length === 0;
  });
  await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      return persisted.history?.entries?.every(item => item.id !== historyFixtures[0].entry.id);
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  await client.evaluate("document.querySelector('[data-action=\"close-history\"]').click()");

  const historyCountBeforePause = (
    await client.evaluate("window.chromaBrowser.getState()")
  ).historyCount;
  const pausedPreferences = await client.evaluate(
    "window.chromaBrowser.command('history:set-preferences', { recordingEnabled: false })"
  );
  assert.equal(pausedPreferences.preferences.recordingEnabled, false);
  const pausedHistoryUrl = new URL("/history-paused?recording=disabled#not-persisted", baseUrl).href;
  const pausedHistoryTabId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(pausedHistoryUrl)} })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === pausedHistoryTabId);
    if (!tab || tab.loading || tab.title !== "Paused History Fixture") return false;
    const result = await client.evaluate(
      "window.chromaBrowser.command('history:query', { query: 'history-paused', range: 'all', limit: 20 })"
    );
    return result.items.length === 0 &&
      candidate.historyCount === historyCountBeforePause &&
      candidate.historyPreferences.recordingEnabled === false;
  });
  await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      return persisted.history?.preferences?.recordingEnabled === false &&
        persisted.history.entries.every(item => !item.url.includes("history-paused"));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });

  const resumedPreferences = await client.evaluate(
    "window.chromaBrowser.command('history:set-preferences', { recordingEnabled: true })"
  );
  assert.equal(resumedPreferences.preferences.recordingEnabled, true);
  const resumedHistoryUrl = new URL("/history-resumed?recording=enabled#ignored-fragment", baseUrl).href;
  const expectedResumedHistoryUrl = new URL(resumedHistoryUrl);
  expectedResumedHistoryUrl.hash = "";
  const resumedHistoryTabId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(resumedHistoryUrl)} })`
  );
  const resumedHistoryEntry = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === resumedHistoryTabId);
    if (!tab || tab.loading || tab.title !== "Resumed History Fixture") return false;
    const result = await client.evaluate(
      "window.chromaBrowser.command('history:query', { query: 'history-resumed', range: 'all', limit: 20 })"
    );
    const item = result.items.find(entry => entry.url === expectedResumedHistoryUrl.href);
    return item && candidate.historyPreferences.recordingEnabled === true ? item : false;
  });
  assert.equal(new URL(resumedHistoryEntry.url).hash, "");
  await client.evaluate(
    `window.chromaBrowser.command('navigation:go', { id: ${JSON.stringify(resumedHistoryTabId)}, input: ${JSON.stringify(`${expectedResumedHistoryUrl.href}#fragment-only`)} })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === resumedHistoryTabId);
    if (tab?.url !== `${expectedResumedHistoryUrl.href}#fragment-only`) return false;
    const result = await client.evaluate(
      "window.chromaBrowser.command('history:query', { query: 'history-resumed', range: 'all', limit: 20 })"
    );
    return result.items.filter(item => item.url === expectedResumedHistoryUrl.href).length === 1;
  });
  await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      return persisted.history?.preferences?.recordingEnabled === true &&
        persisted.history.entries.some(item => item.id === resumedHistoryEntry.id) &&
        persisted.history.entries.every(item => !item.url.includes("#"));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });

  const historyTabsBeforeClear = (
    await client.evaluate("window.chromaBrowser.getState()")
  ).tabs.map(tab => tab.id);
  const resumedViewportBeforePanel = (
    await client.evaluate("window.chromaBrowser.getSmokeViewports()")
  )[resumedHistoryTabId];
  await client.evaluate("document.querySelector('[data-action=\"open-history\"]').click()");
  await waitFor(() => client.evaluate(
    "!document.querySelector('#history-panel').hidden && document.querySelector('#history-panel').dataset.state === 'ready'"
  ));
  await client.evaluate("document.querySelector('[data-action=\"open-history-clear\"]').click()");
  await waitFor(() => client.evaluate("document.querySelector('#history-clear-dialog').open"));
  const historyCountBeforeAllConfirmation = (
    await client.evaluate("window.chromaBrowser.getState()")
  ).historyCount;
  assert.ok(historyCountBeforeAllConfirmation > 0);
  const firstAllHistoryConfirmation = await client.evaluate(`(() => {
    const radio = document.querySelector('input[name="history-clear-range"][value="all"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#history-clear-submit').click();
    return {
      dialogOpen: document.querySelector('#history-clear-dialog').open,
      warningHidden: document.querySelector('#history-clear-warning').hidden,
      submitText: document.querySelector('#history-clear-submit').textContent,
    };
  })()`);
  assert.deepEqual(firstAllHistoryConfirmation, {
    dialogOpen: true,
    warningHidden: false,
    submitText: "Clear all history",
  });
  assert.equal(
    (await client.evaluate("window.chromaBrowser.getState()")).historyCount,
    historyCountBeforeAllConfirmation
  );
  await client.evaluate("document.querySelector('#history-clear-submit').click()");
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const ui = await client.evaluate(`(() => ({
      dialogOpen: document.querySelector('#history-clear-dialog').open,
      panelState: document.querySelector('#history-panel').dataset.state,
      rowCount: document.querySelectorAll('.history-row').length,
    }))()`);
    const result = await client.evaluate(
      "window.chromaBrowser.command('history:query', { query: '', range: 'all', limit: 20 })"
    );
    return candidate.historyCount === 0 &&
      ui.dialogOpen === false &&
      ui.panelState === "empty" &&
      ui.rowCount === 0 &&
      result.items.length === 0;
  });
  const clearedPersistedHistory = await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      return persisted.history?.entries?.length === 0 &&
        persisted.history.preferences.recordingEnabled === true
        ? persisted.history
        : false;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  assert.ok(clearedPersistedHistory.revision > persistedHistoryFixtures.revision);
  await client.evaluate("document.querySelector('[data-action=\"close-history\"]').click()");
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const viewport = (
      await client.evaluate("window.chromaBrowser.getSmokeViewports()")
    )[resumedHistoryTabId];
    return candidate.activeTabId === resumedHistoryTabId &&
      candidate.runtime.chromeModalOpen === false &&
      JSON.stringify(candidate.tabs.map(tab => tab.id)) === JSON.stringify(historyTabsBeforeClear) &&
      viewport?.nativeVisible === true &&
      viewport.width === resumedViewportBeforePanel.width &&
      viewport.height === resumedViewportBeforePanel.height;
  });

  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(testTabId)} })`
  );
  const historyTabIds = [
    ...historyFixtures.map(fixture => fixture.tabId),
    pausedHistoryTabId,
    resumedHistoryTabId,
  ];
  for (const id of historyTabIds) {
    await client.evaluate(
      `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(id)} })`
    );
  }
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return candidate.activeTabId === testTabId &&
      historyTabIds.every(id => !candidate.tabs.some(tab => tab.id === id));
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

  const dividerDrag = await client.evaluate(`(() => {
    const divider = document.querySelector('.pane-divider[data-split-path=""]');
    if (!divider) return null;
    const bounds = divider.getBoundingClientRect();
    const available = Number(divider.dataset.availablePixels);
    const startX = bounds.left + bounds.width / 2;
    const startY = bounds.top + bounds.height / 2;
    divider.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 81,
      button: 0,
      buttons: 1,
      clientX: startX,
      clientY: startY,
    }));
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 81,
      button: 0,
      buttons: 1,
      clientX: startX + available * .2,
      clientY: startY,
    }));
    return { startX, startY, available };
  })()`);
  assert.ok(dividerDrag?.available > 100);
  const ratioPreview = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.tabIds.includes(testTabId));
    const firstId = group?.tabIds[0];
    const secondId = group?.tabIds[1];
    const first = candidate.runtime.viewBounds[firstId];
    const second = candidate.runtime.viewBounds[secondId];
    const capsule = await client.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.split-tab-group.is-current > .tab-row')]
        .map(row => ({ id: row.dataset.tabId, width: row.getBoundingClientRect().width }));
      return rows.length === 2 ? rows : null;
    })()`);
    const capsuleById = new Map(capsule?.map(row => [row.id, row.width]) || []);
    return group?.layout?.ratio === .5 &&
      first?.width > second?.width * 1.8 &&
      capsuleById.get(firstId) > capsuleById.get(secondId) * 1.8
      ? { group, first, second, capsule }
      : false;
  });
  assert.equal(ratioPreview.group.layout.ratio, .5, "drag preview must not mutate durable state");
  assert.ok(ratioPreview.capsule[0].width !== ratioPreview.capsule[1].width);
  await client.evaluate(`document.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    pointerId: 81,
    button: 0,
    buttons: 0,
    clientX: ${dividerDrag.startX + dividerDrag.available * .2},
    clientY: ${dividerDrag.startY},
  }))`);
  const committedRatio = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.tabIds.includes(testTabId));
    const capsule = await client.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.split-tab-group.is-current > .tab-row')]
        .map(row => row.getBoundingClientRect().width);
      return rows.length === 2 ? rows : null;
    })()`);
    return group?.layout?.ratio > .69 && group.layout.ratio < .71 &&
      capsule?.[0] > capsule?.[1] * 1.8
      ? { group, capsule }
      : false;
  });
  assert.ok(committedRatio.capsule[0] > committedRatio.capsule[1]);
  const persistedSplitRatio = await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      const group = persisted.splitGroups?.find(item => item.id === committedRatio.group.id);
      return group?.layout?.ratio > .69 && group.layout.ratio < .71 ? group.layout.ratio : false;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  assert.ok(persistedSplitRatio > .69);
  await client.evaluate(
    `window.chromaBrowser.command('split:set-ratio', { groupId: ${JSON.stringify(committedRatio.group.id)}, path: [], ratio: .5 })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.id === committedRatio.group.id);
    return group?.layout?.ratio === .5;
  });

  // A completed live preview must leave the ratio tree usable by every tab
  // topology operation. Swap twice to restore the original order, insert a
  // disposable pane next to a precise leaf, then detach it again.
  const postPreviewOrder = await client.evaluate(
    `window.chromaBrowser.getState().then(state => state.splitGroups.find(group => group.id === ${JSON.stringify(committedRatio.group.id)})?.tabIds || [])`
  );
  assert.equal(postPreviewOrder.length, 2);
  await client.evaluate(
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(postPreviewOrder[0])}, targetId: ${JSON.stringify(postPreviewOrder[1])}, direction: 'row', placement: 'after' })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.id === committedRatio.group.id);
    return JSON.stringify(group?.tabIds) === JSON.stringify([...postPreviewOrder].reverse());
  });
  await client.evaluate(
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(postPreviewOrder[0])}, targetId: ${JSON.stringify(postPreviewOrder[1])}, direction: 'row', placement: 'after' })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.id === committedRatio.group.id);
    return JSON.stringify(group?.tabIds) === JSON.stringify(postPreviewOrder);
  });
  const postPreviewProbeId = await client.evaluate(
    "window.chromaBrowser.command('tab:create', { activate: false })"
  );
  await client.evaluate(
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(postPreviewProbeId)}, targetId: ${JSON.stringify(postPreviewOrder[0])}, direction: 'column', placement: 'after' })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.id === committedRatio.group.id);
    return group?.tabIds.length === 3 && group.tabIds.includes(postPreviewProbeId);
  });
  await client.evaluate(
    `window.chromaBrowser.command('split:detach', { id: ${JSON.stringify(postPreviewProbeId)} })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.id === committedRatio.group.id);
    const native = candidate.runtime.viewBounds[postPreviewProbeId];
    const content = candidate.runtime.contentBounds;
    return candidate.activeTabId === postPreviewProbeId &&
      group?.tabIds.length === 2 &&
      !group.tabIds.includes(postPreviewProbeId) &&
      native?.x === content.x &&
      native?.y === content.y &&
      native?.width === content.width &&
      native?.height === content.height;
  });
  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(testTabId)} })`
  );
  await client.evaluate(
    `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(postPreviewProbeId)} })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return candidate.activeTabId === testTabId &&
      !candidate.tabs.some(tab => tab.id === postPreviewProbeId);
  });

  // Ordinary tabs sort around a split capsule as one logical block. Moving a
  // row before/after either split member must never insert it between panes.
  const splitBlockProbeId = await client.evaluate(
    "window.chromaBrowser.command('tab:create', { activate: false })"
  );
  await waitFor(() => client.evaluate(
    `Boolean(document.querySelector('.tab-row[data-tab-id=${JSON.stringify(splitBlockProbeId)}]'))`
  ));
  await client.evaluate(
    `window.chromaBrowser.command('tab:reorder', { id: ${JSON.stringify(splitBlockProbeId)}, targetId: ${JSON.stringify(testTabId)}, position: 'before' })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.tabIds.includes(testTabId));
    const probeIndex = candidate.tabs.findIndex(item => item.id === splitBlockProbeId);
    const groupIndexes = group?.tabIds.map(id =>
      candidate.tabs.findIndex(item => item.id === id)
    ) || [];
    const domBefore = await client.evaluate(`(() => {
      const probe = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(splitBlockProbeId)}]');
      const group = document.querySelector('.split-tab-group:has(.tab-row[data-tab-id=${JSON.stringify(testTabId)}])');
      return Boolean(probe && group && (probe.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING));
    })()`);
    return groupIndexes.length === 2 &&
      groupIndexes.every(index => probeIndex < index) &&
      domBefore;
  });
  await client.evaluate(
    `window.chromaBrowser.command('tab:reorder', { id: ${JSON.stringify(splitBlockProbeId)}, targetId: ${JSON.stringify(splitTabId)}, position: 'after' })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.tabIds.includes(testTabId));
    const probeIndex = candidate.tabs.findIndex(item => item.id === splitBlockProbeId);
    const groupIndexes = group?.tabIds.map(id =>
      candidate.tabs.findIndex(item => item.id === id)
    ) || [];
    const domAfter = await client.evaluate(`(() => {
      const probe = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(splitBlockProbeId)}]');
      const group = document.querySelector('.split-tab-group:has(.tab-row[data-tab-id=${JSON.stringify(testTabId)}])');
      return Boolean(probe && group && (group.compareDocumentPosition(probe) & Node.DOCUMENT_POSITION_FOLLOWING));
    })()`);
    return groupIndexes.length === 2 &&
      groupIndexes.every(index => probeIndex > index) &&
      domAfter;
  });
  await client.evaluate(
    `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(splitBlockProbeId)} })`
  );

  // Closing the active pane commits a valid active tab before native teardown.
  // A three-pane grid must normalize back to a two-pane row and prefer a split
  // sibling rather than an unrelated MRU tab.
  const atomicCloseTabId = await client.evaluate(
    "window.chromaBrowser.command('tab:create')"
  );
  await client.evaluate(
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(atomicCloseTabId)}, targetId: ${JSON.stringify(testTabId)}, direction: 'row', placement: 'after' })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.tabIds.includes(atomicCloseTabId));
    return candidate.activeTabId === atomicCloseTabId &&
      group?.tabIds.length === 3 &&
      group.direction === "grid";
  });
  await client.evaluate(`(() => {
    globalThis.__chromaInvalidCloseStates = [];
    globalThis.__chromaCloseStateUnsubscribe?.();
    globalThis.__chromaCloseStateUnsubscribe = window.chromaBrowser.onStateChanged(candidate => {
      if (!candidate.tabs.some(tab => tab.id === candidate.activeTabId)) {
        globalThis.__chromaInvalidCloseStates.push({
          activeTabId: candidate.activeTabId,
          tabIds: candidate.tabs.map(tab => tab.id),
        });
      }
    });
  })()`);
  await client.evaluate(
    `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(atomicCloseTabId)} })`
  );
  const atomicCloseState = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.tabIds.includes(testTabId));
    const invalidStates = await client.evaluate(
      "globalThis.__chromaInvalidCloseStates"
    );
    return candidate.activeTabId === testTabId &&
      candidate.tabs.some(tab => tab.id === candidate.activeTabId) &&
      !candidate.tabs.some(tab => tab.id === atomicCloseTabId) &&
      !candidate.runtime.viewBounds[atomicCloseTabId] &&
      group?.tabIds.length === 2 &&
      group.direction === "row" &&
      invalidStates.length === 0
      ? candidate
      : false;
  });
  assert.ok(atomicCloseState.tabs.some(tab => tab.id === testTabId));
  await client.evaluate(`(() => {
    globalThis.__chromaCloseStateUnsubscribe?.();
    delete globalThis.__chromaCloseStateUnsubscribe;
  })()`);

  // Promoting a split member to Essential first detaches it from library
  // topology, leaving one full-size native page and no stale split capsule.
  const essentialEnabled = await client.evaluate(
    `window.chromaBrowser.command('tab:toggle-essential', { id: ${JSON.stringify(splitTabId)} })`
  );
  assert.equal(essentialEnabled, true);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const viewports = await client.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    );
    const content = candidate.runtime.contentBounds;
    const activeBounds = candidate.runtime.viewBounds[testTabId];
    const ui = await client.evaluate(`(() => ({
      essentialRow: Boolean(document.querySelector('#essentials-grid .essential-item[data-tab-id=${JSON.stringify(splitTabId)}]')),
      splitCapsules: document.querySelectorAll('.split-tab-group').length,
      paneFrames: document.querySelectorAll('#pane-frame-layer .pane-frame').length,
    }))()`);
    return candidate.splitGroups.length === 0 &&
      candidate.tabs.find(tab => tab.id === splitTabId)?.essential === true &&
      candidate.activeTabId === testTabId &&
      ui.essentialRow &&
      ui.splitCapsules === 0 &&
      ui.paneFrames === 0 &&
      viewports[testTabId]?.nativeVisible === true &&
      viewports[splitTabId]?.nativeVisible === false &&
      activeBounds?.x === content.x &&
      activeBounds?.y === content.y &&
      activeBounds?.width === content.width &&
      activeBounds?.height === content.height;
  });
  const essentialDisabled = await client.evaluate(
    `window.chromaBrowser.command('tab:toggle-essential', { id: ${JSON.stringify(splitTabId)} })`
  );
  assert.equal(essentialDisabled, false);
  const splitTabUnpinned = await client.evaluate(
    `window.chromaBrowser.command('tab:toggle-pin', { id: ${JSON.stringify(splitTabId)} })`
  );
  assert.equal(splitTabUnpinned, false);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const tab = candidate.tabs.find(item => item.id === splitTabId);
    return tab?.essential === false && tab.pinned === false;
  });
  await client.evaluate(
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(splitTabId)}, targetId: ${JSON.stringify(testTabId)}, direction: 'row', placement: 'before' })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.tabIds.includes(testTabId));
    return group?.tabIds.length === 2 && group.tabIds.includes(splitTabId);
  });

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
  const folderWorkspaceState = await client.evaluate(
    "window.chromaBrowser.getState()"
  );
  const folderWorkspaceId = folderWorkspaceState.activeWorkspaceId;
  const folderWorkspaceBaseId = folderWorkspaceState.activeTabId;

  await client.evaluate(
    "document.querySelector('[data-action=\"new-folder\"]').click()"
  );
  await waitFor(() => client.evaluate("document.querySelector('#text-prompt').open"));
  await client.evaluate(`(() => {
    document.querySelector('#text-prompt-input').value = 'Smoke Folder';
    document.querySelector('#text-prompt-form').requestSubmit();
    return true;
  })()`);
  const emptyFolder = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const folder = candidate.folders.find(item => item.name === "Smoke Folder");
    if (!folder) return false;
    const ui = await client.evaluate(`(() => {
      const folder = document.querySelector('.folder[data-folder-id=${JSON.stringify(folder.id)}]');
      const header = folder?.querySelector('.folder-header');
      const dropZone = folder?.querySelector('.folder-tabs[data-drop-zone="folder"]');
      const emptyDrop = dropZone?.querySelector('.folder-empty-drop');
      const count = folder?.querySelector('.folder-count');
      const bounds = dropZone?.getBoundingClientRect();
      return {
        empty: folder?.classList.contains('is-empty'),
        count: count?.textContent?.trim(),
        expanded: header?.getAttribute('aria-expanded'),
        controls: header?.getAttribute('aria-controls'),
        dropZoneId: dropZone?.id,
        dropFolderId: dropZone?.dataset.folderId,
        emptyDrop: emptyDrop?.textContent?.trim(),
        dropHeight: bounds?.height || 0,
      };
    })()`);
    return folder.workspaceId === folderWorkspaceId &&
      folder.expanded &&
      folder.tabIds.length === 0 &&
      ui.empty &&
      ui.count === "0" &&
      ui.expanded === "true" &&
      ui.controls === ui.dropZoneId &&
      ui.dropFolderId === folder.id &&
      ui.emptyDrop === "Drop tabs here" &&
      ui.dropHeight >= 30
      ? { state: candidate, folder, ui }
      : false;
  });

  const smokeFolderId = emptyFolder.folder.id;
  await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      const folder = persisted.folders?.find(item => item.id === smokeFolderId);
      return folder?.expanded === true && folder.tabIds?.length === 0;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });

  await client.evaluate(
    `document.querySelector('.folder[data-folder-id=${JSON.stringify(smokeFolderId)}] .folder-menu-button').click()`
  );
  const folderPopover = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const ui = await client.evaluate(`(() => {
      const layer = document.querySelector('#popover-layer');
      const content = document.querySelector('.content-shell');
      const menu = document.querySelector('.folder-popover[data-folder-id=${JSON.stringify(smokeFolderId)}][role="menu"]');
      const bounds = menu?.getBoundingClientRect();
      return {
        visible: Boolean(bounds && bounds.width > 100 && bounds.height > 80),
        layerZ: Number.parseInt(getComputedStyle(layer).zIndex, 10) || 0,
        contentZ: Number.parseInt(getComputedStyle(content).zIndex, 10) || 0,
        actions: [...(menu?.querySelectorAll('[role="menuitem"]') || [])]
          .map(item => item.dataset.action),
      };
    })()`);
    const viewport = (
      await client.evaluate("window.chromaBrowser.getSmokeViewports()")
    )[folderWorkspaceBaseId];
    return candidate.runtime.chromeModalOpen &&
      viewport?.nativeVisible === false &&
      ui.visible &&
      ui.layerZ > ui.contentZ
      ? ui
      : false;
  });
  assert.deepEqual(folderPopover.actions, [
    "folder-menu-toggle",
    "folder-rename",
    "folder-delete",
  ]);
  await client.evaluate(
    `document.querySelector('.folder-popover[data-folder-id=${JSON.stringify(smokeFolderId)}] [data-action="folder-rename"]').click()`
  );
  const renamePrompt = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const ui = await client.evaluate(`(() => {
      const prompt = document.querySelector('#text-prompt');
      const input = document.querySelector('#text-prompt-input');
      return {
        open: prompt.open,
        title: document.querySelector('#text-prompt-title').textContent,
        required: input.required,
        maxLength: input.maxLength,
        value: input.value,
      };
    })()`);
    return candidate.runtime.chromeModalOpen && ui.open ? ui : false;
  });
  assert.deepEqual(renamePrompt, {
    open: true,
    title: "Rename folder",
    required: true,
    maxLength: 80,
    value: "Smoke Folder",
  });
  const renamedFolderName = "F".repeat(80);
  await client.evaluate(`(() => {
    document.querySelector('#text-prompt-input').value = ${JSON.stringify(renamedFolderName)};
    document.querySelector('#text-prompt-form').requestSubmit();
  })()`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const folder = candidate.folders.find(item => item.id === smokeFolderId);
    const domName = await client.evaluate(
      `document.querySelector('.folder[data-folder-id=${JSON.stringify(smokeFolderId)}] .folder-name')?.textContent || null`
    );
    return !candidate.runtime.chromeModalOpen &&
      folder?.name === renamedFolderName &&
      domName === renamedFolderName;
  });
  const folderDragTabId = await client.evaluate(
    "window.chromaBrowser.command('tab:create', { url: 'chroma://newtab/' })"
  );
  await waitFor(() => client.evaluate(
    `Boolean(document.querySelector('.tab-row[data-tab-id=${JSON.stringify(folderDragTabId)}]'))`
  ));
  await client.evaluate(`(() => {
    const source = document.querySelector('.tab-row[data-tab-id=${JSON.stringify(folderDragTabId)}]');
    const drop = document.querySelector('.folder[data-folder-id=${JSON.stringify(smokeFolderId)}] .folder-empty-drop');
    const sourceBounds = source.getBoundingClientRect();
    const dropBounds = drop.getBoundingClientRect();
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
      clientX: dropBounds.left + dropBounds.width / 2,
      clientY: dropBounds.top + dropBounds.height / 2,
    }));
    document.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      pointerId: 61,
      button: 0,
      buttons: 0,
      clientX: dropBounds.left + dropBounds.width / 2,
      clientY: dropBounds.top + dropBounds.height / 2,
    }));
    return true;
  })()`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const folder = candidate.folders.find(item => item.id === smokeFolderId);
    const domFolderId = await client.evaluate(
      `document.querySelector('.tab-row[data-tab-id=${JSON.stringify(folderDragTabId)}]')?.closest('.folder')?.dataset.folderId || null`
    );
    const ui = await client.evaluate(`(() => {
      const folder = document.querySelector('.folder[data-folder-id=${JSON.stringify(smokeFolderId)}]');
      return {
        empty: folder?.classList.contains('is-empty'),
        count: folder?.querySelector('.folder-count')?.textContent?.trim(),
        dropFolderId: folder?.querySelector('.folder-tabs[data-drop-zone="folder"]')?.dataset.folderId,
      };
    })()`);
    return folder?.expanded &&
      folder.tabIds.length === 1 &&
      folder.tabIds[0] === folderDragTabId &&
      domFolderId === smokeFolderId &&
      !ui.empty &&
      ui.count === "1" &&
      ui.dropFolderId === smokeFolderId &&
      !candidate.runtime.tabDragActive;
  });
  await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      return persisted.folders?.find(item => item.id === smokeFolderId)
        ?.tabIds?.[0] === folderDragTabId;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
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
    const ui = await client.evaluate(`(() => {
      const folder = document.querySelector('.folder[data-folder-id=${JSON.stringify(smokeFolderId)}]');
      const drop = folder?.querySelector('.folder-tabs[data-drop-zone="folder"]');
      return {
        present: Boolean(folder),
        empty: folder?.classList.contains('is-empty'),
        count: folder?.querySelector('.folder-count')?.textContent?.trim(),
        dropFolderId: drop?.dataset.folderId,
        emptyDrop: drop?.querySelector('.folder-empty-drop')?.textContent?.trim(),
      };
    })()`);
    return folder &&
      folder.expanded &&
      folder.tabIds.length === 0 &&
      inUngroupedZone &&
      ui.present &&
      ui.empty &&
      ui.count === "0" &&
      ui.dropFolderId === smokeFolderId &&
      ui.emptyDrop === "Drop tabs here" &&
      !candidate.runtime.tabDragActive;
  });
  await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      const folder = persisted.folders?.find(item => item.id === smokeFolderId);
      return folder?.name === renamedFolderName && folder.tabIds?.length === 0;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });

  const pinnedFolderGuardId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(`${baseUrl}/folder-pinned-guard`)}, pinned: true })`
  );
  const essentialFolderGuardId = await client.evaluate(
    `window.chromaBrowser.command('tab:create', { url: ${JSON.stringify(`${baseUrl}/folder-essential-guard`)}, essential: true })`
  );
  assert.ok(pinnedFolderGuardId);
  assert.ok(essentialFolderGuardId);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const pinned = candidate.tabs.find(tab => tab.id === pinnedFolderGuardId);
    const essential = candidate.tabs.find(tab => tab.id === essentialFolderGuardId);
    return pinned && !pinned.loading && pinned.pinned && !pinned.essential &&
      essential && !essential.loading && essential.pinned && essential.essential;
  });
  const folderGuardBaseline = await client.evaluate(
    "window.chromaBrowser.getState()"
  );
  const rejectedLibraryMoves = await client.evaluate(`Promise.all([
    window.chromaBrowser.command('tab:reorder', { id: ${JSON.stringify(pinnedFolderGuardId)}, targetId: null, position: 'after', folderId: ${JSON.stringify(smokeFolderId)} }),
    window.chromaBrowser.command('tab:reorder', { id: ${JSON.stringify(essentialFolderGuardId)}, targetId: null, position: 'after', folderId: ${JSON.stringify(smokeFolderId)} }),
    window.chromaBrowser.command('folder:create', { name: 'Forbidden Folder', tabIds: [${JSON.stringify(pinnedFolderGuardId)}, ${JSON.stringify(essentialFolderGuardId)}] }),
    window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(pinnedFolderGuardId)}, targetId: ${JSON.stringify(folderWorkspaceBaseId)}, direction: 'row', placement: 'after' }),
    window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(essentialFolderGuardId)}, targetId: ${JSON.stringify(folderWorkspaceBaseId)}, direction: 'row', placement: 'after' }),
  ])`);
  assert.deepEqual(rejectedLibraryMoves, [false, false, null, false, false]);
  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(pinnedFolderGuardId)} })`
  );
  assert.equal(
    await client.evaluate("window.chromaBrowser.command('split:active', { direction: 'row' })"),
    null
  );
  const pinnedGuardMenuOpened = await client.evaluate(`(() => {
    const item = document.querySelector('.pinned-tab[data-tab-id=${JSON.stringify(pinnedFolderGuardId)}]');
    if (!item) return false;
    const bounds = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
    }));
    return true;
  })()`);
  assert.equal(pinnedGuardMenuOpened, true);
  const pinnedGuardMenu = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const ui = await client.evaluate(`(() => ({
      open: Boolean(document.querySelector('#popover-layer .popover')),
      folder: Boolean(document.querySelector('#popover-layer [data-action="context-folder"]')),
      split: Boolean(document.querySelector('#popover-layer [data-action^="context-split"]')),
      unsplit: Boolean(document.querySelector('#popover-layer [data-action="context-unsplit"]')),
    }))()`);
    return candidate.runtime.chromeModalOpen && ui.open ? ui : false;
  });
  assert.deepEqual(pinnedGuardMenu, {
    open: true,
    folder: false,
    split: false,
    unsplit: false,
  });
  await client.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }))`);
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return !candidate.runtime.chromeModalOpen &&
      !await client.evaluate("Boolean(document.querySelector('#popover-layer .popover'))");
  });

  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(essentialFolderGuardId)} })`
  );
  assert.equal(
    await client.evaluate("window.chromaBrowser.command('split:active', { direction: 'row' })"),
    null
  );
  const essentialContextHidden = await client.evaluate(`(() => {
    const item = document.querySelector('.essential-item[data-tab-id=${JSON.stringify(essentialFolderGuardId)}]');
    if (!item) return false;
    const bounds = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
    }));
    return !document.querySelector('#popover-layer .popover');
  })()`);
  assert.equal(essentialContextHidden, true);
  const folderGuardState = await client.evaluate(
    "window.chromaBrowser.getState()"
  );
  assert.deepEqual(
    folderGuardState.folders.find(folder => folder.id === smokeFolderId)?.tabIds,
    []
  );
  assert.equal(
    folderGuardState.folders.some(folder => folder.name === "Forbidden Folder"),
    false
  );
  assert.deepEqual(folderGuardState.splitGroups, folderGuardBaseline.splitGroups);
  await client.evaluate(
    `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(essentialFolderGuardId)} })`
  );
  await client.evaluate(
    `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(pinnedFolderGuardId)} })`
  );

  assert.equal(
    await client.evaluate(
      `window.chromaBrowser.command('tab:reorder', { id: ${JSON.stringify(folderDragTabId)}, targetId: null, position: 'after', folderId: ${JSON.stringify(smokeFolderId)} })`
    ),
    true
  );
  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(folderDragTabId)} })`
  );
  const folderDeleteBefore = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const folder = candidate.folders.find(item => item.id === smokeFolderId);
    const viewport = (
      await client.evaluate("window.chromaBrowser.getSmokeViewports()")
    )[folderDragTabId];
    return folder?.tabIds.length === 1 &&
      folder.tabIds[0] === folderDragTabId &&
      candidate.activeTabId === folderDragTabId &&
      viewport?.nativeVisible === true
      ? { state: candidate, viewport }
      : false;
  });
  await client.evaluate(
    `document.querySelector('.folder[data-folder-id=${JSON.stringify(smokeFolderId)}] .folder-menu-button').click()`
  );
  await waitFor(() => client.evaluate(
    `Boolean(document.querySelector('.folder-popover[data-folder-id=${JSON.stringify(smokeFolderId)}] [data-action="folder-delete"]'))`
  ));
  await client.evaluate(
    `document.querySelector('.folder-popover[data-folder-id=${JSON.stringify(smokeFolderId)}] [data-action="folder-delete"]').click()`
  );
  const deleteConfirmation = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const ui = await client.evaluate(`(() => ({
      open: document.querySelector('#text-prompt').open,
      title: document.querySelector('#text-prompt-title').textContent,
      message: document.querySelector('#text-prompt-description').textContent,
      inputHidden: document.querySelector('#text-prompt-input').hidden,
      submit: document.querySelector('#text-prompt-submit').textContent,
    }))()`);
    return candidate.runtime.chromeModalOpen && ui.open ? ui : false;
  });
  assert.equal(deleteConfirmation.title, "Delete folder?");
  assert.match(deleteConfirmation.message, /only removes the folder/i);
  assert.match(deleteConfirmation.message, /1 tab will stay open/i);
  assert.equal(deleteConfirmation.inputHidden, true);
  assert.equal(deleteConfirmation.submit, "Delete folder");
  await client.evaluate(
    "document.querySelector('#text-prompt-form').requestSubmit()"
  );
  const folderDeleteAfter = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const viewport = (
      await client.evaluate("window.chromaBrowser.getSmokeViewports()")
    )[folderDragTabId];
    const ui = await client.evaluate(`(() => ({
      folderPresent: Boolean(document.querySelector('.folder[data-folder-id=${JSON.stringify(smokeFolderId)}]')),
      ungrouped: Boolean(document.querySelector('.ungrouped-tabs > .tab-row[data-tab-id=${JSON.stringify(folderDragTabId)}]')),
    }))()`);
    return !candidate.runtime.chromeModalOpen &&
      !candidate.folders.some(folder => folder.id === smokeFolderId) &&
      candidate.tabs.some(tab => tab.id === folderDragTabId) &&
      candidate.runtime.managedViewCount === folderDeleteBefore.state.runtime.managedViewCount &&
      candidate.runtime.liveWebContentsCount === folderDeleteBefore.state.runtime.liveWebContentsCount &&
      viewport?.nativeVisible === true &&
      viewport.url === folderDeleteBefore.viewport.url &&
      !ui.folderPresent &&
      ui.ungrouped
      ? { state: candidate, viewport, ui }
      : false;
  });
  assert.equal(folderDeleteAfter.viewport.url, folderDeleteBefore.viewport.url);
  await waitFor(async () => {
    try {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      return !persisted.folders?.some(folder => folder.id === smokeFolderId) &&
        persisted.tabs?.some(tab => tab.id === folderDragTabId);
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  await client.evaluate(
    `window.chromaBrowser.command('tab:close', { id: ${JSON.stringify(folderDragTabId)} })`
  );
  await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    return candidate.activeTabId === folderWorkspaceBaseId &&
      !candidate.tabs.some(tab => tab.id === folderDragTabId) &&
      !candidate.tabs.some(tab => tab.id === pinnedFolderGuardId) &&
      !candidate.tabs.some(tab => tab.id === essentialFolderGuardId);
  });

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
  const twoPaneGridState = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.tabIds.includes(snapTargetId));
    return group?.tabIds.length === 2 &&
      candidate.runtime.viewBounds[snapTargetId] &&
      candidate.runtime.viewBounds[snapSourceId]
      ? candidate
      : false;
  });
  const targetBeforeThirdBounds = twoPaneGridState.runtime.viewBounds[snapTargetId];
  const sourceBeforeThirdBounds = twoPaneGridState.runtime.viewBounds[snapSourceId];

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
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(thirdPaneId)}, targetId: ${JSON.stringify(snapTargetId)}, direction: 'column', placement: 'after' })`
  );
  const threePaneInsertionState = await waitFor(async () => {
    const candidate = await client.evaluate("window.chromaBrowser.getState()");
    const group = candidate.splitGroups.find(item => item.tabIds.includes(snapTargetId));
    const layout = group?.layout;
    return group?.tabIds.length === 3 &&
      layout?.type === "split" &&
      layout.direction === "row" &&
      layout.first?.type === "split" &&
      layout.first.direction === "column" &&
      layout.first.first?.paneId === snapTargetId &&
      layout.first.second?.paneId === thirdPaneId &&
      layout.second?.type === "pane" &&
      layout.second.paneId === snapSourceId
      ? candidate
      : false;
  });
  const targetAfterThirdBounds = threePaneInsertionState.runtime.viewBounds[snapTargetId];
  const thirdAfterThirdBounds = threePaneInsertionState.runtime.viewBounds[thirdPaneId];
  const sourceBeforeFourthBounds = threePaneInsertionState.runtime.viewBounds[snapSourceId];
  assert.deepEqual(sourceBeforeFourthBounds, sourceBeforeThirdBounds);
  assert.equal(targetAfterThirdBounds.x, targetBeforeThirdBounds.x);
  assert.equal(targetAfterThirdBounds.width, targetBeforeThirdBounds.width);
  assert.ok(targetAfterThirdBounds.height < targetBeforeThirdBounds.height);
  assert.equal(thirdAfterThirdBounds.x, targetAfterThirdBounds.x);
  assert.equal(thirdAfterThirdBounds.width, targetAfterThirdBounds.width);
  assert.ok(thirdAfterThirdBounds.y > targetAfterThirdBounds.y);
  assert.ok(sourceBeforeFourthBounds.height > targetAfterThirdBounds.height * 1.8);
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
    `window.chromaBrowser.command('split:tabs', { sourceId: ${JSON.stringify(fourthPaneId)}, targetId: ${JSON.stringify(snapSourceId)}, direction: 'column', placement: 'after' })`
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
  assert.equal(fourPaneGroup.layout?.type, "split");
  assert.equal(fourPaneGroup.layout?.direction, "row");
  assert.deepEqual(
    [
      fourPaneGroup.layout?.first?.type,
      fourPaneGroup.layout?.first?.direction,
      fourPaneGroup.layout?.first?.first?.paneId,
      fourPaneGroup.layout?.first?.second?.paneId,
    ],
    ["split", "column", snapTargetId, thirdPaneId]
  );
  assert.deepEqual(
    [
      fourPaneGroup.layout?.second?.type,
      fourPaneGroup.layout?.second?.direction,
      fourPaneGroup.layout?.second?.first?.paneId,
      fourPaneGroup.layout?.second?.second?.paneId,
    ],
    ["split", "column", snapSourceId, fourthPaneId]
  );
  assert.deepEqual(
    fourPaneState.runtime.viewBounds[snapTargetId],
    targetAfterThirdBounds
  );
  assert.deepEqual(
    fourPaneState.runtime.viewBounds[thirdPaneId],
    thirdAfterThirdBounds
  );
  const sourceAfterFourthBounds = fourPaneState.runtime.viewBounds[snapSourceId];
  const fourthAfterSplitBounds = fourPaneState.runtime.viewBounds[fourthPaneId];
  assert.equal(sourceAfterFourthBounds.x, sourceBeforeFourthBounds.x);
  assert.equal(sourceAfterFourthBounds.width, sourceBeforeFourthBounds.width);
  assert.ok(sourceAfterFourthBounds.height < sourceBeforeFourthBounds.height);
  assert.equal(fourthAfterSplitBounds.x, sourceAfterFourthBounds.x);
  assert.equal(fourthAfterSplitBounds.width, sourceAfterFourthBounds.width);
  assert.ok(fourthAfterSplitBounds.y > sourceAfterFourthBounds.y);

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
      groupLeft: groupBounds.left,
      groupTop: groupBounds.top,
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
  assertCapsuleMatchesSplitLayout(
    fourCapsuleGeometry,
    fourPaneGroup.layout,
    .06
  );
  assert.ok(fourCapsuleGeometry.rows.every(row =>
    Math.abs(row.width - fourCapsuleGeometry.rows[0].width) <= 1 &&
    Math.abs(row.height - fourCapsuleGeometry.rows[0].height) <= 1
  ));
  const capsuleColumns = [...new Set(
    fourCapsuleGeometry.rows.map(row => Math.round(row.left))
  )].sort((left, right) => left - right);
  const capsuleRows = [...new Set(
    fourCapsuleGeometry.rows.map(row => Math.round(row.top))
  )].sort((left, right) => left - right);
  assert.equal(capsuleColumns.length, 2);
  assert.equal(capsuleRows.length, 2);
  assert.ok(capsuleColumns[1] > capsuleColumns[0]);
  assert.ok(capsuleRows[1] > capsuleRows[0]);
  const fourPaneRectsBeforeSwap = new Map(
    fourCapsuleGeometry.rows.map(row => [row.id, row])
  );
  const fourPaneIdsBeforeSwap = [...fourPaneGroup.tabIds].sort();
  const rectMatches = (actual, expected, tolerance = 1) =>
    actual &&
    expected &&
    ["left", "top", "width", "height"].every(key =>
      Math.abs(actual[key] - expected[key]) <= tolerance
    );

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
    if (
      group?.tabIds.length !== fourPaneIdsBeforeSwap.length ||
      !fourPaneIdsBeforeSwap.every(id => group.tabIds.includes(id))
    ) {
      return false;
    }
    const rows = await client.evaluate(`(() => {
      const splitGroup = document.querySelector('.split-tab-group[data-count="4"]');
      if (!splitGroup) return [];
      return [...splitGroup.querySelectorAll(':scope > .tab-row')].map(row => {
        const bounds = row.getBoundingClientRect();
        return {
          id: row.dataset.tabId,
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        };
      });
    })()`);
    const rectsById = new Map(rows.map(row => [row.id, row]));
    const sourceBefore = fourPaneRectsBeforeSwap.get(fourthPaneId);
    const targetBefore = fourPaneRectsBeforeSwap.get(snapTargetId);
    const sourceAfter = rectsById.get(fourthPaneId);
    const targetAfter = rectsById.get(snapTargetId);
    const unchangedIds = fourPaneIdsBeforeSwap.filter(id =>
      id !== fourthPaneId && id !== snapTargetId
    );
    return rectMatches(sourceAfter, targetBefore) &&
      rectMatches(targetAfter, sourceBefore) &&
      unchangedIds.every(id =>
        rectMatches(rectsById.get(id), fourPaneRectsBeforeSwap.get(id))
      )
      ? candidate
      : false;
  });
  const sortedGroup = sortedState.splitGroups.find(group =>
    group.tabIds.includes(fourthPaneId)
  );
  assert.deepEqual([...sortedGroup.tabIds].sort(), fourPaneIdsBeforeSwap);

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
  const detachedThreeGroup = detachedState.splitGroups.find(group =>
    group.tabIds.includes(snapTargetId)
  );
  assert.equal(detachedThreeGroup.tabIds.length, 3);
  const expectedThreeRects = splitRectsByPaneId(detachedThreeGroup.layout);
  const expectedThreeFullId = [...expectedThreeRects.entries()]
    .sort((left, right) => right[1].height - left[1].height)[0][0];
  const threeCapsuleGeometry = await client.evaluate(`(() => {
    const group = document.querySelector('.split-tab-group[data-count="3"]');
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
      groupLeft: groupBounds.left,
      groupTop: groupBounds.top,
      groupHeight: groupBounds.height,
      groupWidth: groupBounds.width,
      rows,
    };
  })()`);
  const [collapsedThreeFull, ...collapsedThreeStacked] = [
    ...threeCapsuleGeometry.rows,
  ].sort((left, right) => right.height - left.height);
  collapsedThreeStacked.sort((left, right) => left.top - right.top);
  assert.ok(threeCapsuleGeometry.groupHeight <= 40);
  assertCapsuleMatchesSplitLayout(
    threeCapsuleGeometry,
    detachedThreeGroup.layout,
    .1
  );
  assert.ok(threeCapsuleGeometry.rows.every(row =>
    Math.abs(row.width - threeCapsuleGeometry.rows[0].width) <= 1
  ));
  assert.equal(collapsedThreeFull.id, expectedThreeFullId);
  assert.ok(collapsedThreeFull.height > collapsedThreeStacked[0].height * 1.8);
  assert.ok(
    Math.abs(
      collapsedThreeStacked[0].height - collapsedThreeStacked[1].height
    ) <= 1
  );
  assert.ok(
    Math.abs(collapsedThreeFull.top - collapsedThreeStacked[0].top) <= 1
  );
  assert.ok(collapsedThreeStacked[1].top > collapsedThreeStacked[0].top);
  assert.ok(
    Math.abs(
      collapsedThreeStacked[0].left - collapsedThreeStacked[1].left
    ) <= 1
  );
  assert.ok(collapsedThreeStacked[0].left > collapsedThreeFull.left);

  await client.evaluate(
    `window.chromaBrowser.command('tab:select', { id: ${JSON.stringify(snapTargetId)} })`
  );
  const expandedThreeCapsuleGeometry = await waitFor(() => client.evaluate(`(() => {
    const group = document.querySelector('.split-tab-group[data-count="3"].is-current');
    if (!group) return false;
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
    return groupBounds.height >= 64
      ? {
          groupLeft: groupBounds.left,
          groupTop: groupBounds.top,
          groupHeight: groupBounds.height,
          groupWidth: groupBounds.width,
          rows,
        }
      : false;
  })()`));
  const [expandedThreeFull, ...expandedThreeStacked] = [
    ...expandedThreeCapsuleGeometry.rows,
  ].sort((left, right) => right.height - left.height);
  assertCapsuleMatchesSplitLayout(
    expandedThreeCapsuleGeometry,
    detachedThreeGroup.layout,
    .06
  );
  assert.equal(expandedThreeFull.id, expectedThreeFullId);
  assert.ok(expandedThreeFull.height > 60);
  assert.ok(expandedThreeStacked.every(row => row.height >= 28));
  assert.ok(
    Math.abs(
      expandedThreeStacked[0].height - expandedThreeStacked[1].height
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
    brokenPipeLogging: true,
    bridge: true,
    commandPalette: true,
    bookmarkUi: true,
    bookmarkPersistence: true,
    pinnedTabUi: true,
    pinnedTabPersistence: true,
    pinnedTabReopen: true,
    essentialPinGuard: true,
    appearanceUi: true,
    appearanceRuntime: true,
    appearancePersistence: true,
    downloadUi: true,
    downloadLifecycle: true,
    downloadPersistence: true,
    historyPanel: true,
    historySearch: true,
    historyDelete: true,
    historyClearRange: true,
    historyPersistence: true,
    historyPrivacyPolicy: true,
    webNavigation: true,
    tabLifecycle: true,
    splitView: true,
    splitRatioDrag: true,
    splitRatioPreviewCapsule: true,
    splitRatioPersistence: true,
    splitPostPreviewTopology: true,
    stateRestoreModel: true,
    contentSandbox: true,
    viewCleanup: true,
    cleanWindowClose: true,
    newTabSearch: true,
    workspaceUi: true,
    folderUi: true,
    folderEmptyDrop: true,
    folderRename: true,
    folderDragMove: true,
    folderLibraryGuards: true,
    folderDeleteIntegrity: true,
    folderPersistence: true,
    folderPopoverLayering: true,
    snapDragSplit: true,
    preciseSplitInsertion: true,
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
    atomicCloseState: true,
    essentialSplitDetach: true,
    splitBlockReorder: true,
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
