import test from "node:test";
import assert from "node:assert/strict";

import {
  BOOKMARK_FOLDER_LIMIT,
  BOOKMARK_FOLDER_MEMBER_LIMIT,
  FOLDER_MEMBER_LIMIT,
  LIBRARY_CONTAINER_LIMIT,
  repairBookmarkTopology,
  repairLibraryTopology,
} from "../src/shared/state-invariants.mjs";

const workspaces = [{ id: "space-a" }, { id: "space-b" }];
const tabs = [
  { id: "a-1", workspaceId: "space-a" },
  { id: "a-2", workspaceId: "space-a" },
  { id: "a-3", workspaceId: "space-a" },
  { id: "a-4", workspaceId: "space-a" },
  { id: "a-5", workspaceId: "space-a" },
  { id: "a-essential", workspaceId: "space-a", essential: true },
  { id: "a-pinned", workspaceId: "space-a", pinned: true },
  { id: "b-1", workspaceId: "space-b" },
  { id: "b-2", workspaceId: "space-b" },
];

function factory(...values) {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}

test("keeps valid topology and ordering unchanged", () => {
  const folders = [
    {
      id: "folder-a",
      workspaceId: "space-a",
      name: "First",
      tabIds: ["a-3", "a-1"],
      expanded: true,
    },
    {
      id: "folder-b",
      workspaceId: "space-b",
      name: "Second",
      tabIds: ["b-2", "b-1"],
      expanded: false,
    },
  ];
  const splitGroups = [
    {
      id: "split-a",
      workspaceId: "space-a",
      direction: "row",
      tabIds: ["a-4", "a-2"],
    },
    {
      id: "split-b",
      workspaceId: "space-b",
      direction: "column",
      tabIds: ["b-2", "b-1"],
    },
  ];

  const result = repairLibraryTopology(
    { workspaces, tabs, folders, splitGroups },
    factory("unused")
  );

  assert.deepEqual(result.folders, folders);
  assert.deepEqual(result.splitGroups, splitGroups);
  assert.deepEqual(result.stats, {
    folderIdsRepaired: 0,
    splitIdsRepaired: 0,
    foldersRemoved: 0,
    splitGroupsRemoved: 0,
    folderMembershipsRemoved: 0,
    splitMembershipsRemoved: 0,
    splitContainersRepaired: 0,
    totalRepairs: 0,
  });
  assert.notEqual(result.folders, folders);
  assert.notEqual(result.folders[0], folders[0]);
  assert.notEqual(result.folders[0].tabIds, folders[0].tabIds);
});

test("repairs topology IDs in one namespace without stealing later stable IDs", () => {
  const result = repairLibraryTopology(
    {
      workspaces,
      tabs,
      folders: [
        { id: "", workspaceId: "space-a", tabIds: [] },
        { id: "stable", workspaceId: "space-a", tabIds: [] },
        { id: "stable", workspaceId: "space-b", tabIds: [] },
      ],
      splitGroups: [
        {
          id: "shared",
          workspaceId: "space-a",
          tabIds: ["a-1", "a-2"],
        },
        {
          id: "shared",
          workspaceId: "space-b",
          tabIds: ["b-1", "b-2"],
        },
      ],
    },
    factory("stable", "shared", "new-folder", "new-duplicate", "new-split")
  );

  assert.deepEqual(
    result.folders.map(folder => folder.id),
    ["new-folder", "stable", "new-duplicate"]
  );
  assert.deepEqual(
    result.splitGroups.map(group => group.id),
    ["shared", "new-split"]
  );
  assert.equal(
    new Set([
      ...result.folders.map(folder => folder.id),
      ...result.splitGroups.map(group => group.id),
    ]).size,
    5
  );
  assert.equal(result.stats.folderIdsRepaired, 2);
  assert.equal(result.stats.splitIdsRepaired, 1);
  assert.equal(result.stats.totalRepairs, 3);
});

test("keeps each tab in only the first valid folder for its workspace", () => {
  const input = {
    workspaces,
    tabs,
    folders: [
      {
        id: "first",
        workspaceId: "space-a",
        tabIds: ["a-2", "a-1", "a-2", "b-1", "missing"],
      },
      {
        id: "second",
        workspaceId: "space-a",
        tabIds: ["a-1", "a-3"],
      },
      { id: "wrong-space", workspaceId: "missing", tabIds: ["a-4"] },
    ],
    splitGroups: [],
  };
  const snapshot = structuredClone(input);

  const result = repairLibraryTopology(input, factory());

  assert.deepEqual(
    result.folders.map(folder => ({ id: folder.id, tabIds: folder.tabIds })),
    [
      { id: "first", tabIds: ["a-2", "a-1"] },
      { id: "second", tabIds: ["a-3"] },
    ]
  );
  assert.equal(result.stats.foldersRemoved, 1);
  assert.equal(result.stats.folderMembershipsRemoved, 4);
  assert.equal(result.stats.totalRepairs, 5);
  assert.deepEqual(input, snapshot);
});

