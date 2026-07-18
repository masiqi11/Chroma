const GENERATED_ID_ATTEMPTS = 100;

export const LIBRARY_CONTAINER_LIMIT = 512;
export const FOLDER_MEMBER_LIMIT = 512;
export const BOOKMARK_FOLDER_LIMIT = 512;
export const BOOKMARK_FOLDER_MEMBER_LIMIT = 512;
export const BOOKMARK_FOLDER_DEPTH_LIMIT = 8;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function referenceId(value) {
  return typeof value === "string" && value.length ? value : "";
}

function collectReservedIds(folders, splitGroups) {
  const reservedIds = new Set();
  for (const item of [...folders, ...splitGroups]) {
    const id = normalizedId(item?.id);
    if (id) reservedIds.add(id);
  }
  return reservedIds;
}

function nextUniqueId(idFactory, usedIds, reservedIds, prefix) {
  if (typeof idFactory === "function") {
    for (let attempt = 0; attempt < GENERATED_ID_ATTEMPTS; attempt += 1) {
      const candidate = normalizedId(idFactory());
      if (candidate && !usedIds.has(candidate) && !reservedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
    }
  }

  let suffix = 1;
  while (
    usedIds.has(`${prefix}-${suffix}`) ||
    reservedIds.has(`${prefix}-${suffix}`)
  ) {
    suffix += 1;
  }
  const id = `${prefix}-${suffix}`;
  usedIds.add(id);
  return id;
}

function repairEntityId(item, idFactory, usedIds, reservedIds, prefix) {
  const candidate = normalizedId(item?.id);
  if (candidate && !usedIds.has(candidate)) {
    usedIds.add(candidate);
    return { id: candidate, repaired: candidate !== item.id };
  }

  return {
    id: nextUniqueId(idFactory, usedIds, reservedIds, prefix),
    repaired: true,
  };
}

function indexTabs(tabs, workspaceIds) {
  const tabsById = new Map();
  for (const tab of tabs) {
    const id = referenceId(tab?.id);
    if (
      !id ||
      tabsById.has(id) ||
      !workspaceIds.has(tab?.workspaceId)
    ) {
      continue;
    }
    tabsById.set(id, tab);
  }
  return tabsById;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Repairs folder and split membership invariants without mutating the input.
 *
 * Entity and member order is stable. When a tab is claimed more than once, the
 * first surviving folder or split group owns it. Every split group is repaired
 * into one folder container (anchored by its first pane) or into the ungrouped
 * container. Folder and split IDs share one namespace so an ID cannot identify
 * two topology entities. Pinned and Essential tabs cannot belong to either
 * container type, while an explicitly empty folder remains a durable entity.
 *
 * @param {{workspaces?: unknown[], tabs?: unknown[], folders?: unknown[], splitGroups?: unknown[]}} topology
 * @param {() => string} idFactory
 * @returns {{folders: object[], splitGroups: object[], stats: object}}
 */
export function repairLibraryTopology(
  { workspaces, tabs, folders, splitGroups } = {},
  idFactory
) {
  const sourceWorkspaces = asArray(workspaces);
  const sourceTabs = asArray(tabs);
  const allFolders = asArray(folders);
  const allSplitGroups = asArray(splitGroups);
  const sourceFolders = allFolders.slice(0, LIBRARY_CONTAINER_LIMIT);
  const sourceSplitGroups = allSplitGroups.slice(0, LIBRARY_CONTAINER_LIMIT);
  const workspaceIds = new Set(
    sourceWorkspaces.map(workspace => referenceId(workspace?.id)).filter(Boolean)
  );
  const tabsById = indexTabs(sourceTabs, workspaceIds);
  const reservedIds = collectReservedIds(sourceFolders, sourceSplitGroups);
  const usedEntityIds = new Set();
  const claimedFolderTabs = new Set();
  const claimedSplitTabs = new Set();
  const repairedFolders = [];
  const repairedSplitGroups = [];
  const stats = {
    folderIdsRepaired: 0,
    splitIdsRepaired: 0,
    foldersRemoved: Math.max(0, allFolders.length - sourceFolders.length),
    splitGroupsRemoved: Math.max(
      0,
      allSplitGroups.length - sourceSplitGroups.length
    ),
    folderMembershipsRemoved: 0,
    splitMembershipsRemoved: 0,
    splitContainersRepaired: 0,
    totalRepairs: 0,
  };

  for (const folder of sourceFolders) {
    if (!folder || typeof folder !== "object" || !workspaceIds.has(folder.workspaceId)) {
      stats.foldersRemoved += 1;
      continue;
    }

    const repairedId = repairEntityId(
      folder,
      idFactory,
      usedEntityIds,
      reservedIds,
      "repaired-folder"
    );
    if (repairedId.repaired) stats.folderIdsRepaired += 1;

    const allTabIds = asArray(folder.tabIds);
    const sourceTabIds = allTabIds.slice(0, FOLDER_MEMBER_LIMIT);
    stats.folderMembershipsRemoved += Math.max(
      0,
      allTabIds.length - sourceTabIds.length
    );
    const tabIds = [];
    for (const tabId of sourceTabIds) {
      const tab = tabsById.get(tabId);
      if (
        tab?.workspaceId !== folder.workspaceId ||
        tab?.essential === true ||
        tab?.pinned === true ||
        claimedFolderTabs.has(tabId)
      ) {
        stats.folderMembershipsRemoved += 1;
        continue;
      }
      claimedFolderTabs.add(tabId);
      tabIds.push(tabId);
    }

    repairedFolders.push({ ...folder, id: repairedId.id, tabIds });
  }

  for (const splitGroup of sourceSplitGroups) {
    if (
      !splitGroup ||
      typeof splitGroup !== "object" ||
      !workspaceIds.has(splitGroup.workspaceId)
    ) {
      stats.splitGroupsRemoved += 1;
      continue;
    }

    const allTabIds = asArray(splitGroup.tabIds);
    const sourceTabIds = allTabIds.slice(0, FOLDER_MEMBER_LIMIT);
    stats.splitMembershipsRemoved += Math.max(
      0,
      allTabIds.length - sourceTabIds.length
    );
    const candidateTabIds = [];
    const candidateTabs = new Set();
    for (const tabId of sourceTabIds) {
      const tab = tabsById.get(tabId);
      if (
        tab?.workspaceId !== splitGroup.workspaceId ||
        tab?.essential === true ||
        tab?.pinned === true ||
        claimedSplitTabs.has(tabId) ||
        candidateTabs.has(tabId) ||
        candidateTabIds.length >= 4
      ) {
        stats.splitMembershipsRemoved += 1;
        continue;
      }
      candidateTabs.add(tabId);
      candidateTabIds.push(tabId);
    }

    if (candidateTabIds.length < 2) {
      stats.splitGroupsRemoved += 1;
      stats.splitMembershipsRemoved += candidateTabIds.length;
      continue;
    }

    const repairedId = repairEntityId(
      splitGroup,
      idFactory,
      usedEntityIds,
      reservedIds,
      "repaired-split"
    );
    if (repairedId.repaired) stats.splitIdsRepaired += 1;

    for (const tabId of candidateTabIds) claimedSplitTabs.add(tabId);
    repairedSplitGroups.push({
      ...splitGroup,
      id: repairedId.id,
      tabIds: candidateTabIds,
    });
  }

  for (const splitGroup of repairedSplitGroups) {
    const groupIds = new Set(splitGroup.tabIds);
    const anchorFolder = repairedFolders.find(folder =>
      folder.workspaceId === splitGroup.workspaceId &&
      folder.tabIds.includes(splitGroup.tabIds[0])
    );
    const anchorIndex = anchorFolder
      ? anchorFolder.tabIds.indexOf(splitGroup.tabIds[0])
      : -1;
    const insertAt = anchorFolder
      ? anchorFolder.tabIds
          .slice(0, anchorIndex)
          .filter(tabId => !groupIds.has(tabId)).length
      : -1;
    let repaired = false;

    for (const folder of repairedFolders) {
      const tabIds = folder.tabIds.filter(tabId => !groupIds.has(tabId));
      if (folder === anchorFolder) {
        tabIds.splice(insertAt, 0, ...splitGroup.tabIds);
      }
      if (!arraysEqual(tabIds, folder.tabIds)) {
        folder.tabIds = tabIds;
        repaired = true;
      }
    }
    if (repaired) stats.splitContainersRepaired += 1;
  }

  stats.totalRepairs =
    stats.folderIdsRepaired +
    stats.splitIdsRepaired +
    stats.foldersRemoved +
    stats.splitGroupsRemoved +
    stats.folderMembershipsRemoved +
    stats.splitMembershipsRemoved +
    stats.splitContainersRepaired;

  return {
    folders: repairedFolders,
    splitGroups: repairedSplitGroups,
    stats,
  };
}

/**
 * Repairs bookmark-folder membership invariants without mutating the input.
 * Bookmark folders are global (not workspace-scoped) and flat (no nesting),
 * so this is a smaller sibling of {@link repairLibraryTopology}: there are no
 * split groups, no pinned/Essential exceptions, and no anchor-splicing.
 *
 * Folder and member order is stable. A bookmark claimed by more than one
 * folder is kept only by the first surviving owner. An explicitly empty
 * folder remains a durable, persisted entity.
 *
 * @param {{bookmarks?: unknown[], bookmarkFolders?: unknown[]}} topology
 * @param {() => string} idFactory
 * @returns {{bookmarkFolders: object[], stats: object}}
 */
export function repairBookmarkTopology(
  { bookmarks, bookmarkFolders } = {},
  idFactory
) {
  const sourceBookmarks = asArray(bookmarks);
  const allBookmarkFolders = asArray(bookmarkFolders);
  const sourceBookmarkFolders = allBookmarkFolders.slice(0, BOOKMARK_FOLDER_LIMIT);
  const bookmarkIds = new Set(
    sourceBookmarks.map(bookmark => referenceId(bookmark?.id)).filter(Boolean)
  );
  const reservedIds = new Set();
  for (const folder of sourceBookmarkFolders) {
    const id = normalizedId(folder?.id);
    if (id) reservedIds.add(id);
  }
  const usedEntityIds = new Set();
  const claimedBookmarks = new Set();
  const repairedBookmarkFolders = [];
  const stats = {
    folderIdsRepaired: 0,
    foldersRemoved: Math.max(
      0,
      allBookmarkFolders.length - sourceBookmarkFolders.length
    ),
    membershipsRemoved: 0,
    parentsRepaired: 0,
    totalRepairs: 0,
  };

  for (const folder of sourceBookmarkFolders) {
    if (!folder || typeof folder !== "object") {
      stats.foldersRemoved += 1;
      continue;
    }

    const repairedId = repairEntityId(
      folder,
      idFactory,
      usedEntityIds,
      reservedIds,
      "repaired-bookmark-folder"
    );
    if (repairedId.repaired) stats.folderIdsRepaired += 1;

    const allBookmarkIds = asArray(folder.bookmarkIds);
    const sourceBookmarkIds = allBookmarkIds.slice(0, BOOKMARK_FOLDER_MEMBER_LIMIT);
    stats.membershipsRemoved += Math.max(
      0,
      allBookmarkIds.length - sourceBookmarkIds.length
    );
    const memberIds = [];
    for (const bookmarkId of sourceBookmarkIds) {
      if (!bookmarkIds.has(bookmarkId) || claimedBookmarks.has(bookmarkId)) {
        stats.membershipsRemoved += 1;
        continue;
      }
      claimedBookmarks.add(bookmarkId);
      memberIds.push(bookmarkId);
    }

    repairedBookmarkFolders.push({
      ...folder,
      id: repairedId.id,
      bookmarkIds: memberIds,
    });
  }

  // Nesting repair: a parent reference must name another surviving folder,
  // and following parents must terminate at the top level within the depth
  // cap. Anything else (self-parenting, cycles, stale ids, excess depth)
  // resets to top level rather than dropping the folder.
  const survivingIds = new Set(repairedBookmarkFolders.map(folder => folder.id));
  const parentOf = new Map();
  for (const folder of repairedBookmarkFolders) {
    const parentId = referenceId(folder.parentId);
    parentOf.set(
      folder.id,
      parentId && parentId !== folder.id && survivingIds.has(parentId)
        ? parentId
        : ""
    );
  }
  // Break cycles at a node inside the cycle so subtrees hanging off the
  // cycle stay attached to their repaired ancestor.
  for (const folder of repairedBookmarkFolders) {
    const path = new Set([folder.id]);
    let current = folder.id;
    while (parentOf.get(current)) {
      const parent = parentOf.get(current);
      if (path.has(parent)) {
        parentOf.set(parent, "");
        break;
      }
      path.add(parent);
      current = parent;
    }
  }
  // Enforce the depth cap top-down: a folder that would sit at or beyond
  // the cap becomes top-level (its own subtree keeps its relative shape).
  const depthOf = new Map();
  const resolveDepth = id => {
    if (depthOf.has(id)) return depthOf.get(id);
    const parent = parentOf.get(id);
    const depth = parent ? resolveDepth(parent) + 1 : 0;
    depthOf.set(id, depth);
    return depth;
  };
  for (const folder of repairedBookmarkFolders) {
    if (resolveDepth(folder.id) >= BOOKMARK_FOLDER_DEPTH_LIMIT) {
      parentOf.set(folder.id, "");
      depthOf.set(folder.id, 0);
    }
  }
  for (const folder of repairedBookmarkFolders) {
    const repairedParentId = parentOf.get(folder.id);
    if (repairedParentId !== referenceId(folder.parentId)) {
      stats.parentsRepaired += 1;
    }
    folder.parentId = repairedParentId;
  }

  stats.totalRepairs =
    stats.folderIdsRepaired +
    stats.foldersRemoved +
    stats.membershipsRemoved +
    stats.parentsRepaired;

  return {
    bookmarkFolders: repairedBookmarkFolders,
    stats,
  };
}
