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
  { CONTAINER_LIMIT, createDefaultState },
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
  const state = createDefaultState(() => `container-harness-${nextId++}`);
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

function containerById(state, id) {
  return state.containers.find(container => container.id === id);
}

test("container lifecycle supports public and dispatched create/rename/color/delete", async t => {
  const { controller, snapshots, state } = createHarness(t);
  await controller.createTab({});

  const containerId = controller.createContainer({ name: "  Work  ", color: "#AABBCC" });
  assert.ok(containerId);
  assert.deepEqual(containerById(state, containerId), {
    id: containerId,
    name: "Work",
    color: "#aabbcc",
    proxy: "",
    userAgent: "",
  });
  assert.deepEqual(
    controller.getPublicState().containers.find(item => item.id === containerId),
    containerById(state, containerId)
  );
  assert.deepEqual(
    snapshots.at(-1).containers.find(item => item.id === containerId)?.name,
    "Work"
  );

  assert.equal(controller.renameContainer(containerId, "  Personal  "), true);
  assert.equal(containerById(state, containerId).name, "Personal");
  assert.equal(
    await controller.dispatch(commands.renameContainer, {
      id: containerId,
      name: "Research",
    }),
    true
  );
  assert.equal(containerById(state, containerId).name, "Research");

  const commitsBeforeInvalidRename = snapshots.length;
  assert.equal(controller.renameContainer(containerId, "   "), false);
  assert.equal(snapshots.length, commitsBeforeInvalidRename);

  assert.equal(
    await controller.dispatch(commands.setContainerColor, {
      id: containerId,
      color: "#123456",
    }),
    true
  );
  assert.equal(containerById(state, containerId).color, "#123456");
  assert.equal(controller.setContainerColor(containerId, "not-a-color"), false);
  assert.equal(containerById(state, containerId).color, "#123456");

  assert.equal(await controller.deleteContainer(containerId), true);
  assert.equal(containerById(state, containerId), undefined);

  const dispatchedId = controller.createContainer({ name: "Temporary" });
  assert.ok(dispatchedId);
  assert.equal(
    await controller.dispatch(commands.deleteContainer, { id: dispatchedId }),
    true
  );
  assert.equal(containerById(state, dispatchedId), undefined);
});

test("container tabs receive an isolated persistent partition", async t => {
  const { controller, state } = createHarness(t);
  const containerId = controller.createContainer({ name: "Isolated" });

  const defaultTabId = await controller.createTab({});
  const containerTabId = await controller.createTab({
    containerId,
    activate: false,
  });

  const defaultView = electronMock.views.find(
    view => view.partition === "persist:chroma-main"
  );
  const containerView = electronMock.views.find(
    view => view.partition === `persist:chroma-container-${containerId}`
  );
  assert.ok(defaultView, "the default tab must use the shared main partition");
  assert.ok(containerView, "the container tab must use its own persistent partition");
  assert.notEqual(
    defaultView.unsafeWebContents.session,
    containerView.unsafeWebContents.session,
    "container and default tabs must not share a session"
  );
  assert.equal(
    state.tabs.find(tab => tab.id === containerTabId).containerId,
    containerId
  );
  assert.equal(state.tabs.find(tab => tab.id === defaultTabId).containerId, "");
});

test("an unknown or unsafe containerId falls back to the default partition", async t => {
  const { controller, state } = createHarness(t);
  await controller.createTab({ containerId: "missing-container" });
  await controller.createTab({ containerId: 42, activate: false });

  assert.equal(state.tabs.every(tab => tab.containerId === ""), true);
  assert.equal(
    electronMock.views.every(view => view.partition === "persist:chroma-main"),
    true
  );
});

test("deleting a container closes its tabs and clears the partition storage", async t => {
  const { controller, state } = createHarness(t);
  const containerId = controller.createContainer({ name: "Doomed" });
  const keeperId = await controller.createTab({});
  const memberId = await controller.createTab({ containerId, activate: false });
  const partition = `persist:chroma-container-${containerId}`;

  assert.equal(await controller.deleteContainer(containerId), true);

  assert.equal(containerById(state, containerId), undefined);
  assert.equal(state.tabs.some(tab => tab.id === memberId), false);
  assert.equal(state.tabs.some(tab => tab.id === keeperId), true);
  assert.equal(
    electronMock.sessions.get(partition)?.clearStorageDataCalls,
    1,
    "deleting a container must clear its partition's storage data"
  );
});

