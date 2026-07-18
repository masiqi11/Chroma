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
  { LIVE_FOLDER_ITEM_LIMIT, LIVE_FOLDER_LIMIT, createDefaultState },
  { MockBrowserWindow, electronMock },
] = await Promise.all([
  import("../src/main/browser-controller.mjs"),
  import("../src/shared/channels.mjs"),
  import("../src/shared/model.mjs"),
  import("electron"),
]);

function feedResponse(xml) {
  return new Response(xml, { status: 200 });
}

function rssDocument(title, links) {
  return `<rss><channel><title>${title}</title>${links
    .map(link => `<item><title>Item for ${link}</title><link>${link}</link></item>`)
    .join("")}</channel></rss>`;
}

function createHarness(t, { feeds = new Map(), failUrls = new Set() } = {}) {
  electronMock.reset();
  let nextId = 1;
  const state = createDefaultState(() => `live-folder-harness-${nextId++}`);
  const snapshots = [];
  const store = {
    scheduleSave(candidate) {
      snapshots.push(structuredClone(candidate));
    },
    async flush() {},
  };
  const fetchCalls = [];
  const liveFolderFetch = async url => {
    fetchCalls.push(url);
    if (failUrls.has(url)) throw new Error("network unreachable");
    const xml = feeds.get(url);
    if (typeof xml !== "string") return new Response("missing", { status: 404 });
    return feedResponse(xml);
  };
  const window = new MockBrowserWindow();
  const controller = new BrowserController(window, state, store, {
    liveFolderFetch,
  });
  t.after(async () => {
    await controller.destroy();
  });
  return { controller, snapshots, state, fetchCalls };
}

test("creates a live folder, fetches its feed, and adopts the feed title", async t => {
  const feedUrl = "https://feeds.example/news.xml";
  const { controller, snapshots, state, fetchCalls } = createHarness(t, {
    feeds: new Map([
      [feedUrl, rssDocument("Example News", [
        "https://example.com/story-one",
        "https://example.com/story-two",
      ])],
    ]),
  });

  const folderId = await controller.dispatch(commands.createLiveFolder, {
    url: feedUrl,
  });
  assert.ok(folderId);
  assert.deepEqual(fetchCalls, [feedUrl]);
  const folder = state.liveFolders.find(item => item.id === folderId);
  assert.equal(folder.name, "Example News");
  assert.equal(folder.sourceUrl, feedUrl);
  assert.equal(folder.status, "ok");
  assert.ok(folder.refreshedAt > 0);
  assert.deepEqual(folder.items.map(item => item.url), [
    "https://example.com/story-one",
    "https://example.com/story-two",
  ]);
  assert.equal(
    snapshots.at(-1).liveFolders.find(item => item.id === folderId)?.items.length,
    2
  );
  assert.equal(
    controller.getPublicState().liveFolders.find(item => item.id === folderId)
      ?.items.length,
    2
  );
});

test("rejects unsafe sources, duplicates, and enforces the folder cap", async t => {
  const { controller, state } = createHarness(t, {
    feeds: new Map([["https://feeds.example/one.xml", rssDocument("One", [])]]),
  });

  assert.equal(await controller.createLiveFolder({ url: "javascript:alert(1)" }), null);
  assert.equal(await controller.createLiveFolder({ url: "file:///etc/passwd" }), null);
  assert.equal(await controller.createLiveFolder({ url: "not a url" }), null);
  assert.equal(await controller.createLiveFolder({}), null);

  const first = await controller.createLiveFolder({
    url: "https://feeds.example/one.xml",
    name: "Kept name",
  });
  assert.ok(first);
  assert.equal(
    await controller.createLiveFolder({ url: "https://feeds.example/one.xml" }),
    null
  );

  for (let index = state.liveFolders.length; index < LIVE_FOLDER_LIMIT; index += 1) {
    state.liveFolders.push({
      id: `filler-${index}`,
      name: `Filler ${index}`,
      sourceUrl: `https://feeds.example/filler-${index}.xml`,
      expanded: true,
      items: [],
      refreshedAt: Date.now(),
      status: "ok",
    });
  }
  assert.equal(
    await controller.createLiveFolder({ url: "https://feeds.example/over.xml" }),
    null
  );
});

