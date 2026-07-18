import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_APPEARANCE } from "../src/shared/appearance.mjs";
import {
  ENTITY_ID_MAX_LENGTH,
  HISTORY_DEFAULT_PREFERENCES,
  HISTORY_ENTRY_LIMIT,
  STATE_SCHEMA_VERSION,
  TAB_COUNT_LIMIT,
  TAB_DATA_FAVICON_MAX_LENGTH,
  TAB_URL_MAX_LENGTH,
  createDefaultState,
  normalizeContainerProxy,
  normalizeContainerUserAgent,
  normalizeTabFavicon,
  normalizeTabUrl,
  sanitizeHistory,
  sanitizeState,
  stateForDisk,
} from "../src/shared/model.mjs";
import { splitLayoutPaneIds } from "../src/shared/split-ratios.mjs";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 6, 16, 12);

function ids() {
  let value = 0;
  return () => `id-${++value}`;
}

function assertLibraryContainerInvariants(state) {
  const tabsById = new Map(state.tabs.map(tab => [tab.id, tab]));
  const coreIds = new Set([
    ...state.workspaces.map(workspace => workspace.id),
    ...state.tabs.map(tab => tab.id),
  ]);
  const containers = [...state.folders, ...state.splitGroups];
  const containerIds = containers.map(container => container.id);
  assert.equal(new Set(containerIds).size, containerIds.length);
  assert.equal(containerIds.some(id => coreIds.has(id)), false);

  for (const collection of [state.folders, state.splitGroups]) {
    const owners = new Set();
    for (const container of collection) {
      for (const tabId of container.tabIds) {
        assert.equal(owners.has(tabId), false);
        owners.add(tabId);
        assert.equal(
          tabsById.get(tabId)?.workspaceId,
          container.workspaceId
        );
      }
    }
  }

  for (const group of state.splitGroups) {
    assert.deepEqual(splitLayoutPaneIds(group.layout), group.tabIds);
  }
}

test("creates a usable first-run workspace and tab", () => {
  const state = createDefaultState(ids());
  assert.equal(state.workspaces.length, 1);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.activeWorkspaceId, state.workspaces[0].id);
  assert.equal(state.activeTabId, state.tabs[0].id);
  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(state.history, {
    revision: 0,
    entries: [],
    preferences: HISTORY_DEFAULT_PREFERENCES,
  });
  assert.deepEqual(state.settings.appearance, DEFAULT_APPEARANCE);
  assert.notEqual(state.settings.appearance, DEFAULT_APPEARANCE);
});

test("migrates schema-5 profiles to default appearance settings", () => {
  const candidate = createDefaultState(ids());
  candidate.schemaVersion = 5;
  delete candidate.settings.appearance;

  const state = sanitizeState(candidate, ids(), { now: NOW });

  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(state.settings.appearance, DEFAULT_APPEARANCE);
  assert.equal(Object.hasOwn(candidate.settings, "appearance"), false);
});

