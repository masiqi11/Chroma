import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  { MockBrowserWindow, electronMock },
] = await Promise.all([
  import("../src/main/browser-controller.mjs"),
  import("../src/shared/channels.mjs"),
  import("../src/shared/model.mjs"),
  import("electron"),
]);

async function writeExtension(directory, manifest) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest),
    "utf8"
  );
  if (typeof manifest?.action?.default_popup === "string") {
    await writeFile(
      path.join(directory, manifest.action.default_popup.replace(/^\/+/, "")),
      "<!doctype html><title>Popup</title>",
      "utf8"
    ).catch(() => {});
  }
}

async function createHarness(t) {
  electronMock.reset();
  const workDirectory = await mkdtemp(path.join(tmpdir(), "chroma-ext-popup-"));
  t.after(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });
  let nextId = 1;
  const state = createDefaultState(() => `ext-popup-${nextId++}`);
  const snapshots = [];
  const store = {
    scheduleSave(candidate) {
      snapshots.push(structuredClone(candidate));
    },
    async flush() {},
  };
  const window = new MockBrowserWindow();
  const controller = new BrowserController(window, state, store, {
    extensionRegistryFile: path.join(workDirectory, "extensions.json"),
  });
  await controller.initialize();
  controller.setContentBounds({ x: 240, y: 12, width: 1000, height: 700 });
  t.after(async () => {
    await controller.destroy();
  });
  return { controller, state, workDirectory };
}

test("opens and toggles an extension action popup from its own origin", async t => {
  const { controller, workDirectory } = await createHarness(t);
  const extensionDirectory = path.join(workDirectory, "with-popup");
  await writeExtension(extensionDirectory, {
    manifest_version: 3,
    name: "Popup Extension",
    version: "1.0",
    action: { default_popup: "popup.html", default_title: "Do the thing" },
  });
  const extensionId = await controller.installExtension(extensionDirectory);
  assert.ok(extensionId);

  const snapshotEntry = controller
    .getPublicState()
    .extensions.find(entry => entry.id === extensionId);
  assert.equal(snapshotEntry.popupPath, "popup.html");
  assert.equal(snapshotEntry.actionTitle, "Do the thing");

  const viewsBefore = electronMock.views.length;
  assert.equal(
    await controller.dispatch(commands.openExtensionPopup, { id: extensionId }),
    true
  );
  assert.equal(electronMock.views.length, viewsBefore + 1);
  const popupView = electronMock.views.at(-1);
  assert.equal(popupView.visible, true);
  assert.equal(
    popupView.unsafeWebContents.url,
    `chrome-extension://${extensionId}/popup.html`
  );
  const bounds = popupView.getBounds();
  assert.ok(bounds.x + bounds.width <= 240 + 1000, "popup stays inside the page area");
  assert.ok(bounds.width <= 380);
  assert.deepEqual(controller.getPublicState().extensionPopup, {
    open: true,
    extensionId,
  });

  assert.equal(
    await controller.dispatch(commands.openExtensionPopup, { id: extensionId }),
    true,
    "invoking the same action again must toggle the popup closed"
  );
  assert.deepEqual(controller.getPublicState().extensionPopup, { open: false });
  assert.equal(popupView.visible, false);
});

test("escape closes the popup and popup links open as tabs", async t => {
  const { controller, state, workDirectory } = await createHarness(t);
  const extensionDirectory = path.join(workDirectory, "escape-popup");
  await writeExtension(extensionDirectory, {
    manifest_version: 3,
    name: "Escape Extension",
    version: "1.0",
    action: { default_popup: "popup.html" },
  });
  const extensionId = await controller.installExtension(extensionDirectory);
  assert.equal(controller.openExtensionPopup(extensionId), true);
  const popupContents = electronMock.views.at(-1).unsafeWebContents;

  const openResult = popupContents.windowOpenHandler({
    url: "https://example.com/from-popup",
  });
  assert.deepEqual(openResult, { action: "deny" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(
    state.tabs.some(tab => tab.url === "https://example.com/from-popup"),
    "http(s) links from the popup must become real tabs"
  );
  assert.deepEqual(
    controller.getPublicState().extensionPopup,
    { open: true, extensionId },
    "opening a link must not itself close the popup"
  );

  let prevented = false;
  popupContents.emit(
    "before-input-event",
    { preventDefault: () => { prevented = true; } },
    { type: "keyDown", key: "Escape" }
  );
  assert.equal(prevented, true);
  assert.deepEqual(controller.getPublicState().extensionPopup, { open: false });
});

test("refuses popups for unknown extensions and ones without an action popup", async t => {
  const { controller, workDirectory } = await createHarness(t);
  const noPopupDirectory = path.join(workDirectory, "no-popup");
  await writeExtension(noPopupDirectory, {
    manifest_version: 3,
    name: "No Popup",
    version: "1.0",
  });
  const escapingDirectory = path.join(workDirectory, "escaping-popup");
  await writeExtension(escapingDirectory, {
    manifest_version: 3,
    name: "Escaping Popup",
    version: "1.0",
    action: { default_popup: "../outside.html" },
  });

  const noPopupId = await controller.installExtension(noPopupDirectory);
  const escapingId = await controller.installExtension(escapingDirectory);
  assert.equal(controller.openExtensionPopup(noPopupId), false);
  assert.equal(controller.openExtensionPopup(escapingId), false);
  assert.equal(
    controller
      .getPublicState()
      .extensions.find(entry => entry.id === escapingId).popupPath,
    "",
    "a popup path escaping the extension root must be discarded at load time"
  );
  assert.equal(controller.openExtensionPopup("missing-extension"), false);
  assert.equal(controller.closeExtensionPopup(), false);
});
