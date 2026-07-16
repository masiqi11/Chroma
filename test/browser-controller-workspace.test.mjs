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
  { TAB_COUNT_LIMIT, createDefaultState },
  { MockBrowserWindow, electronMock },
] = await Promise.all([
  import("../src/main/browser-controller.mjs"),
  import("../src/shared/model.mjs"),
  import("electron"),
]);

function createHarness() {
  electronMock.reset();
  let nextId = 1;
  const state = createDefaultState(() => `workspace-${nextId++}`);
  state.tabs = [];
  state.activeTabId = "";
  const saves = [];
  const window = new MockBrowserWindow();
  const controller = new BrowserController(window, state, {
    scheduleSave(candidate) {
      saves.push(structuredClone(candidate));
    },
  });
  return { controller, saves, state, window };
}

async function seedTwoWorkspaces(controller, state) {
  const firstWorkspaceId = state.workspaces[0].id;
  const firstTabId = await controller.createTab({ workspaceId: firstWorkspaceId });
  const secondWorkspaceId = await controller.createWorkspace({ name: "Second" });
  const secondTabId = state.activeTabId;
  return { firstWorkspaceId, firstTabId, secondWorkspaceId, secondTabId };
}

test("workspace deletion is atomic, deterministic, and destroys only owned views", async () => {
  const { controller, state, window } = createHarness();
  const seeded = await seedTwoWorkspaces(controller, state);
  const extraId = await controller.createTab({
    workspaceId: seeded.secondWorkspaceId,
    activate: false,
  });
  const folderId = controller.createFolder({ name: "Second folder", tabIds: [extraId] });
  assert.ok(folderId);

  const removedViews = electronMock.views.slice(1, 3);
  const liveBefore = electronMock.views.filter(view => !view.webContents.isDestroyed()).length;

  assert.equal(await controller.deleteWorkspace(seeded.secondWorkspaceId), true);

  assert.deepEqual(state.workspaces.map(item => item.id), [seeded.firstWorkspaceId]);
  assert.equal(state.activeWorkspaceId, seeded.firstWorkspaceId);
  assert.equal(state.activeTabId, seeded.firstTabId);
  assert.equal(state.tabs.some(tab => tab.workspaceId === seeded.secondWorkspaceId), false);
  assert.equal(state.folders.some(folder => folder.workspaceId === seeded.secondWorkspaceId), false);
  assert.equal(state.splitGroups.some(group => group.workspaceId === seeded.secondWorkspaceId), false);
  assert.equal(
    electronMock.views.filter(view => !view.webContents.isDestroyed()).length,
    liveBefore - 2
  );
  assert.ok(removedViews.every(view => view.webContents.isDestroyed()));
  const lastPublished = window.webContents.sent
    .filter(message => message.channel === "chroma:state-changed")
    .at(-1)?.payload;
  assert.equal(lastPublished.runtime.managedViewCount, 1);
});

test("unknown and final workspaces cannot be deleted", async () => {
  const { controller, state } = createHarness();
  await controller.createTab();
  const snapshot = structuredClone(state);

  assert.equal(await controller.deleteWorkspace("missing"), false);
  assert.equal(await controller.deleteWorkspace(state.workspaces[0].id), false);
  assert.deepEqual(state, snapshot);
});

test("workspace reorder preserves the active space and tab topology", async () => {
  const { controller, state } = createHarness();
  const first = await seedTwoWorkspaces(controller, state);
  const thirdWorkspaceId = await controller.createWorkspace({ name: "Third" });
  const activeTabId = state.activeTabId;

  assert.equal(
    controller.reorderWorkspace(
      thirdWorkspaceId,
      first.firstWorkspaceId,
      "before"
    ),
    true
  );
  assert.deepEqual(state.workspaces.map(item => item.id), [
    thirdWorkspaceId,
    first.firstWorkspaceId,
    first.secondWorkspaceId,
  ]);
  assert.equal(state.activeWorkspaceId, thirdWorkspaceId);
  assert.equal(state.activeTabId, activeTabId);
  assert.equal(
    controller.reorderWorkspace(thirdWorkspaceId, "missing", "after"),
    false
  );
});

test("a plain tab moves across spaces while protected topology is rejected", async () => {
  const { controller, state } = createHarness();
  const seeded = await seedTwoWorkspaces(controller, state);
  controller.selectTab(seeded.firstTabId);

  assert.equal(
    controller.moveTabToWorkspace(seeded.firstTabId, seeded.secondWorkspaceId),
    true
  );
  assert.equal(
    state.tabs.find(tab => tab.id === seeded.firstTabId).workspaceId,
    seeded.secondWorkspaceId
  );
  assert.equal(state.activeWorkspaceId, seeded.secondWorkspaceId);
  assert.equal(state.activeTabId, seeded.firstTabId);
  const sourceTabs = state.tabs.filter(
    tab => tab.workspaceId === seeded.firstWorkspaceId
  );
  assert.equal(sourceTabs.length, 1);
  assert.equal(sourceTabs[0].url, "chroma://newtab/");

  controller.togglePin(seeded.firstTabId);
  const snapshot = structuredClone(state);
  assert.equal(
    controller.moveTabToWorkspace(seeded.firstTabId, seeded.firstWorkspaceId),
    false
  );
  assert.deepEqual(state, snapshot);
});

test("moving a workspace's only tab rejects atomically at the global cap", async () => {
  const { controller, state } = createHarness();
  const seeded = await seedTwoWorkspaces(controller, state);
  controller.selectTab(seeded.firstTabId);
  const targetTemplate = state.tabs.find(tab => tab.id === seeded.secondTabId);
  for (let index = state.tabs.length; index < TAB_COUNT_LIMIT; index += 1) {
    state.tabs.push({
      ...structuredClone(targetTemplate),
      id: `capacity-${index}`,
      workspaceId: seeded.secondWorkspaceId,
    });
  }
  const snapshot = structuredClone(state);

  assert.equal(
    controller.moveTabToWorkspace(seeded.firstTabId, seeded.secondWorkspaceId),
    false
  );
  assert.equal(state.tabs.length, TAB_COUNT_LIMIT);
  assert.deepEqual(state, snapshot);
});
