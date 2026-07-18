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
  { BOOKMARK_FOLDER_LIMIT, BOOKMARK_FOLDER_MEMBER_LIMIT },
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
  const state = createDefaultState(() => `bookmark-folder-${nextId++}`);
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

async function createTrackedBookmark(controller, state, url) {
  const tabId = await controller.createTab({ url, activate: false });
  assert.equal(controller.toggleBookmark(tabId), true);
  const bookmark = state.bookmarks.find(item => item.url === new URL(url).href);
  assert.ok(bookmark);
  return bookmark;
}

function folderById(state, id) {
  return state.bookmarkFolders.find(folder => folder.id === id);
}

test("empty bookmark folders are durable entities and support public and dispatched rename/delete", async t => {
  const { controller, snapshots, state } = createHarness(t);

  const folderId = controller.createBookmarkFolder({ name: "  Reading  ", bookmarkIds: [] });
  assert.ok(folderId);
  assert.deepEqual(folderById(state, folderId), {
    id: folderId,
    name: "Reading",
    parentId: "",
    bookmarkIds: [],
    expanded: true,
  });
  assert.deepEqual(
    controller.getPublicState().bookmarkFolders.find(folder => folder.id === folderId)
      ?.bookmarkIds,
    []
  );
  assert.deepEqual(
    snapshots.at(-1).bookmarkFolders.find(folder => folder.id === folderId)?.bookmarkIds,
    []
  );

  assert.equal(controller.renameBookmarkFolder(folderId, "  Later  "), true);
  assert.equal(folderById(state, folderId).name, "Later");
  assert.equal(
    await controller.dispatch(commands.renameBookmarkFolder, {
      id: folderId,
      name: "Reference",
    }),
    true
  );
  assert.equal(folderById(state, folderId).name, "Reference");

  const commitsBeforeInvalidRename = snapshots.length;
  assert.equal(controller.renameBookmarkFolder(folderId, "   "), false);
  assert.equal(folderById(state, folderId).name, "Reference");
  assert.equal(snapshots.length, commitsBeforeInvalidRename);

  assert.equal(controller.deleteBookmarkFolder(folderId), true);
  assert.equal(folderById(state, folderId), undefined);

  const dispatchedId = controller.createBookmarkFolder({ name: "Temporary", bookmarkIds: [] });
  assert.ok(dispatchedId);
  assert.equal(
    await controller.dispatch(commands.deleteBookmarkFolder, { id: dispatchedId }),
    true
  );
  assert.equal(folderById(state, dispatchedId), undefined);
});

test("toggling expanded state works directly and through dispatch", async t => {
  const { controller, state } = createHarness(t);
  const folderId = controller.createBookmarkFolder({ name: "Inbox", bookmarkIds: [] });
  assert.equal(folderById(state, folderId).expanded, true);

  assert.equal(controller.toggleBookmarkFolder(folderId), false);
  assert.equal(folderById(state, folderId).expanded, false);

  assert.equal(
    await controller.dispatch(commands.toggleBookmarkFolder, { id: folderId }),
    true
  );
  assert.equal(folderById(state, folderId).expanded, true);
});

test("creating a folder with member bookmarks and deleting it only removes the container", async t => {
  const { controller, state } = createHarness(t);
  const first = await createTrackedBookmark(controller, state, "https://example.com/one");
  const second = await createTrackedBookmark(controller, state, "https://example.com/two");

  const folderId = controller.createBookmarkFolder({
    name: "Reading list",
    bookmarkIds: [first.id, second.id],
  });
  assert.ok(folderId);
  assert.deepEqual(folderById(state, folderId).bookmarkIds, [first.id, second.id]);

  assert.equal(
    await controller.dispatch(commands.deleteBookmarkFolder, { id: folderId }),
    true
  );
  assert.equal(folderById(state, folderId), undefined);
  assert.deepEqual(
    state.bookmarks.map(bookmark => bookmark.id).sort(),
    [first.id, second.id].sort(),
    "deleting a folder must not remove its member bookmarks"
  );
});

