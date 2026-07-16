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

function createHarness() {
  electronMock.reset();
  let nextId = 1;
  const state = createDefaultState(() => `crash-${nextId++}`);
  state.tabs = [];
  state.activeTabId = "";
  const window = new MockBrowserWindow();
  const controller = new BrowserController(window, state, {
    scheduleSave() {},
  });
  controller.setContentBounds({ x: 220, y: 8, width: 900, height: 700 });
  return { controller, state, window };
}

test("a crashed pane is hidden and reload recovery preserves its topology", async () => {
  const { controller, state } = createHarness();
  const firstId = await controller.createTab({ url: "https://one.example/" });
  const secondId = await controller.createTab({
    url: "https://two.example/",
    activate: false,
  });
  const groupId = controller.splitTabs(secondId, firstId, "row", "after");
  controller.selectTab(firstId);
  const firstView = electronMock.views[0];
  assert.equal(firstView.getVisible(), true);

  firstView.webContents.emit("render-process-gone", {}, { reason: "crashed" });

  assert.equal(state.tabs.find(tab => tab.id === firstId).crashed, true);
  assert.equal(firstView.getVisible(), false);
  assert.equal(electronMock.views[1].getVisible(), true);
  assert.deepEqual(state.splitGroups[0].tabIds, [firstId, secondId]);

  assert.equal(await controller.recoverTab(firstId), true);
  assert.equal(state.tabs.find(tab => tab.id === firstId).crashed, false);
  assert.equal(firstView.webContents.reloadCalls, 1);
  assert.equal(firstView.getVisible(), true);
  assert.equal(state.splitGroups[0].id, groupId);
  assert.deepEqual(state.splitGroups[0].tabIds, [firstId, secondId]);
});

test("recovery rebuilds a destroyed WebContents without changing the tab id", async () => {
  const { controller, state } = createHarness();
  const id = await controller.createTab({ url: "https://rebuild.example/" });
  const oldView = electronMock.views[0];
  state.tabs[0].crashed = true;
  oldView.webContents.destroyed = true;
  const topology = structuredClone({
    workspaces: state.workspaces,
    tabs: state.tabs.map(tab => ({ id: tab.id, workspaceId: tab.workspaceId })),
  });

  assert.equal(await controller.recoverTab(id), true);

  assert.equal(electronMock.views.length, 2);
  assert.equal(state.tabs[0].id, id);
  assert.equal(state.tabs[0].crashed, false);
  assert.deepEqual(
    {
      workspaces: state.workspaces,
      tabs: state.tabs.map(tab => ({ id: tab.id, workspaceId: tab.workspaceId })),
    },
    topology
  );
});

test("recovery tolerates an Electron wrapper that throws Object destroyed", async () => {
  const { controller, state } = createHarness();
  const id = await controller.createTab({ url: "https://race.example/" });
  const oldView = electronMock.views[0];
  state.tabs[0].crashed = true;
  oldView.unsafeWebContents.destroyed = true;
  oldView.throwOnWebContentsAccess = true;

  assert.equal(await controller.recoverTab(id), true);
  assert.equal(state.tabs[0].id, id);
  assert.equal(state.tabs[0].crashed, false);
  assert.equal(electronMock.views.length, 2);
  assert.notEqual(electronMock.views[1], oldView);
});

test("native view access failure becomes a recoverable crashed tab", async () => {
  const { controller, state } = createHarness();
  const id = await controller.createTab({ url: "https://native-race.example/" });
  const view = electronMock.views[0];
  view.throwOnNativeAccess = true;

  assert.doesNotThrow(() => {
    controller.setContentBounds({ x: 220, y: 8, width: 800, height: 600 });
  });
  assert.equal(state.tabs.find(tab => tab.id === id).crashed, true);
  assert.equal(state.tabs.find(tab => tab.id === id).loading, false);
});

test("healthy and unknown tabs reject recovery without mutation", async () => {
  const { controller, state } = createHarness();
  const id = await controller.createTab();
  const snapshot = structuredClone(state);

  assert.equal(await controller.recoverTab(id), false);
  assert.equal(await controller.recoverTab("missing"), false);
  assert.deepEqual(state, snapshot);
});