test("deleting the container that owns every tab creates a replacement first", async t => {
  const { controller, state } = createHarness(t);
  const containerId = controller.createContainer({ name: "Only" });
  const onlyTabId = await controller.createTab({ containerId });

  assert.equal(await controller.deleteContainer(containerId), true);

  assert.equal(state.tabs.some(tab => tab.id === onlyTabId), false);
  assert.equal(state.tabs.length >= 1, true);
  assert.ok(state.tabs.some(tab => tab.id === state.activeTabId));
  assert.equal(state.tabs.every(tab => tab.containerId === ""), true);
});

test("reopening a tab in a container preserves URL, position, and folder membership", async t => {
  const { controller, state } = createHarness(t);
  const containerId = controller.createContainer({ name: "Target" });
  const first = await controller.createTab({ url: "https://example.com/first" });
  const middle = await controller.createTab({
    url: "https://example.com/middle",
    activate: false,
  });
  const last = await controller.createTab({
    url: "https://example.com/last",
    activate: false,
  });
  const folderId = controller.createFolder({ name: "Keep", tabIds: [middle] });
  assert.ok(folderId);

  const reopenedId = await controller.reopenTabInContainer(middle, containerId);
  assert.ok(reopenedId);
  assert.notEqual(reopenedId, middle);

  const reopened = state.tabs.find(tab => tab.id === reopenedId);
  assert.equal(reopened.containerId, containerId);
  assert.equal(reopened.url, "https://example.com/middle");
  assert.deepEqual(
    state.tabs.map(tab => tab.id),
    [first, reopenedId, last],
    "the replacement must keep the original tab's list position"
  );
  assert.deepEqual(
    state.folders.find(folder => folder.id === folderId).tabIds,
    [reopenedId],
    "folder membership must transfer to the replacement tab"
  );
  const replacementView = electronMock.views.find(
    view => view.partition === `persist:chroma-container-${containerId}`
  );
  assert.ok(replacementView, "the replacement must live in the container partition");
});

test("reopening an active tab keeps it active and supports leaving a container", async t => {
  const { controller, state } = createHarness(t);
  const containerId = controller.createContainer({ name: "Round trip" });
  const tabId = await controller.createTab({ url: "https://example.com/page" });
  assert.equal(state.activeTabId, tabId);

  const inContainer = await controller.reopenTabInContainer(tabId, containerId);
  assert.ok(inContainer);
  assert.equal(state.activeTabId, inContainer);
  assert.equal(state.tabs.find(tab => tab.id === inContainer).containerId, containerId);

  const backOutside = await controller.reopenTabInContainer(inContainer, "");
  assert.ok(backOutside);
  assert.equal(state.activeTabId, backOutside);
  assert.equal(state.tabs.find(tab => tab.id === backOutside).containerId, "");

  assert.equal(
    await controller.reopenTabInContainer(backOutside, ""),
    backOutside,
    "reopening into the current container must be a no-op returning the same tab"
  );
});

test("pinned, Essential, split, and unknown-container reopens are rejected", async t => {
  const { controller, state } = createHarness(t);
  const containerId = controller.createContainer({ name: "Guard" });
  const pinned = await controller.createTab({ pinned: true });
  const essential = await controller.createTab({ essential: true, activate: false });
  const one = await controller.createTab({ activate: false });
  const two = await controller.createTab({ activate: false });
  const splitId = controller.splitTabs(two, one, "row", "after");
  assert.ok(splitId);
  const ordinary = await controller.createTab({ activate: false });

  assert.equal(await controller.reopenTabInContainer(pinned, containerId), null);
  assert.equal(await controller.reopenTabInContainer(essential, containerId), null);
  assert.equal(await controller.reopenTabInContainer(one, containerId), null);
  assert.equal(
    await controller.reopenTabInContainer(ordinary, "missing-container"),
    null
  );
  assert.equal(state.tabs.some(tab => tab.id === ordinary), true);
});