test("enforces split ownership, workspace, and two-to-four member bounds", () => {
  const result = repairLibraryTopology(
    {
      workspaces,
      tabs,
      folders: [],
      splitGroups: [
        {
          id: "too-small",
          workspaceId: "space-a",
          tabIds: ["a-1", "b-1", "missing"],
        },
        {
          id: "main",
          workspaceId: "space-a",
          tabIds: ["a-1", "a-2", "a-3", "a-4", "a-5"],
        },
        {
          id: "next",
          workspaceId: "space-a",
          tabIds: ["a-4", "a-5", "a-5", "a-1"],
        },
        {
          id: "invalid-space",
          workspaceId: "missing",
          tabIds: ["a-1", "a-2"],
        },
      ],
    },
    factory()
  );

  assert.deepEqual(
    result.splitGroups.map(group => ({ id: group.id, tabIds: group.tabIds })),
    [{ id: "main", tabIds: ["a-1", "a-2", "a-3", "a-4"] }]
  );
  assert.equal(result.stats.splitGroupsRemoved, 3);
  assert.equal(result.stats.splitMembershipsRemoved, 8);
  assert.equal(result.stats.totalRepairs, 11);
});

test("removes Essential tabs from restored split membership", () => {
  const result = repairLibraryTopology(
    {
      workspaces,
      tabs,
      folders: [],
      splitGroups: [
        {
          id: "essential-split",
          workspaceId: "space-a",
          tabIds: ["a-1", "a-essential", "a-2"],
        },
      ],
    },
    factory()
  );

  assert.deepEqual(result.splitGroups[0].tabIds, ["a-1", "a-2"]);
  assert.equal(result.stats.splitMembershipsRemoved, 1);
});

test("removes pinned and Essential tabs from every restored library container", () => {
  const result = repairLibraryTopology(
    {
      workspaces,
      tabs,
      folders: [{
        id: "folder",
        workspaceId: "space-a",
        tabIds: ["a-pinned", "a-1", "a-essential", "a-2"],
      }],
      splitGroups: [{
        id: "split",
        workspaceId: "space-a",
        tabIds: ["a-1", "a-pinned", "a-essential", "a-2"],
      }],
    },
    factory()
  );

  assert.deepEqual(result.folders[0].tabIds, ["a-1", "a-2"]);
  assert.deepEqual(result.splitGroups[0].tabIds, ["a-1", "a-2"]);
  assert.equal(result.stats.folderMembershipsRemoved, 2);
  assert.equal(result.stats.splitMembershipsRemoved, 2);
});

test("co-locates every split capsule in the first pane's folder container", () => {
  const result = repairLibraryTopology(
    {
      workspaces,
      tabs,
      folders: [
        {
          id: "anchor",
          workspaceId: "space-a",
          tabIds: ["a-3", "a-1", "a-4"],
        },
        {
          id: "source",
          workspaceId: "space-a",
          tabIds: ["a-5", "a-2"],
        },
      ],
      splitGroups: [
        {
          id: "split",
          workspaceId: "space-a",
          tabIds: ["a-1", "a-2", "a-3"],
        },
      ],
    },
    factory()
  );

  assert.deepEqual(result.folders, [
    {
      id: "anchor",
      workspaceId: "space-a",
      tabIds: ["a-1", "a-2", "a-3", "a-4"],
    },
    {
      id: "source",
      workspaceId: "space-a",
      tabIds: ["a-5"],
    },
  ]);
  assert.equal(result.stats.splitContainersRepaired, 1);
  assert.equal(result.stats.totalRepairs, 1);
});

test("preserves a folder when split co-location moves out its final member", () => {
  const result = repairLibraryTopology(
    {
      workspaces,
      tabs,
      folders: [
        { id: "anchor", workspaceId: "space-a", tabIds: ["a-1"] },
        { id: "source", workspaceId: "space-a", tabIds: ["a-2"] },
      ],
      splitGroups: [{
        id: "split",
        workspaceId: "space-a",
        tabIds: ["a-1", "a-2"],
      }],
    },
    factory()
  );

  assert.deepEqual(result.folders, [
    { id: "anchor", workspaceId: "space-a", tabIds: ["a-1", "a-2"] },
    { id: "source", workspaceId: "space-a", tabIds: [] },
  ]);
  assert.equal(result.stats.foldersRemoved, 0);
  assert.equal(result.stats.splitContainersRepaired, 1);
});

