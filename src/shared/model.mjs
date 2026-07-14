import { isSafePageUrl } from "./navigation.mjs";

export const STATE_SCHEMA_VERSION = 1;

const DEFAULT_COLORS = ["#e4a8ff", "#8dd7ff", "#a9e6bd", "#ffd28f"];
const DEFAULT_ICONS = ["sparkles", "briefcase", "book", "planet"];

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function uniqueStrings(values) {
  return [...new Set(Array.isArray(values) ? values.filter(v => typeof v === "string") : [])];
}

export function normalizeWorkspaceColor(value, fallback = "#e4a8ff") {
  const color = asString(value).trim();
  return /^#[\da-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
}

export function createDefaultState(idFactory) {
  const workspaceId = idFactory();
  const tabId = idFactory();

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
    history: [],
    downloads: [],
    settings: {
      sidebarWidth: 228,
      sidebarCollapsed: false,
      compactMode: false,
    },
  };
}

export function sanitizeState(candidate, idFactory) {
  if (!candidate || typeof candidate !== "object") {
    return createDefaultState(idFactory);
  }

  const workspaceIds = new Set();
  const workspaces = [];
  for (const [index, item] of (Array.isArray(candidate.workspaces)
    ? candidate.workspaces
    : []
  ).entries()) {
    const id = asString(item?.id) || idFactory();
    if (workspaceIds.has(id)) continue;
    workspaceIds.add(id);
    workspaces.push({
      id,
      name: asString(item?.name, `Space ${index + 1}`).slice(0, 80),
      icon: asString(item?.icon, DEFAULT_ICONS[index % DEFAULT_ICONS.length]),
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
  for (const item of Array.isArray(candidate.tabs) ? candidate.tabs : []) {
    const id = asString(item?.id) || idFactory();
    if (tabIds.has(id)) continue;
    const workspaceId = workspaceIds.has(item?.workspaceId)
      ? item.workspaceId
      : workspaces[0].id;
    const url = isSafePageUrl(item?.url) ? item.url : "chroma://newtab/";
    tabIds.add(id);
    tabs.push({
      id,
      workspaceId,
      url,
      title: asString(item?.title, "New Tab").slice(0, 500),
      favicon: asString(item?.favicon),
      essential: asBoolean(item?.essential),
      pinned: asBoolean(item?.pinned),
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
      const id = idFactory();
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

  const folders = (Array.isArray(candidate.folders) ? candidate.folders : [])
    .filter(item => item && workspaceIds.has(item.workspaceId))
    .map(item => ({
      id: asString(item.id) || idFactory(),
      workspaceId: item.workspaceId,
      name: asString(item.name, "Folder").slice(0, 80),
      tabIds: uniqueStrings(item.tabIds).filter(id => tabIds.has(id)),
      expanded: asBoolean(item.expanded, true),
    }));

  const splitGroups = (Array.isArray(candidate.splitGroups)
    ? candidate.splitGroups
    : []
  )
    .filter(item => item && workspaceIds.has(item.workspaceId))
    .map(item => ({
      id: asString(item.id) || idFactory(),
      workspaceId: item.workspaceId,
      direction: ["row", "column", "grid"].includes(item.direction)
        ? item.direction
        : "row",
      tabIds: uniqueStrings(item.tabIds)
        .filter(id => tabIds.has(id))
        .slice(0, 4),
    }))
    .filter(group => group.tabIds.length >= 2);

  const activeWorkspaceId = workspaceIds.has(candidate.activeWorkspaceId)
    ? candidate.activeWorkspaceId
    : workspaces[0].id;
  const workspaceTabs = tabs.filter(tab => tab.workspaceId === activeWorkspaceId);
  const activeTabId = workspaceTabs.some(tab => tab.id === candidate.activeTabId)
    ? candidate.activeTabId
    : workspaceTabs[0].id;

  const history = (Array.isArray(candidate.history) ? candidate.history : [])
    .filter(item => item && isSafePageUrl(item.url) && !item.url.startsWith("chroma:"))
    .slice(-1000)
    .map(item => ({
      url: item.url,
      title: asString(item.title, item.url).slice(0, 500),
      visitedAt: Number.isFinite(item.visitedAt) ? item.visitedAt : Date.now(),
    }));

  const sidebarWidth = Number(candidate.settings?.sidebarWidth);

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    activeWorkspaceId,
    activeTabId,
    workspaces,
    tabs,
    folders,
    splitGroups,
    history,
    downloads: [],
    settings: {
      sidebarWidth: Number.isFinite(sidebarWidth)
        ? Math.min(500, Math.max(220, Math.round(sidebarWidth)))
        : 228,
      sidebarCollapsed: asBoolean(candidate.settings?.sidebarCollapsed),
      compactMode: asBoolean(candidate.settings?.compactMode),
    },
  };
}

export function stateForDisk(state) {
  return {
    ...state,
    downloads: [],
    tabs: state.tabs.map(tab => ({
      ...tab,
      audible: false,
      loading: false,
      crashed: false,
      canGoBack: false,
      canGoForward: false,
    })),
  };
}
