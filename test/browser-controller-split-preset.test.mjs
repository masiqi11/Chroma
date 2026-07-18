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
  const state = createDefaultState(() => `split-preset-${nextId++}`);
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

test("applies a preset ratio to the active split and persists it", async t => {
  const { controller, snapshots, state } = createHarness(t);
  const first = await controller.createTab({ url: "https://example.com/first" });
  const second = await controller.createTab({ url: "https://example.com/second" });
  controller.splitTabs(second, first, "row", "after");

  assert.equal(
    await controller.dispatch(commands.setSplitPreset, { ratio: 0.7 }),
    true
  );
  const group = state.splitGroups[0];
  assert.equal(group.layout.ratio, 0.7);
  assert.equal(snapshots.at(-1).splitGroups[0].layout.ratio, 0.7);

  assert.equal(controller.setSplitPreset({ ratio: 0.5 }), true);
  assert.equal(group.layout.ratio, 0.5);
});

test("presets equalize nested dividers in a three-pane split", async t => {
  const { controller, state } = createHarness(t);
  const first = await controller.createTab({ url: "https://example.com/one" });
  const second = await controller.createTab({ url: "https://example.com/two" });
  const third = await controller.createTab({ url: "https://example.com/three" });
  controller.splitTabs(second, first, "row", "after");
  controller.splitTabs(third, first, "column", "after");

  const group = state.splitGroups[0];
  controller.commitSplitRatio({
    groupId: group.id,
    path: [],
    ratio: 0.3,
  });

  assert.equal(controller.setSplitPreset({ ratio: 0.7 }), true);
  assert.equal(group.layout.ratio, 0.7);
  const nested = [group.layout.first, group.layout.second].find(
    node => node.type === "split"
  );
  assert.equal(nested.ratio, 0.5);
});

test("rejects out-of-bounds ratios and tabs outside a split", async t => {
  const { controller, snapshots, state } = createHarness(t);
  const first = await controller.createTab({ url: "https://example.com/solo" });

  const commitsBefore = snapshots.length;
  assert.equal(controller.setSplitPreset({ ratio: 0.5 }), false);

  const second = await controller.createTab({ url: "https://example.com/pair" });
  controller.splitTabs(second, first, "row", "after");
  assert.equal(controller.setSplitPreset({ ratio: 0.1 }), false);
  assert.equal(controller.setSplitPreset({ ratio: 0.9 }), false);
  assert.equal(controller.setSplitPreset({ ratio: Number.NaN }), false);
  assert.equal(controller.setSplitPreset({ ratio: "0.5" }), false);
  assert.equal(controller.setSplitPreset({}), false);
  assert.equal(state.splitGroups[0].layout.ratio, 0.5);
  assert.ok(snapshots.length > commitsBefore, "the split itself commits");
});
