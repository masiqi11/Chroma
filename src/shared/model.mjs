import {
  DEFAULT_APPEARANCE,
  sanitizeAppearance,
} from "./appearance.mjs";
import { isSafePageUrl } from "./navigation.mjs";
import {
  FOLDER_MEMBER_LIMIT,
  LIBRARY_CONTAINER_LIMIT,
  repairLibraryTopology,
} from "./state-invariants.mjs";
import {
  sanitizeSplitLayout,
  splitLayoutPaneIds,
} from "./split-ratios.mjs";

export const STATE_SCHEMA_VERSION = 6;

export const HISTORY_ENTRY_LIMIT = 10_000;
export const ENTITY_ID_MAX_LENGTH = 199;
export const TAB_COUNT_LIMIT = 512;
export const TAB_URL_MAX_LENGTH = 8_192;
export const TAB_DATA_FAVICON_MAX_LENGTH = 64 * 1_024;
export const HISTORY_DEFAULT_PREFERENCES = Object.freeze({
  recordingEnabled: true,
  retentionDays: 90,
  clearOnExit: false,
});

const HISTORY_RETENTION_DAYS = new Set([0, 7, 30, 90, 365]);
const HISTORY_TRANSITIONS = new Set([
  "typed",
  "link",
  "form-submit",
  "reload",
  "redirect",
  "other",
]);
const HISTORY_MAX_URL_LENGTH = 8_192;
const HISTORY_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DOWNLOAD_RECORD_LIMIT = 100;
const DOWNLOAD_TERMINAL_STATES = new Set([
  "completed",
  "cancelled",
  "interrupted",
]);

const DEFAULT_COLORS = ["#e4a8ff", "#8dd7ff", "#a9e6bd", "#ffd28f"];
const DEFAULT_ICONS = ["sparkles", "briefcase", "book", "planet"];

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeWorkspaceName(value, fallback) {
  return asString(value).trim().slice(0, 80) || fallback;
}

function normalizeFolderName(value) {
  return asString(value).trim().slice(0, 80) || "Folder";
}

function normalizeEntityId(value) {
  return typeof value === "string"
    ? value.slice(0, ENTITY_ID_MAX_LENGTH).trim()
    : "";
}

function normalizeHttpUrl(value, maximumLength) {
  if (
    typeof value !== "string" ||
    value.length > maximumLength
  ) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.href.length <= maximumLength ? url.href : null;
  } catch {
    return null;
  }
}

export function normalizeTabUrl(value) {
  if (typeof value !== "string" || value.length > TAB_URL_MAX_LENGTH) {
    return "chroma://newtab/";
  }
  const candidate = value.trim();
  try {
    const url = new URL(candidate);
    if (["http:", "https:"].includes(url.protocol)) {
      return normalizeHttpUrl(candidate, TAB_URL_MAX_LENGTH) || "chroma://newtab/";
    }
    if (url.protocol === "chroma:" && url.href.length <= TAB_URL_MAX_LENGTH) {
      return url.href;
    }
  } catch {
    // Fall through to the safe internal page.
  }
  return "chroma://newtab/";
}

