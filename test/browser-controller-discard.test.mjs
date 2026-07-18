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
  { commands },
  { createDefaultState },
  { MockBrowserWindow, electronMock },
] = await Promise.all([
  import("../src/main/browser-controller.mjs"),
  import("../src/shared/channels.mjs"),
  import("../src/shared/model.mjs"),
  import("electron"),
]);

function createHarness(t) {
  electronMock.reset();
  let nextId = 1;
  const state = createDefaultState(() => `discard-${nextId++}`);
  state.tabs = [];
  state.activeTabId = "";
  const snapshots = [];
  const store = {
    scheduleSave(candidate) {
      snapshots.push(structuredClone(candidate));
    },
    async flush() {},
  };
  const window = new MockBrowserWindow();
  const controller = new BrowserController(window, state, store);
  t.after(async () => {
    await controller.destroy();
  });
  return { controller, snapshots, state };
}

function liveViewCount() {
  return electronMock.contents.filter(contents => !contents.isDestroyed()).length;
}

test("discarding a background tab destroys its view and selecting it restores one", async t => {
  const { controller, state } = createHarness(t);
  const active = await controller.createTab({ url: "https://example.com/active" });
  const background = await controller.createTab({
    url: "https://example.com/background",
    activate: false,
  });
  const viewsBeforeDiscard = liveViewCount();

  assert.equal(
    await controller.dispatch(commands.discardTab, { id: background }),
    true
  );
  const backgroundTab = state.tabs.find(tab => tab.id === background);
  assert.equal(backgroundTab.discarded, true);
  assert.equal(backgroundTab.url, "https://example.com/background");
  assert.equal(liveViewCount(), viewsBeforeDiscard - 1);
  assert.equal(state.activeTabId, active);

  assert.equal(controller.selectTab(background), true);
  assert.equal(backgroundTab.discarded, false);
  assert.equal(state.activeTabId, background);
  assert.equal(liveViewCount(), viewsBeforeDiscard);
});

test("active, split, crashed, and already-discarded tabs reject unloading", async t => {
  const { controller, snapshots, state } = createHarness(t);
  const active = await controller.createTab({});
  const one = await controller.createTab({ activate: false });
  const two = await controller.createTab({ activate: false });
  const splitId = controller.splitTabs(two, one, "row", "after");
  assert.ok(splitId);
  const crashed = await controller.createTab({ activate: false });
  state.tabs.find(tab => tab.id === crashed).crashed = true;
  const plain = await controller.createTab({ activate: false });
  assert.equal(controller.selectTab(active), true);

  const commitsBeforeRejections = snapshots.length;
  assert.equal(await controller.discardTab(active), false);
  assert.equal(await controller.discardTab(one), false);
  assert.equal(await controller.discardTab(crashed), false);
  assert.equal(await controller.discardTab("missing-tab"), false);
  assert.equal(snapshots.length, commitsBeforeRejections);

  assert.equal(await controller.discardTab(plain), true);
  assert.equal(await controller.discardTab(plain), false, "already discarded");
});

test("a discarded tab can be closed, and splitting restores it first", async t => {
  const { controller, state } = createHarness(t);
  await controller.createTab({});
  const closable = await controller.createTab({ activate: false });
  assert.equal(await controller.discardTab(closable), true);
  assert.equal(await controller.closeTab(closable), true);
  assert.equal(state.tabs.some(tab => tab.id === closable), false);

  const anchor = state.activeTabId;
  const sleeper = await controller.createTab({ activate: false });
  assert.equal(await controller.discardTab(sleeper), true);
  const splitId = controller.splitTabs(sleeper, anchor, "row", "after");
  assert.ok(splitId, "splitting with a discarded member must succeed");
  assert.equal(state.tabs.find(tab => tab.id === sleeper).discarded, false);
});

test("discarded state is transient and never persists as true", async t => {
  const { controller, snapshots } = createHarness(t);
  await controller.createTab({});
  const background = await controller.createTab({ activate: false });
  assert.equal(await controller.discardTab(background), true);

  const persisted = snapshots.at(-1).tabs.find(tab => tab.id === background);
  assert.equal(persisted.discarded, true, "live snapshot keeps the flag");

  const { sanitizeState } = await import("../src/shared/model.mjs");
  const restored = sanitizeState(snapshots.at(-1), () => "restored-id");
  assert.equal(
    restored.tabs.every(tab => tab.discarded === false),
    true,
    "sanitization must reset discarded so every restored tab gets a view"
  );
});