test("moveBookmark assigns, reassigns, and ungroups a bookmark", async t => {
  const { controller, state } = createHarness(t);
  const bookmark = await createTrackedBookmark(controller, state, "https://example.com/one");
  const folderA = controller.createBookmarkFolder({ name: "A", bookmarkIds: [] });
  const folderB = controller.createBookmarkFolder({ name: "B", bookmarkIds: [] });

  assert.equal(
    await controller.dispatch(commands.moveBookmark, { id: bookmark.id, folderId: folderA }),
    true
  );
  assert.deepEqual(folderById(state, folderA).bookmarkIds, [bookmark.id]);
  assert.deepEqual(folderById(state, folderB).bookmarkIds, []);

  assert.equal(controller.moveBookmark({ id: bookmark.id, folderId: folderB }), true);
  assert.deepEqual(folderById(state, folderA).bookmarkIds, []);
  assert.deepEqual(folderById(state, folderB).bookmarkIds, [bookmark.id]);

  assert.equal(controller.moveBookmark({ id: bookmark.id, folderId: null }), true);
  assert.deepEqual(folderById(state, folderB).bookmarkIds, []);
});

test("moveBookmark rejects unknown bookmarks, unknown folders, and a full folder", async t => {
  const { controller, snapshots, state } = createHarness(t);
  const bookmark = await createTrackedBookmark(controller, state, "https://example.com/one");
  const folderId = controller.createBookmarkFolder({ name: "Full", bookmarkIds: [] });

  const commitsBeforeRejections = snapshots.length;
  assert.equal(controller.moveBookmark({ id: "missing-bookmark", folderId }), false);
  assert.equal(controller.moveBookmark({ id: bookmark.id, folderId: "missing-folder" }), false);
  assert.equal(snapshots.length, commitsBeforeRejections);

  folderById(state, folderId).bookmarkIds = Array.from(
    { length: BOOKMARK_FOLDER_MEMBER_LIMIT },
    (_, index) => `filler-${index}`
  );
  assert.equal(controller.moveBookmark({ id: bookmark.id, folderId }), false);
  assert.equal(snapshots.length, commitsBeforeRejections);
});

test("removing a bookmark cleans up its folder membership", async t => {
  const { controller, state } = createHarness(t);
  const bookmark = await createTrackedBookmark(controller, state, "https://example.com/one");
  const folderId = controller.createBookmarkFolder({
    name: "Reading",
    bookmarkIds: [bookmark.id],
  });
  assert.deepEqual(folderById(state, folderId).bookmarkIds, [bookmark.id]);

  assert.equal(controller.removeBookmark(bookmark.id), true);
  assert.deepEqual(folderById(state, folderId).bookmarkIds, []);

  const second = await createTrackedBookmark(controller, state, "https://example.com/two");
  const secondTab = state.tabs.find(tab => tab.url === second.url);
  controller.moveBookmark({ id: second.id, folderId });
  assert.deepEqual(folderById(state, folderId).bookmarkIds, [second.id]);
  assert.equal(controller.toggleBookmark(secondTab.id), false);
  assert.deepEqual(folderById(state, folderId).bookmarkIds, []);
});

test("bookmark-folder creation enforces member payload and container limits without committing", async t => {
  const { controller, snapshots, state } = createHarness(t);
  const bookmark = await createTrackedBookmark(controller, state, "https://example.com/one");

  const commitsBeforeOversizedPayload = snapshots.length;
  assert.equal(
    controller.createBookmarkFolder({
      name: "Too many members",
      bookmarkIds: Array.from(
        { length: BOOKMARK_FOLDER_MEMBER_LIMIT + 1 },
        () => bookmark.id
      ),
    }),
    null
  );
  assert.equal(snapshots.length, commitsBeforeOversizedPayload);

  assert.equal(
    controller.createBookmarkFolder({ name: "Unknown member", bookmarkIds: ["missing"] }),
    null
  );
  assert.equal(snapshots.length, commitsBeforeOversizedPayload);

  state.bookmarkFolders = Array.from(
    { length: BOOKMARK_FOLDER_LIMIT },
    (_, index) => ({
      id: `limit-folder-${index}`,
      name: `Folder ${index}`,
      bookmarkIds: [],
      expanded: true,
    })
  );
  const commitsBeforeContainerLimit = snapshots.length;
  assert.equal(
    controller.createBookmarkFolder({ name: "One too many", bookmarkIds: [] }),
    null
  );
  assert.equal(state.bookmarkFolders.length, BOOKMARK_FOLDER_LIMIT);
  assert.equal(snapshots.length, commitsBeforeContainerLimit);
});

