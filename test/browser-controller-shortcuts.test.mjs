import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const electronMockUrl = new URL(
  "./fixtures/electron-controller-mock.mjs",
  import.meta.url
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron") {
      return { url: electronMockUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const [
  { BrowserController },
  { createDefaultState },
  { MockBrowserWindow, electronMock },
] = await Promise.all([
  import("../src/main/browser-controller.mjs"),
  import("../src/shared/model.mjs"),
  import("electron"),
]);

function primaryModifiers(extra = {}) {
  return process.platform === "darwin"
    ? { meta: true, control: false, ...extra }
    : { meta: false, control: true, ...extra };
}

function emitShortcut(contents, options) {
  let prevented = 0;
  contents.emit(
    "before-input-event",
    { preventDefault() { prevented += 1; } },
    {
      type: "keyDown",
      code: options.code,
      key: options.key || "",
      meta: false,
      control: false,
      alt: false,
      shift: false,
      isAutoRepeat: false,
      isComposing: false,
      ...options,
    }
  );
  return prevented;
}

async function waitFor(callback, timeout = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = callback();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for shortcut action");
}

async function createHarness() {
  electronMock.reset();
  let nextId = 1;
  const state = createDefaultState(() => `shortcut-${nextId++}`);
  const window = new MockBrowserWindow();
  const controller = new BrowserController(window, state, {
    scheduleSave() {},
  });
  controller.setContentBounds({ x: 220, y: 8, width: 900, height: 700 });
  await controller.initialize();
  return { controller, state, window, page: electronMock.views[0] };
}

test("page shortcuts use exact modifiers and preserve Zen/Firefox reserved chords", async () => {
  const { state, page } = await createHarness();
  const tabId = state.activeTabId;
  const initialTabCount = state.tabs.length;

  assert.equal(
    emitShortcut(page.webContents, {
      code: "KeyW",
      key: "w",
      ...primaryModifiers({ shift: true }),
    }),
    0
  );
  assert.equal(state.tabs.length, initialTabCount);

  assert.equal(
    emitShortcut(page.webContents, {
      code: "KeyR",
      key: "r",
      ...primaryModifiers({ shift: true }),
    }),
    1
  );
  assert.equal(page.webContents.reloadIgnoringCacheCalls, 1);
  assert.equal(page.webContents.reloadCalls, 0);

  assert.equal(
    emitShortcut(page.webContents, {
      code: "KeyP",
      key: "p",
      ...primaryModifiers({ shift: true }),
    }),
    0
  );
  assert.equal(
    state.tabs.find(tab => tab.id === tabId).crashed,
    false
  );
});

test("shell and page focus share one shortcut router", async () => {
  const { state, window, page } = await createHarness();
  const before = state.tabs.length;
  assert.equal(
    emitShortcut(window.webContents, {
      code: "KeyT",
      key: "t",
      ...primaryModifiers(),
    }),
    1
  );
  await waitFor(() => state.tabs.length === before + 1);

  const firstId = state.tabs[0].id;
  const secondId = state.tabs[1].id;
  assert.equal(state.activeTabId, secondId);
  assert.equal(
    emitShortcut(page.webContents, {
      code: "Tab",
      key: "Tab",
      control: true,
    }),
    1
  );
  assert.equal(state.activeTabId, firstId);

  const collapsedBefore = state.settings.sidebarCollapsed;
  assert.equal(
    emitShortcut(window.webContents, {
      code: "KeyS",
      key: "s",
      ...primaryModifiers(),
    }),
    1
  );
  assert.equal(state.settings.sidebarCollapsed, !collapsedBefore);
});

test("zoom and workspace navigation commands are host validated", async () => {
  const { controller, state, page } = await createHarness();
  const firstWorkspaceId = state.activeWorkspaceId;
  const secondWorkspaceId = await controller.createWorkspace({ name: "Second" });
  assert.equal(state.activeWorkspaceId, secondWorkspaceId);

  assert.equal(await controller.dispatch("workspace:previous"), true);
  assert.equal(state.activeWorkspaceId, firstWorkspaceId);
  assert.equal(await controller.dispatch("workspace:next"), true);
  assert.equal(state.activeWorkspaceId, secondWorkspaceId);

  assert.equal(await controller.dispatch("page:zoom-in"), 110);
  const activeView = electronMock.views.find(view => view.getVisible());
  assert.equal(activeView.webContents.getZoomFactor(), 1.1);
  assert.equal(await controller.dispatch("page:zoom-reset"), 100);
  assert.equal(activeView.webContents.getZoomFactor(), 1);
  assert.equal(page.webContents.reloadIgnoringCacheCalls, 0);
});

test("shell reload consumes the chord and rebuilds a destroyed crashed tab", async () => {
  const { state, window, page } = await createHarness();
  const tabId = state.activeTabId;
  const originalViewCount = electronMock.views.length;
  state.tabs.find(tab => tab.id === tabId).crashed = true;
  page.unsafeWebContents.destroyed = true;

  assert.equal(
    emitShortcut(window.webContents, {
      code: "KeyR",
      key: "r",
      ...primaryModifiers(),
    }),
    1
  );
  await waitFor(() => {
    const tab = state.tabs.find(candidate => candidate.id === tabId);
    return tab?.crashed === false && electronMock.views.length === originalViewCount + 1;
  });
  assert.equal(state.activeTabId, tabId);
});

test("browser chords remain consumed when their action is unavailable", async () => {
  const { window } = await createHarness();
  assert.equal(
    emitShortcut(window.webContents, {
      code: "ArrowLeft",
      key: "ArrowLeft",
      alt: true,
    }),
    1
  );
});

test("overlay history shortcut dismisses the floating sidebar first", async () => {
  const { controller, window } = await createHarness();
  controller.toggleSidebar();
  controller.updateSidebarOverlay({ open: true });
  const overlay = electronMock.views.at(-1);
  const historyInput = process.platform === "darwin"
    ? { code: "KeyY", key: "y", ...primaryModifiers() }
    : { code: "KeyH", key: "h", ...primaryModifiers() };

  assert.equal(emitShortcut(overlay.webContents, historyInput), 1);
  assert.equal(controller.getPublicState().runtime.sidebarOverlayOpen, false);
  assert.ok(
    window.webContents.sent.some(message => message.channel === "chroma:open-history")
  );
});