test("sanitizes and round-trips persisted appearance settings", () => {
  const candidate = createDefaultState(ids());
  candidate.settings.appearance = {
    theme: "light",
    reduceTransparency: true,
    injectedCss: "body { display: none }",
  };

  const state = sanitizeState(candidate, ids(), { now: NOW });
  const persisted = stateForDisk(state);
  const restored = sanitizeState(persisted, ids(), { now: NOW });

  assert.deepEqual(state.settings.appearance, {
    theme: "light",
    reduceTransparency: true,
  });
  assert.deepEqual(persisted.settings.appearance, state.settings.appearance);
  assert.deepEqual(restored.settings.appearance, state.settings.appearance);
  assert.notEqual(persisted.settings.appearance, state.settings.appearance);
  assert.notEqual(restored.settings.appearance, persisted.settings.appearance);
  assert.equal(Object.hasOwn(persisted.settings.appearance, "injectedCss"), false);
  assert.deepEqual(candidate.settings.appearance, {
    theme: "light",
    reduceTransparency: true,
    injectedCss: "body { display: none }",
  });
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

test("repairs blank workspace names with stable positional fallbacks", () => {
  const state = sanitizeState(
    {
      activeWorkspaceId: "space-first",
      activeTabId: "tab-first",
      workspaces: [
        { id: "space-first", name: "  Focus  " },
        { id: "space-second", name: "" },
        { id: "space-third", name: " \n\t " },
      ],
      tabs: [
        { id: "tab-first", workspaceId: "space-first" },
        { id: "tab-second", workspaceId: "space-second" },
        { id: "tab-third", workspaceId: "space-third" },
      ],
      settings: {},
    },
    ids(),
    { now: NOW }
  );

  assert.deepEqual(
    state.workspaces.map(workspace => workspace.name),
    ["Focus", "Space 2", "Space 3"]
  );
});

test("round-trips workspace order without re-sorting", () => {
  const state = sanitizeState(
    {
      activeWorkspaceId: "space-middle",
      activeTabId: "tab-middle",
      workspaces: [
        { id: "space-last", name: "Last" },
        { id: "space-first", name: "First" },
        { id: "space-middle", name: "Middle" },
      ],
      tabs: [
        { id: "tab-last", workspaceId: "space-last" },
        { id: "tab-first", workspaceId: "space-first" },
        { id: "tab-middle", workspaceId: "space-middle" },
      ],
      settings: {},
    },
    ids(),
    { now: NOW }
  );
  const persisted = stateForDisk(state);
  const restored = sanitizeState(persisted, ids(), { now: NOW });
  const expectedOrder = ["space-last", "space-first", "space-middle"];

  assert.deepEqual(state.workspaces.map(workspace => workspace.id), expectedOrder);
  assert.deepEqual(persisted.workspaces.map(workspace => workspace.id), expectedOrder);
  assert.deepEqual(restored.workspaces.map(workspace => workspace.id), expectedOrder);
  assert.equal(restored.activeWorkspaceId, "space-middle");
  assert.equal(restored.activeTabId, "tab-middle");
});

test("restores at least one usable tab for every workspace", () => {
  const state = sanitizeState(
    {
      activeWorkspaceId: "space-empty-active",
      activeTabId: "missing",
      workspaces: [
        { id: "space-empty-first", name: "First" },
        { id: "space-populated", name: "Populated" },
        { id: "space-empty-active", name: "Active" },
      ],
      tabs: [
        { id: "existing-tab", workspaceId: "space-populated" },
      ],
      settings: {},
    },
    ids(),
    { now: NOW }
  );

  for (const workspace of state.workspaces) {
    assert.ok(
      state.tabs.some(tab => tab.workspaceId === workspace.id),
      `workspace ${workspace.id} should own a tab`
    );
  }
  assert.equal(
    state.tabs.find(tab => tab.id === state.activeTabId)?.workspaceId,
    state.activeWorkspaceId
  );
});

test("bounds and privacy-normalizes tab URLs and favicons", () => {
  assert.equal(
    normalizeTabUrl("https://user:secret@example.com/path?q=kept#private"),
    "https://example.com/path?q=kept"
  );
  assert.equal(
    normalizeTabUrl("chroma://newtab/#section"),
    "chroma://newtab/#section"
  );
  assert.equal(
    normalizeTabUrl(`https://example.com/?q=${"x".repeat(TAB_URL_MAX_LENGTH)}`),
    "chroma://newtab/"
  );
  assert.equal(normalizeTabUrl("file:///tmp/private"), "chroma://newtab/");

  assert.equal(
    normalizeTabFavicon("https://user:secret@example.com/icon.png#tracking"),
    "https://example.com/icon.png"
  );
  const dataPrefix = "data:image/png;base64,";
  const maximumDataFavicon = `${dataPrefix}${"A".repeat(
    TAB_DATA_FAVICON_MAX_LENGTH - dataPrefix.length
  )}`;
  assert.equal(maximumDataFavicon.length, TAB_DATA_FAVICON_MAX_LENGTH);
  assert.equal(normalizeTabFavicon(maximumDataFavicon), maximumDataFavicon);
  assert.equal(normalizeTabFavicon(`${maximumDataFavicon}A`), "");
  assert.equal(normalizeTabFavicon("javascript:alert(1)"), "");
});

test("bounds every persisted entity ID and repairs matching references", () => {
  const longId = prefix => `${prefix}-${"x".repeat(ENTITY_ID_MAX_LENGTH * 2)}`;
  const workspaceId = longId("workspace");
  const tabIds = ["first", "second", "third", "fourth"].map(longId);
  let generated = 0;
  const generatedIds = () => longId(`generated-${++generated}`);
  const state = sanitizeState(
    {
      activeWorkspaceId: workspaceId,
      activeTabId: tabIds[2],
      workspaces: [{ id: workspaceId, name: "Bounded" }],
      tabs: tabIds.map((id, index) => ({
        id,
        workspaceId,
        url: index === 0
          ? "https://user:secret@example.com/page?q=1#private"
          : `https://example.com/${index}`,
        favicon: index === 0
          ? `data:image/png;base64,${"A".repeat(TAB_DATA_FAVICON_MAX_LENGTH)}`
          : "",
      })),
      folders: [{
        id: longId("folder"),
        workspaceId,
        tabIds: tabIds.slice(0, 2),
      }],
      splitGroups: [{
        id: longId("split"),
        workspaceId,
        tabIds: tabIds.slice(2),
      }],
      history: {
        revision: 0,
        entries: [{
          id: longId("history"),
          url: "https://example.com/history",
          title: "History",
          visitedAt: NOW,
          transition: "typed",
        }],
        preferences: HISTORY_DEFAULT_PREFERENCES,
      },
      bookmarks: [{
        id: longId("bookmark"),
        title: "Bookmark",
        url: "https://example.com/bookmark",
      }],
      downloads: [{
        id: longId("download"),
        url: "https://example.com/file.bin",
        filename: "file.bin",
        savePath: "/tmp/file.bin",
        state: "completed",
      }],
      settings: {},
    },
    generatedIds,
    { now: NOW }
  );

  const outputIds = [
    state.activeWorkspaceId,
    state.activeTabId,
    ...state.workspaces.flatMap(workspace => [workspace.id]),
    ...state.tabs.flatMap(tab => [tab.id, tab.workspaceId]),
    ...state.folders.flatMap(folder => [
      folder.id,
      folder.workspaceId,
      ...folder.tabIds,
    ]),
    ...state.splitGroups.flatMap(group => [
      group.id,
      group.workspaceId,
      ...group.tabIds,
      ...splitLayoutPaneIds(group.layout),
    ]),
    ...state.history.entries.map(entry => entry.id),
    ...state.bookmarks.map(bookmark => bookmark.id),
    ...state.downloads.map(download => download.id),
  ];
  assert.equal(outputIds.every(id => id.length <= ENTITY_ID_MAX_LENGTH), true);
  assert.equal(state.activeWorkspaceId, workspaceId.slice(0, ENTITY_ID_MAX_LENGTH));
  assert.equal(state.activeTabId, tabIds[2].slice(0, ENTITY_ID_MAX_LENGTH));
  assert.equal(state.tabs[0].url, "https://example.com/page?q=1");
  assert.equal(state.tabs[0].favicon, "");

  const persisted = stateForDisk(state);
  assert.equal(persisted.tabs.length, state.tabs.length);
  assert.equal(
    persisted.tabs.every(tab =>
      tab.id.length <= ENTITY_ID_MAX_LENGTH &&
      tab.workspaceId.length <= ENTITY_ID_MAX_LENGTH
    ),
    true
  );
});

test("caps restored tabs while preserving a usable active selection", () => {
  const state = sanitizeState(
    {
      activeWorkspaceId: "space",
      activeTabId: `tab-${TAB_COUNT_LIMIT + 10}`,
      workspaces: [{ id: "space", name: "Space" }],
      tabs: Array.from({ length: TAB_COUNT_LIMIT + 20 }, (_, index) => ({
        id: `tab-${index}`,
        workspaceId: "space",
        url: `https://example.com/${index}`,
      })),
      settings: {},
    },
    ids(),
    { now: NOW }
  );

  assert.equal(state.tabs.length, TAB_COUNT_LIMIT);
  assert.equal(state.tabs.at(-1).id, `tab-${TAB_COUNT_LIMIT - 1}`);
  assert.equal(state.activeTabId, "tab-0");
  assert.equal(state.tabs.some(tab => tab.id === state.activeTabId), true);
  assert.equal(stateForDisk(state).tabs.length, TAB_COUNT_LIMIT);
});

test("normalizes and persists empty folders while removing pinned memberships", () => {
  const candidate = createDefaultState(ids());
  const workspaceId = candidate.activeWorkspaceId;
  const normalId = candidate.activeTabId;
  candidate.tabs.push(
    {
      ...candidate.tabs[0],
      id: "pinned",
      pinned: true,
      url: "https://example.com/pinned",
    },
    {
      ...candidate.tabs[0],
      id: "essential",
      essential: true,
      pinned: false,
      url: "https://example.com/essential",
    }
  );
  candidate.folders = [
    {
      id: "empty",
      workspaceId,
      name: "   ",
      tabIds: [],
      expanded: false,
    },
    {
      id: "members",
      workspaceId,
      name: `  ${"M".repeat(90)}  `,
      tabIds: ["pinned", "essential", normalId],
      expanded: true,
    },
  ];

  const state = sanitizeState(candidate, ids(), { now: NOW });
  assert.deepEqual(
    state.folders.map(folder => ({
      id: folder.id,
      name: folder.name,
      tabIds: folder.tabIds,
      expanded: folder.expanded,
    })),
    [
      { id: "empty", name: "Folder", tabIds: [], expanded: false },
      {
        id: "members",
        name: "M".repeat(80),
        tabIds: [normalId],
        expanded: true,
      },
    ]
  );
  assert.equal(state.tabs.find(tab => tab.id === "essential").pinned, true);
  assert.deepEqual(stateForDisk(state).folders, state.folders);
});

test("integrates folder and split topology repair without changing active selection", () => {
  const state = sanitizeState(
    {
      activeWorkspaceId: "space-b",
      activeTabId: "b-2",
      workspaces: [
        { id: "space-a", name: "Alpha" },
        { id: "space-b", name: "Beta" },
      ],
      tabs: [
        { id: "a-1", workspaceId: "space-a", url: "https://a.example/1" },
        { id: "a-2", workspaceId: "space-a", url: "https://a.example/2" },
        { id: "a-3", workspaceId: "space-a", url: "https://a.example/3" },
        { id: "a-4", workspaceId: "space-a", url: "https://a.example/4" },
        { id: "b-1", workspaceId: "space-b", url: "https://b.example/1" },
        { id: "b-2", workspaceId: "space-b", url: "https://b.example/2" },
      ],
      folders: [
        {
          id: " shared ",
          workspaceId: "space-a",
          name: "Primary",
          tabIds: ["a-1", "a-1", "b-1", "missing"],
        },
        {
          id: "shared",
          workspaceId: "space-a",
          name: "Secondary",
          tabIds: ["a-1", "a-2"],
        },
        {
          id: "folder-b",
          workspaceId: "space-b",
          tabIds: ["b-1", "b-2"],
        },
        { id: "invalid-folder", workspaceId: "missing", tabIds: ["a-3"] },
      ],
      splitGroups: [
        {
          id: "shared",
          workspaceId: "space-a",
          direction: "diagonal",
          tabIds: ["a-1", "a-2", "b-1", "a-3", "a-4", "a-4"],
        },
        {
          id: "discarded-overlap",
          workspaceId: "space-a",
          tabIds: ["a-2", "a-3"],
        },
        {
          id: "split-b",
          workspaceId: "space-b",
          direction: "column",
          tabIds: ["b-2", "b-1"],
        },
      ],
    },
    ids()
  );

  assert.equal(state.activeWorkspaceId, "space-b");
  assert.equal(state.activeTabId, "b-2");
  assert.deepEqual(
    state.folders.map(folder => ({
      id: folder.id,
      workspaceId: folder.workspaceId,
      tabIds: folder.tabIds,
    })),
    [
      {
        id: "shared",
        workspaceId: "space-a",
        tabIds: ["a-1", "a-2", "a-3", "a-4"],
      },
      { id: "id-1", workspaceId: "space-a", tabIds: [] },
      { id: "folder-b", workspaceId: "space-b", tabIds: ["b-2", "b-1"] },
    ]
  );
  assert.deepEqual(
    state.splitGroups.map(group => ({
      id: group.id,
      workspaceId: group.workspaceId,
      direction: group.direction,
      tabIds: group.tabIds,
    })),
    [
      {
        id: "id-2",
        workspaceId: "space-a",
      direction: "grid",
        tabIds: ["a-1", "a-2", "a-3", "a-4"],
      },
      {
        id: "split-b",
        workspaceId: "space-b",
        direction: "column",
        tabIds: ["b-2", "b-1"],
      },
    ]
  );

  const topologyIds = [
    ...state.folders.map(folder => folder.id),
    ...state.splitGroups.map(group => group.id),
  ];
  assert.equal(new Set(topologyIds).size, topologyIds.length);

  const tabsById = new Map(state.tabs.map(tab => [tab.id, tab]));
  for (const entity of [...state.folders, ...state.splitGroups]) {
    assert.equal(
      entity.tabIds.every(tabId =>
        tabsById.get(tabId)?.workspaceId === entity.workspaceId
      ),
      true
    );
  }
});

test("enforces global container IDs and per-workspace ownership on hostile state", () => {
  const state = sanitizeState(
    {
      schemaVersion: 6,
      activeWorkspaceId: "space-a",
      activeTabId: "a-1",
      workspaces: [
        { id: "space-a", name: "Alpha" },
        { id: "space-b", name: "Beta" },
      ],
      tabs: [
        { id: "a-1", workspaceId: "space-a", url: "https://a.example/1" },
        { id: "a-2", workspaceId: "space-a", url: "https://a.example/2" },
        { id: "a-3", workspaceId: "space-a", url: "https://a.example/3" },
        { id: "a-4", workspaceId: "space-a", url: "https://a.example/4" },
        { id: "b-1", workspaceId: "space-b", url: "https://b.example/1" },
        { id: "b-2", workspaceId: "space-b", url: "https://b.example/2" },
      ],
      folders: [
        {
          id: "space-a",
          workspaceId: "space-a",
          tabIds: ["a-1", "b-1", "a-1"],
        },
        {
          id: "duplicate",
          workspaceId: "space-a",
          tabIds: ["a-1", "a-2"],
        },
        {
          id: "duplicate",
          workspaceId: "space-a",
          tabIds: ["a-2", "a-3"],
        },
        {
          id: "folder-b",
          workspaceId: "space-b",
          tabIds: ["b-1", "a-4", "b-2"],
        },
      ],
      splitGroups: [
        {
          id: "a-1",
          workspaceId: "space-a",
          tabIds: ["a-1", "a-2", "b-1", "a-1"],
        },
        {
          id: "duplicate",
          workspaceId: "space-a",
          tabIds: ["a-2", "a-3"],
        },
        {
          id: "split-a",
          workspaceId: "space-a",
          tabIds: ["a-3", "a-4"],
        },
        {
          id: "split-b",
          workspaceId: "space-b",
          tabIds: ["b-1", "b-2"],
        },
      ],
      settings: {},
    },
    ids(),
    { now: NOW }
  );

  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assertLibraryContainerInvariants(state);
  assert.equal(state.splitGroups.every(group => group.tabIds.length >= 2), true);
});

test("rebuilds cyclic or stale split layouts from the surviving membership", () => {
  const cyclicLayout = {
    type: "split",
    direction: "row",
    ratio: 0.7,
    first: null,
    second: { type: "pane", paneId: "a-2" },
  };
  cyclicLayout.first = cyclicLayout;

  const state = sanitizeState(
    {
      schemaVersion: 6,
      activeWorkspaceId: "space-a",
      activeTabId: "a-1",
      workspaces: [
        { id: "space-a", name: "Alpha" },
        { id: "space-b", name: "Beta" },
      ],
      tabs: [
        { id: "a-1", workspaceId: "space-a", url: "https://a.example/1" },
        { id: "a-2", workspaceId: "space-a", url: "https://a.example/2" },
        { id: "b-1", workspaceId: "space-b", url: "https://b.example/1" },
      ],
      folders: [],
      splitGroups: [{
        id: "split",
        workspaceId: "space-a",
        tabIds: ["a-1", "b-1", "a-2"],
        layout: cyclicLayout,
      }],
      settings: {},
    },
    ids(),
    { now: NOW }
  );

  assert.equal(cyclicLayout.first, cyclicLayout);
  assert.equal(state.splitGroups.length, 1);
  assert.deepEqual(state.splitGroups[0].tabIds, ["a-1", "a-2"]);
  assert.deepEqual(splitLayoutPaneIds(state.splitGroups[0].layout), [
    "a-1",
    "a-2",
  ]);
  assertLibraryContainerInvariants(state);
});

test("repairs library containers again at the disk snapshot boundary", () => {
  const liveState = createDefaultState(ids());
  const workspaceId = liveState.activeWorkspaceId;
  const firstId = liveState.tabs[0].id;
  for (const id of ["second", "third", "fourth"]) {
    liveState.tabs.push({
      ...liveState.tabs[0],
      id,
      workspaceId,
      url: `https://example.com/${id}`,
    });
  }
  liveState.folders = [
    {
      id: workspaceId,
      workspaceId,
      name: "First",
      tabIds: [firstId, "second", "second"],
      expanded: true,
    },
    {
      id: workspaceId,
      workspaceId,
      name: "Second",
      tabIds: ["second", "third"],
      expanded: true,
    },
  ];
  liveState.splitGroups = [
    {
      id: firstId,
      workspaceId,
      direction: "row",
      tabIds: [firstId, "second"],
      layout: {
        type: "split",
        direction: "row",
        first: { type: "pane", paneId: firstId },
        second: { type: "pane", paneId: "stale" },
      },
    },
    {
      id: firstId,
      workspaceId,
      direction: "row",
      tabIds: ["second", "third", "fourth"],
      layout: null,
    },
  ];
  const originalFolders = structuredClone(liveState.folders);
  const originalSplitGroups = structuredClone(liveState.splitGroups);

  const persisted = stateForDisk(liveState);

  assert.equal(persisted.schemaVersion, STATE_SCHEMA_VERSION);
  assertLibraryContainerInvariants(persisted);
  assert.deepEqual(liveState.folders, originalFolders);
  assert.deepEqual(liveState.splitGroups, originalSplitGroups);
});

test("repairs and persists split ratio trees with pane order intact", () => {
  const candidate = createDefaultState(ids());
  const workspaceId = candidate.activeWorkspaceId;
  const firstId = candidate.tabs[0].id;
  const secondId = "split-second";
  const thirdId = "split-third";
  candidate.tabs.push(
    {
      ...candidate.tabs[0],
      id: secondId,
      workspaceId,
      url: "https://example.com/second",
    },
    {
      ...candidate.tabs[0],
      id: thirdId,
      workspaceId,
      url: "https://example.com/third",
    }
  );
  candidate.splitGroups = [{
    id: "split",
    workspaceId,
    direction: "grid",
    tabIds: [firstId, secondId, thirdId],
    layout: {
      type: "split",
      direction: "row",
      ratio: .95,
      first: { type: "pane", paneId: secondId },
      second: {
        type: "split",
        direction: "column",
        ratio: .1,
        first: { type: "pane", paneId: firstId },
        second: { type: "pane", paneId: thirdId },
      },
    },
  }];

  const state = sanitizeState(candidate, ids(), { now: NOW });
  const group = state.splitGroups[0];
  assert.deepEqual(group.tabIds, [secondId, firstId, thirdId]);
  assert.equal(group.layout.ratio, .8);
  assert.equal(group.layout.second.ratio, .2);
  assert.deepEqual(stateForDisk(state).splitGroups[0].layout, group.layout);
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
  assert.deepEqual(persisted.history, state.history);
  assert.notEqual(persisted.history, state.history);
  assert.notEqual(persisted.history.entries, state.history.entries);
  assert.notEqual(persisted.history.preferences, state.history.preferences);
});

test("persists only bounded terminal download metadata and repairs unsafe fields", () => {
  const candidate = createDefaultState(ids());
  candidate.downloads = [
    {
      id: "download",
      url: "https://user:secret@example.com/archive.zip#private",
      filename: "archive.zip",
      mimeType: "application/zip",
      savePath: "/tmp/archive.zip",
      state: "completed",
      receivedBytes: 200,
      totalBytes: 200,
      startedAt: NOW - 2_000,
      updatedAt: NOW - 1_000,
      completedAt: NOW,
      paused: true,
      terminal: true,
    },
    {
      id: "download",
      url: "javascript:alert(1)",
      filename: "cancelled.bin",
      savePath: "relative/file.bin",
      state: "cancelled",
      receivedBytes: -10,
      totalBytes: Number.POSITIVE_INFINITY,
    },
    { id: "active", state: "progressing", filename: "active.bin" },
  ];

  const state = sanitizeState(candidate, ids(), { now: NOW });
  assert.equal(state.downloads.length, 2);
  assert.equal(new Set(state.downloads.map(item => item.id)).size, 2);
  assert.deepEqual(state.downloads[0], {
    id: "download",
    url: "https://example.com/archive.zip",
    filename: "archive.zip",
    mimeType: "application/zip",
    savePath: "/tmp/archive.zip",
    state: "completed",
    receivedBytes: 200,
    totalBytes: 200,
    startedAt: NOW - 2_000,
    updatedAt: NOW - 1_000,
    completedAt: NOW,
  });
  assert.equal(state.downloads[1].url, "");
  assert.equal(state.downloads[1].savePath, "");
  assert.equal(state.downloads[1].receivedBytes, 0);
  assert.equal(state.downloads[1].totalBytes, 0);
  assert.deepEqual(stateForDisk(state).downloads, state.downloads);
});

test("migrates legacy history with privacy-safe URLs and default preferences", () => {
  const candidate = createDefaultState(ids());
  candidate.schemaVersion = 2;
  candidate.history = [
    {
      url: "https://user:secret@example.com/path?query=kept#private-fragment",
      title: "  Example visit  ",
      visitedAt: NOW - DAY_MS,
    },
    {
      url: "javascript:alert(1)",
      title: "Unsafe",
      visitedAt: NOW - 2_000,
    },
    {
      url: "http://example.org/newer#section",
      title: "   ",
      visitedAt: Number.NaN,
    },
  ];

  const state = sanitizeState(candidate, ids(), { now: NOW });

  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(state.history.revision, 1);
  assert.deepEqual(state.history.preferences, HISTORY_DEFAULT_PREFERENCES);
  assert.equal(state.history.entries.length, 2);
  assert.deepEqual(
    state.history.entries.map(({ url, title, visitedAt, transition }) => ({
      url,
      title,
      visitedAt,
      transition,
    })),
    [
      {
        url: "https://example.com/path?query=kept",
        title: "Example visit",
        visitedAt: NOW - DAY_MS,
        transition: "other",
      },
      {
        url: "http://example.org/newer",
        title: "http://example.org/newer",
        visitedAt: NOW,
        transition: "other",
      },
    ]
  );
  assert.equal(new Set(state.history.entries.map(entry => entry.id)).size, 2);
});

test("repairs malformed history entries independently and keeps stable valid IDs", () => {
  const tooLongUrl = `https://example.net/?q=${"x".repeat(8_192)}`;
  const history = sanitizeHistory(
    {
      revision: 4,
      entries: [
        {
          id: "stable",
          url: "https://name:password@example.com/first?q=1#fragment",
          title: `  ${"T".repeat(510)}  `,
          visitedAt: NOW - 1_000,
          transition: "typed",
        },
        {
          id: "stable",
          url: "https://example.com/second#fragment",
          title: "Second",
          visitedAt: NOW + 5 * 60 * 1_000,
          transition: "unexpected",
        },
        {
          id: "future",
          url: "http://example.com/future",
          title: "Future",
          visitedAt: NOW + 5 * 60 * 1_000 + 1,
          transition: "link",
        },
        { id: "unsafe", url: "data:text/html,unsafe", visitedAt: NOW },
        { id: "long", url: tooLongUrl, visitedAt: NOW },
      ],
      preferences: {
        recordingEnabled: false,
        retentionDays: 0,
        clearOnExit: true,
      },
    },
    ids(),
    { now: NOW }
  );

  assert.equal(history.revision, 5);
  assert.deepEqual(history.preferences, {
    recordingEnabled: false,
    retentionDays: 0,
    clearOnExit: true,
  });
  assert.equal(history.entries.length, 3);
  assert.equal(history.entries[0].id, "stable");
  assert.equal(history.entries[0].url, "https://example.com/first?q=1");
  assert.equal(history.entries[0].title.length, 500);
  const repairedDuplicate = history.entries.find(entry =>
    entry.url.endsWith("/second")
  );
  const clampedFuture = history.entries.find(entry =>
    entry.url.endsWith("/future")
  );
  assert.notEqual(repairedDuplicate.id, "stable");
  assert.equal(repairedDuplicate.visitedAt, NOW + 5 * 60 * 1_000);
  assert.equal(repairedDuplicate.transition, "other");
  assert.equal(clampedFuture.visitedAt, NOW);
  assert.equal(clampedFuture.transition, "link");
  assert.equal(new Set(history.entries.map(entry => entry.id)).size, 3);
});

test("applies every supported retention window at its inclusive boundary", () => {
  for (const retentionDays of [7, 30, 90, 365]) {
    const history = sanitizeHistory(
      {
        revision: 10,
        entries: [
          {
            id: `expired-${retentionDays}`,
            url: `https://example.com/expired/${retentionDays}`,
            title: "Expired",
            visitedAt: NOW - retentionDays * DAY_MS - 1,
            transition: "other",
          },
          {
            id: `boundary-${retentionDays}`,
            url: `https://example.com/boundary/${retentionDays}`,
            title: "Boundary",
            visitedAt: NOW - retentionDays * DAY_MS,
            transition: "other",
          },
        ],
        preferences: {
          recordingEnabled: true,
          retentionDays,
          clearOnExit: false,
        },
      },
      ids(),
      { now: NOW }
    );

    assert.deepEqual(
      history.entries.map(entry => entry.id),
      [`boundary-${retentionDays}`]
    );
    assert.equal(history.revision, 11);
  }
});

test("unlimited retention still enforces the 10,000 entry disk cap", () => {
  const entries = Array.from({ length: HISTORY_ENTRY_LIMIT + 3 }, (_, index) => ({
    id: `visit-${index}`,
    url: `https://example.com/${index}`,
    title: `Visit ${index}`,
    visitedAt: NOW - HISTORY_ENTRY_LIMIT - 3 + index,
    transition: "link",
  }));
  const history = sanitizeHistory(
    {
      revision: 8,
      entries,
      preferences: {
        recordingEnabled: true,
        retentionDays: 0,
        clearOnExit: false,
      },
    },
    ids(),
    { now: NOW }
  );

  assert.equal(history.entries.length, HISTORY_ENTRY_LIMIT);
  assert.equal(history.entries[0].id, "visit-3");
  assert.equal(history.entries.at(-1).id, `visit-${HISTORY_ENTRY_LIMIT + 2}`);
  assert.equal(history.revision, 9);
});

test("sanitizes, repairs, and deduplicates stored bookmarks", () => {
  const state = sanitizeState(
    {
      ...createDefaultState(ids()),
      bookmarks: [
        {
          id: "bookmark",
          title: "Example",
          url: "https://example.com",
          createdAt: 123,
        },
        {
          id: "duplicate-url",
          title: "Duplicate",
          url: "https://example.com/",
        },
        {
          id: "bookmark",
          title: "Second",
          url: "http://example.org/path",
        },
        { id: "unsafe", title: "Unsafe", url: "javascript:alert(1)" },
        { id: "internal", title: "Internal", url: "chroma://newtab/" },
      ],
    },
    ids()
  );

  assert.deepEqual(
    state.bookmarks.map(({ title, url }) => ({ title, url })),
    [
      { title: "Example", url: "https://example.com/" },
      { title: "Second", url: "http://example.org/path" },
    ]
  );
  assert.equal(new Set(state.bookmarks.map(bookmark => bookmark.id)).size, 2);
  assert.equal(state.bookmarks[0].createdAt, 123);
  assert.equal(Number.isFinite(state.bookmarks[1].createdAt), true);
});

test("persists bookmarks while repairing missing bookmark state", () => {
  const firstRun = createDefaultState(ids());
  assert.deepEqual(firstRun.bookmarks, []);

  firstRun.bookmarks.push({
    id: "bookmark",
    title: "Example",
    url: "https://example.com/",
    createdAt: 123,
  });
  assert.deepEqual(stateForDisk(firstRun).bookmarks, firstRun.bookmarks);

  const restored = sanitizeState({ ...firstRun, bookmarks: undefined }, ids());
  assert.deepEqual(restored.bookmarks, []);
});

test("migrates schema-6 profiles to an empty bookmark-folder list", () => {
  const candidate = createDefaultState(ids());
  candidate.schemaVersion = 6;
  delete candidate.bookmarkFolders;

  const state = sanitizeState(candidate, ids(), { now: NOW });

  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(state.bookmarkFolders, []);
  assert.equal(Object.hasOwn(candidate, "bookmarkFolders"), false);
});

test("sanitizes bookmark folders and repairs stale or duplicate membership", () => {
  const base = createDefaultState(ids());
  base.bookmarks = [
    { id: "b1", title: "One", url: "https://example.com/one", createdAt: 1 },
    { id: "b2", title: "Two", url: "https://example.com/two", createdAt: 2 },
    { id: "b3", title: "Three", url: "https://example.com/three", createdAt: 3 },
  ];
  base.bookmarkFolders = [
    {
      id: "folder-a",
      name: "Folder A",
      bookmarkIds: ["b1", "b2", "missing-bookmark"],
      expanded: true,
    },
    {
      id: "folder-a",
      name: "Duplicate ID",
      bookmarkIds: ["b2", "b3"],
      expanded: false,
    },
  ];

  const state = sanitizeState(base, ids());

  assert.equal(state.bookmarkFolders.length, 2);
  assert.equal(new Set(state.bookmarkFolders.map(folder => folder.id)).size, 2);
  assert.deepEqual(state.bookmarkFolders[0].bookmarkIds, ["b1", "b2"]);
  assert.deepEqual(state.bookmarkFolders[1].bookmarkIds, ["b3"]);
});

test("keeps an explicitly empty bookmark folder as a durable entity", () => {
  const base = createDefaultState(ids());
  base.bookmarks = [];
  base.bookmarkFolders = [
    { id: "folder-a", name: "Empty", bookmarkIds: [], expanded: true },
  ];

  const state = sanitizeState(base, ids());

  assert.equal(state.bookmarkFolders.length, 1);
  assert.deepEqual(state.bookmarkFolders[0].bookmarkIds, []);
});

test("persists bookmark folders while repairing missing bookmark-folder state", () => {
  const firstRun = createDefaultState(ids());
  firstRun.bookmarks.push({
    id: "bookmark",
    title: "Example",
    url: "https://example.com/",
    createdAt: 123,
  });
  firstRun.bookmarkFolders.push({
    id: "folder",
    name: "Folder",
    parentId: "",
    bookmarkIds: ["bookmark"],
    expanded: true,
  });
  assert.deepEqual(stateForDisk(firstRun).bookmarkFolders, firstRun.bookmarkFolders);

  const restored = sanitizeState({ ...firstRun, bookmarkFolders: undefined }, ids());
  assert.deepEqual(restored.bookmarkFolders, []);
});

test("migrates schema-7 profiles to empty containers and default-container tabs", () => {
  const candidate = createDefaultState(ids());
  candidate.schemaVersion = 7;
  delete candidate.containers;
  for (const tab of candidate.tabs) delete tab.containerId;

  const state = sanitizeState(candidate, ids(), { now: NOW });

  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(state.containers, []);
  assert.equal(state.tabs.every(tab => tab.containerId === ""), true);
});

test("sanitizes containers to partition-safe IDs and valid tab references", () => {
  const base = createDefaultState(ids());
  base.containers = [
    { id: "work-A_1", name: "  Work  ", color: "#AABBCC" },
    { id: "bad id/../escape", name: "Escape", color: "not-a-color" },
    { id: "work-A_1", name: "Duplicate", color: "#123456" },
    { id: "orphan-target", name: "Orphan", color: "#654321" },
  ];
  base.tabs[0].containerId = "work-A_1";
  base.tabs.push({
    ...base.tabs[0],
    id: "tab-orphan",
    containerId: "missing-container",
  });

  const state = sanitizeState(base, ids());

  assert.equal(state.containers.length, 4);
  assert.equal(state.containers[0].id, "work-A_1");
  assert.equal(state.containers[0].name, "Work");
  assert.equal(state.containers[0].color, "#aabbcc");
  assert.equal(/^[A-Za-z0-9_-]{1,64}$/.test(state.containers[1].id), true);
  assert.notEqual(state.containers[1].id, "bad id/../escape");
  assert.equal(state.containers[1].color, "#7cc4ff");
  assert.notEqual(state.containers[2].id, "work-A_1");
  assert.equal(new Set(state.containers.map(container => container.id)).size, 4);
  assert.equal(state.tabs[0].containerId, "work-A_1");
  assert.equal(
    state.tabs.find(tab => tab.id === "tab-orphan").containerId,
    "",
    "a tab referencing a missing container must fall back to the default partition"
  );
});

test("migrates schema-11 containers to a direct proxy policy", () => {
  const candidate = createDefaultState(ids());
  candidate.schemaVersion = 11;
  candidate.containers = [{ id: "work-A_1", name: "Work", color: "#aabbcc" }];

  const state = sanitizeState(candidate, ids(), { now: NOW });

  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(state.containers[0].proxy, "");
});

test("migrates schema-12 containers to the default user agent", () => {
  const candidate = createDefaultState(ids());
  candidate.schemaVersion = 12;
  candidate.containers = [
    { id: "work-A_1", name: "Work", color: "#aabbcc", proxy: "http://p.example:80" },
  ];

  const state = sanitizeState(candidate, ids(), { now: NOW });

  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(state.containers[0].userAgent, "");
  assert.equal(state.containers[0].proxy, "http://p.example:80");
});

test("normalizeContainerUserAgent admits only bounded printable ASCII", () => {
  assert.equal(
    normalizeContainerUserAgent("  Mozilla/5.0 (X11; Linux x86_64) Custom/1.0  "),
    "Mozilla/5.0 (X11; Linux x86_64) Custom/1.0"
  );
  assert.equal(normalizeContainerUserAgent("UA\r\nInjected: header"), "");
  assert.equal(normalizeContainerUserAgent("UA\u0000null"), "");
  assert.equal(normalizeContainerUserAgent("模拟浏览器/1.0"), "");
  assert.equal(normalizeContainerUserAgent("a".repeat(513)), "");
  assert.equal(normalizeContainerUserAgent("   "), "");
  assert.equal(normalizeContainerUserAgent(42), "");
});

test("sanitizes container proxy rules to a single explicit endpoint", () => {
  const base = createDefaultState(ids());
  base.containers = [
    { id: "keep-1", name: "Keep", color: "#aabbcc", proxy: " SOCKS5://127.0.0.1:1080 " },
    { id: "keep-2", name: "Default port", color: "#aabbcc", proxy: "http://proxy.example" },
    { id: "drop-1", name: "Bad scheme", color: "#aabbcc", proxy: "ftp://proxy.example:21" },
    { id: "drop-2", name: "Credentials", color: "#aabbcc", proxy: "http://user:pw@proxy.example:8080" },
  ];

  const state = sanitizeState(base, ids());

  assert.equal(state.containers[0].proxy, "socks5://127.0.0.1:1080");
  assert.equal(state.containers[1].proxy, "http://proxy.example:80");
  assert.equal(state.containers[2].proxy, "");
  assert.equal(state.containers[3].proxy, "");
});

test("normalizeContainerProxy admits only known proxy schemes with usable ports", () => {
  assert.equal(normalizeContainerProxy("socks5://[::1]:9050"), "socks5://[::1]:9050");
  assert.equal(normalizeContainerProxy("HTTPS://Proxy.Example:8443"), "https://proxy.example:8443");
  assert.equal(normalizeContainerProxy("socks4://relay.example:1080"), "socks4://relay.example:1080");
  assert.equal(normalizeContainerProxy("https://proxy.example"), "https://proxy.example:443");
  assert.equal(normalizeContainerProxy("socks5://relay.example"), "", "SOCKS has no default port");
  assert.equal(normalizeContainerProxy("http://proxy.example:0"), "");
  assert.equal(normalizeContainerProxy("http://proxy.example:70000"), "");
  assert.equal(normalizeContainerProxy("http://proxy.example:8080/path"), "");
  assert.equal(normalizeContainerProxy("http://proxy.example:8080?x=1"), "");
  assert.equal(normalizeContainerProxy("javascript:alert(1)"), "");
  assert.equal(normalizeContainerProxy("proxy.example:8080"), "", "a scheme is required");
  assert.equal(normalizeContainerProxy(`http://${"a".repeat(300)}:80`), "");
  assert.equal(normalizeContainerProxy(42), "");
});

test("migrates schema-8 profiles to an empty live-folder list", () => {
  const candidate = createDefaultState(ids());
  candidate.schemaVersion = 8;
  delete candidate.liveFolders;

  const state = sanitizeState(candidate, ids(), { now: NOW });

  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(state.liveFolders, []);
  assert.equal(Object.hasOwn(candidate, "liveFolders"), false);
});

test("sanitizes live folders to safe sources and capped, deduplicated items", () => {
  const base = createDefaultState(ids());
  base.liveFolders = [
    {
      id: "live-a",
      name: "  News  ",
      sourceUrl: "https://feeds.example/news.xml",
      expanded: false,
      items: [
        { url: "https://example.com/one", title: "  One  " },
        { url: "https://example.com/one", title: "Duplicate" },
        { url: "javascript:alert(1)", title: "Unsafe" },
        { url: "https://example.com/two", title: "" },
        { title: "No URL at all" },
      ],
      refreshedAt: NOW + 999_999,
      status: "error",
    },
    { id: "live-b", name: "Dup source", sourceUrl: "https://feeds.example/news.xml" },
    { id: "live-c", name: "Bad source", sourceUrl: "file:///etc/passwd" },
    { id: "live-a", name: "Dup ID", sourceUrl: "https://feeds.example/other.xml" },
  ];

  const state = sanitizeState(base, ids(), { now: NOW });

  assert.equal(state.liveFolders.length, 2);
  const [first, second] = state.liveFolders;
  assert.equal(first.id, "live-a");
  assert.equal(first.name, "News");
  assert.equal(first.expanded, false);
  assert.equal(first.status, "error");
  assert.equal(first.refreshedAt, NOW, "future refresh stamps clamp to now");
  assert.deepEqual(first.items, [
    { url: "https://example.com/one", title: "One" },
    { url: "https://example.com/two", title: "https://example.com/two" },
  ]);
  assert.notEqual(second.id, "live-a");
  assert.equal(second.sourceUrl, "https://feeds.example/other.xml");
  assert.equal(second.status, "ok");
  assert.equal(second.refreshedAt, 0);
});

test("migrates schema-10 essentials to an empty saved-page field", () => {
  const candidate = createDefaultState(ids());
  candidate.schemaVersion = 10;
  candidate.tabs[0].essential = true;
  candidate.tabs[0].pinned = true;
  delete candidate.tabs[0].essentialUrl;

  const state = sanitizeState(candidate, ids(), { now: NOW });

  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(state.tabs[0].essentialUrl, "");
});

test("migrates schema-9 bookmark folders to top-level parents", () => {
  const candidate = createDefaultState(ids());
  candidate.schemaVersion = 9;
  candidate.bookmarks.push({
    id: "bm",
    title: "Example",
    url: "https://example.com/",
    createdAt: 1,
  });
  candidate.bookmarkFolders.push({
    id: "legacy-folder",
    name: "Legacy",
    bookmarkIds: ["bm"],
    expanded: true,
  });
  delete candidate.bookmarkFolders[0].parentId;

  const state = sanitizeState(candidate, ids(), { now: NOW });

  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(state.bookmarkFolders[0].parentId, "");
});

test("persists live folders across disk round-trips", () => {
  const firstRun = createDefaultState(ids());
  firstRun.liveFolders.push({
    id: "live-folder",
    name: "Reader",
    sourceUrl: "https://feeds.example/reader.xml",
    expanded: true,
    items: [{ url: "https://example.com/article", title: "Article" }],
    refreshedAt: 123,
    status: "ok",
  });
  assert.deepEqual(stateForDisk(firstRun).liveFolders, firstRun.liveFolders);

  const restored = sanitizeState({ ...firstRun, liveFolders: undefined }, ids());
  assert.deepEqual(restored.liveFolders, []);
});
