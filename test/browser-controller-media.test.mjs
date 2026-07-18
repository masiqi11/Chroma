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
  const state = createDefaultState(() => `media-${nextId++}`);
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

function contentsForTab(id) {
  return electronMock.contents.find(contents => contents.tabId === id) ||
    electronMock.contents.at(-1);
}

function liveContents() {
  return electronMock.contents.filter(contents => !contents.isDestroyed());
}

test("media playback toggles run as a user gesture and report the outcome", async t => {
  const { controller } = createHarness(t);
  const tabId = await controller.createTab({ url: "https://example.com/media" });
  const contents = liveContents().at(-1);

  contents.executeJavaScriptResult = "paused";
  assert.equal(
    await controller.dispatch(commands.toggleMediaPlayback, { id: tabId }),
    "paused"
  );
  const call = contents.executeJavaScriptCalls.at(-1);
  assert.equal(call.userGesture, true, "playback toggles must carry a user gesture");
  assert.match(call.code, /querySelectorAll\("video, audio"\)/);

  contents.executeJavaScriptResult = "playing";
  assert.equal(await controller.toggleMediaPlayback(tabId), "playing");

  contents.executeJavaScriptResult = { unexpected: true };
  assert.equal(
    await controller.toggleMediaPlayback(tabId),
    null,
    "non-contract script results must collapse to null"
  );

  contents.executeJavaScriptResult = new Error("script blocked");
  assert.equal(await controller.toggleMediaPlayback(tabId), null);
});

test("picture-in-picture toggles target videos and survive script failure", async t => {
  const { controller } = createHarness(t);
  const tabId = await controller.createTab({ url: "https://example.com/video" });
  const contents = liveContents().at(-1);

  contents.executeJavaScriptResult = "entered";
  assert.equal(
    await controller.dispatch(commands.togglePictureInPicture, { id: tabId }),
    "entered"
  );
  const call = contents.executeJavaScriptCalls.at(-1);
  assert.equal(call.userGesture, true);
  assert.match(call.code, /pictureInPictureEnabled/);
  assert.match(call.code, /disablePictureInPicture/);

  contents.executeJavaScriptResult = "exited";
  assert.equal(await controller.togglePictureInPicture(tabId), "exited");

  contents.executeJavaScriptResult = null;
  assert.equal(await controller.togglePictureInPicture(tabId), null);
});

test("media commands refuse missing, discarded, and crashed tabs", async t => {
  const { controller, state } = createHarness(t);
  const active = await controller.createTab({ url: "https://example.com/active" });
  const background = await controller.createTab({
    url: "https://example.com/background",
    activate: false,
  });

  assert.equal(await controller.toggleMediaPlayback("missing-tab"), null);
  assert.equal(await controller.togglePictureInPicture("missing-tab"), null);

  assert.equal(await controller.discardTab(background), true);
  assert.equal(await controller.toggleMediaPlayback(background), null);
  assert.equal(await controller.togglePictureInPicture(background), null);

  state.tabs.find(tab => tab.id === active).crashed = true;
  assert.equal(await controller.toggleMediaPlayback(active), null);
  assert.equal(await controller.togglePictureInPicture(active), null);
});

