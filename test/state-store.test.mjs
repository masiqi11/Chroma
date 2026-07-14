import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StateStore } from "../src/main/state-store.mjs";
import { createDefaultState } from "../src/shared/model.mjs";

function ids() {
  let value = 0;
  return () => `persisted-${++value}`;
}

test("persists atomically and restores a sanitized browser session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chroma-state-store-"));
  const filePath = path.join(directory, "state.json");
  const idFactory = ids();
  const state = createDefaultState(idFactory);
  const expectedTitle = state.tabs[0].title;
  const store = new StateStore(filePath, { idFactory });

  try {
    store.scheduleSave(state, 10_000);
    state.tabs[0].title = "mutated after scheduling";
    await store.flush();

    const disk = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(disk.tabs[0].title, expectedTitle);
    const restored = await store.load();
    assert.equal(restored.activeTabId, state.activeTabId);
    assert.equal(restored.tabs[0].title, expectedTitle);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("observes a debounced write failure without an unhandled rejection", async context => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chroma-state-failure-"));
  const blocker = path.join(directory, "not-a-directory");
  await writeFile(blocker, "block");
  const store = new StateStore(path.join(blocker, "state.json"), { idFactory: ids() });
  const warnings = [];
  context.mock.method(console, "warn", (...items) => warnings.push(items));

  try {
    store.scheduleSave(createDefaultState(ids()), 0);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /Unable to save Chromium shell state/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