test("container creation enforces the container limit without committing", async t => {
  const { controller, snapshots, state } = createHarness(t);
  state.containers = Array.from({ length: CONTAINER_LIMIT }, (_, index) => ({
    id: `limit-container-${index}`,
    name: `Container ${index}`,
    color: "#7cc4ff",
  }));

  const commitsBeforeLimit = snapshots.length;
  assert.equal(controller.createContainer({ name: "One too many" }), null);
  assert.equal(state.containers.length, CONTAINER_LIMIT);
  assert.equal(snapshots.length, commitsBeforeLimit);
});

test("clearSiteData clears the tab's own partition for its origin and reloads", async t => {
  const { controller, state } = createHarness(t);
  const containerId = controller.createContainer({ name: "Iso", color: "#aabbcc" });
  const plainTab = await controller.createTab({ url: "https://example.com/plain" });
  const containerTab = await controller.createTab({
    url: "https://example.com/contained",
    containerId,
    activate: false,
  });

  const mainSession = electronMock.sessions.get("persist:chroma-main");
  const containerSession = electronMock.sessions.get(
    `persist:chroma-container-${containerId}`
  );
  const mainClearsBefore = mainSession.clearStorageDataCalls;

  assert.equal(await controller.dispatch(commands.clearSiteData, { id: plainTab }), true);
  assert.equal(mainSession.clearStorageDataCalls, mainClearsBefore + 1);
  assert.equal(containerSession.clearStorageDataCalls, 0);

  assert.equal(await controller.clearSiteData(containerTab), true);
  assert.equal(containerSession.clearStorageDataCalls, 1);

  state.tabs.find(tab => tab.id === plainTab).url = "chroma://newtab/";
  assert.equal(await controller.clearSiteData(plainTab), false,
    "internal pages have no site data to clear");
  assert.equal(await controller.clearSiteData("missing-tab"), false);
});

test("container proxy policy validates, applies, and clears per-partition proxies", async t => {
  const { controller, snapshots, state } = createHarness(t);
  await controller.createTab({});
  const containerId = controller.createContainer({ name: "Proxied" });
  const partition = `persist:chroma-container-${containerId}`;

  assert.equal(
    await controller.dispatch(commands.setContainerProxy, {
      id: containerId,
      proxy: " SOCKS5://127.0.0.1:1080 ",
    }),
    true
  );
  assert.equal(containerById(state, containerId).proxy, "socks5://127.0.0.1:1080");
  const proxySession = electronMock.sessions.get(partition);
  assert.deepEqual(proxySession.proxyCalls.at(-1), {
    proxyRules: "socks5://127.0.0.1:1080",
  });
  assert.equal(
    snapshots.at(-1).containers.find(item => item.id === containerId).proxy,
    "socks5://127.0.0.1:1080",
    "the applied proxy must persist"
  );

  const committed = snapshots.length;
  assert.equal(
    await controller.setContainerProxy(containerId, "ftp://proxy.example:21"),
    false,
    "unsupported schemes are rejected"
  );
  assert.equal(
    await controller.setContainerProxy(containerId, "http://u:p@proxy.example:80"),
    false,
    "credentialed rules are rejected"
  );
  assert.equal(await controller.setContainerProxy("missing", "http://p.example:80"), false);
  assert.equal(containerById(state, containerId).proxy, "socks5://127.0.0.1:1080");
  assert.equal(snapshots.length, committed, "rejected values must not commit");

  assert.equal(
    await controller.setContainerProxy(containerId, "socks5://127.0.0.1:1080"),
    true,
    "setting the current value is a no-op success"
  );
  assert.equal(snapshots.length, committed);

  assert.equal(await controller.setContainerProxy(containerId, ""), true);
  assert.equal(containerById(state, containerId).proxy, "");
  assert.deepEqual(proxySession.proxyCalls.at(-1), { mode: "system" });
});

