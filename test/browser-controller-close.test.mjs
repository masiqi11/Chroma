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
  const state = createDefaultState(() => `seed-${nextId++}`);
  state.tabs = [];
  state.activeTabId = "";
  const observedStates = [];
  const store = {
    scheduleSave(candidate) {
      observedStates.push(structuredClone(candidate));
    },
  };
  const window = new MockBrowserWindow();
  const controller = new BrowserController(window, state, store);
  return { controller, observedStates, state, window };
}

async function createTrackedTab(controller, options = {}) {
  const before = electronMock.views.length;
  const id = await controller.createTab(options);
  assert.equal(electronMock.views.length, before + 1);
  return { id, view: electronMock.views.at(-1) };
}

function assertEveryObservedActiveTabWasValid(observedStates, window) {
  assert.ok(observedStates.length > 0);
  const publishedStates = window.webContents.sent
    .filter(message => message.channel === "chroma:state-changed")
    .map(message => message.payload);
  assert.ok(publishedStates.length > 0);
  for (const snapshot of [...observedStates, ...publishedStates]) {
    assert.ok(
      snapshot.tabs.some(tab => tab.id === snapshot.activeTabId),
      `active tab ${snapshot.activeTabId} was missing from an observable snapshot`
    );
  }
}

test("closing an active grid pane prefers a survivor and normalizes 3→2 to a row", async () => {
  const { controller, observedStates, state, window } = createHarness();
  const unrelated = await createTrackedTab(controller);
  const primary = await createTrackedTab(controller);
  const second = await createTrackedTab(controller, { activate: false });
  controller.splitTabs(second.id, primary.id, "row", "after");
  const third = await createTrackedTab(controller, { activate: false });
  controller.splitTabs(third.id, primary.id, "column", "after");
  controller.selectTab(primary.id);

  state.tabs.find(tab => tab.id === unrelated.id).lastActiveAt = Number.MAX_SAFE_INTEGER;
  const groupBefore = state.splitGroups.find(group => group.tabIds.includes(primary.id));
  assert.equal(groupBefore.direction, "grid");
  assert.equal(groupBefore.tabIds.length, 3);

  assert.equal(await controller.closeTab(primary.id), true);

  const groupAfter = state.splitGroups.find(group => group.tabIds.includes(second.id));
  assert.ok([second.id, third.id].includes(state.activeTabId));
  assert.notEqual(state.activeTabId, unrelated.id);
  assert.equal(groupAfter.direction, "row");
  assert.deepEqual(groupAfter.layout, {
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: { type: "pane", paneId: third.id },
    second: { type: "pane", paneId: second.id },
  });
  assertEveryObservedActiveTabWasValid(observedStates, window);
});

test("closing 2→1 restores the survivor desktop layout before native teardown", async () => {
  const { controller, observedStates, state, window } = createHarness();
  const first = await createTrackedTab(controller);
  const second = await createTrackedTab(controller, { activate: false });
  controller.splitTabs(second.id, first.id, "row", "after");
  controller.selectTab(first.id);
  const survivorUserAgentCalls = second.view.webContents.userAgentCalls.length;
  let activeDuringTeardown = null;
  first.view.webContents.beforeClose = () => {
    activeDuringTeardown = state.activeTabId;
    assert.ok(state.tabs.some(tab => tab.id === activeDuringTeardown));
  };

  assert.equal(await controller.closeTab(first.id), true);

  assert.equal(activeDuringTeardown, second.id);
  assert.equal(state.activeTabId, second.id);
  assert.equal(state.splitGroups.length, 0);
  assert.ok(
    second.view.webContents.userAgentCalls.length > survivorUserAgentCalls,
    "the remaining pane should be restored to the desktop user agent"
  );
  assertEveryObservedActiveTabWasValid(observedStates, window);
});

test("closing the workspace's final active tab creates a valid replacement first", async () => {
  const { controller, observedStates, state, window } = createHarness();
  const only = await createTrackedTab(controller);

  assert.equal(await controller.closeTab(only.id), true);

  assert.equal(state.tabs.length, 1);
  assert.notEqual(state.activeTabId, only.id);
  assert.equal(state.activeTabId, state.tabs[0].id);
  assertEveryObservedActiveTabWasValid(observedStates, window);
});

test("late navigation and title events from a closing view cannot mutate its tab", async () => {
  const { controller, state } = createHarness();
  const closing = await createTrackedTab(controller, { url: "https://before.example/" });
  const survivor = await createTrackedTab(controller, { activate: false });
  const closingTab = state.tabs.find(tab => tab.id === closing.id);
  const original = { url: closingTab.url, title: closingTab.title };
  let guardObserved = false;
  closing.view.webContents.beforeClose = () => {
    assert.equal(state.tabs.some(tab => tab.id === closing.id), false);
    assert.equal(state.activeTabId, survivor.id);
    closing.view.webContents.emit(
      "did-navigate",
      {},
      "https://late.example/"
    );
    closing.view.webContents.emit(
      "page-title-updated",
      { preventDefault() {} },
      "Late title"
    );
    guardObserved = true;
  };

  assert.equal(await controller.closeTab(closing.id), true);

  assert.equal(guardObserved, true);
  assert.deepEqual(
    { url: closingTab.url, title: closingTab.title },
    original
  );
});