test("now-playing tracks tabs that produced media and reads MediaSession metadata", async t => {
  const { controller, state } = createHarness(t);
  const mediaTab = await controller.createTab({ url: "https://example.com/song" });
  const mediaContents = liveContents().at(-1);
  await controller.createTab({ url: "https://example.com/quiet", activate: false });

  assert.deepEqual(await controller.queryNowPlaying(), [],
    "tabs that never produced media must not be queried");
  assert.deepEqual(controller.getPublicState().mediaTabIds, []);

  mediaContents.emit("media-started-playing");
  assert.equal(state.tabs.find(tab => tab.id === mediaTab).audible, true);
  assert.deepEqual(controller.getPublicState().mediaTabIds, [mediaTab]);

  mediaContents.executeJavaScriptResult = {
    title: "Song Title",
    artist: "Band Name",
    artwork: "https://example.com/cover.png",
    playing: true,
  };
  assert.deepEqual(
    await controller.dispatch(commands.queryNowPlaying, {}),
    [{
      tabId: mediaTab,
      title: "Song Title",
      artist: "Band Name",
      artworkUrl: "https://example.com/cover.png",
      playing: true,
    }]
  );

  for (const hostileArtwork of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html;base64,PGI+",
    `https://example.com/${"a".repeat(2_100)}`,
  ]) {
    mediaContents.executeJavaScriptResult = {
      title: "Song Title",
      artist: "Band Name",
      artwork: hostileArtwork,
      playing: true,
    };
    const [entry] = await controller.queryNowPlaying();
    assert.equal(entry.artworkUrl, "", `unsafe artwork must be dropped: ${hostileArtwork.slice(0, 40)}`);
  }
  mediaContents.executeJavaScriptResult = {
    title: "Song Title",
    artist: "Band Name",
    artwork: "data:image/png;base64,iVBORw0KGgo=",
    playing: true,
  };
  assert.equal(
    (await controller.queryNowPlaying())[0].artworkUrl,
    "data:image/png;base64,iVBORw0KGgo=",
    "bounded raster data URIs are allowed"
  );

  mediaContents.executeJavaScriptResult = { title: "", artist: "", playing: false };
  const fallback = await controller.queryNowPlaying();
  assert.equal(fallback[0].title, state.tabs.find(tab => tab.id === mediaTab).title,
    "missing MediaSession titles fall back to the tab title");
  assert.equal(fallback[0].playing, false);

  mediaContents.executeJavaScriptResult = null;
  assert.deepEqual(await controller.queryNowPlaying(), [],
    "pages whose media went away drop out of the list");

  mediaContents.executeJavaScriptResult = new Error("navigated away");
  assert.deepEqual(await controller.queryNowPlaying(), []);
});

test("now-playing forgets closed tabs and skips discarded ones", async t => {
  const { controller, state } = createHarness(t);
  await controller.createTab({ url: "https://example.com/keep" });
  const mediaTab = await controller.createTab({
    url: "https://example.com/media",
    activate: false,
  });
  const mediaContents = liveContents().at(-1);
  mediaContents.emit("media-started-playing");
  assert.deepEqual(controller.getPublicState().mediaTabIds, [mediaTab]);

  assert.equal(await controller.discardTab(mediaTab), true);
  assert.deepEqual(await controller.queryNowPlaying(), [],
    "a discarded tab has no live page to query");

  controller.selectTab(mediaTab);
  await controller.closeTab(mediaTab);
  assert.deepEqual(controller.getPublicState().mediaTabIds, []);
  assert.equal(state.tabs.some(tab => tab.id === mediaTab), false);
});

test("the hardware media key targets the most recent audible media tab", async t => {
  const { controller, state } = createHarness(t);
  await controller.initialize();
  assert.equal(
    electronMock.globalShortcuts.has("MediaPlayPause"),
    true,
    "initialize must register the play/pause media key"
  );

  assert.equal(await controller.playPauseMostRecentMedia(), null,
    "no media tabs means the key is a clean no-op");

  await controller.createTab({ url: "https://example.com/older" });
  const olderContents = liveContents().at(-1);
  const newer = await controller.createTab({
    url: "https://example.com/newer",
    activate: false,
  });
  const newerContents = liveContents().at(-1);

  olderContents.emit("media-started-playing");
  newerContents.emit("media-started-playing");
  olderContents.emit("media-paused");
  state.tabs.find(tab => tab.id === newer).audible = true;

  olderContents.executeJavaScriptResult = "playing";
  newerContents.executeJavaScriptResult = "paused";
  assert.equal(
    await controller.playPauseMostRecentMedia(),
    "paused",
    "the audible, most recently playing tab wins"
  );
  assert.equal(newerContents.executeJavaScriptCalls.length, 1);
  assert.equal(olderContents.executeJavaScriptCalls.length, 0);

  state.tabs.find(tab => tab.id === newer).audible = false;
  newerContents.executeJavaScriptResult = "playing";
  electronMock.triggerGlobalShortcut("MediaPlayPause");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(
    newerContents.executeJavaScriptCalls.length,
    2,
    "with nothing audible the key resumes the most recent media tab"
  );

  await controller.destroy();
  assert.equal(
    electronMock.globalShortcuts.has("MediaPlayPause"),
    false,
    "destroy must release the media key"
  );
});