export function normalizeTabFavicon(value) {
  if (
    typeof value !== "string" ||
    value.length > TAB_DATA_FAVICON_MAX_LENGTH
  ) {
    return "";
  }
  const candidate = value.trim();
  if (/^data:image\//i.test(candidate)) return candidate;
  if (candidate.length > TAB_URL_MAX_LENGTH) return "";
  return normalizeHttpUrl(candidate, TAB_URL_MAX_LENGTH) || "";
}

function normalizeBookmarkUrl(value) {
  if (!isSafePageUrl(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeDownloadUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.href.length <= HISTORY_MAX_URL_LENGTH ? url.href : "";
  } catch {
    return "";
  }
}

function normalizeAbsoluteFilePath(value) {
  const filePath = asString(value).trim().slice(0, 4_096);
  if (!filePath || filePath.includes("\0")) return "";
  return filePath.startsWith("/") || /^[a-z]:[\\/]/i.test(filePath) || /^\\\\/.test(filePath)
    ? filePath
    : "";
}

function normalizeDownloadTimestamp(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeDownloadBytes(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function sanitizeDownloads(candidate, idFactory, { now = Date.now() } = {}) {
  const records = [];
  const usedIds = new Set();
  const loadTime = Number.isFinite(now) && now >= 0 ? now : Date.now();
  for (const item of Array.isArray(candidate) ? candidate : []) {
    if (!item || typeof item !== "object" || !DOWNLOAD_TERMINAL_STATES.has(item.state)) {
      continue;
    }
    let id = normalizeEntityId(item.id);
    if (!id || usedIds.has(id)) id = nextUniqueId(idFactory, usedIds, "download");
    usedIds.add(id);
    const savePath = normalizeAbsoluteFilePath(item.savePath);
    const filename = asString(item.filename).trim().slice(0, 500) || "Download";
    const startedAt = normalizeDownloadTimestamp(item.startedAt, loadTime);
    const updatedAt = normalizeDownloadTimestamp(item.updatedAt, startedAt);
    records.push({
      id,
      url: normalizeDownloadUrl(item.url),
      filename,
      mimeType: asString(item.mimeType).trim().slice(0, 200),
      savePath,
      state: item.state,
      receivedBytes: normalizeDownloadBytes(item.receivedBytes),
      totalBytes: normalizeDownloadBytes(item.totalBytes),
      startedAt,
      updatedAt,
      completedAt: normalizeDownloadTimestamp(item.completedAt, updatedAt),
    });
    if (records.length === DOWNLOAD_RECORD_LIMIT) break;
  }
  return records;
}

function nextUniqueId(idFactory, usedIds, prefix = "history") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = normalizeEntityId(idFactory());
    if (id && !usedIds.has(id)) return id;
  }

  let suffix = usedIds.size + 1;
  while (usedIds.has(`${prefix}-${suffix}`)) suffix += 1;
  return `${prefix}-${suffix}`;
}

function nextUniqueContainerId(idFactory, usedIds, reservedIds, prefix) {
  if (typeof idFactory === "function") {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = normalizeEntityId(idFactory());
      if (id && !usedIds.has(id) && !reservedIds.has(id)) return id;
    }
  }

  let suffix = 1;
  while (
    usedIds.has(`${prefix}-${suffix}`) ||
    reservedIds.has(`${prefix}-${suffix}`)
  ) {
    suffix += 1;
  }
  return `${prefix}-${suffix}`;
}

function sameIdSet(left, right) {
  if (left.length !== right.length) return false;
  if (new Set(left).size !== left.length) return false;
  const rightIds = new Set(right);
  return rightIds.size === right.length && left.every(id => rightIds.has(id));
}

/**
 * Enforces the persisted library-container boundary in one place. The topology
 * repair owns workspace/membership filtering; this final pass also reserves
 * workspace and tab IDs, and makes a split layout authoritative only when its
 * leaves are exactly the group's surviving members.
 */
function sanitizeLibraryContainers(
  { workspaces, tabs, folders, splitGroups },
  idFactory
) {
  const repaired = repairLibraryTopology(
    { workspaces, tabs, folders, splitGroups },
    idFactory
  );
  const coreIds = new Set();
  for (const entity of [
    ...(Array.isArray(workspaces) ? workspaces : []),
    ...(Array.isArray(tabs) ? tabs : []),
  ]) {
    const id = normalizeEntityId(entity?.id);
    if (id) coreIds.add(id);
  }

  const remainingContainerIds = new Set(
    [...repaired.folders, ...repaired.splitGroups]
      .map(entity => normalizeEntityId(entity?.id))
      .filter(Boolean)
  );
  const usedIds = new Set(coreIds);
  const uniqueContainerId = (value, prefix) => {
    const candidate = normalizeEntityId(value);
    remainingContainerIds.delete(candidate);
    if (candidate && !usedIds.has(candidate)) {
      usedIds.add(candidate);
      return candidate;
    }
    const id = nextUniqueContainerId(
      idFactory,
      usedIds,
      remainingContainerIds,
      prefix
    );
    usedIds.add(id);
    return id;
  };

  const sanitizedFolders = repaired.folders.map(folder => ({
    ...folder,
    id: uniqueContainerId(folder.id, "repaired-folder"),
    tabIds: [...folder.tabIds],
  }));
  const sanitizedSplitGroups = [];
  for (const group of repaired.splitGroups) {
    const fallbackDirection = group.direction === "column" ? "column" : "row";
    let layout = sanitizeSplitLayout(group.layout, group.tabIds, {
      direction: fallbackDirection,
    });
    let layoutTabIds = splitLayoutPaneIds(layout);

    if (!sameIdSet(layoutTabIds, group.tabIds)) {
      layout = sanitizeSplitLayout(null, group.tabIds, {
        direction: fallbackDirection,
      });
      layoutTabIds = splitLayoutPaneIds(layout);
    }
    if (!sameIdSet(layoutTabIds, group.tabIds)) continue;

    sanitizedSplitGroups.push({
      ...group,
      id: uniqueContainerId(group.id, "repaired-split"),
      direction: layoutTabIds.length > 2
        ? "grid"
        : layout?.direction === "column"
          ? "column"
          : "row",
      tabIds: layoutTabIds,
      layout,
    });
  }

  return {
    folders: sanitizedFolders,
    splitGroups: sanitizedSplitGroups,
  };
}

function historyPreferences(candidate) {
  return {
    recordingEnabled: asBoolean(
      candidate?.recordingEnabled,
      HISTORY_DEFAULT_PREFERENCES.recordingEnabled
    ),
    retentionDays: HISTORY_RETENTION_DAYS.has(candidate?.retentionDays)
      ? candidate.retentionDays
      : HISTORY_DEFAULT_PREFERENCES.retentionDays,
    clearOnExit: asBoolean(
      candidate?.clearOnExit,
      HISTORY_DEFAULT_PREFERENCES.clearOnExit
    ),
  };
}

function historyTitle(value, url) {
  return asString(value).trim().slice(0, 500) || url;
}

function historyVisitedAt(value, now) {
  if (!Number.isFinite(value)) return now;
  return value > now + HISTORY_FUTURE_TOLERANCE_MS ? now : value;
}

function historyTransition(value) {
  return HISTORY_TRANSITIONS.has(value) ? value : "other";
}

function historyRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sameHistoryEntry(left, right) {
  return (
    left?.id === right.id &&
    left?.url === right.url &&
    left?.title === right.title &&
    left?.visitedAt === right.visitedAt &&
    left?.transition === right.transition
  );
}

function pruneHistoryEntries(entries, preferences, now) {
  const cutoff = preferences.retentionDays
    ? now - preferences.retentionDays * DAY_MS
    : Number.NEGATIVE_INFINITY;

  return entries
    .filter(entry => entry.visitedAt >= cutoff)
    .slice(-HISTORY_ENTRY_LIMIT);
}

export function normalizeHistoryUrl(value) {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.href.length <= HISTORY_MAX_URL_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

export function createDefaultHistory() {
  return {
    revision: 0,
    entries: [],
    preferences: { ...HISTORY_DEFAULT_PREFERENCES },
  };
}

export function sanitizeHistory(candidate, idFactory, { now = Date.now() } = {}) {
  const loadTime = Number.isFinite(now) ? now : Date.now();

  if (Array.isArray(candidate)) {
    const usedIds = new Set();
    const migrated = [];

    for (const item of candidate) {
      if (!item || typeof item !== "object") continue;
      const url = normalizeHistoryUrl(item.url);
      if (!url) continue;
      const id = nextUniqueId(idFactory, usedIds);
      usedIds.add(id);
      migrated.push({
        id,
        url,
        title: historyTitle(item.title, url),
        visitedAt: historyVisitedAt(item.visitedAt, loadTime),
        transition: "other",
      });
    }

    migrated.sort((left, right) => left.visitedAt - right.visitedAt);
    const preferences = { ...HISTORY_DEFAULT_PREFERENCES };
    const entries = pruneHistoryEntries(migrated, preferences, loadTime);
    return {
      revision: entries.length ? 1 : 0,
      entries,
      preferences,
    };
  }

  if (!candidate || typeof candidate !== "object") {
    return createDefaultHistory();
  }

  const preferences = historyPreferences(candidate.preferences);
  const sourceEntries = Array.isArray(candidate.entries) ? candidate.entries : [];
  const usedIds = new Set();
  const entries = [];
  let repaired = false;

  for (const item of sourceEntries) {
    if (!item || typeof item !== "object") {
      repaired = true;
      continue;
    }

    const url = normalizeHistoryUrl(item.url);
    if (!url) {
      repaired = true;
      continue;
    }

    let id = normalizeEntityId(item.id);
    if (!id || usedIds.has(id)) {
      id = nextUniqueId(idFactory, usedIds);
      repaired = true;
    }
    usedIds.add(id);

    const entry = {
      id,
      url,
      title: historyTitle(item.title, url),
      visitedAt: historyVisitedAt(item.visitedAt, loadTime),
      transition: historyTransition(item.transition),
    };
    if (!sameHistoryEntry(item, entry)) repaired = true;
    entries.push(entry);
  }

  const originalOrder = entries.map(entry => entry.id);
  entries.sort((left, right) => left.visitedAt - right.visitedAt);
  if (entries.some((entry, index) => entry.id !== originalOrder[index])) repaired = true;

  const prunedEntries = pruneHistoryEntries(entries, preferences, loadTime);
  if (prunedEntries.length !== entries.length) repaired = true;

  const revision = historyRevision(candidate.revision);
  return {
    revision: repaired ? Math.min(Number.MAX_SAFE_INTEGER, revision + 1) : revision,
    entries: prunedEntries,
    preferences,
  };
}

export function normalizeWorkspaceColor(value, fallback = "#e4a8ff") {
  const color = asString(value).trim();
  return /^#[\da-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
}

export function createDefaultState(idFactory) {
  const usedIds = new Set();
  const workspaceId = nextUniqueId(idFactory, usedIds, "workspace");
  usedIds.add(workspaceId);
  const tabId = nextUniqueId(idFactory, usedIds, "tab");

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    activeWorkspaceId: workspaceId,
    activeTabId: tabId,
    workspaces: [
      {
        id: workspaceId,
        name: "Personal",
        icon: DEFAULT_ICONS[0],
        color: DEFAULT_COLORS[0],
      },
    ],
    tabs: [
      {
        id: tabId,
        workspaceId,
        url: "chroma://newtab/",
        title: "New Tab",
        favicon: "",
        essential: false,
        pinned: false,
        muted: false,
        audible: false,
        loading: false,
        crashed: false,
        canGoBack: false,
        canGoForward: false,
        lastActiveAt: Date.now(),
      },
    ],
    folders: [],
    splitGroups: [],
    history: createDefaultHistory(),
    bookmarks: [],
    downloads: [],
    settings: {
      sidebarWidth: 228,
      sidebarCollapsed: false,
      compactMode: false,
      appearance: { ...DEFAULT_APPEARANCE },
    },
  };
}

export function sanitizeState(candidate, idFactory, { now = Date.now() } = {}) {
  if (!candidate || typeof candidate !== "object") {
    return createDefaultState(idFactory);
  }

  const workspaceIds = new Set();
  const workspaces = [];
  for (const [index, item] of (Array.isArray(candidate.workspaces)
    ? candidate.workspaces
    : []
  ).slice(0, TAB_COUNT_LIMIT).entries()) {
    const id = normalizeEntityId(item?.id) || nextUniqueId(
      idFactory,
      workspaceIds,
      "workspace"
    );
    if (workspaceIds.has(id)) continue;
    workspaceIds.add(id);
    workspaces.push({
      id,
      name: normalizeWorkspaceName(item?.name, `Space ${index + 1}`),
      icon: normalizeEntityId(item?.icon) || DEFAULT_ICONS[index % DEFAULT_ICONS.length],
      color: normalizeWorkspaceColor(
        item?.color,
        DEFAULT_COLORS[index % DEFAULT_COLORS.length]
      ),
    });
  }

  if (!workspaces.length) {
    return createDefaultState(idFactory);
  }

  const tabIds = new Set();
  const tabs = [];
  for (const item of (Array.isArray(candidate.tabs) ? candidate.tabs : []).slice(
    0,
    TAB_COUNT_LIMIT
  )) {
    const id = normalizeEntityId(item?.id) || nextUniqueId(idFactory, tabIds, "tab");
    if (tabIds.has(id)) continue;
    const requestedWorkspaceId = normalizeEntityId(item?.workspaceId);
    const workspaceId = workspaceIds.has(requestedWorkspaceId)
      ? requestedWorkspaceId
      : workspaces[0].id;
    const url = normalizeTabUrl(item?.url);
    const essential = asBoolean(item?.essential);
    tabIds.add(id);
    tabs.push({
      id,
      workspaceId,
      url,
      title: asString(item?.title, "New Tab").slice(0, 500),
      favicon: normalizeTabFavicon(item?.favicon),
      essential,
      pinned: essential || asBoolean(item?.pinned),
      muted: asBoolean(item?.muted),
      audible: false,
      loading: false,
      crashed: false,
      canGoBack: false,
      canGoForward: false,
      lastActiveAt: Number.isFinite(item?.lastActiveAt)
        ? item.lastActiveAt
        : Date.now(),
    });
  }

  for (const workspace of workspaces) {
    if (!tabs.some(tab => tab.workspaceId === workspace.id)) {
      if (tabs.length === TAB_COUNT_LIMIT) {
        const counts = new Map();
        for (const tab of tabs) {
          counts.set(tab.workspaceId, (counts.get(tab.workspaceId) || 0) + 1);
        }
        const removableIndex = tabs.findLastIndex(
          tab => (counts.get(tab.workspaceId) || 0) > 1
        );
        if (removableIndex >= 0) {
          const [removed] = tabs.splice(removableIndex, 1);
          tabIds.delete(removed.id);
        }
      }
      if (tabs.length === TAB_COUNT_LIMIT) continue;
      const id = nextUniqueId(idFactory, tabIds, "tab");
      tabIds.add(id);
      tabs.push({
        id,
        workspaceId: workspace.id,
        url: "chroma://newtab/",
        title: "New Tab",
        favicon: "",
        essential: false,
        pinned: false,
        muted: false,
        audible: false,
        loading: false,
        crashed: false,
        canGoBack: false,
        canGoForward: false,
        lastActiveAt: Date.now(),
      });
    }
  }

  const folderCandidates = (Array.isArray(candidate.folders)
    ? candidate.folders
    : []
  ).slice(0, LIBRARY_CONTAINER_LIMIT).map(item =>
    item && typeof item === "object"
      ? {
          id: normalizeEntityId(item.id),
          workspaceId: normalizeEntityId(item.workspaceId),
          name: normalizeFolderName(item.name),
          tabIds: Array.isArray(item.tabIds)
            ? item.tabIds
                .slice(0, FOLDER_MEMBER_LIMIT)
                .map(normalizeEntityId)
                .filter(Boolean)
            : [],
          expanded: asBoolean(item.expanded, true),
        }
      : item
  );

  const splitCandidates = (Array.isArray(candidate.splitGroups)
    ? candidate.splitGroups
    : []
  ).slice(0, LIBRARY_CONTAINER_LIMIT).map(item =>
    item && typeof item === "object"
      ? {
          id: normalizeEntityId(item.id),
          workspaceId: normalizeEntityId(item.workspaceId),
          direction: ["row", "column", "grid"].includes(item.direction)
            ? item.direction
            : "row",
          tabIds: Array.isArray(item.tabIds)
            ? item.tabIds
                .slice(0, FOLDER_MEMBER_LIMIT)
                .map(normalizeEntityId)
                .filter(Boolean)
            : [],
          layout: item.layout,
        }
      : item
  );

  const { folders, splitGroups } = sanitizeLibraryContainers(
    {
      workspaces,
      tabs,
      folders: folderCandidates,
      splitGroups: splitCandidates,
    },
    idFactory
  );

  const requestedActiveWorkspaceId = normalizeEntityId(candidate.activeWorkspaceId);
  const activeWorkspaceId = workspaceIds.has(requestedActiveWorkspaceId)
    ? requestedActiveWorkspaceId
    : workspaces[0].id;
  const workspaceTabs = tabs.filter(tab => tab.workspaceId === activeWorkspaceId);
  const requestedActiveTabId = normalizeEntityId(candidate.activeTabId);
  const activeTabId = workspaceTabs.some(tab => tab.id === requestedActiveTabId)
    ? requestedActiveTabId
    : workspaceTabs[0].id;

  const history = sanitizeHistory(candidate.history, idFactory, { now });

  const bookmarkIds = new Set();
  const bookmarkUrls = new Set();
  const bookmarks = [];
  for (const item of Array.isArray(candidate.bookmarks) ? candidate.bookmarks : []) {
    if (!item || typeof item !== "object") continue;
    const url = normalizeBookmarkUrl(item.url);
    if (!url || bookmarkUrls.has(url)) continue;
    let id = normalizeEntityId(item.id);
    if (!id || bookmarkIds.has(id)) {
      id = nextUniqueId(idFactory, bookmarkIds, "bookmark");
    }
    bookmarkIds.add(id);
    bookmarkUrls.add(url);
    bookmarks.push({
      id,
      title: asString(item.title, url).trim().slice(0, 500) || url,
      url,
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
    });
  }

  const sidebarWidth = Number(candidate.settings?.sidebarWidth);
  const downloads = sanitizeDownloads(candidate.downloads, idFactory, { now });

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    activeWorkspaceId,
    activeTabId,
    workspaces,
    tabs,
    folders,
    splitGroups,
    history,
    bookmarks,
    downloads,
    settings: {
      sidebarWidth: Number.isFinite(sidebarWidth)
        ? Math.min(500, Math.max(220, Math.round(sidebarWidth)))
        : 228,
      sidebarCollapsed: asBoolean(candidate.settings?.sidebarCollapsed),
      compactMode: asBoolean(candidate.settings?.compactMode),
      appearance: sanitizeAppearance(candidate.settings?.appearance),
    },
  };
}

export function stateForDisk(state) {
  let generatedId = 0;
  return sanitizeState(
    state,
    () => `persisted-${++generatedId}`,
    { now: Date.now() }
  );
}