test("keeps an explicit name and filters unsafe or excess feed items", async t => {
  const feedUrl = "https://feeds.example/messy.xml";
  const links = [
    "javascript:alert(1)",
    ...Array.from(
      { length: LIVE_FOLDER_ITEM_LIMIT + 5 },
      (_, index) => `https://example.com/item-${index}`
    ),
  ];
  const { controller, state } = createHarness(t, {
    feeds: new Map([[feedUrl, rssDocument("Ignored Title", links)]]),
  });

  const folderId = await controller.createLiveFolder({
    url: feedUrl,
    name: "My Reader",
  });
  const folder = state.liveFolders.find(item => item.id === folderId);
  assert.equal(folder.name, "My Reader");
  assert.equal(folder.items.length, LIVE_FOLDER_ITEM_LIMIT);
  assert.ok(folder.items.every(item => item.url.startsWith("https://example.com/")));
});

test("marks failed feeds as errored while keeping previous items", async t => {
  const feedUrl = "https://feeds.example/flaky.xml";
  const failUrls = new Set();
  const { controller, state, fetchCalls } = createHarness(t, {
    feeds: new Map([[feedUrl, rssDocument("Flaky", ["https://example.com/kept"])]]),
    failUrls,
  });

  const folderId = await controller.createLiveFolder({ url: feedUrl });
  const folder = state.liveFolders.find(item => item.id === folderId);
  assert.equal(folder.items.length, 1);

  failUrls.add(feedUrl);
  folder.refreshedAt = Date.now() - 60_000;
  assert.equal(await controller.refreshLiveFolder(folderId), false);
  assert.equal(folder.status, "error");
  assert.deepEqual(folder.items.map(item => item.url), ["https://example.com/kept"]);
  assert.ok(folder.refreshedAt > Date.now() - 5_000);
  assert.equal(fetchCalls.length, 2);

  failUrls.delete(feedUrl);
  folder.refreshedAt = Date.now() - 60_000;
  assert.equal(await controller.refreshLiveFolder(folderId), true);
  assert.equal(folder.status, "ok");
});

test("rate-limits refreshes triggered from the shell", async t => {
  const feedUrl = "https://feeds.example/limited.xml";
  const { controller, state, fetchCalls } = createHarness(t, {
    feeds: new Map([[feedUrl, rssDocument("Limited", ["https://example.com/a"])]]),
  });

  const folderId = await controller.createLiveFolder({ url: feedUrl });
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    await controller.dispatch(commands.refreshLiveFolder, { id: folderId }),
    false
  );
  assert.equal(fetchCalls.length, 1);

  const folder = state.liveFolders.find(item => item.id === folderId);
  folder.refreshedAt = Date.now() - 60_000;
  assert.equal(
    await controller.dispatch(commands.refreshLiveFolder, { id: folderId }),
    true
  );
  assert.equal(fetchCalls.length, 2);
  assert.equal(await controller.refreshLiveFolder("missing-folder"), false);
});

test("supports toggle, rename, and delete through dispatch", async t => {
  const feedUrl = "https://feeds.example/managed.xml";
  const { controller, snapshots, state } = createHarness(t, {
    feeds: new Map([[feedUrl, rssDocument("Managed", ["https://example.com/x"])]]),
  });
  const folderId = await controller.createLiveFolder({ url: feedUrl });
  const folder = state.liveFolders.find(item => item.id === folderId);

  assert.equal(
    await controller.dispatch(commands.toggleLiveFolder, { id: folderId }),
    false
  );
  assert.equal(folder.expanded, false);

  assert.equal(
    await controller.dispatch(commands.renameLiveFolder, {
      id: folderId,
      name: "  Renamed Feed  ",
    }),
    true
  );
  assert.equal(folder.name, "Renamed Feed");
  assert.equal(await controller.renameLiveFolder(folderId, "   "), false);

  const commitsBeforeInvalidDelete = snapshots.length;
  assert.equal(await controller.dispatch(commands.deleteLiveFolder, { id: "nope" }), false);
  assert.equal(snapshots.length, commitsBeforeInvalidDelete);

  assert.equal(
    await controller.dispatch(commands.deleteLiveFolder, { id: folderId }),
    true
  );
  assert.equal(state.liveFolders.length, 0);
  assert.deepEqual(snapshots.at(-1).liveFolders, []);
});
