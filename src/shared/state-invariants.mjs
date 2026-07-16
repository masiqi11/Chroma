const GENERATED_ID_ATTEMPTS = 100;

export const LIBRARY_CONTAINER_LIMIT = 512;
export const FOLDER_MEMBER_LIMIT = 512;

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
 * two topology entities.
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
