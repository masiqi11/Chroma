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
  const state = createDefaultState(() => `ua-${nextId++}`);
  state.tabs = [];
  state.activeTabId = "";
  const store = {
    scheduleSave() {},
    async flush() {},
  };
  const controller = new BrowserController(new MockBrowserWindow(), state, store);
  t.after(async () => {
    await controller.destroy();
  });
  return { controller, state };
}

function liveContents() {
  return electronMock.contents.filter(contents => !contents.isDestroyed());
}

test("requesting the mobile site pins a mobile UA and reloads bypassing cache", async t => {
  const { controller } = createHarness(t);
  const tabId = await controller.createTab({ url: "https://example.com/site" });
  const contents = liveContents().at(-1);
  const reloadsBefore = contents.reloadIgnoringCacheCalls;

  assert.equal(
    await controller.dispatch(commands.setTabUserAgentMode, {
      id: tabId,
      mode: "mobile",
    }),
    true
  );
  const mobileAgent = contents.userAgentCalls.at(-1);
  assert.match(mobileAgent, /Mobile/);
  assert.ok(!mobileAgent.includes("Electron"));
  assert.equal(contents.reloadIgnoringCacheCalls, reloadsBefore + 1);
  assert.deepEqual(controller.getPublicState().uaOverrides, { [tabId]: "mobile" });

  assert.equal(
    controller.setTabUserAgentMode(tabId, "mobile"),
    true,
    "re-requesting the current mode is a no-op"
  );
  assert.equal(contents.reloadIgnoringCacheCalls, reloadsBefore + 1);

  assert.equal(controller.setTabUserAgentMode(tabId, "auto"), true);
  assert.ok(!contents.userAgentCalls.at(-1).includes("Mobile"));
  assert.equal(contents.reloadIgnoringCacheCalls, reloadsBefore + 2);
  assert.deepEqual(controller.getPublicState().uaOverrides, {});

  assert.equal(
    controller.setTabUserAgentMode(tabId, "auto"),
    true,
    "auto with no override does not reload"
  );
  assert.equal(contents.reloadIgnoringCacheCalls, reloadsBefore + 2);
});

test("rejects invalid modes and unavailable tabs, and forgets closed tabs", async t => {
  const { controller, state } = createHarness(t);
  const active = await controller.createTab({ url: "https://example.com/keep" });
  const tabId = await controller.createTab({
    url: "https://example.com/other",
    activate: false,
  });

  assert.equal(controller.setTabUserAgentMode(tabId, "tablet"), false);
  assert.equal(controller.setTabUserAgentMode("missing", "mobile"), false);

  assert.equal(controller.setTabUserAgentMode(tabId, "mobile"), true);
  assert.equal(await controller.discardTab(tabId), true);
  assert.equal(
    controller.setTabUserAgentMode(tabId, "desktop"),
    false,
    "a discarded tab has no live page to re-identify"
  );
  controller.selectTab(tabId);
  assert.equal(controller.setTabUserAgentMode(tabId, "desktop"), true);
  controller.selectTab(active);

  await controller.closeTab(tabId);
  assert.deepEqual(controller.getPublicState().uaOverrides, {},
    "closing a tab must drop its override");
  assert.equal(state.tabs.some(tab => tab.id === tabId), false);
});
