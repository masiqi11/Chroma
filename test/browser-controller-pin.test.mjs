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
  { createDefaultState, sanitizeState, stateForDisk },
  { MockBrowserWindow, electronMock },
] = await Promise.all([
  import("../src/main/browser-controller.mjs"),
  import("../src/shared/channels.mjs"),
  import("../src/shared/model.mjs"),
  import("electron"),
]);

function createHarness() {
  electronMock.reset();
  let nextId = 1;
  const state = createDefaultState(() => `pin-${nextId++}`);
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
  return { controller, snapshots, state };
}

async function createTrackedTab(controller, options = {}) {
  const before = electronMock.views.length;
  const id = await controller.createTab(options);
  assert.equal(electronMock.views.length, before + 1);
  return { id, view: electronMock.views.at(-1) };
}

test("pinning through the allow-listed command detaches folder and split topology", async () => {
  const { controller, snapshots, state } = createHarness();
  const pinned = await createTrackedTab(controller);
  const survivor = await createTrackedTab(controller, { activate: false });
  const folderId = controller.createFolder({
    name: "Work",
    tabIds: [pinned.id, survivor.id],
  });
  assert.ok(folderId);
  assert.ok(controller.splitTabs(survivor.id, pinned.id, "row", "after"));
  const pinnedDesktopCalls = pinned.view.webContents.userAgentCalls.length;
  const survivorDesktopCalls = survivor.view.webContents.userAgentCalls.length;

  assert.equal(
    await controller.dispatch(commands.togglePin, { id: pinned.id }),
    true
  );

  assert.equal(state.tabs.find(tab => tab.id === pinned.id).pinned, true);
  assert.equal(state.splitGroups.length, 0);
  assert.deepEqual(
    state.folders.find(folder => folder.id === folderId)?.tabIds,
    [survivor.id]
  );
  assert.ok(
    pinned.view.webContents.userAgentCalls.length > pinnedDesktopCalls,
    "the pinned page must leave compact split mode"
  );
  assert.ok(
    survivor.view.webContents.userAgentCalls.length > survivorDesktopCalls,
    "the remaining split survivor must return to desktop mode"
  );
  assert.equal(snapshots.at(-1).tabs.find(tab => tab.id === pinned.id).pinned, true);
  assert.equal(controller.getPublicState().tabs.find(tab => tab.id === pinned.id).pinned, true);

  assert.equal(controller.togglePin(pinned.id), false);
  assert.equal(state.tabs.find(tab => tab.id === pinned.id).pinned, false);
  assert.deepEqual(
    state.folders.find(folder => folder.id === folderId)?.tabIds,
    [survivor.id],
    "unpinning must not silently reinsert a tab into its former folder"
  );
  await controller.destroy();
});

test("Essential tabs stay pinned and reject toggle-pin without a commit", async () => {
  const { controller, snapshots, state } = createHarness();
  const essential = await createTrackedTab(controller, {
    essential: true,
    pinned: false,
  });
  const commitsBeforeToggle = snapshots.length;

  assert.equal(state.tabs[0].essential, true);
  assert.equal(state.tabs[0].pinned, true);
  assert.equal(await controller.dispatch(commands.togglePin, { id: essential.id }), false);
  assert.equal(state.tabs[0].pinned, true);
  assert.equal(snapshots.length, commitsBeforeToggle);
  await controller.destroy();
});

test("pinned state survives disk sanitization and Essential repair", () => {
  let nextId = 1;
  const state = createDefaultState(() => `disk-${nextId++}`);
  state.tabs[0].pinned = true;
  const persisted = stateForDisk(state);
  const restored = sanitizeState(persisted, () => `restore-${nextId++}`);

  assert.equal(persisted.tabs[0].pinned, true);
  assert.equal(restored.tabs[0].pinned, true);

  const damagedEssential = structuredClone(persisted);
  damagedEssential.tabs[0].essential = true;
  damagedEssential.tabs[0].pinned = false;
  assert.equal(
    sanitizeState(damagedEssential, () => `repair-${nextId++}`).tabs[0].pinned,
    true
  );
});

test("closing and reopening a pinned tab restores its pinned status", async () => {
  const { controller, state } = createHarness();
  const pinned = await createTrackedTab(controller);
  assert.equal(controller.togglePin(pinned.id), true);

  assert.equal(await controller.closeTab(pinned.id), true);
  assert.equal(state.tabs.some(tab => tab.id === pinned.id), false);

  const reopenedId = await controller.reopenClosedTab();
  assert.ok(reopenedId);
  assert.notEqual(reopenedId, pinned.id);
  assert.equal(state.tabs.find(tab => tab.id === reopenedId).pinned, true);
  await controller.destroy();
});

test("Essentials remember their saved page and reset back to it", async () => {
  const { controller, state } = createHarness();
  const { id } = await createTrackedTab(controller, {
    url: "https://example.com/home",
  });
  await createTrackedTab(controller, { url: "https://example.com/other" });

  assert.equal(controller.toggleEssential(id), true);
  const tab = state.tabs.find(item => item.id === id);
  assert.equal(tab.essentialUrl, "https://example.com/home");

  assert.equal(controller.navigate(id, "https://example.com/elsewhere"), true);
  assert.equal(
    await controller.dispatch(commands.resetEssential, { id }),
    true
  );
  assert.equal(tab.url, "https://example.com/home");

  assert.equal(controller.toggleEssential(id), false);
  assert.equal(tab.essentialUrl, "", "demoting an Essential clears its saved page");
  assert.equal(controller.resetEssential(id), false);
  assert.equal(controller.resetEssential("missing-tab"), false);
});

test("an unloaded Essential resets by restoring its view first", async () => {
  const { controller, state } = createHarness();
  const { id } = await createTrackedTab(controller, {
    url: "https://example.com/pinned",
  });
  const { id: activeId } = await createTrackedTab(controller, {
    url: "https://example.com/active",
  });
  controller.selectTab(activeId);
  assert.equal(controller.toggleEssential(id), true);

  assert.equal(await controller.discardTab(id), true);
  const tab = state.tabs.find(item => item.id === id);
  assert.equal(tab.discarded, true);

  assert.equal(controller.resetEssential(id), true);
  assert.equal(tab.discarded, false, "reset must revive the discarded view");
  assert.equal(tab.url, "https://example.com/pinned");

  const internal = await controller.createTab({});
  controller.selectTab(id);
  assert.equal(controller.toggleEssential(internal), true);
  assert.equal(
    state.tabs.find(item => item.id === internal).essentialUrl,
    "",
    "internal pages have no web URL to save"
  );
  assert.equal(controller.resetEssential(internal), false);
});

test("essentialUrl survives disk sanitization only while essential", () => {
  let nextId = 1;
  const ids = () => () => `essential-disk-${nextId++}`;
  const base = createDefaultState(ids());
  base.tabs[0].essential = true;
  base.tabs[0].pinned = true;
  base.tabs[0].essentialUrl = "https://example.com/saved";
  base.tabs.push({
    ...base.tabs[0],
    id: "plain-tab",
    essential: false,
    pinned: false,
    essentialUrl: "https://example.com/leftover",
  });

  const restored = sanitizeState(base, ids());
  assert.equal(restored.tabs[0].essentialUrl, "https://example.com/saved");
  assert.equal(
    restored.tabs.find(tab => tab.id === "plain-tab").essentialUrl,
    "",
    "a non-essential tab must not carry a stale saved page"
  );

  base.tabs[0].essentialUrl = "javascript:alert(1)";
  assert.equal(sanitizeState(base, ids()).tabs[0].essentialUrl, "");
});