test("nests folders with depth and cycle guards through create/move/delete", async t => {
  const { controller, state } = createHarness(t);

  const rootId = controller.createBookmarkFolder({ name: "Root" });
  const childId = controller.createBookmarkFolder({ name: "Child", parentId: rootId });
  assert.ok(childId);
  assert.equal(folderById(state, childId).parentId, rootId);
  assert.equal(
    controller.createBookmarkFolder({ name: "Nope", parentId: "missing" }),
    null
  );

  const grandchildId = controller.createBookmarkFolder({
    name: "Grandchild",
    parentId: childId,
  });
  assert.equal(
    await controller.dispatch(commands.moveBookmarkFolder, {
      id: rootId,
      parentId: grandchildId,
    }),
    false,
    "a folder may not move into its own descendant"
  );
  assert.equal(controller.moveBookmarkFolder({ id: rootId, parentId: rootId }), false);

  assert.equal(
    controller.moveBookmarkFolder({ id: grandchildId, parentId: null }),
    true
  );
  assert.equal(folderById(state, grandchildId).parentId, "");
  assert.equal(
    controller.moveBookmarkFolder({ id: grandchildId, parentId: rootId }),
    true
  );
  assert.equal(folderById(state, grandchildId).parentId, rootId);

  assert.equal(controller.deleteBookmarkFolder(rootId), true);
  assert.equal(
    folderById(state, childId).parentId,
    "",
    "children of a deleted folder promote to its parent"
  );
  assert.equal(folderById(state, grandchildId).parentId, "");
});

test("rejects folder chains beyond the nesting depth cap", async t => {
  const { controller, state } = createHarness(t);
  let parentId = null;
  const created = [];
  for (let index = 0; index < 12; index += 1) {
    const id = controller.createBookmarkFolder({
      name: `Level ${index}`,
      ...(parentId ? { parentId } : {}),
    });
    if (id === null) break;
    created.push(id);
    parentId = id;
  }
  assert.equal(created.length, 8, "creation stops at the depth cap");
  assert.equal(state.bookmarkFolders.length, 8);
});


test("renaming a bookmark validates, trims, and no-ops on unchanged titles", async t => {
  const { controller, snapshots, state } = createHarness(t);
  const bookmark = await createTrackedBookmark(controller, state, "https://example.com/renamed");

  assert.equal(
    await controller.dispatch(commands.renameBookmark, {
      id: bookmark.id,
      title: "  Field Notes  ",
    }),
    true
  );
  assert.equal(
    state.bookmarks.find(item => item.id === bookmark.id).title,
    "Field Notes"
  );
  assert.equal(
    snapshots.at(-1).bookmarks.find(item => item.id === bookmark.id).title,
    "Field Notes"
  );

  const committed = snapshots.length;
  assert.equal(controller.renameBookmark(bookmark.id, "Field Notes"), true);
  assert.equal(controller.renameBookmark(bookmark.id, "   "), false);
  assert.equal(controller.renameBookmark("missing-bookmark", "Name"), false);
  assert.equal(controller.renameBookmark(bookmark.id, 42), false);
  assert.equal(snapshots.length, committed, "rejected renames must not commit");

  assert.equal(controller.renameBookmark(bookmark.id, `${"x".repeat(600)}`), true);
  assert.equal(
    state.bookmarks.find(item => item.id === bookmark.id).title.length,
    500,
    "titles are capped at 500 characters"
  );
});
