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
  const state = createDefaultState(() => `glance-${nextId++}`);
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
  controller.setContentBounds({ x: 240, y: 12, width: 1000, height: 700 });
  t.after(async () => {
    await controller.destroy();
  });
  return { controller, snapshots, state, window };
}

function glanceViews() {
  return electronMock.views.filter(view =>
    !electronMock.contents.includes(view.unsafeWebContents)
      ? false
      : view.unsafeWebContents.url !== "about:blank" || view.visible
  );
}

test("opening a Glance shows a centered preview above the active page", async t => {
  const { controller, state } = createHarness(t);
  await controller.createTab({ url: "https://example.com/source" });
  const viewsBefore = electronMock.views.length;

  assert.equal(
    await controller.dispatch(commands.openGlance, {
      url: "https://example.com/preview",
    }),
    true
  );
  assert.equal(electronMock.views.length, viewsBefore + 1);
  const glanceView = electronMock.views.at(-1);
  assert.equal(glanceView.visible, true);
  assert.equal(glanceView.unsafeWebContents.url, "https://example.com/preview");
  const bounds = glanceView.getBounds();
  assert.ok(bounds.x > 240, "the preview must be inset from the page area");
  assert.ok(bounds.width < 1000);

  const publicState = controller.getPublicState();
  assert.equal(publicState.glance.open, true);
  assert.equal(publicState.glance.url, "https://example.com/preview");
  assert.equal(publicState.glance.sourceTabId, state.activeTabId);
});

test("Glance rejects unsafe URLs and non-active source tabs", async t => {
  const { controller } = createHarness(t);
  await controller.createTab({ url: "https://example.com/source" });
  const background = await controller.createTab({ activate: false });

  assert.equal(controller.openGlance("javascript:alert(1)"), false);
  assert.equal(controller.openGlance("chroma://newtab/"), false);
  assert.equal(
    controller.openGlance("https://example.com/preview", background),
    false,
    "a background tab cannot own the Glance overlay"
  );
  assert.equal(controller.getPublicState().glance.open, false);
});

test("closing and reopening replaces the preview; tab switch auto-closes it", async t => {
  const { controller, state } = createHarness(t);
  await controller.createTab({ url: "https://example.com/source" });
  const other = await controller.createTab({ activate: false });
  assert.equal(controller.selectTab(state.tabs[0].id), true);

  assert.equal(controller.openGlance("https://example.com/one"), true);
  assert.equal(controller.openGlance("https://example.com/two"), true);
  assert.equal(controller.getPublicState().glance.url, "https://example.com/two");

  assert.equal(controller.selectTab(other), true);
  assert.equal(
    controller.getPublicState().glance.open,
    false,
    "switching tabs must retire the Glance overlay"
  );

  assert.equal(controller.closeGlance(), false, "closing again is a no-op");
});

test("promoting a Glance opens its URL as a real active tab", async t => {
  const { controller, state } = createHarness(t);
  await controller.createTab({ url: "https://example.com/source" });
  assert.equal(controller.openGlance("https://example.com/promoted"), true);

  const promotedId = await controller.dispatch(commands.promoteGlance, {});
  assert.ok(promotedId);
  assert.equal(controller.getPublicState().glance.open, false);
  const promoted = state.tabs.find(tab => tab.id === promotedId);
  assert.equal(promoted.url, "https://example.com/promoted");
  assert.equal(state.activeTabId, promotedId);

  assert.equal(await controller.promoteGlance(), null, "no Glance left to promote");
});