test("bounds folder entities and membership before topology repair", () => {
  const boundedTabs = Array.from(
    { length: FOLDER_MEMBER_LIMIT + 1 },
    (_, index) => ({ id: `bounded-${index}`, workspaceId: "space-a" })
  );
  const result = repairLibraryTopology(
    {
      workspaces,
      tabs: [...tabs, ...boundedTabs],
      folders: Array.from(
        { length: LIBRARY_CONTAINER_LIMIT + 1 },
        (_, index) => ({
          id: `folder-${index}`,
          workspaceId: "space-a",
          tabIds: index === 0
            ? boundedTabs.map(tab => tab.id)
            : [],
        })
      ),
      splitGroups: [],
    },
    factory()
  );

  assert.equal(result.folders.length, LIBRARY_CONTAINER_LIMIT);
  assert.equal(result.folders[0].tabIds.length, FOLDER_MEMBER_LIMIT);
  assert.equal(result.stats.foldersRemoved, 1);
  assert.equal(result.stats.folderMembershipsRemoved, 1);
});

test("a discarded split does not claim an ID needed by a later surviving split", () => {
  const result = repairLibraryTopology(
    {
      workspaces,
      tabs,
      folders: [],
      splitGroups: [
        { id: "keep-me", workspaceId: "space-a", tabIds: ["a-1"] },
        {
          id: "keep-me",
          workspaceId: "space-a",
          tabIds: ["a-1", "a-2"],
        },
      ],
    },
    factory("should-not-be-used")
  );

  assert.equal(result.splitGroups.length, 1);
  assert.equal(result.splitGroups[0].id, "keep-me");
  assert.equal(result.stats.splitIdsRepaired, 0);
  assert.equal(result.stats.splitGroupsRemoved, 1);
});

test("uses deterministic fallback IDs when the factory cannot produce one", () => {
  const result = repairLibraryTopology(
    {
      workspaces,
      tabs,
      folders: [
        { workspaceId: "space-a", tabIds: [] },
        { workspaceId: "space-b", tabIds: [] },
      ],
      splitGroups: [
        { workspaceId: "space-a", tabIds: ["a-1", "a-2"] },
      ],
    },
    () => ""
  );

  assert.deepEqual(
    result.folders.map(folder => folder.id),
    ["repaired-folder-1", "repaired-folder-2"]
  );
  assert.equal(result.splitGroups[0].id, "repaired-split-1");
  assert.equal(result.stats.totalRepairs, 3);
});

const bookmarks = [
  { id: "bm-1" },
  { id: "bm-2" },
  { id: "bm-3" },
];

test("keeps valid bookmark-folder topology and ordering unchanged", () => {
  const bookmarkFolders = [
    { id: "folder-a", name: "A", parentId: "", bookmarkIds: ["bm-1", "bm-2"], expanded: true },
    { id: "folder-b", name: "B", parentId: "folder-a", bookmarkIds: ["bm-3"], expanded: false },
  ];

  const result = repairBookmarkTopology(
    { bookmarks, bookmarkFolders },
    () => "generated"
  );

  assert.deepEqual(result.bookmarkFolders, bookmarkFolders);
  assert.deepEqual(result.stats, {
    folderIdsRepaired: 0,
    foldersRemoved: 0,
    membershipsRemoved: 0,
    parentsRepaired: 0,
    totalRepairs: 0,
  });
});

test("repairs bookmark-folder parents that cycle, self-reference, or dangle", () => {
  const result = repairBookmarkTopology(
    {
      bookmarks,
      bookmarkFolders: [
        { id: "cycle-a", name: "CycleA", parentId: "cycle-b", bookmarkIds: [], expanded: true },
        { id: "cycle-b", name: "CycleB", parentId: "cycle-a", bookmarkIds: [], expanded: true },
        { id: "selfie", name: "Selfie", parentId: "selfie", bookmarkIds: [], expanded: true },
        { id: "orphan", name: "Orphan", parentId: "missing-folder", bookmarkIds: [], expanded: true },
        { id: "fine", name: "Fine", parentId: "cycle-a", bookmarkIds: [], expanded: true },
      ],
    },
    () => "generated"
  );

  const parents = Object.fromEntries(
    result.bookmarkFolders.map(folder => [folder.id, folder.parentId])
  );
  assert.equal(parents.selfie, "", "self-parenting resets to top level");
  assert.equal(parents.orphan, "", "a dangling parent resets to top level");
  assert.ok(
    !(parents["cycle-a"] && parents["cycle-b"]),
    "a parent cycle must be broken"
  );
  assert.equal(parents.fine, "cycle-a", "children of a repaired folder stay attached");
  assert.ok(result.stats.parentsRepaired >= 3);
});

