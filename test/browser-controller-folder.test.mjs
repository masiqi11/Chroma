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
  { FOLDER_MEMBER_LIMIT, LIBRARY_CONTAINER_LIMIT },
  { MockBrowserWindow, electronMock },
] = await Promise.all([
  import("../src/main/browser-controller.mjs"),
  import("../src/shared/channels.mjs"),
  import("../src/shared/model.mjs"),
  import("../src/shared/state-invariants.mjs"),
  import("electron"),
]);

function createHarness(t) {
  electronMock.reset();
  let nextId = 1;
  const state = createDefaultState(() => `folder-${nextId++}`);
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

async function createTrackedTab(controller, options = {}) {
  const before = electronMock.views.length;
  const id = await controller.createTab(options);
  assert.equal(electronMock.views.length, before + 1);
  return { id, view: electronMock.views.at(-1) };
}

function folderById(state, id) {
  return state.folders.find(folder => folder.id === id);
}

test("empty folders are durable entities and support public and dispatched rename/delete", async t => {
  const { controller, snapshots, state } = createHarness(t);
  await createTrackedTab(controller);

  const folderId = controller.createFolder({ name: "  Inbox  ", tabIds: [] });
  assert.ok(folderId);
  assert.deepEqual(folderById(state, folderId), {
    id: folderId,
    workspaceId: state.activeWorkspaceId,
    name: "Inbox",
    tabIds: [],
    expanded: true,
  });
  assert.deepEqual(
    controller.getPublicState().folders.find(folder => folder.id === folderId)?.tabIds,
    []
  );
  assert.deepEqual(
    snapshots.at(-1).folders.find(folder => folder.id === folderId)?.tabIds,
    []
  );

  assert.equal(controller.renameFolder(folderId, "  Reading  "), true);
  assert.equal(folderById(state, folderId).name, "Reading");
  assert.equal(
    await controller.dispatch(commands.renameFolder, {
      id: folderId,
      name: "Research",
    }),
    true
  );
  assert.equal(folderById(state, folderId).name, "Research");

  const commitsBeforeInvalidRename = snapshots.length;
  assert.equal(controller.renameFolder(folderId, "   "), false);
  assert.equal(folderById(state, folderId).name, "Research");
  assert.equal(snapshots.length, commitsBeforeInvalidRename);

  assert.equal(controller.deleteFolder(folderId), true);
  assert.equal(folderById(state, folderId), undefined);

  const dispatchedId = controller.createFolder({ name: "Temporary", tabIds: [] });
  assert.ok(dispatchedId);
  assert.equal(
    await controller.dispatch(commands.deleteFolder, { id: dispatchedId }),
    true
  );
  assert.equal(folderById(state, dispatchedId), undefined);
});

test("creating a folder from one split pane moves the complete split and delete only removes the container", async t => {
  const { controller, state } = createHarness(t);
  const first = await createTrackedTab(controller);
  const second = await createTrackedTab(controller, { activate: false });
  const outside = await createTrackedTab(controller, { activate: false });
  const splitId = controller.splitTabs(second.id, first.id, "row", "after");
  assert.ok(splitId);
  const group = state.splitGroups.find(item => item.id === splitId);
  assert.ok(group);

  const folderId = controller.createFolder({
    name: "Split project",
    tabIds: [first.id],
  });
  assert.ok(folderId);
  assert.deepEqual(folderById(state, folderId).tabIds, group.tabIds);
  assert.equal(folderById(state, folderId).tabIds.includes(outside.id), false);

  assert.equal(
    await controller.dispatch(commands.renameFolder, {
      id: folderId,
      name: "Split research",
    }),
    true
  );
  const tabIdsBeforeDelete = state.tabs.map(tab => tab.id);
  const splitBeforeDelete = structuredClone(group);

  assert.equal(
    await controller.dispatch(commands.deleteFolder, { id: folderId }),
    true
  );
  assert.equal(folderById(state, folderId), undefined);
  assert.deepEqual(state.tabs.map(tab => tab.id), tabIdsBeforeDelete);
  assert.deepEqual(
    state.splitGroups.find(item => item.id === splitId),
    splitBeforeDelete,
    "deleting a folder must not close tabs or dissolve its split capsule"
  );
});

test("explicit folder destinations move tabs into empty folders and back to the ungrouped area", async t => {
  const { controller, state } = createHarness(t);
  const first = await createTrackedTab(controller);
  const second = await createTrackedTab(controller, { activate: false });
  const outside = await createTrackedTab(controller, { activate: false });
  const folderId = controller.createFolder({ name: "Drop target", tabIds: [] });
  assert.ok(folderId);

  const splitId = controller.splitTabs(second.id, first.id, "row", "after");
  assert.ok(splitId);
  assert.equal(
    await controller.dispatch(commands.detachSplitTab, {
      id: first.id,
      targetId: null,
      position: "after",
      moveToEnd: true,
      folderId,
    }),
    true
  );
  assert.equal(state.splitGroups.some(group => group.id === splitId), false);
  assert.deepEqual(folderById(state, folderId).tabIds, [first.id]);

  assert.equal(controller.reorderTab(first.id, null, "after", null), true);
  assert.deepEqual(
    folderById(state, folderId).tabIds,
    [],
    "moving the final member out must preserve the now-empty folder"
  );

  assert.equal(controller.reorderTab(outside.id, null, "after", folderId), true);
  assert.deepEqual(folderById(state, folderId).tabIds, [outside.id]);
  assert.equal(controller.reorderTab(outside.id, null, "after", null), true);
  assert.deepEqual(folderById(state, folderId).tabIds, []);
});

test("pinned and Essential tabs cannot enter folders", async t => {
  const { controller, snapshots, state } = createHarness(t);
  const ordinary = await createTrackedTab(controller);
  const pinned = await createTrackedTab(controller, {
    activate: false,
    pinned: true,
  });
  const essential = await createTrackedTab(controller, {
    activate: false,
    essential: true,
  });
  const folderId = controller.createFolder({ name: "Allowed", tabIds: [] });
  assert.ok(folderId);

  const commitsBeforeRejectedMoves = snapshots.length;
  assert.equal(controller.reorderTab(pinned.id, null, "after", folderId), false);
  assert.equal(controller.reorderTab(essential.id, null, "after", folderId), false);
  assert.deepEqual(folderById(state, folderId).tabIds, []);
  assert.equal(snapshots.length, commitsBeforeRejectedMoves);

  const foldersBeforeRejectedCreate = state.folders.length;
  assert.equal(
    controller.createFolder({
      name: "Forbidden",
      tabIds: [pinned.id, essential.id],
    }),
    null
  );
  assert.equal(state.folders.length, foldersBeforeRejectedCreate);

  const commitsBeforeRejectedSplits = snapshots.length;
  assert.equal(controller.splitTabs(pinned.id, ordinary.id, "row", "after"), false);
  assert.equal(controller.splitTabs(ordinary.id, essential.id, "row", "after"), false);
  assert.equal(state.splitGroups.length, 0);
  assert.equal(snapshots.length, commitsBeforeRejectedSplits);

  assert.equal(controller.selectTab(pinned.id), true);
  const commitsAfterPinnedSelection = snapshots.length;
  assert.equal(await controller.splitActive("row"), null);
  assert.equal(state.splitGroups.length, 0);
  assert.equal(snapshots.length, commitsAfterPinnedSelection);

  const commitsBeforeMixedCreate = snapshots.length;
  const mixedFolderId = controller.createFolder({
    name: "Mixed",
    tabIds: [ordinary.id, pinned.id, essential.id],
  });
  assert.equal(mixedFolderId, null);
  assert.equal(
    state.folders.some(folder =>
      folder.tabIds.includes(pinned.id) || folder.tabIds.includes(essential.id)
    ),
    false
  );
  assert.equal(snapshots.length, commitsBeforeMixedCreate);
});

test("closing the final member leaves its empty folder intact", async t => {
  const { controller, state } = createHarness(t);
  const only = await createTrackedTab(controller);
  const folderId = controller.createFolder({
    name: "Keep me",
    tabIds: [only.id],
  });
  assert.ok(folderId);

  assert.equal(await controller.closeTab(only.id), true);

  assert.equal(state.tabs.some(tab => tab.id === only.id), false);
  assert.ok(state.tabs.some(tab => tab.id === state.activeTabId));
  assert.deepEqual(folderById(state, folderId).tabIds, []);
});

test("folder creation enforces member payload and container limits without committing", async t => {
  const { controller, snapshots, state } = createHarness(t);
  const tab = await createTrackedTab(controller);

  const boundaryId = controller.createFolder({
    name: "Boundary",
    tabIds: Array.from({ length: FOLDER_MEMBER_LIMIT }, () => tab.id),
  });
  assert.ok(boundaryId);
  assert.deepEqual(folderById(state, boundaryId).tabIds, [tab.id]);

  const commitsBeforeOversizedPayload = snapshots.length;
  assert.equal(
    controller.createFolder({
      name: "Too many members",
      tabIds: Array.from(
        { length: FOLDER_MEMBER_LIMIT + 1 },
        () => tab.id
      ),
    }),
    null
  );
  assert.equal(snapshots.length, commitsBeforeOversizedPayload);

  state.folders = Array.from({ length: LIBRARY_CONTAINER_LIMIT }, (_, index) => ({
    id: `limit-folder-${index}`,
    workspaceId: state.activeWorkspaceId,
    name: `Folder ${index}`,
    tabIds: [],
    expanded: true,
  }));
  const commitsBeforeContainerLimit = snapshots.length;
  assert.equal(
    controller.createFolder({ name: "One too many", tabIds: [] }),
    null
  );
  assert.equal(state.folders.length, LIBRARY_CONTAINER_LIMIT);
  assert.equal(snapshots.length, commitsBeforeContainerLimit);
});

test("explicit folder destinations reject cross-workspace moves and mismatched targets", async t => {
  const { controller, snapshots, state } = createHarness(t);
  const first = await createTrackedTab(controller);
  const peer = await createTrackedTab(controller, { activate: false });
  const folderId = controller.createFolder({
    name: "First space",
    tabIds: [first.id],
  });
  assert.ok(folderId);

  const secondWorkspaceId = await controller.createWorkspace({ name: "Second" });
  const secondWorkspaceTab = state.tabs.find(
    tab => tab.workspaceId === secondWorkspaceId
  );
  assert.ok(secondWorkspaceTab);

  const commitsBeforeRejectedMoves = snapshots.length;
  assert.equal(
    controller.reorderTab(secondWorkspaceTab.id, null, "after", folderId),
    false
  );
  assert.equal(
    controller.reorderTab(peer.id, secondWorkspaceTab.id, "before", folderId),
    false
  );
  assert.deepEqual(folderById(state, folderId).tabIds, [first.id]);
  assert.equal(snapshots.length, commitsBeforeRejectedMoves);
});
