import test from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultState,
  sanitizeState,
  stateForDisk,
} from "../src/shared/model.mjs";

function ids() {
  let value = 0;
  return () => `id-${++value}`;
}

test("creates a usable first-run workspace and tab", () => {
  const state = createDefaultState(ids());
  assert.equal(state.workspaces.length, 1);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.activeWorkspaceId, state.workspaces[0].id);
  assert.equal(state.activeTabId, state.tabs[0].id);
});

test("repairs stale IDs and unsafe stored URLs", () => {
  const state = sanitizeState(
    {
      activeWorkspaceId: "missing",
      activeTabId: "missing",
      workspaces: [
        { id: "space", name: "Work", color: "red; background:url(https://invalid/)" },
      ],
      tabs: [
        {
          id: "tab",
          workspaceId: "missing",
          url: "javascript:alert(1)",
          title: "unsafe",
        },
      ],
      settings: { sidebarWidth: 9999 },
    },
    ids()
  );

  assert.equal(state.tabs[0].workspaceId, "space");
  assert.equal(state.tabs[0].url, "chroma://newtab/");
  assert.equal(state.activeWorkspaceId, "space");
  assert.equal(state.activeTabId, "tab");
  assert.equal(state.settings.sidebarWidth, 500);
  assert.equal(state.workspaces[0].color, "#e4a8ff");
});

test("removes volatile renderer state before persistence", () => {
  const state = createDefaultState(ids());
  state.tabs[0].loading = true;
  state.tabs[0].audible = true;
  state.downloads.push({ id: "download" });
  const persisted = stateForDisk(state);

  assert.equal(persisted.tabs[0].loading, false);
  assert.equal(persisted.tabs[0].audible, false);
  assert.deepEqual(persisted.downloads, []);
});