test("caps bookmark-folder nesting depth", () => {
  const chain = Array.from({ length: 12 }, (_, index) => ({
    id: `deep-${index}`,
    name: `Deep ${index}`,
    parentId: index === 0 ? "" : `deep-${index - 1}`,
    bookmarkIds: [],
    expanded: true,
  }));

  const result = repairBookmarkTopology(
    { bookmarks: [], bookmarkFolders: chain },
    () => "generated"
  );

  for (const folder of result.bookmarkFolders) {
    let depth = 0;
    let current = folder;
    const byId = new Map(result.bookmarkFolders.map(item => [item.id, item]));
    while (current.parentId) {
      current = byId.get(current.parentId);
      depth += 1;
      assert.ok(depth <= 8, "no folder may sit deeper than the depth cap");
    }
  }
  assert.ok(result.stats.parentsRepaired >= 1, "over-deep parents must be reset");
});

test("keeps each bookmark in only the first valid folder", () => {
  const result = repairBookmarkTopology(
    {
      bookmarks,
      bookmarkFolders: [
        { id: "folder-a", name: "A", bookmarkIds: ["bm-1", "bm-2"], expanded: true },
        { id: "folder-b", name: "B", bookmarkIds: ["bm-2", "bm-3"], expanded: true },
      ],
    },
    () => "generated"
  );

  assert.deepEqual(result.bookmarkFolders[0].bookmarkIds, ["bm-1", "bm-2"]);
  assert.deepEqual(result.bookmarkFolders[1].bookmarkIds, ["bm-3"]);
  assert.equal(result.stats.membershipsRemoved, 1);
});

test("drops bookmark-folder membership referencing an unknown bookmark", () => {
  const result = repairBookmarkTopology(
    {
      bookmarks,
      bookmarkFolders: [
        { id: "folder-a", name: "A", bookmarkIds: ["bm-1", "missing"], expanded: true },
      ],
    },
    () => "generated"
  );

  assert.deepEqual(result.bookmarkFolders[0].bookmarkIds, ["bm-1"]);
  assert.equal(result.stats.membershipsRemoved, 1);
});

test("keeps an explicitly empty bookmark folder as a durable entity", () => {
  const result = repairBookmarkTopology(
    {
      bookmarks,
      bookmarkFolders: [
        { id: "folder-a", name: "Empty", bookmarkIds: [], expanded: true },
      ],
    },
    () => "generated"
  );

  assert.equal(result.bookmarkFolders.length, 1);
  assert.deepEqual(result.bookmarkFolders[0].bookmarkIds, []);
});

test("repairs colliding bookmark-folder IDs in their own namespace", () => {
  const result = repairBookmarkTopology(
    {
      bookmarks,
      bookmarkFolders: [
        { id: "same-id", name: "First", bookmarkIds: ["bm-1"], expanded: true },
        { id: "same-id", name: "Second", bookmarkIds: ["bm-2"], expanded: true },
      ],
    },
    factory("same-id")
  );

  assert.equal(result.bookmarkFolders[0].id, "same-id");
  assert.notEqual(result.bookmarkFolders[1].id, "same-id");
  assert.equal(result.stats.folderIdsRepaired, 1);
});

test("bounds bookmark-folder entities and membership before repair", () => {
  const manyFolders = Array.from({ length: BOOKMARK_FOLDER_LIMIT + 2 }, (_, index) => ({
    id: `folder-${index}`,
    name: `Folder ${index}`,
    bookmarkIds: [],
    expanded: true,
  }));
  const manyBookmarkIds = Array.from(
    { length: BOOKMARK_FOLDER_MEMBER_LIMIT + 2 },
    (_, index) => `bm-${index}`
  );
  manyFolders[0].bookmarkIds = manyBookmarkIds;
  const manyBookmarks = manyBookmarkIds.map(id => ({ id }));

  const result = repairBookmarkTopology(
    { bookmarks: manyBookmarks, bookmarkFolders: manyFolders },
    () => "generated"
  );

  assert.equal(result.bookmarkFolders.length, BOOKMARK_FOLDER_LIMIT);
  assert.equal(
    result.bookmarkFolders[0].bookmarkIds.length,
    BOOKMARK_FOLDER_MEMBER_LIMIT
  );
  assert.equal(result.stats.foldersRemoved, 2);
  assert.ok(result.stats.membershipsRemoved >= 2);
});