test("initialize reapplies persisted container proxies and delete resets them", async t => {
  const { controller, state } = createHarness(t);
  state.containers.push({
    id: "restored-proxy",
    name: "Restored",
    color: "#aabbcc",
    proxy: "http://proxy.example:8080",
  });
  await controller.initialize();

  const partition = "persist:chroma-container-restored-proxy";
  const proxySession = electronMock.sessions.get(partition);
  assert.deepEqual(proxySession.proxyCalls.at(-1), {
    proxyRules: "http://proxy.example:8080",
  });

  assert.equal(await controller.deleteContainer("restored-proxy"), true);
  assert.deepEqual(
    proxySession.proxyCalls.at(-1),
    { mode: "system" },
    "deleting a container must return its partition to the system proxy"
  );
});


test("container user-agent policy pins member tabs and defers to per-tab overrides", async t => {
  const { controller, snapshots, state } = createHarness(t);
  await controller.createTab({});
  const containerId = controller.createContainer({ name: "Impersonated" });
  const memberTabId = await controller.createTab({ containerId });
  const outsideTabId = await controller.createTab({});
  const customUa = "Mozilla/5.0 (X11; Linux x86_64) ChromaTest/1.0";

  assert.equal(
    await controller.dispatch(commands.setContainerUserAgent, {
      id: containerId,
      userAgent: ` ${customUa} `,
    }),
    true
  );
  assert.equal(containerById(state, containerId).userAgent, customUa);
  assert.equal(
    snapshots.at(-1).containers.find(item => item.id === containerId).userAgent,
    customUa
  );

  const committed = snapshots.length;
  assert.equal(
    await controller.setContainerUserAgent(containerId, "bad\u0000ua"),
    false
  );
  assert.equal(
    await controller.setContainerUserAgent(containerId, customUa),
    true,
    "re-setting the current value is a no-op success"
  );
  assert.equal(snapshots.length, committed);

  assert.equal(await controller.setContainerUserAgent(containerId, ""), true);
  assert.equal(containerById(state, containerId).userAgent, "");
  await controller.closeTab(memberTabId);
  await controller.closeTab(outsideTabId);
});


test("container user-agent applies to live members, defers to per-tab overrides, and seeds new views", async t => {
  const { controller, state } = createHarness(t);
  await controller.createTab({});
  const containerId = controller.createContainer({ name: "Identity" });
  const memberTabId = await controller.createTab({ containerId, activate: false });
  const partition = `persist:chroma-container-${containerId}`;
  const memberContents = electronMock.views.find(
    view => view.partition === partition
  ).unsafeWebContents;
  const mainContents = electronMock.views.find(
    view => view.partition === "persist:chroma-main"
  ).unsafeWebContents;
  const customUa = "Mozilla/5.0 (X11; Linux x86_64) ChromaTest/1.0";

  assert.equal(await controller.setContainerUserAgent(containerId, customUa), true);
  assert.equal(memberContents.userAgentCalls.at(-1), customUa);
  assert.ok(
    memberContents.reloadIgnoringCacheCalls >= 1,
    "a container UA change must reload live member tabs"
  );
  assert.notEqual(
    mainContents.userAgentCalls.at(-1),
    customUa,
    "tabs outside the container keep the default identity"
  );

  assert.equal(controller.setTabUserAgentMode(memberTabId, "mobile"), true);
  const mobileUa = memberContents.userAgentCalls.at(-1);
  assert.notEqual(mobileUa, customUa);
  assert.equal(await controller.setContainerUserAgent(containerId, "Another/2.0"), true);
  assert.equal(
    memberContents.userAgentCalls.at(-1),
    mobileUa,
    "a per-tab override outranks the container identity"
  );
  assert.equal(controller.setTabUserAgentMode(memberTabId, "auto"), true);
  assert.equal(
    memberContents.userAgentCalls.at(-1),
    "Another/2.0",
    "clearing the per-tab override falls back to the container identity"
  );

  await controller.createTab({ containerId, activate: false });
  const newContents = electronMock.views.findLast(
    view => view.partition === partition
  ).unsafeWebContents;
  assert.equal(
    newContents.userAgentCalls[0],
    "Another/2.0",
    "new views in a pinned container adopt the container identity at creation"
  );

  assert.equal(await controller.setContainerUserAgent(containerId, ""), true);
  assert.equal(containerById(state, containerId).userAgent, "");
});
