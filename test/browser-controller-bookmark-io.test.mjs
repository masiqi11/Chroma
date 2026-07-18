import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
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
  { parseBookmarksHtml },
  { MockBrowserWindow, electronMock },
] = await Promise.all([
  import("../src/main/browser-controller.mjs"),
  import("../src/shared/channels.mjs"),
  import("../src/shared/model.mjs"),
  import("../src/shared/bookmark-io.mjs"),
  import("electron"),
]);

function createHarness(t) {
  electronMock.reset();
  let nextId = 1;
  const state = createDefaultState(() => `bookmark-io-${nextId++}`);
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

async function createWorkDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "chroma-bookmark-io-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("exports bookmarks and folders to a parseable file", async t => {
  const { controller, state } = createHarness(t);
  const directory = await createWorkDirectory(t);
  state.bookmarks.push(
    { id: "b1", title: "Grouped", url: "https://example.com/grouped", createdAt: 1 },
    { id: "b2", title: "Loose", url: "https://example.com/loose", createdAt: 2 }
  );
  state.bookmarkFolders.push({
    id: "f1",
    name: "Group",
    bookmarkIds: ["b1"],
    expanded: true,
  });

  const target = path.join(directory, "export.html");
  const result = await controller.dispatch(commands.exportBookmarks, {
    path: target,
  });
  assert.deepEqual(result, { exported: 2, path: target });
  const { items } = parseBookmarksHtml(await readFile(target, "utf8"));
  assert.deepEqual(items, [
    { title: "Grouped", url: "https://example.com/grouped", folderPath: ["Group"] },
    { title: "Loose", url: "https://example.com/loose", folderPath: [] },
  ]);
});

test("imports a bookmark file, recreating folders and skipping known URLs", async t => {
  const { controller, snapshots, state } = createHarness(t);
  const directory = await createWorkDirectory(t);
  state.bookmarks.push({
    id: "existing",
    title: "Existing",
    url: "https://example.com/existing",
    createdAt: 1,
  });
  state.bookmarkFolders.push({
    id: "have",
    name: "Existing Folder",
    bookmarkIds: [],
    expanded: true,
  });

  const source = path.join(directory, "import.html");
  await writeFile(source, `<DL><p>
    <DT><H3>Existing Folder</H3>
    <DL><p>
      <DT><A HREF="https://example.com/reuse">Reused folder page</A>
    </DL><p>
    <DT><H3>New Folder</H3>
    <DL><p>
      <DT><A HREF="https://example.com/fresh">Fresh page</A>
      <DT><A HREF="https://example.com/existing">Duplicate of existing</A>
    </DL><p>
    <DT><A HREF="https://example.com/top">Top page</A>
    <DT><A HREF="javascript:alert(1)">Rejected</A>
  </DL><p>`, "utf8");

  const result = await controller.dispatch(commands.importBookmarks, {
    path: source,
  });
  assert.deepEqual(result, { imported: 3, skipped: 1 });

  const urls = state.bookmarks.map(item => item.url);
  assert.deepEqual(urls, [
    "https://example.com/existing",
    "https://example.com/reuse",
    "https://example.com/fresh",
    "https://example.com/top",
  ]);
  const existingFolder = state.bookmarkFolders.find(
    folder => folder.name === "Existing Folder"
  );
  assert.equal(existingFolder.id, "have", "imports reuse same-name folders");
  assert.equal(existingFolder.bookmarkIds.length, 1);
  const newFolder = state.bookmarkFolders.find(folder => folder.name === "New Folder");
  assert.ok(newFolder);
  assert.equal(newFolder.bookmarkIds.length, 1);
  assert.deepEqual(
    snapshots.at(-1).bookmarks.map(item => item.url),
    urls,
    "an import must commit"
  );

  const again = await controller.importBookmarks({ path: source });
  assert.deepEqual(again, { imported: 0, skipped: 4 }, "re-import is a no-op");
});

test("returns null for missing files and cancelled dialogs without committing", async t => {
  const { controller, snapshots } = createHarness(t);
  const directory = await createWorkDirectory(t);
  const commitsBefore = snapshots.length;

  assert.equal(
    await controller.importBookmarks({ path: path.join(directory, "missing.html") }),
    null
  );
  assert.equal(await controller.importBookmarks({}), null, "mock dialog cancels");
  assert.equal(await controller.exportBookmarks({}), null, "mock dialog cancels");
  assert.equal(snapshots.length, commitsBefore);
});
