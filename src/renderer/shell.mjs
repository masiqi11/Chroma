import { commands } from "../shared/channels.mjs";
import {
  DEFAULT_BROWSER_COMMANDS,
  searchCommands,
} from "../shared/command-search.mjs";
import {
  APPEARANCE_THEMES,
  sanitizeAppearance,
} from "../shared/appearance.mjs";
import { displayNavigationUrl } from "../shared/navigation.mjs";
import { shortcutDisplayForAction } from "../shared/shortcut-registry.mjs";
import {
  sanitizeSplitLayout,
  setSplitRatio,
  splitLayoutRects,
} from "../shared/split-ratios.mjs";

const api = window.chromaBrowser;
const isSidebarOverlay = new URLSearchParams(window.location.search).get("mode") === "sidebar-overlay";
document.documentElement.classList.toggle("is-sidebar-overlay-document", isSidebarOverlay);
const appElement = document.querySelector("#app");
const sidebarElement = document.querySelector("#sidebar");
const sidebarPeekTrigger = document.querySelector("#sidebar-peek-trigger");
const viewportElement = document.querySelector("#content-viewport");
const paneFrameLayer = document.querySelector("#pane-frame-layer");
const addressForm = document.querySelector("#address-form");
const addressInput = document.querySelector("#address-input");
const addressResults = document.querySelector("#address-results");
const bookmarkToggle = document.querySelector("#bookmark-toggle");
const pinnedSection = document.querySelector("#pinned-section");
const pinnedGrid = document.querySelector("#pinned-grid");
const bookmarksSection = document.querySelector("#bookmarks-section");
const bookmarksToggle = document.querySelector("#bookmarks-toggle");
const bookmarksList = document.querySelector("#bookmarks-list");
const bookmarkSearchInput = document.querySelector("#bookmark-search");
const liveFoldersSection = document.querySelector("#live-folders-section");
const liveFoldersList = document.querySelector("#live-folders-list");
const extensionActions = document.querySelector("#extension-actions");
const nowPlayingButton = document.querySelector("#now-playing-button");
const authPrompt = document.querySelector("#auth-prompt");
const authPromptForm = document.querySelector("#auth-prompt-form");
const authPromptDescription = document.querySelector("#auth-prompt-description");
const authPromptUsername = document.querySelector("#auth-prompt-username");
const authPromptPassword = document.querySelector("#auth-prompt-password");
const authPromptCancel = document.querySelector("#auth-prompt-cancel");
let authPromptRequestId = null;
const appearanceButton = document.querySelector("#appearance-button");
const popoverLayer = document.querySelector("#popover-layer");
const toastLayer = document.querySelector("#toast-layer");
const resizer = document.querySelector("#sidebar-resizer");
const textPrompt = document.querySelector("#text-prompt");
const textPromptForm = document.querySelector("#text-prompt-form");
const textPromptTitle = document.querySelector("#text-prompt-title");
const textPromptDescription = document.querySelector("#text-prompt-description");
const textPromptLabel = document.querySelector("#text-prompt-label");
const textPromptInput = document.querySelector("#text-prompt-input");
const textPromptCancel = document.querySelector("#text-prompt-cancel");
const textPromptSubmit = document.querySelector("#text-prompt-submit");
const commandPalette = document.querySelector("#command-palette");
const commandPaletteButton = document.querySelector("#command-palette-button");
const commandPaletteInput = document.querySelector("#command-palette-input");
const commandPaletteResults = document.querySelector("#command-palette-results");
const commandPaletteCount = document.querySelector("#command-palette-count");
const historyPanel = document.querySelector("#history-panel");
const historySearch = document.querySelector("#history-search");
const historyClearSearch = document.querySelector("#history-clear-search");
const historyResults = document.querySelector("#history-results");
const historySummary = document.querySelector("#history-summary");
const historyLiveStatus = document.querySelector("#history-live-status");
const historyRecordingStatus = document.querySelector("#history-recording-status");
const historyClearButton = document.querySelector("#history-clear-button");
const historySelectionBar = document.querySelector("#history-selection-bar");
const historySelectionCount = document.querySelector("#history-selection-count");
const historyDeleteSelection = document.querySelector("#history-delete-selection");
const historyClearDialog = document.querySelector("#history-clear-dialog");
const historyClearForm = document.querySelector("#history-clear-form");
const historyCustomRange = document.querySelector("#history-custom-range");
const historyClearFrom = document.querySelector("#history-clear-from");
const historyClearTo = document.querySelector("#history-clear-to");
const historyClearWarning = document.querySelector("#history-clear-warning");
const historyClearError = document.querySelector("#history-clear-error");
const historyClearSubmit = document.querySelector("#history-clear-submit");
const splitDropOverlay = document.querySelector("#split-drop-overlay");
const splitDropLabel = document.querySelector("#split-drop-label");
const tabDragChip = document.querySelector("#tab-drag-chip");
const paneCrashStatus = document.querySelector("#pane-crash-status");
const trafficLightButtons = [...document.querySelectorAll(".traffic-light")];

let state = null;
let addressDirty = false;
let selectedSuggestion = -1;
let suggestionItems = [];
let suggestionHistoryItems = [];
let suggestionQueryToken = 0;
let suggestionTimer = null;
let contextTabId = null;
let layoutFrame = 0;
let tabPointerDrag = null;
let bookmarkPointerDrag = null;
let splitDividerDrag = null;
let splitDividerPreviewFrame = 0;
let dragTargetRow = null;
let dragSplitTargetId = null;
let dragSplitEdge = "right";
let dragIntent = "none";
let dragTargetId = null;
let dragTargetFolderId = null;
let dragPlacement = "before";
let suppressTabClick = false;
let addressWindowDrag = null;
let suppressAddressClick = false;
let sidebarOverlayCloseTimer = null;
let bookmarksExpanded = true;
let bookmarkSearchQuery = "";
let historySearchTimer = null;
let historyOpener = null;
let historyAllTimeConfirmPending = false;
let commandPaletteItems = [];
let commandPaletteIndex = 0;
let commandPaletteOpener = null;
let draggedWorkspaceId = null;
const announcedCrashTabIds = new Set();

const historyCommands = Object.freeze({
  query: commands.queryHistory,
  suggest: commands.suggestHistory,
  remove: commands.removeHistory,
  clear: commands.clearHistory,
});

const historyView = {
  mode: "closed",
  items: [],
  selection: new Set(),
  query: "",
  range: "all",
  nextCursor: null,
  hasMore: false,
  revision: 0,
  queryToken: 0,
  error: "",
  announcement: "",
};

const iconPaths = Object.freeze({
  back: '<path d="m15 5-7 7 7 7"/><path d="M8 12h11"/>',
  forward: '<path d="m9 5 7 7-7 7"/><path d="M5 12h11"/>',
  reload: '<path d="M19 8a8 8 0 1 0 .4 7"/><path d="M19 4v4h-4"/>',
  stop: '<path d="M7 7h10v10H7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  split: '<rect x="3" y="5" width="8" height="14" rx="2"/><rect x="13" y="5" width="8" height="14" rx="2"/>',
  splitColumn: '<rect x="5" y="3" width="14" height="8" rx="2"/><rect x="5" y="13" width="14" height="8" rx="2"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  folder: '<path d="M3 7.5h7l2 2h9v9.5H3z"/><path d="M3 7.5V5h7l2 2"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
  chevron: '<path d="m9 7 5 5-5 5"/>',
  collapse: '<path d="M4 5h16v14H4z"/><path d="M9 5v14"/><path d="m16 9-3 3 3 3"/>',
  expand: '<path d="M4 5h16v14H4z"/><path d="M9 5v14"/><path d="m13 9 3 3-3 3"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  volume: '<path d="M4 10v4h4l5 4V6l-5 4z"/><path d="M16 9c1.5 1.7 1.5 4.3 0 6"/>',
  muted: '<path d="M4 10v4h4l5 4V6l-5 4z"/><path d="m17 10 4 4m0-4-4 4"/>',
  pin: '<path d="m9 3 6 6"/><path d="m14 4 6 6-4 2-4 4-4-4 4-4z"/><path d="m9 15-5 5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  device: '<rect x="8" y="3" width="8" height="18" rx="2"/><path d="M11 18h2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/>',
  history: '<path d="M4 8V4m0 0h4"/><path d="M5 5a9 9 0 1 1-2 9"/><path d="M12 7v5l3 2"/>',
  tools: '<path d="m14 6 4-3 3 3-3 4"/><path d="M17 8 8 17l-1 4-4-4 4-1 9-9"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  space: '<path d="M4.7 13.5a7.5 7.5 0 1 0 11.8-7.1"/><path d="M3.1 8.6c-1.8 1.5-2.4 2.9-1.7 3.8 1.2 1.6 6.8-.1 12.4-3.8s9-8 7.8-9.6c-.6-.8-2.3-.7-4.5.1"/><path d="M18.4 8.8c3.1-.3 4.6.1 4.9 1 .5 1.6-3.1 4.3-8 6.1-4.9 1.8-9.3 2-9.8.4"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
  starFilled: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z" fill="currentColor"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6"/>',
  moon: '<path d="M20 13.5A7.5 7.5 0 0 1 10.5 4 8 8 0 1 0 20 13.5z"/>',
  rss: '<path d="M5 5a14 14 0 0 1 14 14"/><path d="M5 11a8 8 0 0 1 8 8"/><circle cx="6" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  restore: '<path d="M4 8V4m0 0h4"/><path d="M5 5a9 9 0 1 1-2 9"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  developer: '<path d="m8 9-3 3 3 3m8-6 3 3-3 3M14 5l-4 14"/>',
  appearance: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v2.2M12 19.8V22M4.9 4.9l1.6 1.6m11 11 1.6 1.6M2 12h2.2M19.8 12H22M4.9 19.1l1.6-1.6m11-11 1.6-1.6"/>',
});

function icon(name, label = "") {
  const paths = iconPaths[name] || iconPaths.globe;
  return `<svg class="chroma-icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>${label ? `<span class="sr-only">${escapeHtml(label)}</span>` : ""}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

function replaceTrustedMarkup(element, markup) {
  // nosec: XSS_INNERHTML — callers use local templates and escape every state-derived value with escapeHtml.
  element.innerHTML = markup;
}

function safeFavicon(url) {
  return typeof url === "string" && /^(https?:|data:image\/)/i.test(url) ? url : "";
}

function activeTab() {
  return state?.tabs.find(tab => tab.id === state.activeTabId) || null;
}

function activeWorkspace() {
  return state?.workspaces.find(workspace => workspace.id === state.activeWorkspaceId) || null;
}

function tabsForWorkspace() {
  return state?.tabs.filter(tab => tab.workspaceId === state.activeWorkspaceId) || [];
}

function splitForTab(id) {
  return state?.splitGroups.find(group => group.tabIds.includes(id)) || null;
}

function visiblePaneIds() {
  const tab = activeTab();
  if (!tab || tab.workspaceId !== state?.activeWorkspaceId) return [];
  const group = splitForTab(tab.id);
  if (!group) return [tab.id];
  return group.tabIds.filter(id =>
    state.tabs.some(candidate =>
      candidate.id === id && candidate.workspaceId === tab.workspaceId
    )
  );
}

function faviconMarkup(tab) {
  const favicon = safeFavicon(tab.favicon);
  const fallback = (() => {
    try {
      return new URL(tab.url).hostname.charAt(0) || "Z";
    } catch {
      return "Z";
    }
  })();
  if (!favicon) {
    return `<span class="fallback-favicon">${escapeHtml(fallback)}</span>`;
  }
  return `<img class="favicon" src="${escapeHtml(favicon)}" alt="" /><span class="fallback-favicon" hidden>${escapeHtml(fallback)}</span>`;
}

function hexToRgb(value) {
  const match = /^#([\da-f]{6})$/i.exec(value || "");
  if (!match) return "228, 168, 255";
  const number = Number.parseInt(match[1], 16);
  return `${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}`;
}

function initializeStaticIcons() {
  const mapping = {
    back: "back",
    forward: "forward",
    reload: "reload",
    "open-command-palette": "search",
    "split-row": "split",
    downloads: "download",
    appearance: "appearance",
    "open-history": "history",
    "new-folder": "folder",
    "new-bookmark-folder": "folder",
    "bookmarks-menu": "more",
    "new-live-folder": "plus",
    "containers-menu": "globe",
    "extensions-menu": "grid",
    "now-playing-menu": "volume",
    "new-workspace": "plus",
  };
  for (const [action, name] of Object.entries(mapping)) {
    const button = document.querySelector(`[data-action="${action}"]`);
    if (button) replaceTrustedMarkup(button, icon(name));
  }
  replaceTrustedMarkup(
    document.querySelector('[data-icon-slot="plus"]'),
    icon("plus")
  );
  replaceTrustedMarkup(document.querySelector(".live-folders-heading-icon"), icon("rss"));
  replaceTrustedMarkup(document.querySelector(".history-heading-icon"), icon("history"));
  replaceTrustedMarkup(document.querySelector(".history-close"), icon("close"));
  replaceTrustedMarkup(document.querySelector(".history-search-icon"), icon("search"));
  replaceTrustedMarkup(historyClearSearch, icon("close"));
  replaceTrustedMarkup(document.querySelector(".command-palette-search-icon"), icon("search"));
}

function render() {
  if (!state) return;
  const tab = activeTab();
  const workspace = activeWorkspace();
  const collapsed = Boolean(state.settings.sidebarCollapsed);
  const appearance = sanitizeAppearance(state.settings?.appearance);
  const reduceTransparency = appearance.reduceTransparency === true;
  document.documentElement.dataset.theme = appearance.theme;
  document.documentElement.dataset.reduceTransparency = String(reduceTransparency);
  document.documentElement.style.colorScheme = appearance.theme === "system"
    ? "light dark"
    : appearance.theme;
  appElement.dataset.theme = appearance.theme;
  appElement.dataset.reduceTransparency = String(reduceTransparency);
  appElement.classList.toggle("reduced-transparency", reduceTransparency);
  if (collapsed && !isSidebarOverlay) {
    trafficLightButtons.forEach(button => button.classList.remove("is-hovered"));
  }
  appElement.classList.toggle("is-collapsed", collapsed);
  appElement.classList.toggle("is-sidebar-overlay", isSidebarOverlay);
  appElement.classList.toggle("is-macos", state.runtime.platform === "darwin");
  const split = splitForTab(state.activeTabId);
  appElement.classList.toggle("has-split", Boolean(split));
  appElement.dataset.splitDirection = split?.direction || "";
  appElement.classList.remove("is-loading");
  appElement.style.setProperty("--sidebar-width", `${state.settings.sidebarWidth}px`);
  appElement.style.setProperty("--chroma-accent", workspace?.color || "#e4a8ff");
  appElement.style.setProperty("--chroma-accent-rgb", hexToRgb(workspace?.color));
  sidebarElement.inert = collapsed && !isSidebarOverlay;
  sidebarElement.setAttribute(
    "aria-hidden",
    collapsed && !isSidebarOverlay ? "true" : "false"
  );

  const backButton = document.querySelector('[data-action="back"]');
  const forwardButton = document.querySelector('[data-action="forward"]');
  const reloadButton = document.querySelector('[data-action="reload"]');
  backButton.disabled = !tab?.canGoBack;
  forwardButton.disabled = !tab?.canGoForward;
  replaceTrustedMarkup(reloadButton, icon(tab?.loading ? "stop" : "reload"));
  reloadButton.title = tab?.loading ? "Stop" : "Reload";

  const bookmarks = Array.isArray(state.bookmarks) ? state.bookmarks : [];
  const bookmarkable = /^https?:\/\//i.test(tab?.url || "");
  const bookmarked = bookmarkable && bookmarks.some(bookmark => bookmark.url === tab.url);
  bookmarkToggle.disabled = !bookmarkable;
  bookmarkToggle.classList.toggle("is-bookmarked", bookmarked);
  bookmarkToggle.setAttribute("aria-pressed", bookmarked ? "true" : "false");
  bookmarkToggle.setAttribute("aria-label", bookmarked ? "Remove bookmark" : "Bookmark this page");
  bookmarkToggle.title = bookmarkable
    ? (bookmarked ? "Remove bookmark" : "Bookmark this page")
    : "Only web pages can be bookmarked";
  replaceTrustedMarkup(bookmarkToggle, icon(bookmarked ? "starFilled" : "star"));

  addressForm.classList.toggle("is-secure", Boolean(tab?.url?.startsWith("https:")));
  document.querySelector("#loading-indicator").classList.toggle("is-loading", Boolean(tab?.loading));
  if (document.activeElement !== addressInput || !addressDirty) {
    addressInput.value = displayNavigationUrl(tab?.url || "");
  }

  replaceTrustedMarkup(
    document.querySelector("#workspace-title"),
    workspace
      ? `<span class="workspace-glyph" style="--workspace-color:${escapeHtml(workspace.color)}">${icon("space")}</span><span class="workspace-title-copy">${escapeHtml(workspace.name)}</span>`
      : ""
  );

  renderEssentials();
  renderPinnedTabs();
  renderBookmarks();
  renderLiveFolders();
  renderExtensionActions();
  renderNowPlayingButton();
  renderAuthPrompt();
  renderTabs();
  renderWorkspaces();
  if (!historyPanel.hidden) renderHistoryPanel();
  if (!commandPalette.hidden) renderCommandPalette();
  if (popoverLayer.querySelector('[data-popover-kind="downloads"]')) {
    const downloadsAnchor = document.querySelector('[data-action="downloads"]');
    if (downloadsAnchor) showDownloads(downloadsAnchor);
  }
  const toggle = document.querySelector('[data-action="toggle-sidebar"]');
  replaceTrustedMarkup(toggle, icon(collapsed ? "expand" : "collapse"));
  toggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";

  document.querySelector("#empty-state").hidden = Boolean(tab);
  if (document.activeElement === addressInput) renderAddressSuggestions();
  scheduleLayout();
  if (!isSidebarOverlay) updateSidebarOverlayBounds();
}

function renderEssentials() {
  const essentials = tabsForWorkspace().filter(tab => tab.essential);
  const grid = document.querySelector("#essentials-grid");
  replaceTrustedMarkup(
    grid,
    essentials
      .map(tab => `<button class="essential-item${tab.id === state.activeTabId ? " is-active" : ""}${tab.discarded ? " is-discarded" : ""}" data-action="select-tab" data-tab-id="${escapeHtml(tab.id)}" title="${escapeHtml(tab.title)}">${faviconMarkup(tab)}</button>`)
      .join("")
  );
}

function showEssentialMenu(tabId, anchor = null, point = null) {
  const tab = state.tabs.find(item => item.id === tabId);
  if (!tab?.essential) return;
  closePopover();
  const id = escapeHtml(tab.id);
  const title = escapeHtml(tab.title || "Essential");
  const popover = document.createElement("div");
  popover.className = "popover folder-popover";
  popover.dataset.popoverKind = "essential";
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", `${tab.title || "Essential"} actions`);
  const canReset = Boolean(tab.essentialUrl);
  const canUnload = !tab.discarded && tab.id !== state.activeTabId;
  replaceTrustedMarkup(popover, `<div class="popover-title">${title}</div>
    <button class="menu-item" type="button" role="menuitem" data-action="essential-reset" data-tab-id="${id}"${canReset ? "" : " disabled"}>${icon("restore")}<span>Reset to saved page</span></button>
    <button class="menu-item" type="button" role="menuitem" data-action="essential-unload" data-tab-id="${id}"${canUnload ? "" : " disabled"}>${icon("moon")}<span>Unload</span></button>
    <div class="menu-separator"></div>
    <button class="menu-item danger" type="button" role="menuitem" data-action="essential-remove" data-tab-id="${id}">${icon("close")}<span>Remove from Essentials</span></button>`);
  const anchorRect = anchor?.getBoundingClientRect?.() || {
    left: point?.x || 8,
    right: point?.x || 8,
    top: point?.y || 8,
    bottom: point?.y || 8,
  };
  positionPopover(popover, anchorRect);
  presentPopover(popover);
  menuPopoverKeydown(popover, anchor);
}

function pinnedTabMarkup(tab) {
  const title = tab.title || "New Tab";
  const active = tab.id === state.activeTabId;
  const id = escapeHtml(tab.id);
  return `<div class="pinned-tab${active ? " is-active" : ""}" data-tab-id="${id}">
    <button class="pinned-tab-main" type="button" data-action="select-tab" data-tab-id="${id}" role="tab" aria-selected="${active}" aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}">
      ${faviconMarkup(tab)}
      <span class="pinned-tab-title">${escapeHtml(title)}</span>
    </button>
    <button class="pinned-tab-close" type="button" data-action="close-tab" data-tab-id="${id}" title="Close tab" aria-label="Close ${escapeHtml(title)}">${icon("close")}</button>
  </div>`;
}

function renderPinnedTabs() {
  const pinnedTabs = tabsForWorkspace().filter(tab => tab.pinned && !tab.essential);
  pinnedSection.hidden = pinnedTabs.length === 0;
  replaceTrustedMarkup(
    pinnedGrid,
    pinnedTabs.map(pinnedTabMarkup).join("")
  );
}

function bookmarkFavicon(bookmark) {
  const matchingTab = state.tabs.find(tab => tab.url === bookmark.url);
  const openTabFavicon = safeFavicon(matchingTab?.favicon);
  if (openTabFavicon) return openTabFavicon;
  try {
    const url = new URL(bookmark.url);
    return safeFavicon(`${url.origin}/favicon.ico`);
  } catch {
    return "";
  }
}

function bookmarkTitle(bookmark) {
  return bookmark.title || (() => {
    try { return new URL(bookmark.url).hostname; } catch { return "Bookmark"; }
  })();
}

function bookmarkItemMarkup(bookmark, { folderId = null } = {}) {
  const title = bookmarkTitle(bookmark);
  const displayBookmark = {
    url: bookmark.url,
    favicon: bookmarkFavicon(bookmark),
  };
  const id = escapeHtml(bookmark.id);
  return `<div class="bookmark-item" data-bookmark-id="${id}">
    <button class="bookmark-open" type="button" data-action="open-bookmark" data-url="${escapeHtml(bookmark.url)}" title="${escapeHtml(title)}">
      ${faviconMarkup(displayBookmark)}
      <span class="bookmark-title">${escapeHtml(title)}</span>
    </button>
    <button class="bookmark-menu-button" type="button" data-action="bookmark-menu" data-bookmark-id="${id}" data-folder-id="${folderId ? escapeHtml(folderId) : ""}" title="Bookmark actions" aria-label="${escapeHtml(title)} actions" aria-haspopup="menu">${icon("tools")}</button>
    <button class="bookmark-remove" type="button" data-action="remove-bookmark" data-bookmark-id="${id}" title="Remove bookmark" aria-label="Remove ${escapeHtml(title)}">${icon("trash")}</button>
  </div>`;
}

function bookmarkFolderMarkup(folder, members, childrenMarkup = "") {
  const name = escapeHtml(folder.name);
  const folderId = escapeHtml(folder.id);
  const body = members
    .map(member => bookmarkItemMarkup(member, { folderId: folder.id }))
    .join("") + childrenMarkup;
  return `<section class="bookmark-folder${folder.expanded ? " is-expanded" : ""}" data-bookmark-folder-id="${folderId}">
    <div class="bookmark-folder-heading">
      <button class="bookmark-folder-header" type="button" data-action="toggle-bookmark-folder" data-folder-id="${folderId}" aria-expanded="${folder.expanded ? "true" : "false"}">
        <span class="bookmark-folder-disclosure">${icon("chevron")}</span>
        <span class="bookmark-folder-glyph">${icon("folder")}</span>
        <span class="bookmark-folder-name">${name}</span>
        <span class="bookmark-folder-count">${members.length}</span>
      </button>
      <button class="bookmark-folder-menu-button" type="button" data-action="bookmark-folder-menu" data-folder-id="${folderId}" title="Folder actions" aria-label="${name} folder actions" aria-haspopup="menu">${icon("tools")}</button>
    </div>
    <div class="bookmark-folder-items">${
      body || '<p class="bookmark-folder-empty">No bookmarks in this folder</p>'
    }</div>
  </section>`;
}

function renderBookmarks() {
  const bookmarks = Array.isArray(state.bookmarks) ? state.bookmarks : [];
  const bookmarkFolders = Array.isArray(state.bookmarkFolders) ? state.bookmarkFolders : [];
  bookmarksSection.classList.toggle("is-collapsed", !bookmarksExpanded);
  bookmarksToggle.setAttribute("aria-expanded", bookmarksExpanded ? "true" : "false");
  replaceTrustedMarkup(
    bookmarksToggle,
    `<span class="bookmarks-chevron">${icon("chevron")}</span><span class="bookmarks-heading-icon">${icon("star")}</span><span class="bookmarks-heading">Bookmarks</span><span class="bookmarks-count">${bookmarks.length}</span>`
  );
  bookmarksList.hidden = !bookmarksExpanded;
  bookmarkSearchInput.hidden = !bookmarksExpanded || !bookmarks.length;
  if (!bookmarksExpanded) return;
  if (!bookmarks.length) {
    replaceTrustedMarkup(bookmarksList, '<p class="bookmarks-empty">No bookmarks yet</p>');
    return;
  }
  const searchQuery = bookmarkSearchQuery.trim().toLowerCase();
  if (searchQuery) {
    // Search flattens the tree: every match is shown as a plain row no
    // matter which folder owns it, so filing never hides a result.
    const matches = bookmarks.filter(bookmark =>
      bookmarkTitle(bookmark).toLowerCase().includes(searchQuery) ||
      bookmark.url?.toLowerCase().includes(searchQuery)
    );
    replaceTrustedMarkup(
      bookmarksList,
      matches.map(bookmark => bookmarkItemMarkup(bookmark)).join("") ||
        '<p class="bookmarks-empty">No matching bookmarks</p>'
    );
    return;
  }
  const bookmarksById = new Map(bookmarks.map(bookmark => [bookmark.id, bookmark]));
  const grouped = new Set();
  const renderFolderTree = (parentId, seen) => bookmarkFolders
    .filter(folder => (folder.parentId || "") === parentId && !seen.has(folder.id))
    .map(folder => {
      seen.add(folder.id);
      const members = folder.bookmarkIds
        .map(id => bookmarksById.get(id))
        .filter(Boolean);
      for (const member of members) grouped.add(member.id);
      return bookmarkFolderMarkup(folder, members, renderFolderTree(folder.id, seen));
    })
    .join("");
  const folderMarkup = renderFolderTree("", new Set());
  const ungroupedMarkup = bookmarks
    .filter(bookmark => !grouped.has(bookmark.id))
    .map(bookmark => bookmarkItemMarkup(bookmark))
    .join("");
  replaceTrustedMarkup(bookmarksList, folderMarkup + ungroupedMarkup);
}

function liveFolderMarkup(folder) {
  const name = escapeHtml(folder.name);
  const folderId = escapeHtml(folder.id);
  const itemsMarkup = folder.items.map(item => {
    const title = escapeHtml(item.title || item.url);
    return `<div class="live-folder-item">
      <button class="live-folder-open" type="button" data-action="open-bookmark" data-url="${escapeHtml(item.url)}" title="${title}">
        <span class="live-folder-item-glyph">${icon("globe")}</span>
        <span class="live-folder-item-title">${title}</span>
      </button>
    </div>`;
  }).join("");
  return `<section class="live-folder${folder.expanded ? " is-expanded" : ""}${folder.status === "error" ? " is-errored" : ""}" data-live-folder-id="${folderId}">
    <div class="bookmark-folder-heading">
      <button class="bookmark-folder-header" type="button" data-action="toggle-live-folder" data-folder-id="${folderId}" aria-expanded="${folder.expanded ? "true" : "false"}">
        <span class="bookmark-folder-disclosure">${icon("chevron")}</span>
        <span class="bookmark-folder-glyph">${icon("rss")}</span>
        <span class="bookmark-folder-name">${name}</span>
        <span class="bookmark-folder-count">${folder.items.length}</span>
      </button>
      <button class="bookmark-folder-menu-button" type="button" data-action="live-folder-menu" data-folder-id="${folderId}" title="Live folder actions" aria-label="${name} live folder actions" aria-haspopup="menu">${icon("tools")}</button>
    </div>
    <div class="bookmark-folder-items">${
      folder.items.length
        ? itemsMarkup
        : `<p class="bookmark-folder-empty">${
            folder.status === "error"
              ? "The feed could not be loaded"
              : "No items from this feed yet"
          }</p>`
    }</div>
  </section>`;
}

function safeExtensionIcon(value) {
  return typeof value === "string" &&
    /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value)
    ? value
    : "";
}

function closeAuthPrompt() {
  authPromptRequestId = null;
  authPromptUsername.value = "";
  authPromptPassword.value = "";
  if (authPrompt.open) authPrompt.close();
  api.setChromeModalOpen(false);
}

function renderAuthPrompt() {
  const pending = state.pendingAuth;
  if (!pending) {
    if (authPrompt.open) closeAuthPrompt();
    return;
  }
  if (authPrompt.open) {
    if (authPromptRequestId !== pending.id) {
      // A newer challenge replaced the one on screen; restart the form.
      authPromptRequestId = pending.id;
      authPromptUsername.value = "";
      authPromptPassword.value = "";
    }
    return;
  }
  if (textPrompt.open || historyClearDialog.open) return;
  authPromptRequestId = pending.id;
  const target = `${pending.host || "this server"}${pending.realm ? ` — “${pending.realm}”` : ""}`;
  authPromptDescription.textContent = pending.isProxy
    ? `The proxy ${target} requires a username and password.`
    : `${target} requires a username and password. Chroma will not store them.`;
  authPromptUsername.value = "";
  authPromptPassword.value = "";
  api.setChromeModalOpen(true);
  authPrompt.showModal();
  requestAnimationFrame(() => authPromptUsername.focus());
}

authPromptForm.addEventListener("submit", event => {
  event.preventDefault();
  if (!authPromptRequestId) return;
  const id = authPromptRequestId;
  const username = authPromptUsername.value.slice(0, 500);
  const password = authPromptPassword.value.slice(0, 500);
  closeAuthPrompt();
  void runCommand(commands.submitAuthCredentials, { id, username, password });
});

authPromptCancel.addEventListener("click", event => {
  event.preventDefault();
  const id = authPromptRequestId;
  closeAuthPrompt();
  if (id) void runCommand(commands.cancelAuthRequest, { id });
});

authPrompt.addEventListener("cancel", event => {
  event.preventDefault();
  const id = authPromptRequestId;
  closeAuthPrompt();
  if (id) void runCommand(commands.cancelAuthRequest, { id });
});

function renderNowPlayingButton() {
  const mediaTabIds = Array.isArray(state.mediaTabIds) ? state.mediaTabIds : [];
  const anyAudible = state.tabs.some(tab => tab.audible);
  nowPlayingButton.hidden = !mediaTabIds.length && !anyAudible;
  nowPlayingButton.classList.toggle("is-audible", anyAudible);
}

async function showNowPlayingMenu(anchor = null) {
  const openMenu = popoverLayer.querySelector('[data-popover-kind="now-playing"]');
  if (openMenu) {
    closePopover();
    anchor?.focus({ preventScroll: true });
    return;
  }
  const entries = await runCommand(commands.queryNowPlaying, {});
  closePopover();
  const rows = (Array.isArray(entries) ? entries : []).map(entry => {
    const tab = state.tabs.find(item => item.id === entry.tabId);
    if (!tab) return "";
    const id = escapeHtml(entry.tabId);
    const title = escapeHtml(entry.title || tab.title || "Media");
    const artist = escapeHtml(entry.artist || "");
    const artworkUrl = typeof entry.artworkUrl === "string" &&
      /^(https?:|data:image\/(png|jpeg|gif|webp);base64,)/i.test(entry.artworkUrl)
      ? entry.artworkUrl
      : "";
    const artwork = artworkUrl
      ? `<img class="now-playing-art" src="${escapeHtml(artworkUrl)}" alt="" />`
      : `<span class="now-playing-art now-playing-art-fallback">${icon("volume")}</span>`;
    return `<div class="container-row">
      <button class="menu-item extension-row-label" type="button" role="menuitem" data-action="select-tab" data-tab-id="${id}" title="Go to ${title}">
        ${artwork}<span>${title}</span>${artist ? `<span class="extension-version">${artist}</span>` : ""}
      </button>
      <button class="container-row-action" type="button" role="menuitem" data-action="now-playing-toggle" data-tab-id="${id}" title="${entry.playing ? "Pause" : "Play"}" aria-label="${entry.playing ? "Pause" : "Play"} ${title}">${icon(entry.playing ? "pause" : "play")}</button>
      <button class="container-row-action" type="button" role="menuitem" data-action="toggle-mute" data-tab-id="${id}" title="${tab.muted ? "Unmute" : "Mute"}" aria-label="${tab.muted ? "Unmute" : "Mute"} ${title}">${icon(tab.muted ? "muted" : "volume")}</button>
    </div>`;
  }).join("");
  const popover = document.createElement("div");
  popover.className = "popover folder-popover containers-popover";
  popover.dataset.popoverKind = "now-playing";
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", "Now playing");
  replaceTrustedMarkup(popover, `<div class="popover-title">Now Playing</div>
    ${rows || '<p class="containers-empty">Nothing is playing right now.</p>'}`);
  const anchorRect = anchor?.getBoundingClientRect?.() || {
    left: 8, right: 8, top: 8, bottom: 8,
  };
  positionPopover(popover, anchorRect);
  presentPopover(popover);
  anchor?.setAttribute("aria-expanded", "true");
  menuPopoverKeydown(popover, anchor);
}

function renderExtensionActions() {
  const extensions = Array.isArray(state.extensions) ? state.extensions : [];
  const actionable = extensions.filter(extension => extension.popupPath);
  const openId = state.extensionPopup?.open ? state.extensionPopup.extensionId : "";
  replaceTrustedMarkup(
    extensionActions,
    actionable.map(extension => {
      const id = escapeHtml(extension.id);
      const title = escapeHtml(extension.actionTitle || extension.name);
      const iconUrl = safeExtensionIcon(extension.iconDataUrl);
      const glyph = iconUrl
        ? `<img class="extension-action-icon" src="${escapeHtml(iconUrl)}" alt="" />`
        : `<span class="extension-action-fallback">${escapeHtml((extension.name || "?").charAt(0))}</span>`;
      return `<button class="extension-action-button${extension.id === openId ? " is-open" : ""}" type="button" data-action="extension-open-popup" data-extension-id="${id}" title="${title}" aria-label="${title}" aria-pressed="${extension.id === openId}">${glyph}</button>`;
    }).join("")
  );
}

function renderLiveFolders() {
  const liveFolders = Array.isArray(state.liveFolders) ? state.liveFolders : [];
  liveFoldersSection.classList.toggle("is-empty", !liveFolders.length);
  replaceTrustedMarkup(
    liveFoldersList,
    liveFolders.map(folder => liveFolderMarkup(folder)).join("")
  );
}

function historyPreferences() {
  if (state?.historyPreferences && typeof state.historyPreferences === "object") {
    return state.historyPreferences;
  }
  return { recordingEnabled: true };
}

function historyDateKey(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function historyDateLabel(timestamp) {
  const date = new Date(timestamp);
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const startDate = new Date(date);
  startDate.setHours(0, 0, 0, 0);
  const dayDelta = Math.round((startToday.getTime() - startDate.getTime()) / 86_400_000);
  if (dayDelta === 0) return "Today";
  if (dayDelta === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function historyTimeLabel(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function historyUrlLabel(value) {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

function normalizeHistoryItems(items) {
  if (!Array.isArray(items)) return [];
  return items.flatMap(item => {
    if (!item || typeof item.id !== "string" || !/^https?:\/\//i.test(item.url || "")) {
      return [];
    }
    const visitedAt = Number(item.visitedAt);
    if (!Number.isFinite(visitedAt) || Number.isNaN(new Date(visitedAt).getTime())) return [];
    return [{
      id: item.id,
      url: item.url,
      title: String(item.title || item.url),
      visitedAt,
      transition: String(item.transition || "other"),
    }];
  });
}

function historyRowMarkup(item) {
  const selected = historyView.selection.has(item.id);
  const title = item.title || item.url;
  let initial = "•";
  try {
    initial = new URL(item.url).hostname.charAt(0).toUpperCase() || "•";
  } catch {
    // The query boundary already limits history rows to HTTP(S) URLs.
  }
  return `<article class="history-row${selected ? " is-selected" : ""}" role="listitem" data-history-id="${escapeHtml(item.id)}">
    <label class="history-select" title="Select visit">
      <input type="checkbox" data-action="toggle-history-select" data-history-id="${escapeHtml(item.id)}" aria-label="Select ${escapeHtml(title)}"${selected ? " checked" : ""}${historyView.mode === "mutating" ? " disabled" : ""} />
      <span aria-hidden="true">${icon("check")}</span>
    </label>
    <span class="history-favicon" aria-hidden="true">${escapeHtml(initial)}</span>
    <button class="history-row-open" type="button" data-action="open-history-item" data-url="${escapeHtml(item.url)}"${historyView.mode === "mutating" ? " disabled" : ""}>
      <span class="history-row-title">${escapeHtml(title)}</span>
      <span class="history-row-url">${escapeHtml(historyUrlLabel(item.url))}</span>
    </button>
    <time class="history-row-time" datetime="${escapeHtml(new Date(item.visitedAt).toISOString())}">${escapeHtml(historyTimeLabel(item.visitedAt))}</time>
    <button class="history-row-remove" type="button" data-action="remove-history-item" data-history-id="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(title)} from history" title="Remove from history"${historyView.mode === "mutating" ? " disabled" : ""}>${icon("trash")}</button>
  </article>`;
}

function renderHistoryPanel() {
  if (historyPanel.hidden) return;
  historyPanel.dataset.state = historyView.mode;
  const preferences = historyPreferences();
  const recordingEnabled = preferences.recordingEnabled !== false;
  historyRecordingStatus.textContent = recordingEnabled ? "History recording is on" : "History recording is paused";
  historyRecordingStatus.classList.toggle("is-paused", !recordingEnabled);
  historySearch.value = historyView.query;
  historyClearSearch.hidden = !historyView.query;
  historyClearButton.disabled = historyView.mode === "mutating";

  const selectionCount = historyView.selection.size;
  historySelectionBar.hidden = selectionCount === 0;
  historySelectionCount.textContent = `${selectionCount} selected`;
  historyDeleteSelection.disabled = historyView.mode === "mutating";
  historyLiveStatus.textContent = historyView.announcement;

  if (historyView.mode === "loading" && !historyView.items.length) {
    historySummary.textContent = "Loading…";
    replaceTrustedMarkup(historyResults, '<div class="history-state"><span class="history-spinner" aria-hidden="true"></span><p>Loading browsing history…</p></div>');
    historyResults.setAttribute("aria-busy", "true");
    return;
  }

  historyResults.setAttribute("aria-busy", historyView.mode === "loading-more" || historyView.mode === "mutating" ? "true" : "false");
  if (historyView.error && !historyView.items.length) {
    historySummary.textContent = "History unavailable";
    replaceTrustedMarkup(historyResults, `<div class="history-state is-error"><p>${escapeHtml(historyView.error)}</p><button class="history-button secondary" type="button" data-action="retry-history">Try again</button></div>`);
    return;
  }

  if (!historyView.items.length) {
    const hasQuery = Boolean(historyView.query);
    historySummary.textContent = hasQuery ? "No matches" : "No history";
    replaceTrustedMarkup(historyResults, `<div class="history-state"><span class="history-state-icon">${icon(hasQuery ? "search" : "history")}</span><h2>${hasQuery ? "No matching visits" : "No browsing history yet"}</h2><p>${hasQuery ? "Try a different title, website, or address." : "Pages you visit will appear here."}</p>${hasQuery ? '<button class="history-button secondary" type="button" data-action="clear-history-search">Clear search</button>' : ""}</div>`);
    return;
  }

  historySummary.textContent = `${historyView.items.length}${historyView.hasMore ? "+" : ""} ${historyView.items.length === 1 ? "visit" : "visits"}`;
  const groups = [];
  for (const item of historyView.items) {
    const key = historyDateKey(item.visitedAt);
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = { key, label: historyDateLabel(item.visitedAt), items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }

  const inlineError = historyView.error
    ? `<div class="history-inline-error" role="alert"><span>${escapeHtml(historyView.error)}</span><button type="button" data-action="retry-history">Retry</button></div>`
    : "";
  const groupMarkup = groups.map((group, index) => {
    const headingId = `history-date-${index}`;
    return `<section class="history-date-group" role="group" aria-labelledby="${headingId}">
      <h2 id="${headingId}">${escapeHtml(group.label)}</h2>
      <div class="history-date-items">${group.items.map(historyRowMarkup).join("")}</div>
    </section>`;
  }).join("");
  const pagination = historyView.mode === "loading-more"
    ? '<div class="history-pagination" role="status"><span class="history-spinner" aria-hidden="true"></span>Loading more…</div>'
    : historyView.hasMore
      ? '<div class="history-pagination"><button class="history-button secondary" type="button" data-action="load-more-history">Load more</button></div>'
      : '<p class="history-end">End of history</p>';
  replaceTrustedMarkup(historyResults, `${inlineError}${groupMarkup}${pagination}`);
}

function isStaleHistoryCursor(error) {
  return error?.code === "HISTORY_CURSOR_STALE" || String(error?.message || "").includes("HISTORY_CURSOR_STALE");
}

async function queryHistory({ append = false } = {}) {
  if (historyPanel.hidden) return;
  const queryToken = ++historyView.queryToken;
  const payload = {
    query: historyView.query,
    range: historyView.range,
    limit: 50,
  };
  if (append && historyView.nextCursor) payload.cursor = historyView.nextCursor;
  historyView.mode = append ? "loading-more" : "loading";
  historyView.error = "";
  if (!append) {
    historyView.items = [];
    historyView.nextCursor = null;
    historyView.hasMore = false;
  }
  renderHistoryPanel();

  try {
    const result = await api.command(historyCommands.query, payload);
    if (historyPanel.hidden || queryToken !== historyView.queryToken) return;
    const nextItems = normalizeHistoryItems(result?.items);
    if (append) {
      const byId = new Map(historyView.items.map(item => [item.id, item]));
      nextItems.forEach(item => byId.set(item.id, item));
      historyView.items = [...byId.values()];
    } else {
      historyView.items = nextItems;
    }
    historyView.nextCursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;
    historyView.hasMore = Boolean(result?.hasMore && historyView.nextCursor);
    historyView.revision = Number.isInteger(result?.revision) ? result.revision : historyView.revision;
    historyView.mode = historyView.items.length ? "ready" : "empty";
    historyView.selection = new Set([...historyView.selection].filter(id => historyView.items.some(item => item.id === id)));
    if (!historyView.announcement) {
      historyView.announcement = historyView.items.length === 1
        ? "1 history result."
        : `${historyView.items.length} history results.`;
    }
    renderHistoryPanel();
  } catch (error) {
    if (historyPanel.hidden || queryToken !== historyView.queryToken) return;
    if (append && isStaleHistoryCursor(error)) {
      void queryHistory();
      return;
    }
    historyView.mode = historyView.items.length ? "ready" : "error";
    historyView.error = error?.message || "Browsing history could not be loaded.";
    historyView.announcement = historyView.error;
    renderHistoryPanel();
  }
}

function scheduleHistoryQuery({ immediate = false } = {}) {
  clearTimeout(historySearchTimer);
  historyView.query = historySearch.value.trim().slice(0, 200);
  historyView.selection.clear();
  historyView.announcement = "";
  renderHistoryPanel();
  if (immediate) {
    void queryHistory();
    return;
  }
  historySearchTimer = setTimeout(() => {
    historySearchTimer = null;
    void queryHistory();
  }, 150);
}

function openHistoryPanel() {
  if (!historyPanel.hidden) return;
  if (textPrompt.open) return;
  historyOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closePopover();
  clearTimeout(historySearchTimer);
  Object.assign(historyView, {
    mode: "loading",
    items: [],
    selection: new Set(),
    query: "",
    range: "all",
    nextCursor: null,
    hasMore: false,
    error: "",
    announcement: "",
  });
  historyPanel.hidden = false;
  appElement.classList.add("has-history-panel");
  api.setChromeModalOpen(true);
  renderHistoryPanel();
  void queryHistory();
  requestAnimationFrame(() => historySearch.focus());
}

function closeHistoryClearDialog() {
  historyAllTimeConfirmPending = false;
  if (historyClearDialog.open) historyClearDialog.close();
}

function closeHistoryPanel() {
  if (historyPanel.hidden) return;
  clearTimeout(historySearchTimer);
  historySearchTimer = null;
  historyView.queryToken += 1;
  closeHistoryClearDialog();
  historyPanel.hidden = true;
  historyView.mode = "closed";
  appElement.classList.remove("has-history-panel");
  api.setChromeModalOpen(false);
  closeSidebarOverlaySoon();
  const focusTarget = historyOpener;
  historyOpener = null;
  if (focusTarget?.isConnected && !focusTarget.closest("[inert]")) {
    requestAnimationFrame(() => focusTarget.focus());
  }
}

function toggleHistorySelection(id) {
  if (!id || historyView.mode === "mutating") return;
  if (historyView.selection.has(id)) historyView.selection.delete(id);
  else historyView.selection.add(id);
  historyView.announcement = `${historyView.selection.size} selected`;
  renderHistoryPanel();
}

async function removeHistoryItems(ids) {
  const uniqueIds = [...new Set(ids.filter(id => typeof id === "string" && id))].slice(0, 200);
  if (!uniqueIds.length || historyView.mode === "mutating") return;
  const previousMode = historyView.items.length ? "ready" : "empty";
  historyView.mode = "mutating";
  historyView.error = "";
  renderHistoryPanel();
  try {
    const result = await api.command(historyCommands.remove, { ids: uniqueIds });
    const removedCount = Number(result?.removedCount) || 0;
    const removedIds = new Set(uniqueIds);
    historyView.items = historyView.items.filter(item => !removedIds.has(item.id));
    uniqueIds.forEach(id => historyView.selection.delete(id));
    historyView.revision = Number.isInteger(result?.revision) ? result.revision : historyView.revision;
    historyView.announcement = removedCount === 1 ? "1 history visit deleted." : `${removedCount} history visits deleted.`;
    historyView.mode = historyView.items.length ? "ready" : "empty";
    renderHistoryPanel();
    await queryHistory();
  } catch (error) {
    historyView.mode = previousMode;
    historyView.error = error?.message || "The selected history could not be deleted.";
    historyView.announcement = historyView.error;
    renderHistoryPanel();
  }
}

function resetHistoryClearDialog() {
  const initialRange = historyClearForm.elements.namedItem("history-clear-range");
  if (initialRange instanceof RadioNodeList) initialRange.value = "last-hour";
  historyCustomRange.hidden = true;
  historyClearFrom.value = "";
  historyClearTo.value = "";
  historyClearError.hidden = true;
  historyClearError.textContent = "";
  historyClearWarning.hidden = true;
  historyClearSubmit.textContent = "Clear history";
  historyClearSubmit.classList.remove("danger");
  historyAllTimeConfirmPending = false;
}

function openHistoryClearDialog() {
  if (historyClearDialog.open || historyView.mode === "mutating") return;
  resetHistoryClearDialog();
  historyClearDialog.showModal();
  requestAnimationFrame(() => historyClearForm.querySelector('input[name="history-clear-range"]:checked')?.focus());
}

function selectedHistoryClearRange() {
  const control = historyClearForm.elements.namedItem("history-clear-range");
  return control instanceof RadioNodeList ? control.value : "last-hour";
}

function historyClearPayload() {
  const range = selectedHistoryClearRange();
  if (range !== "custom") return { range };
  const from = new Date(historyClearFrom.value).getTime();
  const to = new Date(historyClearTo.value).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new Error("Choose a valid custom interval with the start before the end.");
  }
  return { range, from, to };
}

async function clearHistory(payload) {
  if (historyView.mode === "mutating") return;
  historyView.mode = "mutating";
  historyView.error = "";
  historyClearSubmit.disabled = true;
  historyClearForm.querySelectorAll("input, button").forEach(control => { control.disabled = true; });
  renderHistoryPanel();
  try {
    const result = await api.command(historyCommands.clear, payload);
    const removedCount = Number(result?.removedCount) || 0;
    historyView.selection.clear();
    historyView.revision = Number.isInteger(result?.revision) ? result.revision : historyView.revision;
    historyView.announcement = removedCount === 1 ? "1 history visit cleared." : `${removedCount} history visits cleared.`;
    closeHistoryClearDialog();
    historyView.mode = "loading";
    await queryHistory();
  } catch (error) {
    historyView.mode = historyView.items.length ? "ready" : "empty";
    historyClearError.textContent = error?.message || "Browsing history could not be cleared.";
    historyClearError.hidden = false;
    historyView.announcement = historyClearError.textContent;
    renderHistoryPanel();
  } finally {
    historyClearForm.querySelectorAll("input, button").forEach(control => { control.disabled = false; });
    historyClearSubmit.disabled = false;
  }
}

function containerForTab(tab) {
  if (!tab?.containerId || !Array.isArray(state.containers)) return null;
  return state.containers.find(container => container.id === tab.containerId) || null;
}

function tabMarkup(tab, rowStyle = "") {
  const split = splitForTab(tab.id);
  const container = containerForTab(tab);
  const containerDot = container
    ? `<span class="tab-container-dot" style="background:${escapeHtml(container.color)}" title="Container: ${escapeHtml(container.name)}"></span>`
    : "";
  const status = tab.audible || tab.muted
    ? `<button class="tab-status" data-action="toggle-mute" data-tab-id="${escapeHtml(tab.id)}" title="${tab.muted ? "Unmute" : "Mute"}">${icon(tab.muted ? "muted" : "volume")}</button>`
    : tab.crashed
      ? `<span class="tab-status" title="Tab crashed">!</span>`
      : "";
  return `<div class="tab-row" data-tab-id="${escapeHtml(tab.id)}"${rowStyle ? ` style="${rowStyle}"` : ""}>
    <div class="tab-item${tab.id === state.activeTabId ? " is-active" : ""}${split ? " is-split" : ""}${tab.discarded ? " is-discarded" : ""}" data-action="select-tab" data-tab-id="${escapeHtml(tab.id)}" role="tab" aria-selected="${tab.id === state.activeTabId}" tabindex="0">
      ${faviconMarkup(tab)}
      <span class="tab-copy">${escapeHtml(tab.title || "New Tab")}</span>
      <span class="tab-indicators">${containerDot}${status}<button class="tab-close" data-action="close-tab" data-tab-id="${escapeHtml(tab.id)}" title="Close tab">${icon("close")}</button></span>
    </div>
  </div>`;
}

function normalizedSplitLayoutForRenderer(group) {
  if (splitDividerDrag?.groupId === group.id) {
    return splitDividerDrag.previewLayout;
  }
  return sanitizeSplitLayout(group.layout, group.tabIds, {
    direction: group.direction === "column" ? "column" : "row",
  });
}

function splitCapsuleGeometry(group, layout = normalizedSplitLayoutForRenderer(group)) {
  const geometry = splitLayoutRects(
    { x: 0, y: 0, width: 1_000, height: 1_000 },
    layout,
    { gap: 0, inset: 0 }
  );
  return {
    geometry,
    layout,
    rectsById: new Map(
      geometry.paneIds.map((id, index) => [id, geometry.frameRects[index]])
    ),
  };
}

function setSplitCapsuleRowGeometry(row, rect) {
  if (!rect) return;
  row.style.setProperty("--pane-x", `${rect.x / 10}%`);
  row.style.setProperty("--pane-y", `${rect.y / 10}%`);
  row.style.setProperty("--pane-width", `${rect.width / 10}%`);
  row.style.setProperty("--pane-height", `${rect.height / 10}%`);
}

function updateSplitCapsuleGeometry(groupId, layout) {
  const group = state.splitGroups.find(item => item.id === groupId);
  if (!group) return;
  const normalized = sanitizeSplitLayout(layout, group.tabIds, {
    direction: group.direction === "column" ? "column" : "row",
  });
  const { rectsById } = splitCapsuleGeometry(group, normalized);
  for (const capsule of document.querySelectorAll(".split-tab-group.has-ratio-layout")) {
    if (capsule.dataset.splitGroupId !== groupId) continue;
    capsule.dataset.rootDirection = normalized?.direction === "column"
      ? "column"
      : "row";
    for (const row of capsule.querySelectorAll(":scope > .tab-row")) {
      setSplitCapsuleRowGeometry(row, rectsById.get(row.dataset.tabId));
    }
  }
}

function splitGroupMarkup(group, tabs) {
  const current = tabs.some(tab => tab.id === state.activeTabId) ? " is-current" : "";
  const { layout, rectsById } = splitCapsuleGeometry(group);
  const styles = new Map(tabs.map(tab => {
    const rect = rectsById.get(tab.id);
    if (!rect) return [tab.id, ""];
    return [tab.id, [
      `--pane-x:${rect.x / 10}%`,
      `--pane-y:${rect.y / 10}%`,
      `--pane-width:${rect.width / 10}%`,
      `--pane-height:${rect.height / 10}%`,
    ].join(";")];
  }));
  const rootDirection = layout?.direction === "column" ? "column" : "row";
  return `<div class="split-tab-group has-ratio-layout${current}" data-split-group-id="${escapeHtml(group.id)}" data-count="${tabs.length}" data-direction="${escapeHtml(group.direction || "row")}" data-root-direction="${rootDirection}" role="group" aria-label="Split tabs">
    ${tabs.map(tab => tabMarkup(tab, styles.get(tab.id))).join("")}
  </div>`;
}

function renderTabSequence(tabs, renderedSplitGroups) {
  const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
  const availableIds = new Set(tabsById.keys());
  const markup = [];
  for (const tab of tabs) {
    const group = splitForTab(tab.id);
    if (!group) {
      markup.push(tabMarkup(tab));
      continue;
    }
    const groupTabs = group.tabIds
      .filter(id => availableIds.has(id))
      .map(id => tabsById.get(id))
      .filter(Boolean);
    const completeInContainer = group.tabIds.every(id => availableIds.has(id));
    if (!completeInContainer || groupTabs.length < 2) {
      markup.push(tabMarkup(tab));
      continue;
    }
    if (renderedSplitGroups.has(group.id)) continue;
    renderedSplitGroups.add(group.id);
    markup.push(splitGroupMarkup(group, groupTabs));
  }
  return markup.join("");
}

function renderTabs() {
  const list = document.querySelector("#tabs-list");
  const tabs = tabsForWorkspace().filter(tab => !tab.essential && !tab.pinned);
  const folders = state.folders.filter(folder => folder.workspaceId === state.activeWorkspaceId);
  const folderTabIds = new Set(folders.flatMap(folder => folder.tabIds));
  const ungrouped = tabs.filter(tab => !folderTabIds.has(tab.id));
  const renderedSplitGroups = new Set();
  const folderMarkup = folders
    .map(folder => {
      const childTabs = folder.tabIds.map(id => tabs.find(tab => tab.id === id)).filter(Boolean);
      const folderId = escapeHtml(folder.id);
      const folderName = escapeHtml(folder.name);
      const folderTabsId = `folder-tabs-${folderId}`;
      const countLabel = `${childTabs.length} ${childTabs.length === 1 ? "tab" : "tabs"}`;
      return `<section class="folder${folder.expanded ? " is-expanded" : ""}${childTabs.length ? "" : " is-empty"}" data-folder-id="${folderId}" role="group" aria-label="${folderName} folder">
        <div class="folder-heading">
          <button class="folder-header" type="button" data-action="toggle-folder" data-folder-id="${folderId}" aria-expanded="${Boolean(folder.expanded)}" aria-controls="${folderTabsId}" aria-label="${folder.expanded ? "Collapse" : "Expand"} ${folderName} folder, ${countLabel}">
            <span class="folder-disclosure">${icon("chevron")}</span>
            <span class="folder-glyph">${icon("folder")}</span>
            <span class="folder-name">${folderName}</span>
            <span class="folder-count" aria-hidden="true">${childTabs.length}</span>
          </button>
          <button class="folder-menu-button" type="button" data-action="folder-menu" data-folder-id="${folderId}" title="Folder actions" aria-label="Open menu for ${folderName} folder" aria-haspopup="menu" aria-expanded="false">${icon("more")}</button>
        </div>
        <div id="${folderTabsId}" class="folder-tabs" data-drop-zone="folder" data-folder-id="${folderId}" role="group" aria-label="${folderName} tabs">${childTabs.length ? renderTabSequence(childTabs, renderedSplitGroups) : '<div class="folder-empty-drop" aria-hidden="true">Drop tabs here</div>'}</div>
      </section>`;
    })
    .join("");
  const ungroupedMarkup = renderTabSequence(ungrouped, renderedSplitGroups);
  replaceTrustedMarkup(
    list,
    `${folderMarkup}<div class="ungrouped-tabs" data-drop-zone="ungrouped">${ungroupedMarkup}</div>`
  );
}

function renderWorkspaces() {
  const switcher = document.querySelector("#workspace-switcher");
  const focusedWorkspaceId = document.activeElement?.closest?.(".workspace-dot")
    ?.dataset.workspaceId;
  const tabbableWorkspaceId = state.workspaces.some(
    workspace => workspace.id === focusedWorkspaceId
  )
    ? focusedWorkspaceId
    : state.activeWorkspaceId || state.workspaces[0]?.id;
  replaceTrustedMarkup(
    switcher,
    state.workspaces
      .map(workspace => `<button class="workspace-dot${workspace.id === state.activeWorkspaceId ? " is-active" : ""}" type="button" role="tab" aria-selected="${workspace.id === state.activeWorkspaceId}" aria-label="${escapeHtml(workspace.name)} space" tabindex="${workspace.id === tabbableWorkspaceId ? "0" : "-1"}" draggable="true" data-action="select-workspace" data-workspace-id="${escapeHtml(workspace.id)}" title="${escapeHtml(workspace.name)}"><span class="workspace-dot-mark" style="--workspace-color:${escapeHtml(workspace.color)}"></span></button>`)
      .join("")
  );
  const focusedReplacement = focusedWorkspaceId
    ? [...switcher.querySelectorAll(".workspace-dot")].find(
        item => item.dataset.workspaceId === focusedWorkspaceId
      )
    : null;
  focusedReplacement?.focus({ preventScroll: true });
}

async function runCommand(command, payload = {}) {
  try {
    return await api.command(command, payload);
  } catch (error) {
    showToast(error?.message || "Browser command failed");
    return null;
  }
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  toastLayer.append(toast);
  setTimeout(() => toast.remove(), 2800);
}

function commandPaletteContext() {
  const tab = activeTab();
  const split = tab ? splitForTab(tab.id) : null;
  return {
    hasActiveTab: Boolean(tab),
    tabCount: tabsForWorkspace().length,
    canRestoreTab: state?.runtime?.canReopenTab === true,
    canReload: Boolean(tab),
    canBookmark: /^https?:\/\//i.test(tab?.url || ""),
    canSplit: Boolean(tab && !tab.essential && (!split || split.tabIds.length < 4)),
    inSplit: Boolean(split),
    historyAvailable: true,
    downloadsAvailable: true,
    developerToolsAllowed: Boolean(tab),
  };
}

function renderCommandPalette() {
  if (!state || commandPalette.hidden) return;
  commandPaletteItems = searchCommands(commandPaletteInput.value, {
    catalog: DEFAULT_BROWSER_COMMANDS,
    context: commandPaletteContext(),
    limit: 10,
  });
  commandPaletteIndex = Math.max(
    0,
    Math.min(commandPaletteIndex, Math.max(0, commandPaletteItems.length - 1))
  );
  if (!commandPaletteItems.length) {
    replaceTrustedMarkup(
      commandPaletteResults,
      '<div class="command-palette-empty">No matching commands</div>'
    );
    commandPaletteInput.removeAttribute("aria-activedescendant");
    commandPaletteCount.textContent = "No results";
    return;
  }
  replaceTrustedMarkup(
    commandPaletteResults,
    commandPaletteItems.map((item, index) => {
      const shortcut = shortcutDisplayForAction(
        item.action,
        state.runtime?.platform
      );
      return `
      <button id="command-option-${index}" class="command-palette-item${index === commandPaletteIndex ? " is-selected" : ""}" type="button" role="option" aria-selected="${index === commandPaletteIndex}" data-command-index="${index}" tabindex="-1">
        <span class="command-palette-item-icon">${icon(item.icon || "globe")}</span>
        <span class="command-palette-item-copy">
          <strong>${escapeHtml(item.title)}</strong>
          <small>${escapeHtml(item.category)}${item.description ? ` · ${escapeHtml(item.description)}` : ""}</small>
        </span>
        ${shortcut ? `<kbd>${escapeHtml(shortcut)}</kbd>` : ""}
      </button>`;
    }).join("")
  );
  commandPaletteInput.setAttribute(
    "aria-activedescendant",
    `command-option-${commandPaletteIndex}`
  );
  commandPaletteCount.textContent = `${commandPaletteItems.length} command${commandPaletteItems.length === 1 ? "" : "s"}`;
  commandPaletteResults
    .querySelector(`[data-command-index="${commandPaletteIndex}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

function openCommandPalette(query = "") {
  if (!state || textPrompt.open || historyClearDialog.open) return false;
  if (!historyPanel.hidden) closeHistoryPanel();
  closePopover();
  commandPaletteOpener = document.activeElement;
  commandPaletteInput.value = String(query || "").slice(0, 120);
  commandPaletteIndex = 0;
  commandPalette.hidden = false;
  commandPaletteButton?.setAttribute("aria-expanded", "true");
  api.setChromeModalOpen(true);
  renderCommandPalette();
  requestAnimationFrame(() => {
    commandPaletteInput.focus();
    commandPaletteInput.select();
  });
  return true;
}

function closeCommandPalette({ restoreFocus = true } = {}) {
  if (commandPalette.hidden) return;
  commandPalette.hidden = true;
  commandPaletteButton?.setAttribute("aria-expanded", "false");
  commandPaletteInput.value = "";
  commandPaletteItems = [];
  commandPaletteResults.replaceChildren();
  commandPaletteCount.textContent = "";
  api.setChromeModalOpen(false);
  const opener = commandPaletteOpener;
  commandPaletteOpener = null;
  if (restoreFocus && opener?.isConnected) {
    requestAnimationFrame(() => opener.focus());
  }
}

function moveCommandPaletteSelection(delta) {
  if (!commandPaletteItems.length) return;
  commandPaletteIndex = (
    commandPaletteIndex + delta + commandPaletteItems.length
  ) % commandPaletteItems.length;
  renderCommandPalette();
}

async function executeCommandPaletteItem(index = commandPaletteIndex) {
  const item = commandPaletteItems[index];
  const tab = activeTab();
  if (!item) return false;
  closeCommandPalette({ restoreFocus: false });

  switch (item.action) {
    case "address:focus":
      if (state.settings.sidebarCollapsed && !isSidebarOverlay) {
        openSidebarOverlay({ focusAddress: true });
      } else {
        addressInput.focus();
        addressInput.select();
      }
      return true;
    case "tab:create":
      return runCommand(commands.createTab);
    case "tab:close":
      return tab ? runCommand(commands.closeTab, { id: tab.id }) : false;
    case "tab:reopen":
      return runCommand(commands.reopenTab);
    case "navigation:reload":
      return tab ? runCommand(commands.reload, { id: tab.id }) : false;
    case "bookmark:toggle":
      return tab ? runCommand(commands.toggleBookmark, { id: tab.id }) : false;
    case "sidebar:toggle":
      return runCommand(commands.toggleSidebar);
    case "split:active":
      return runCommand(commands.splitActive, { direction: "row" });
    case "split:set-preset":
      return runCommand(commands.setSplitPreset, { ...item.payload });
    case "media:toggle-playback": {
      if (!tab) return false;
      const playback = await runCommand(commands.toggleMediaPlayback, { id: tab.id });
      if (playback === null) showToast("No playable media on this page.");
      return playback !== null;
    }
    case "media:toggle-pip": {
      if (!tab) return false;
      const pip = await runCommand(commands.togglePictureInPicture, { id: tab.id });
      if (pip === null) showToast("No video is eligible for Picture-in-Picture.");
      return pip !== null;
    }
    case "history:open":
      openHistoryPanel();
      return true;
    case "downloads:open": {
      const anchor = document.querySelector('[data-action="downloads"]');
      if (!anchor) return false;
      showDownloads(anchor);
      return true;
    }
    case "developer:open-tools":
      return tab ? runCommand(commands.openDevTools, { id: tab.id }) : false;
    default:
      showToast("That command is not available yet.");
      return false;
  }
}

function requestText({
  title,
  label,
  value = "",
  submitLabel = "Save",
  maxLength = 80,
  allowEmpty = false,
}) {
  if (textPrompt.open) return Promise.resolve(null);
  const boundedMaxLength = Number.isInteger(maxLength)
    ? Math.max(1, Math.min(512, maxLength))
    : 80;
  textPromptTitle.textContent = title;
  textPromptDescription.textContent = "";
  textPromptDescription.hidden = true;
  textPrompt.removeAttribute("aria-describedby");
  textPromptLabel.textContent = label;
  textPromptLabel.hidden = false;
  textPromptInput.hidden = false;
  textPromptInput.required = !allowEmpty;
  textPromptInput.maxLength = boundedMaxLength;
  textPromptInput.value = String(value).slice(0, boundedMaxLength);
  textPromptSubmit.textContent = submitLabel;
  textPromptSubmit.classList.remove("danger");
  api.setChromeModalOpen(true);

  return new Promise(resolve => {
    const finish = result => {
      textPromptForm.removeEventListener("submit", onSubmit);
      textPromptCancel.removeEventListener("click", onCancel);
      textPrompt.removeEventListener("cancel", onCancel);
      textPrompt.removeEventListener("click", onBackdropClick);
      if (textPrompt.open) textPrompt.close();
      api.setChromeModalOpen(false);
      closeSidebarOverlaySoon();
      resolve(result);
    };
    const onSubmit = event => {
      event.preventDefault();
      const result = textPromptInput.value.trim().slice(0, boundedMaxLength);
      if (result || allowEmpty) finish(result);
    };
    const onCancel = event => {
      event.preventDefault();
      finish(null);
    };
    const onBackdropClick = event => {
      if (event.target === textPrompt) finish(null);
    };

    textPromptForm.addEventListener("submit", onSubmit);
    textPromptCancel.addEventListener("click", onCancel);
    textPrompt.addEventListener("cancel", onCancel);
    textPrompt.addEventListener("click", onBackdropClick);
    textPrompt.showModal();
    requestAnimationFrame(() => {
      textPromptInput.focus();
      textPromptInput.select();
    });
  });
}

function requestConfirmation({ title, message, confirmLabel = "Confirm" }) {
  if (textPrompt.open) return Promise.resolve(false);
  textPromptTitle.textContent = title;
  textPromptDescription.textContent = message;
  textPromptDescription.hidden = false;
  textPrompt.setAttribute("aria-describedby", "text-prompt-description");
  textPromptLabel.hidden = true;
  textPromptInput.hidden = true;
  textPromptInput.required = false;
  textPromptSubmit.textContent = confirmLabel;
  textPromptSubmit.classList.add("danger");
  api.setChromeModalOpen(true);

  return new Promise(resolve => {
    const finish = confirmed => {
      textPromptForm.removeEventListener("submit", onSubmit);
      textPromptCancel.removeEventListener("click", onCancel);
      textPrompt.removeEventListener("cancel", onCancel);
      textPrompt.removeEventListener("click", onBackdropClick);
      if (textPrompt.open) textPrompt.close();
      textPromptSubmit.classList.remove("danger");
      textPromptLabel.hidden = false;
      textPromptInput.hidden = false;
      textPromptInput.required = true;
      api.setChromeModalOpen(false);
      closeSidebarOverlaySoon();
      resolve(confirmed);
    };
    const onSubmit = event => {
      event.preventDefault();
      finish(true);
    };
    const onCancel = event => {
      event.preventDefault();
      finish(false);
    };
    const onBackdropClick = event => {
      if (event.target === textPrompt) finish(false);
    };

    textPromptForm.addEventListener("submit", onSubmit);
    textPromptCancel.addEventListener("click", onCancel);
    textPrompt.addEventListener("cancel", onCancel);
    textPrompt.addEventListener("click", onBackdropClick);
    textPrompt.showModal();
    requestAnimationFrame(() => textPromptSubmit.focus());
  });
}

window.addEventListener("beforeunload", () => {
  api?.setChromeModalOpen(false);
  api?.setTabDragActive(false);
  api?.endWindowDrag();
});

function closePopover({ keepModalOpen = false } = {}) {
  const wasOpen = popoverLayer.childElementCount > 0;
  popoverLayer.replaceChildren();
  appearanceButton?.setAttribute("aria-expanded", "false");
  document.querySelectorAll('.folder-menu-button[aria-expanded="true"]').forEach(button => {
    button.setAttribute("aria-expanded", "false");
  });
  contextTabId = null;
  if (wasOpen && !keepModalOpen) api.setChromeModalOpen(false);
  if (wasOpen && !keepModalOpen) closeSidebarOverlaySoon();
}

function presentPopover(popover, tabId = null) {
  popoverLayer.replaceChildren(popover);
  appearanceButton?.setAttribute(
    "aria-expanded",
    popover.dataset.popoverKind === "appearance" ? "true" : "false"
  );
  contextTabId = tabId;
  api.setChromeModalOpen(true);
}

function positionPopover(popover, anchorRect, preferred = "below") {
  document.body.append(popover);
  const width = popover.offsetWidth || 226;
  const height = popover.offsetHeight || 160;
  popover.remove();
  let left = Math.min(window.innerWidth - width - 8, Math.max(8, anchorRect.left));
  let top = preferred === "above" ? anchorRect.top - height - 5 : anchorRect.bottom + 5;
  top = Math.min(window.innerHeight - height - 8, Math.max(8, top));
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function showWorkspaceMenu(anchor) {
  const popover = document.createElement("div");
  popover.className = "popover";
  replaceTrustedMarkup(popover, `<div class="popover-title">Spaces</div>${state.workspaces.map(workspace => `<button class="menu-item" data-action="select-workspace" data-workspace-id="${escapeHtml(workspace.id)}"><span class="workspace-dot-mark" style="--workspace-color:${escapeHtml(workspace.color)}"></span><span>${escapeHtml(workspace.name)}</span></button>`).join("")}<div class="menu-separator"></div><button class="menu-item" data-action="new-workspace">${icon("plus")}<span>New space</span></button><button class="menu-item" data-action="rename-workspace">${icon("tools")}<span>Rename current space</span></button><button class="menu-item danger" data-action="delete-workspace"${state.workspaces.length <= 1 ? " disabled" : ""}>${icon("trash")}<span>Delete current space</span></button>`);
  positionPopover(popover, anchor.getBoundingClientRect());
  presentPopover(popover);
}

function showAppearance(anchor) {
  if (popoverLayer.querySelector('[data-popover-kind="appearance"]')) {
    closePopover();
    anchor.focus({ preventScroll: true });
    return;
  }
  const workspace = activeWorkspace();
  if (!workspace) {
    showToast("No active space is available.");
    return;
  }
  const appearance = sanitizeAppearance(state.settings?.appearance);
  const workspaceColor = /^#[\da-f]{6}$/i.test(workspace.color || "")
    ? workspace.color
    : "#e4a8ff";
  const popover = document.createElement("div");
  popover.id = "appearance-popover";
  popover.className = "popover appearance-popover";
  popover.dataset.popoverKind = "appearance";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-modal", "true");
  popover.setAttribute("aria-labelledby", "appearance-title");
  const themeLabel = theme => theme.charAt(0).toUpperCase() + theme.slice(1);
  replaceTrustedMarkup(popover, `
    <form id="appearance-form" class="appearance-form">
      <header class="appearance-heading">
        <span class="appearance-heading-icon" aria-hidden="true">${icon("appearance")}</span>
        <span><strong id="appearance-title">Appearance</strong><small>Personalize this browser window</small></span>
      </header>
      <fieldset class="appearance-theme-fieldset">
        <legend>Theme</legend>
        <div class="appearance-theme-options">
          ${APPEARANCE_THEMES.map(theme => `<label class="appearance-theme-option"><input type="radio" name="theme" value="${theme}"${appearance.theme === theme ? " checked" : ""} /><span>${themeLabel(theme)}</span></label>`).join("")}
        </div>
      </fieldset>
      <label class="appearance-setting" for="appearance-space-color">
        <span><strong>Space color</strong><small>Applied to ${escapeHtml(workspace.name)}</small></span>
        <span class="appearance-color-control">
          <output class="appearance-color-preview" aria-hidden="true" style="--appearance-preview-color:${escapeHtml(workspaceColor)}"></output>
          <input id="appearance-space-color" name="workspaceColor" type="color" value="${escapeHtml(workspaceColor)}" aria-label="Color for ${escapeHtml(workspace.name)}" />
        </span>
      </label>
      <label class="appearance-setting appearance-transparency-setting" for="appearance-reduce-transparency">
        <span><strong>Reduce transparency</strong><small>Use opaque rounded surfaces</small></span>
        <input id="appearance-reduce-transparency" name="reduceTransparency" type="checkbox"${appearance.reduceTransparency ? " checked" : ""} />
      </label>
      <footer class="appearance-actions">
        <p id="appearance-status" class="appearance-status" role="status" aria-live="polite"></p>
        <button class="appearance-save" type="submit">Save</button>
      </footer>
    </form>`);

  const form = popover.querySelector("#appearance-form");
  const colorInput = popover.querySelector("#appearance-space-color");
  const colorPreview = popover.querySelector(".appearance-color-preview");
  const reduceTransparencyInput = popover.querySelector("#appearance-reduce-transparency");
  const status = popover.querySelector("#appearance-status");
  const saveButton = popover.querySelector(".appearance-save");
  colorInput.addEventListener("input", () => {
    colorPreview.style.setProperty("--appearance-preview-color", colorInput.value);
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (form.dataset.saving === "true") return;
    const theme = new FormData(form).get("theme");
    const workspaceColor = colorInput.value;
    const reduceTransparency = reduceTransparencyInput.checked === true;
    const workspaceId = workspace.id;
    if (
      !APPEARANCE_THEMES.includes(theme) ||
      !/^#[\da-f]{6}$/i.test(workspaceColor) ||
      typeof workspaceId !== "string" ||
      !workspaceId
    ) {
      status.textContent = "Choose a valid theme and space color.";
      return;
    }
    form.dataset.saving = "true";
    form.setAttribute("aria-busy", "true");
    saveButton.disabled = true;
    status.textContent = "Saving…";
    const saved = await runCommand(commands.setAppearance, {
      theme,
      reduceTransparency,
      workspaceId,
      workspaceColor,
    });
    if (saved === true) {
      closePopover();
      anchor.focus({ preventScroll: true });
      return;
    }
    form.dataset.saving = "false";
    form.removeAttribute("aria-busy");
    saveButton.disabled = false;
    status.textContent = "Appearance settings could not be saved.";
  });

  positionPopover(popover, anchor.getBoundingClientRect(), "above");
  presentPopover(popover);
  appearanceButton?.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => {
    popover.querySelector('input[name="theme"]:checked')?.focus({ preventScroll: true });
  });
}

function showDownloads(anchor) {
  const popover = document.createElement("div");
  popover.className = "popover downloads-popover";
  popover.dataset.popoverKind = "downloads";
  const downloads = state.downloads.slice(0, 8);
  const hasFinished = downloads.some(download => download.terminal === true);
  const titleActions = hasFinished
    ? '<button class="download-clear" type="button" data-action="download-clear-finished">Clear finished</button>'
    : "";
  replaceTrustedMarkup(popover, `
    <div class="download-heading">
      <div class="popover-title">Downloads</div>${titleActions}
    </div>
    <div class="download-list">${downloads.length ? downloads.map(download => {
      const totalBytes = Number(download.totalBytes) || 0;
      const receivedBytes = Number(download.receivedBytes) || 0;
      const percent = totalBytes > 0
        ? Math.min(100, Math.round(receivedBytes / totalBytes * 100))
        : 0;
      const stateLabel = download.state === "progressing"
        ? "Downloading"
        : download.state === "cancelling"
          ? "Cancelling"
          : download.state.charAt(0).toUpperCase() + download.state.slice(1);
      const sizeLabel = totalBytes > 0
        ? `${formatDownloadBytes(receivedBytes)} of ${formatDownloadBytes(totalBytes)}`
        : formatDownloadBytes(receivedBytes);
      const id = escapeHtml(download.id);
      const controls = download.terminal
        ? `${download.state === "completed" && download.savePath
            ? `<button type="button" data-action="download-open" data-download-id="${id}">Open</button>`
            : ""}
           ${download.savePath
            ? `<button type="button" data-action="download-reveal" data-download-id="${id}" aria-label="Show ${escapeHtml(download.filename)} in folder">Show</button>`
            : ""}
           <button type="button" data-action="download-remove" data-download-id="${id}" aria-label="Remove ${escapeHtml(download.filename)} from downloads">Remove</button>`
        : `${download.paused || download.state === "interrupted"
            ? `<button type="button" data-action="download-resume" data-download-id="${id}">${icon("play")}<span>Resume</span></button>`
            : `<button type="button" data-action="download-pause" data-download-id="${id}">${icon("pause")}<span>Pause</span></button>`}
           <button type="button" data-action="download-cancel" data-download-id="${id}">Cancel</button>`;
      return `<section class="download-row" data-download-state="${escapeHtml(download.state)}">
        <div class="download-copy">
          <div class="download-name" title="${escapeHtml(download.filename)}">${escapeHtml(download.filename)}</div>
          <div class="download-meta">${escapeHtml(stateLabel)}${sizeLabel ? ` · ${escapeHtml(sizeLabel)}` : ""}</div>
        </div>
        ${download.terminal ? "" : `<div class="download-progress" role="progressbar" aria-label="${escapeHtml(download.filename)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>`}
        <div class="download-actions">${controls}</div>
      </section>`;
    }).join("") : '<div class="download-empty">No downloads yet</div>'}</div>`);
  positionPopover(popover, anchor.getBoundingClientRect());
  presentPopover(popover);
}

function formatDownloadBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const amount = bytes / 1024 ** power;
  return `${amount >= 10 || power === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[power]}`;
}

function showFolderMenu(folderId, anchor = null, point = null) {
  const folder = state.folders.find(item =>
    item.id === folderId && item.workspaceId === state.activeWorkspaceId
  );
  if (!folder) return;
  const openMenu = popoverLayer.querySelector(
    `[data-popover-kind="folder"][data-folder-id="${CSS.escape(folder.id)}"]`
  );
  if (openMenu) {
    closePopover();
    anchor?.focus({ preventScroll: true });
    return;
  }

  closePopover();
  const id = escapeHtml(folder.id);
  const name = escapeHtml(folder.name);
  const popover = document.createElement("div");
  popover.className = "popover folder-popover";
  popover.dataset.popoverKind = "folder";
  popover.dataset.folderId = folder.id;
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", `${folder.name} folder actions`);
  replaceTrustedMarkup(popover, `<div class="popover-title">${name}</div>
    <button class="menu-item" type="button" role="menuitem" data-action="folder-menu-toggle" data-folder-id="${id}">${icon("chevron")}<span>${folder.expanded ? "Collapse folder" : "Expand folder"}</span></button>
    <button class="menu-item" type="button" role="menuitem" data-action="folder-rename" data-folder-id="${id}">${icon("tools")}<span>Rename folder</span></button>
    <div class="menu-separator"></div>
    <button class="menu-item danger" type="button" role="menuitem" data-action="folder-delete" data-folder-id="${id}" aria-label="Delete ${name} folder">${icon("trash")}<span>Delete folder</span></button>`);
  const anchorRect = anchor?.getBoundingClientRect?.() || {
    left: point?.x || 8,
    right: point?.x || 8,
    top: point?.y || 8,
    bottom: point?.y || 8,
  };
  positionPopover(popover, anchorRect);
  presentPopover(popover);
  anchor?.setAttribute("aria-expanded", "true");
  menuPopoverKeydown(popover, anchor);
}

function menuPopoverKeydown(popover, anchor) {
  popover.addEventListener("keydown", event => {
    const items = [...popover.querySelectorAll('[role="menuitem"]')];
    const currentIndex = items.indexOf(document.activeElement);
    let nextIndex = -1;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
    else if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePopover();
      anchor?.focus({ preventScroll: true });
      return;
    } else {
      return;
    }
    event.preventDefault();
    items[nextIndex]?.focus();
  });
  requestAnimationFrame(() => popover.querySelector('[role="menuitem"]')?.focus());
}

function showBookmarkFolderMenu(folderId, anchor = null, point = null) {
  const folder = state.bookmarkFolders?.find(item => item.id === folderId);
  if (!folder) return;
  const openMenu = popoverLayer.querySelector(
    `[data-popover-kind="bookmark-folder"][data-folder-id="${CSS.escape(folder.id)}"]`
  );
  if (openMenu) {
    closePopover();
    anchor?.focus({ preventScroll: true });
    return;
  }

  closePopover();
  const id = escapeHtml(folder.id);
  const name = escapeHtml(folder.name);
  const popover = document.createElement("div");
  popover.className = "popover folder-popover";
  popover.dataset.popoverKind = "bookmark-folder";
  popover.dataset.folderId = folder.id;
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", `${folder.name} folder actions`);
  const descendantIds = (() => {
    const collected = new Set([folder.id]);
    let added = true;
    while (added) {
      added = false;
      for (const candidate of state.bookmarkFolders) {
        if (!collected.has(candidate.id) && collected.has(candidate.parentId || "-")) {
          collected.add(candidate.id);
          added = true;
        }
      }
    }
    return collected;
  })();
  const moveTargets = state.bookmarkFolders
    .filter(candidate => !descendantIds.has(candidate.id))
    .map(candidate => `<button class="menu-item" type="button" role="menuitem" data-action="bookmark-folder-move" data-folder-id="${id}" data-parent-id="${escapeHtml(candidate.id)}">${icon("folder")}<span>Move into “${escapeHtml(candidate.name)}”</span></button>`)
    .join("");
  const moveToTop = folder.parentId
    ? `<button class="menu-item" type="button" role="menuitem" data-action="bookmark-folder-move" data-folder-id="${id}" data-parent-id="">${icon("close")}<span>Move to top level</span></button>`
    : "";
  replaceTrustedMarkup(popover, `<div class="popover-title">${name}</div>
    <button class="menu-item" type="button" role="menuitem" data-action="bookmark-folder-menu-toggle" data-folder-id="${id}">${icon("chevron")}<span>${folder.expanded ? "Collapse folder" : "Expand folder"}</span></button>
    <button class="menu-item" type="button" role="menuitem" data-action="bookmark-folder-rename" data-folder-id="${id}">${icon("tools")}<span>Rename folder</span></button>
    <button class="menu-item" type="button" role="menuitem" data-action="bookmark-folder-new-subfolder" data-folder-id="${id}">${icon("plus")}<span>New subfolder…</span></button>
    ${moveTargets || moveToTop ? '<div class="menu-separator"></div>' : ""}
    ${moveToTop}${moveTargets}
    <div class="menu-separator"></div>
    <button class="menu-item danger" type="button" role="menuitem" data-action="bookmark-folder-delete" data-folder-id="${id}" aria-label="Delete ${name} folder">${icon("trash")}<span>Delete folder</span></button>`);
  const anchorRect = anchor?.getBoundingClientRect?.() || {
    left: point?.x || 8,
    right: point?.x || 8,
    top: point?.y || 8,
    bottom: point?.y || 8,
  };
  positionPopover(popover, anchorRect);
  presentPopover(popover);
  anchor?.setAttribute("aria-expanded", "true");
  menuPopoverKeydown(popover, anchor);
}

function showBookmarksMenu(anchor = null) {
  const openMenu = popoverLayer.querySelector('[data-popover-kind="bookmarks-io"]');
  if (openMenu) {
    closePopover();
    anchor?.focus({ preventScroll: true });
    return;
  }
  closePopover();
  const popover = document.createElement("div");
  popover.className = "popover folder-popover";
  popover.dataset.popoverKind = "bookmarks-io";
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", "Bookmark import and export");
  replaceTrustedMarkup(popover, `<div class="popover-title">Bookmarks</div>
    <button class="menu-item" type="button" role="menuitem" data-action="bookmarks-import">${icon("download")}<span>Import bookmarks (HTML)…</span></button>
    <button class="menu-item" type="button" role="menuitem" data-action="bookmarks-export">${icon("star")}<span>Export bookmarks (HTML)…</span></button>`);
  const anchorRect = anchor?.getBoundingClientRect?.() || {
    left: 8,
    right: 8,
    top: 8,
    bottom: 8,
  };
  positionPopover(popover, anchorRect);
  presentPopover(popover);
  anchor?.setAttribute("aria-expanded", "true");
  menuPopoverKeydown(popover, anchor);
}

function showLiveFolderMenu(folderId, anchor = null, point = null) {
  const folder = state.liveFolders?.find(item => item.id === folderId);
  if (!folder) return;
  const openMenu = popoverLayer.querySelector(
    `[data-popover-kind="live-folder"][data-folder-id="${CSS.escape(folder.id)}"]`
  );
  if (openMenu) {
    closePopover();
    anchor?.focus({ preventScroll: true });
    return;
  }

  closePopover();
  const id = escapeHtml(folder.id);
  const name = escapeHtml(folder.name);
  const popover = document.createElement("div");
  popover.className = "popover folder-popover";
  popover.dataset.popoverKind = "live-folder";
  popover.dataset.folderId = folder.id;
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", `${folder.name} live folder actions`);
  replaceTrustedMarkup(popover, `<div class="popover-title">${name}</div>
    <button class="menu-item" type="button" role="menuitem" data-action="live-folder-refresh" data-folder-id="${id}">${icon("reload")}<span>Refresh now</span></button>
    <button class="menu-item" type="button" role="menuitem" data-action="live-folder-menu-toggle" data-folder-id="${id}">${icon("chevron")}<span>${folder.expanded ? "Collapse folder" : "Expand folder"}</span></button>
    <button class="menu-item" type="button" role="menuitem" data-action="live-folder-rename" data-folder-id="${id}">${icon("tools")}<span>Rename folder</span></button>
    <div class="menu-separator"></div>
    <button class="menu-item danger" type="button" role="menuitem" data-action="live-folder-delete" data-folder-id="${id}" aria-label="Delete ${name} live folder">${icon("trash")}<span>Delete live folder</span></button>`);
  const anchorRect = anchor?.getBoundingClientRect?.() || {
    left: point?.x || 8,
    right: point?.x || 8,
    top: point?.y || 8,
    bottom: point?.y || 8,
  };
  positionPopover(popover, anchorRect);
  presentPopover(popover);
  anchor?.setAttribute("aria-expanded", "true");
  menuPopoverKeydown(popover, anchor);
}

function showSiteInfo(anchor = null) {
  const openMenu = popoverLayer.querySelector('[data-popover-kind="site-info"]');
  if (openMenu) {
    closePopover();
    anchor?.focus({ preventScroll: true });
    return;
  }
  const tab = activeTab();
  if (!tab) return;
  closePopover();
  let host = "";
  let scheme = "";
  try {
    const url = new URL(tab.url);
    host = url.hostname;
    scheme = url.protocol;
  } catch {
    // Fall through to the internal-page presentation.
  }
  const isHttps = scheme === "https:";
  const isHttp = scheme === "http:";
  const isInternal = scheme === "chroma:";
  const container = containerForTab(tab);
  const securityLine = isHttps
    ? "Your connection to this site is encrypted (HTTPS)."
    : isHttp
      ? "Your connection to this site is not encrypted. Avoid entering sensitive information."
      : isInternal
        ? "This is a built-in Chroma page."
        : "This page has no web connection information.";
  const popover = document.createElement("div");
  popover.className = "popover folder-popover site-info-popover";
  popover.dataset.popoverKind = "site-info";
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", "Site information");
  const securityClass = isHttps ? "is-secure" : isHttp ? "is-insecure" : "is-neutral";
  replaceTrustedMarkup(popover, `<div class="popover-title">${escapeHtml(host || (isInternal ? "Chroma" : "This page"))}</div>
    <p class="site-info-security ${securityClass}">${escapeHtml(securityLine)}</p>
    ${container ? `<p class="site-info-line"><span class="container-color-dot" style="--container-color:${escapeHtml(container.color)}"></span>Open in the “${escapeHtml(container.name)}” container</p>` : ""}
    <p class="site-info-line">Permissions are asked for on demand and never remembered.</p>
    <div class="menu-separator"></div>
    <button class="menu-item" type="button" role="menuitem" data-action="site-copy-url">${icon("globe")}<span>Copy address</span></button>
    ${isHttps || isHttp ? `<button class="menu-item danger" type="button" role="menuitem" data-action="site-clear-data" data-tab-id="${escapeHtml(tab.id)}">${icon("trash")}<span>Clear data for this site…</span></button>` : ""}`);
  const anchorRect = anchor?.getBoundingClientRect?.() || {
    left: 8, right: 8, top: 8, bottom: 8,
  };
  positionPopover(popover, anchorRect);
  presentPopover(popover);
  anchor?.setAttribute("aria-expanded", "true");
  menuPopoverKeydown(popover, anchor);
}

function showContainersMenu(anchor = null) {
  const openMenu = popoverLayer.querySelector('[data-popover-kind="containers"]');
  if (openMenu) {
    closePopover();
    anchor?.focus({ preventScroll: true });
    return;
  }

  closePopover();
  const containers = Array.isArray(state.containers) ? state.containers : [];
  const popover = document.createElement("div");
  popover.className = "popover folder-popover containers-popover";
  popover.dataset.popoverKind = "containers";
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", "Containers");
  const rows = containers.map(container => {
    const id = escapeHtml(container.id);
    const name = escapeHtml(container.name);
    const proxyBadge = container.proxy
      ? `<span class="container-proxy-badge" title="Proxy: ${escapeHtml(container.proxy)}">proxy</span>`
      : "";
    const uaBadge = container.userAgent
      ? `<span class="container-proxy-badge" title="User agent: ${escapeHtml(container.userAgent)}">ua</span>`
      : "";
    return `<div class="container-row">
      <button class="menu-item container-open" type="button" role="menuitem" data-action="container-new-tab" data-container-id="${id}" title="New tab in ${name}">
        <span class="container-color-dot" style="background:${escapeHtml(container.color)}"></span><span>${name}</span>${proxyBadge}${uaBadge}
      </button>
      <button class="container-row-action" type="button" role="menuitem" data-action="container-proxy" data-container-id="${id}" title="Set proxy for ${name}" aria-label="Set proxy for ${name}">${icon("globe")}</button>
      <button class="container-row-action" type="button" role="menuitem" data-action="container-ua" data-container-id="${id}" title="Set user agent for ${name}" aria-label="Set user agent for ${name}">${icon("device")}</button>
      <button class="container-row-action" type="button" role="menuitem" data-action="container-rename" data-container-id="${id}" title="Rename ${name}" aria-label="Rename ${name}">${icon("tools")}</button>
      <button class="container-row-action" type="button" role="menuitem" data-action="container-delete" data-container-id="${id}" title="Delete ${name}" aria-label="Delete ${name}">${icon("trash")}</button>
    </div>`;
  }).join("");
  replaceTrustedMarkup(popover, `<div class="popover-title">Containers</div>
    ${rows || '<p class="containers-empty">No containers yet. Tabs in a container keep separate cookies and site data.</p>'}
    <div class="menu-separator"></div>
    <button class="menu-item" type="button" role="menuitem" data-action="container-create">${icon("plus")}<span>New container…</span></button>`);
  const anchorRect = anchor?.getBoundingClientRect?.() || {
    left: 8, right: 8, top: 8, bottom: 8,
  };
  positionPopover(popover, anchorRect);
  presentPopover(popover);
  anchor?.setAttribute("aria-expanded", "true");
  menuPopoverKeydown(popover, anchor);
}

function showExtensionsMenu(anchor = null) {
  const openMenu = popoverLayer.querySelector('[data-popover-kind="extensions"]');
  if (openMenu) {
    closePopover();
    anchor?.focus({ preventScroll: true });
    return;
  }

  closePopover();
  const extensions = Array.isArray(state.extensions) ? state.extensions : [];
  const popover = document.createElement("div");
  popover.className = "popover folder-popover containers-popover";
  popover.dataset.popoverKind = "extensions";
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", "Extensions");
  const rows = extensions.map(extension => {
    const id = escapeHtml(extension.id);
    const name = escapeHtml(extension.name);
    const version = escapeHtml(extension.version);
    const actionTitle = escapeHtml(extension.actionTitle || name);
    const label = extension.popupPath
      ? `<button class="menu-item extension-row-label" type="button" role="menuitem" data-action="extension-open-popup" data-extension-id="${id}" title="Open ${actionTitle}">
          <span>${name}</span><span class="extension-version">${version}</span>
        </button>`
      : `<div class="menu-item extension-row-label" role="menuitem" tabindex="0" title="${name} ${version}">
          <span>${name}</span><span class="extension-version">${version}</span>
        </div>`;
    return `<div class="container-row">
      ${label}
      <button class="container-row-action" type="button" role="menuitem" data-action="extension-reload" data-extension-id="${id}" title="Reload ${name}" aria-label="Reload ${name}">${icon("reload")}</button>
      <button class="container-row-action" type="button" role="menuitem" data-action="extension-remove" data-extension-id="${id}" title="Remove ${name}" aria-label="Remove ${name}">${icon("trash")}</button>
    </div>`;
  }).join("");
  replaceTrustedMarkup(popover, `<div class="popover-title">Extensions</div>
    ${rows || '<p class="containers-empty">No extensions installed. Install an unpacked (unzipped) Chrome extension folder.</p>'}
    <div class="menu-separator"></div>
    <button class="menu-item" type="button" role="menuitem" data-action="extension-install">${icon("plus")}<span>Install unpacked extension…</span></button>`);
  const anchorRect = anchor?.getBoundingClientRect?.() || {
    left: 8, right: 8, top: 8, bottom: 8,
  };
  positionPopover(popover, anchorRect);
  presentPopover(popover);
  anchor?.setAttribute("aria-expanded", "true");
  menuPopoverKeydown(popover, anchor);
}

function showBookmarkMenu(bookmarkId, currentFolderId, anchor = null, point = null) {
  const bookmark = state.bookmarks?.find(item => item.id === bookmarkId);
  if (!bookmark) return;
  const openMenu = popoverLayer.querySelector(
    `[data-popover-kind="bookmark"][data-bookmark-id="${CSS.escape(bookmark.id)}"]`
  );
  if (openMenu) {
    closePopover();
    anchor?.focus({ preventScroll: true });
    return;
  }

  closePopover();
  const id = escapeHtml(bookmark.id);
  const title = escapeHtml(bookmarkTitle(bookmark));
  const folders = Array.isArray(state.bookmarkFolders) ? state.bookmarkFolders : [];
  const popover = document.createElement("div");
  popover.className = "popover folder-popover";
  popover.dataset.popoverKind = "bookmark";
  popover.dataset.bookmarkId = bookmark.id;
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", `${title} actions`);
  const folderItems = folders
    .filter(folder => folder.id !== currentFolderId)
    .map(folder => `<button class="menu-item" type="button" role="menuitem" data-action="bookmark-move-to-folder" data-bookmark-id="${id}" data-folder-id="${escapeHtml(folder.id)}">${icon("folder")}<span>Move to “${escapeHtml(folder.name)}”</span></button>`)
    .join("");
  const removeFromFolderItem = currentFolderId
    ? `<button class="menu-item" type="button" role="menuitem" data-action="bookmark-move-to-folder" data-bookmark-id="${id}" data-folder-id="">${icon("close")}<span>Remove from folder</span></button>`
    : "";
  replaceTrustedMarkup(popover, `<div class="popover-title">${title}</div>
    <button class="menu-item" type="button" role="menuitem" data-action="bookmark-rename" data-bookmark-id="${id}">${icon("tools")}<span>Rename…</span></button>
    ${folderItems}
    <button class="menu-item" type="button" role="menuitem" data-action="bookmark-move-to-new-folder" data-bookmark-id="${id}">${icon("plus")}<span>New folder…</span></button>
    ${removeFromFolderItem ? `<div class="menu-separator"></div>${removeFromFolderItem}` : ""}`);
  const anchorRect = anchor?.getBoundingClientRect?.() || {
    left: point?.x || 8,
    right: point?.x || 8,
    top: point?.y || 8,
    bottom: point?.y || 8,
  };
  positionPopover(popover, anchorRect);
  presentPopover(popover);
  anchor?.setAttribute("aria-expanded", "true");
  menuPopoverKeydown(popover, anchor);
}

function showTabMenu(tabId, x, y) {
  const tab = state.tabs.find(item => item.id === tabId);
  if (!tab) return;
  const group = splitForTab(tabId);
  const movable = !tab.essential && !tab.pinned;
  const pinAction = tab.essential
    ? ""
    : `<button class="menu-item" data-action="context-pin">${icon("pin")}<span>${tab.pinned ? "Unpin tab" : "Pin tab"}</span></button>`;
  const folderAction = movable
    ? `<button class="menu-item" data-action="context-folder">${icon("folder")}<span>Move to new folder</span></button>`
    : "";
  const inFolder = state.folders.some(folder => folder.tabIds.includes(tab.id));
  const workspaceActions = movable && !group && !inFolder
    ? state.workspaces
        .filter(workspace => workspace.id !== tab.workspaceId)
        .map(workspace => `<button class="menu-item" data-action="context-move-workspace" data-workspace-id="${escapeHtml(workspace.id)}"><span class="workspace-dot-mark" style="--workspace-color:${escapeHtml(workspace.color)}"></span><span>Move to ${escapeHtml(workspace.name)}</span></button>`)
        .join("")
    : "";
  const splitActions = movable
    ? group
      ? `<button class="menu-item" data-action="context-unsplit">${icon("grid")}<span>Exit split view</span></button>`
      : `<button class="menu-item" data-action="context-split-row">${icon("split")}<span>Split side by side</span></button><button class="menu-item" data-action="context-split-column">${icon("splitColumn")}<span>Split top and bottom</span></button>`
    : "";
  const containers = Array.isArray(state.containers) ? state.containers : [];
  const containerActions = movable && !group
    ? [
        ...containers
          .filter(container => container.id !== tab.containerId)
          .map(container => `<button class="menu-item" data-action="context-reopen-container" data-container-id="${escapeHtml(container.id)}"><span class="container-color-dot" style="background:${escapeHtml(container.color)}"></span><span>Reopen in ${escapeHtml(container.name)}</span></button>`),
        ...(tab.containerId
          ? [`<button class="menu-item" data-action="context-reopen-container" data-container-id=""><span class="container-color-dot" style="background:var(--chroma-text-faint)"></span><span>Reopen outside containers</span></button>`]
          : []),
      ].join("")
    : "";
  const discardAction = !group && !tab.crashed && !tab.discarded && tab.id !== state.activeTabId
    ? `<button class="menu-item" data-action="context-discard">${icon("moon")}<span>Unload tab</span></button>`
    : "";
  const uaMode = state.uaOverrides?.[tab.id] || "auto";
  const uaAction = !tab.crashed && !tab.discarded && /^https?:\/\//i.test(tab.url)
    ? `<button class="menu-item" data-action="context-ua-mode" data-ua-mode="${uaMode === "mobile" ? "auto" : "mobile"}">${icon("globe")}<span>${uaMode === "mobile" ? "Request desktop site" : "Request mobile site"}</span></button>`
    : "";
  const popover = document.createElement("div");
  popover.className = "popover";
  replaceTrustedMarkup(popover, `${pinAction}<button class="menu-item" data-action="context-essential">${icon("pin")}<span>${tab.essential ? "Remove from Essentials" : "Add to Essentials"}</span></button><button class="menu-item" data-action="context-mute">${icon(tab.muted ? "volume" : "muted")}<span>${tab.muted ? "Unmute tab" : "Mute tab"}</span></button>${discardAction}${uaAction}${folderAction}${workspaceActions ? `<div class="menu-separator"></div>${workspaceActions}` : ""}${containerActions ? `<div class="menu-separator"></div>${containerActions}` : ""}<div class="menu-separator"></div>${splitActions}<button class="menu-item" data-action="context-devtools">${icon("tools")}<span>Developer tools</span></button><div class="menu-separator"></div><button class="menu-item" data-action="context-close">${icon("close")}<span>Close tab</span></button>`);
  const fakeRect = { left: x, right: x, top: y, bottom: y };
  positionPopover(popover, fakeRect);
  presentPopover(popover, tabId);
}

function bookmarkAddressSuggestions(query) {
  if (!query || query.length < 2) return [];
  const bookmarks = Array.isArray(state.bookmarks) ? state.bookmarks : [];
  const needle = query.toLowerCase();
  return bookmarks
    .filter(bookmark =>
      bookmark.title?.toLowerCase().includes(needle) ||
      bookmark.url?.toLowerCase().includes(needle)
    )
    .slice(0, 3)
    .map(bookmark => ({
      type: "bookmark",
      title: bookmarkTitle(bookmark),
      url: bookmark.url,
      value: bookmark.url,
    }));
}

function renderAddressSuggestions() {
  if (!state || document.activeElement !== addressInput) {
    addressResults.hidden = true;
    return;
  }
  const query = addressInput.value.trim();
  const bookmarkItems = bookmarkAddressSuggestions(query);
  const bookmarkUrls = new Set(bookmarkItems.map(item => item.url));
  const historyItems = suggestionHistoryItems.filter(
    item => !bookmarkUrls.has(item.url)
  );
  suggestionItems = query
    ? [
        { type: "search", title: `Search for “${query}”`, url: "Google Search", value: query },
        ...bookmarkItems,
        ...historyItems,
      ]
    : suggestionHistoryItems;
  selectedSuggestion = Math.min(selectedSuggestion, suggestionItems.length - 1);
  const iconForSuggestion = item =>
    item.type === "bookmark" ? "star" : item.type === "history" ? "history" : "search";
  replaceTrustedMarkup(addressResults, suggestionItems
    .map((item, index) => `<button class="address-result${index === selectedSuggestion ? " is-selected" : ""}" data-action="address-suggestion" data-index="${index}">${icon(iconForSuggestion(item))}<span class="address-result-copy"><div class="address-result-title">${escapeHtml(item.title)}</div><div class="address-result-url">${escapeHtml(item.url)}</div></span></button>`)
    .join(""));
  addressResults.hidden = !suggestionItems.length;
}

async function fetchAddressSuggestions() {
  if (!state || document.activeElement !== addressInput) return;
  const query = addressInput.value.trim().slice(0, 200);
  const queryToken = ++suggestionQueryToken;
  try {
    const result = await api.command(historyCommands.suggest, { query, limit: 5 });
    if (
      queryToken !== suggestionQueryToken ||
      document.activeElement !== addressInput ||
      addressInput.value.trim().slice(0, 200) !== query
    ) return;
    suggestionHistoryItems = (Array.isArray(result?.items) ? result.items : []).flatMap(item => {
      if (!item || !/^https?:\/\//i.test(item.url || "")) return [];
      return [{
        type: "history",
        title: String(item.title || item.url),
        url: item.url,
        value: item.url,
      }];
    });
    renderAddressSuggestions();
  } catch {
    if (queryToken !== suggestionQueryToken) return;
    suggestionHistoryItems = [];
    renderAddressSuggestions();
  }
}

function scheduleAddressSuggestions({ immediate = false } = {}) {
  clearTimeout(suggestionTimer);
  suggestionHistoryItems = [];
  renderAddressSuggestions();
  if (immediate) {
    void fetchAddressSuggestions();
    return;
  }
  suggestionTimer = setTimeout(() => {
    suggestionTimer = null;
    void fetchAddressSuggestions();
  }, 120);
}

function scheduleLayout() {
  if (!api || isSidebarOverlay) return;
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    const rect = viewportElement.getBoundingClientRect();
    renderPaneFrames(rect);
    api.setContentBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  });
}

function syncCrashAnnouncement() {
  const crashedTabs = state.tabs.filter(tab => tab.crashed);
  const crashedIds = new Set(crashedTabs.map(tab => tab.id));
  for (const id of announcedCrashTabIds) {
    if (!crashedIds.has(id)) announcedCrashTabIds.delete(id);
  }
  const newlyCrashed = crashedTabs.filter(tab => !announcedCrashTabIds.has(tab.id));
  if (!newlyCrashed.length) {
    if (!crashedTabs.length) paneCrashStatus.textContent = "";
    return;
  }
  newlyCrashed.forEach(tab => announcedCrashTabIds.add(tab.id));
  paneCrashStatus.textContent = newlyCrashed.length === 1
    ? `${newlyCrashed[0].title || "This tab"} stopped working.`
    : `${newlyCrashed.length} tabs stopped working.`;
}

function renderPaneFrames(viewportRect) {
  syncCrashAnnouncement();
  const focusedDivider = document.activeElement?.closest?.(".pane-divider");
  const focusedDividerKey = focusedDivider && paneFrameLayer.contains(focusedDivider)
    ? {
        groupId: focusedDivider.dataset.splitGroupId,
        path: focusedDivider.dataset.splitPath,
      }
    : null;
  const focusedCrashAction = document.activeElement?.closest?.(
    ".pane-crash-card [data-action]"
  );
  const focusedCrashActionKey = focusedCrashAction && paneFrameLayer.contains(focusedCrashAction)
    ? {
        tabId: focusedCrashAction.dataset.tabId,
        action: focusedCrashAction.dataset.action,
      }
    : null;
  const restorePaneLayerFocus = () => {
    if (focusedCrashActionKey) {
      const replacement = [...paneFrameLayer.querySelectorAll(
        ".pane-crash-card [data-action]"
      )].find(control =>
        control.dataset.tabId === focusedCrashActionKey.tabId &&
        control.dataset.action === focusedCrashActionKey.action
      );
      replacement?.focus({ preventScroll: true });
    }
  };
  const ids = visiblePaneIds();
  if (!ids.length) {
    replaceTrustedMarkup(paneFrameLayer, "");
    return;
  }
  if (ids.length === 1) {
    const tab = state.tabs.find(item => item.id === ids[0]);
    replaceTrustedMarkup(
      paneFrameLayer,
      tab?.crashed
        ? paneCrashMarkup(tab, {
            x: 0,
            y: 0,
            width: viewportRect.width,
            height: viewportRect.height,
          })
        : ""
    );
    restorePaneLayerFocus();
    return;
  }
  const group = splitForTab(state.activeTabId);
  if (!group) {
    replaceTrustedMarkup(paneFrameLayer, "");
    return;
  }
  const layout = splitDividerDrag?.groupId === group.id
    ? splitDividerDrag.previewLayout
    : sanitizeSplitLayout(group.layout, group.tabIds, {
        direction: group.direction === "column" ? "column" : "row",
      });
  const geometry = splitLayoutRects(
    { x: 0, y: 0, width: viewportRect.width, height: viewportRect.height },
    layout
  );
  const frames = geometry.frameRects.map((rect, index) => {
    const id = geometry.paneIds[index];
    const active = id === state.activeTabId ? " is-active" : "";
    const tab = state.tabs.find(item => item.id === id);
    return `<div class="pane-frame${active}" aria-hidden="true" data-tab-id="${escapeHtml(id)}" style="left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px"></div>${tab?.crashed ? paneCrashMarkup(tab, rect) : ""}`;
  });
  const dividers = geometry.dividers.map(divider => {
    const rowDivider = divider.direction === "row";
    const hitSlop = 4;
    const rect = rowDivider
      ? {
          x: divider.rect.x - hitSlop,
          y: divider.rect.y,
          width: divider.rect.width + hitSlop * 2,
          height: divider.rect.height,
        }
      : {
          x: divider.rect.x,
          y: divider.rect.y - hitSlop,
          width: divider.rect.width,
          height: divider.rect.height + hitSlop * 2,
        };
    return `<div class="pane-divider" role="separator" tabindex="0" aria-label="Resize split panes" aria-orientation="${rowDivider ? "vertical" : "horizontal"}" aria-valuemin="20" aria-valuemax="80" aria-valuenow="${Math.round(divider.ratio * 100)}" data-split-group-id="${escapeHtml(group.id)}" data-split-path="${divider.path.join("/")}" data-split-direction="${divider.direction}" data-split-ratio="${divider.ratio}" data-available-pixels="${divider.availablePixels}" style="left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px"><span></span></div>`;
  });
  replaceTrustedMarkup(
    paneFrameLayer,
    [...frames, ...dividers].join("")
  );
  if (focusedDividerKey) {
    const replacement = [...paneFrameLayer.querySelectorAll(".pane-divider")]
      .find(divider =>
        divider.dataset.splitGroupId === focusedDividerKey.groupId &&
        divider.dataset.splitPath === focusedDividerKey.path
      );
    replacement?.focus({ preventScroll: true });
  }
  restorePaneLayerFocus();
}

function paneCrashMarkup(tab, rect) {
  const id = escapeHtml(tab.id);
  const title = escapeHtml(tab.title || "This tab");
  const headingId = `pane-crash-title-${id}`;
  return `<section class="pane-crash-card" role="region" aria-labelledby="${headingId}" data-tab-id="${id}" style="left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px">
    <div class="pane-crash-content">
      <span class="pane-crash-icon" aria-hidden="true">!</span>
      <h2 id="${headingId}">This tab stopped working</h2>
      <p>${title}</p>
      <div class="pane-crash-actions">
        <button class="primary" type="button" data-action="recover-tab" data-tab-id="${id}">Reload tab</button>
        <button type="button" data-action="close-tab" data-tab-id="${id}">Close</button>
      </div>
    </div>
  </section>`;
}

function sidebarOverlayBounds() {
  const inset = 5;
  return {
    x: 0,
    y: 0,
    width: Math.max(1, state.settings.sidebarWidth + inset + 10),
    height: Math.max(1, window.innerHeight),
  };
}

function updateSidebarOverlayBounds() {
  if (!api || !state || isSidebarOverlay) return;
  api.updateSidebarOverlay({ bounds: sidebarOverlayBounds() });
}

function openSidebarOverlay({ focusAddress = false } = {}) {
  if (!api || !state?.settings.sidebarCollapsed) return;
  clearTimeout(sidebarOverlayCloseTimer);
  sidebarOverlayCloseTimer = null;
  api.updateSidebarOverlay({
    open: true,
    bounds: sidebarOverlayBounds(),
    focusAddress,
  });
}

function closeSidebarOverlaySoon() {
  if (!isSidebarOverlay || !state?.settings.sidebarCollapsed) return;
  clearTimeout(sidebarOverlayCloseTimer);
  sidebarOverlayCloseTimer = setTimeout(() => {
    sidebarOverlayCloseTimer = null;
    const chromeBusy = Boolean(
      popoverLayer.firstElementChild ||
      textPrompt.open ||
      !commandPalette.hidden ||
      !historyPanel.hidden ||
      document.activeElement === addressInput ||
      tabPointerDrag
    );
    if (!chromeBusy && !sidebarElement.matches(":hover")) {
      api.updateSidebarOverlay({ open: false });
    }
  }, 240);
}

async function handleAction(action, element) {
  const tabId = element.dataset.tabId;
  switch (action) {
    case "back":
      await runCommand(commands.back, { id: state.activeTabId });
      break;
    case "forward":
      await runCommand(commands.forward, { id: state.activeTabId });
      break;
    case "reload":
      await runCommand(activeTab()?.loading ? commands.stop : commands.reload, { id: state.activeTabId });
      break;
    case "recover-tab":
      await runCommand(commands.recoverTab, { id: tabId || state.activeTabId });
      break;
    case "window-close":
      api.windowControl("close");
      break;
    case "window-minimize":
      api.windowControl("minimize");
      break;
    case "window-maximize":
      api.windowControl("maximize");
      break;
    case "new-tab":
      await runCommand(commands.createTab);
      break;
    case "open-command-palette":
      if (isSidebarOverlay && typeof api.requestOpenCommandPalette === "function") {
        api.requestOpenCommandPalette();
        api.updateSidebarOverlay({ open: false });
      } else {
        openCommandPalette();
      }
      break;
    case "close-command-palette":
      closeCommandPalette();
      break;
    case "open-history":
      if (isSidebarOverlay && typeof api.requestOpenHistory === "function") {
        try {
          await api.requestOpenHistory();
          api.updateSidebarOverlay({ open: false });
        } catch (error) {
          showToast(error?.message || "History could not be opened.");
        }
      } else {
        openHistoryPanel();
      }
      break;
    case "close-history":
      closeHistoryPanel();
      break;
    case "clear-history-search":
      historySearch.value = "";
      scheduleHistoryQuery({ immediate: true });
      historySearch.focus();
      break;
    case "retry-history":
      void queryHistory();
      break;
    case "load-more-history":
      if (historyView.hasMore && historyView.mode === "ready") void queryHistory({ append: true });
      break;
    case "toggle-history-select":
      toggleHistorySelection(element.dataset.historyId);
      break;
    case "cancel-history-selection":
      historyView.selection.clear();
      historyView.announcement = "Selection cleared.";
      renderHistoryPanel();
      break;
    case "delete-history-selection":
      await removeHistoryItems([...historyView.selection]);
      break;
    case "remove-history-item":
      await removeHistoryItems([element.dataset.historyId]);
      break;
    case "open-history-item": {
      const url = element.dataset.url || "";
      if (/^https?:\/\//i.test(url)) {
        const result = await runCommand(commands.createTab, { url });
        if (result !== null) closeHistoryPanel();
      }
      break;
    }
    case "open-history-clear":
      openHistoryClearDialog();
      break;
    case "close-history-clear":
      closeHistoryClearDialog();
      break;
    case "toggle-bookmark": {
      const tab = activeTab();
      if (tab && /^https?:\/\//i.test(tab.url || "")) {
        await runCommand(commands.toggleBookmark, { id: tab.id });
      }
      break;
    }
    case "toggle-bookmarks":
      bookmarksExpanded = !bookmarksExpanded;
      renderBookmarks();
      break;
    case "open-bookmark": {
      const url = element.dataset.url || "";
      if (/^https?:\/\//i.test(url)) await runCommand(commands.createTab, { url });
      break;
    }
    case "remove-bookmark":
      await runCommand(commands.removeBookmark, { id: element.dataset.bookmarkId });
      break;
    case "new-bookmark-folder": {
      const name = await requestText({
        title: "New bookmark folder",
        label: "Folder name",
        value: "Folder",
        submitLabel: "Create",
        maxLength: 80,
      });
      if (name) await runCommand(commands.createBookmarkFolder, { name, bookmarkIds: [] });
      break;
    }
    case "toggle-bookmark-folder":
      await runCommand(commands.toggleBookmarkFolder, { id: element.dataset.folderId });
      break;
    case "bookmark-folder-menu":
      showBookmarkFolderMenu(element.dataset.folderId, element);
      break;
    case "bookmark-folder-menu-toggle": {
      const folderId = element.dataset.folderId;
      closePopover();
      await runCommand(commands.toggleBookmarkFolder, { id: folderId });
      break;
    }
    case "bookmark-folder-rename": {
      const folderId = element.dataset.folderId;
      const folder = state.bookmarkFolders?.find(item => item.id === folderId);
      closePopover({ keepModalOpen: Boolean(folder) });
      if (!folder) break;
      const name = await requestText({
        title: "Rename bookmark folder",
        label: "Folder name",
        value: folder.name,
        submitLabel: "Rename",
        maxLength: 80,
      });
      if (name) {
        await runCommand(commands.renameBookmarkFolder, {
          id: folder.id,
          name: name.trim().slice(0, 80),
        });
      }
      break;
    }
    case "bookmark-folder-new-subfolder": {
      const parentFolderId = element.dataset.folderId;
      const parentFolder = state.bookmarkFolders?.find(item => item.id === parentFolderId);
      closePopover({ keepModalOpen: Boolean(parentFolder) });
      if (!parentFolder) break;
      const name = await requestText({
        title: `New folder inside “${parentFolder.name}”`,
        label: "Folder name",
        value: "Folder",
        submitLabel: "Create",
        maxLength: 80,
      });
      if (name) {
        const created = await runCommand(commands.createBookmarkFolder, {
          name,
          bookmarkIds: [],
          parentId: parentFolder.id,
        });
        if (created === null) showToast("The folder could not be created (nesting limit reached).");
      }
      break;
    }
    case "bookmark-folder-move": {
      const folderId = element.dataset.folderId;
      const parentId = element.dataset.parentId || "";
      closePopover();
      const moved = await runCommand(commands.moveBookmarkFolder, {
        id: folderId,
        parentId: parentId || null,
      });
      if (!moved) showToast("The folder cannot move there.");
      break;
    }
    case "bookmark-folder-delete": {
      const folderId = element.dataset.folderId;
      const folder = state.bookmarkFolders?.find(item => item.id === folderId);
      closePopover({ keepModalOpen: Boolean(folder) });
      if (!folder) break;
      const bookmarkLabel = `${folder.bookmarkIds.length} ${folder.bookmarkIds.length === 1 ? "bookmark" : "bookmarks"}`;
      const confirmed = await requestConfirmation({
        title: "Delete folder?",
        message: `Deleting “${folder.name}” only removes the folder. Its ${bookmarkLabel} will stay saved and return to the ungrouped bookmark list.`,
        confirmLabel: "Delete folder",
      });
      if (confirmed) await runCommand(commands.deleteBookmarkFolder, { id: folder.id });
      break;
    }
    case "bookmark-menu":
      showBookmarkMenu(
        element.dataset.bookmarkId,
        element.dataset.folderId || null,
        element
      );
      break;
    case "bookmark-move-to-folder": {
      const bookmarkId = element.dataset.bookmarkId;
      const folderId = element.dataset.folderId || null;
      closePopover();
      await runCommand(commands.moveBookmark, { id: bookmarkId, folderId });
      break;
    }
    case "bookmarks-menu":
      showBookmarksMenu(element);
      break;
    case "bookmarks-import": {
      closePopover();
      const result = await runCommand(commands.importBookmarks, {});
      showToast(
        result
          ? `Imported ${result.imported} bookmark${result.imported === 1 ? "" : "s"}${result.skipped ? ` (${result.skipped} already saved)` : ""}.`
          : "No bookmarks were imported."
      );
      break;
    }
    case "bookmarks-export": {
      closePopover();
      const result = await runCommand(commands.exportBookmarks, {});
      showToast(
        result
          ? `Exported ${result.exported} bookmark${result.exported === 1 ? "" : "s"}.`
          : "Bookmarks were not exported."
      );
      break;
    }
    case "new-live-folder": {
      const url = await requestText({
        title: "New live folder",
        label: "Feed address (RSS or Atom)",
        value: "https://",
        submitLabel: "Create",
        maxLength: 2000,
      });
      if (!url || !/^https?:\/\//i.test(url.trim())) {
        if (url) showToast("Live folders need an http(s) feed address.");
        break;
      }
      const created = await runCommand(commands.createLiveFolder, { url: url.trim() });
      if (created === null) showToast("The live folder could not be created.");
      break;
    }
    case "toggle-live-folder":
      await runCommand(commands.toggleLiveFolder, { id: element.dataset.folderId });
      break;
    case "live-folder-menu":
      showLiveFolderMenu(element.dataset.folderId, element);
      break;
    case "live-folder-menu-toggle": {
      const folderId = element.dataset.folderId;
      closePopover();
      await runCommand(commands.toggleLiveFolder, { id: folderId });
      break;
    }
    case "live-folder-refresh": {
      const folderId = element.dataset.folderId;
      closePopover();
      const refreshed = await runCommand(commands.refreshLiveFolder, { id: folderId });
      if (!refreshed) showToast("The feed was refreshed recently or could not be loaded.");
      break;
    }
    case "live-folder-rename": {
      const folderId = element.dataset.folderId;
      const folder = state.liveFolders?.find(item => item.id === folderId);
      closePopover({ keepModalOpen: Boolean(folder) });
      if (!folder) break;
      const name = await requestText({
        title: "Rename live folder",
        label: "Folder name",
        value: folder.name,
        submitLabel: "Rename",
        maxLength: 80,
      });
      if (name) {
        await runCommand(commands.renameLiveFolder, {
          id: folder.id,
          name: name.trim().slice(0, 80),
        });
      }
      break;
    }
    case "live-folder-delete": {
      const folderId = element.dataset.folderId;
      const folder = state.liveFolders?.find(item => item.id === folderId);
      closePopover({ keepModalOpen: Boolean(folder) });
      if (!folder) break;
      const confirmed = await requestConfirmation({
        title: "Delete live folder?",
        message: `Deleting “${folder.name}” stops refreshing its feed. Pages you opened from it stay in your tabs and history.`,
        confirmLabel: "Delete live folder",
      });
      if (confirmed) await runCommand(commands.deleteLiveFolder, { id: folder.id });
      break;
    }
    case "essential-reset": {
      const tabId = element.dataset.tabId;
      closePopover();
      const reset = await runCommand(commands.resetEssential, { id: tabId });
      if (!reset) showToast("This Essential has no saved page to return to.");
      break;
    }
    case "essential-unload": {
      const tabId = element.dataset.tabId;
      closePopover();
      const unloaded = await runCommand(commands.discardTab, { id: tabId });
      if (!unloaded) showToast("The active Essential cannot be unloaded.");
      break;
    }
    case "essential-remove": {
      const tabId = element.dataset.tabId;
      closePopover();
      await runCommand(commands.toggleEssential, { id: tabId });
      break;
    }
    case "site-info":
      showSiteInfo(element);
      break;
    case "site-copy-url": {
      const tab = activeTab();
      closePopover();
      if (tab?.url) {
        try {
          await navigator.clipboard.writeText(displayNavigationUrl(tab.url));
          showToast("Address copied.");
        } catch {
          showToast("The address could not be copied.");
        }
      }
      break;
    }
    case "site-clear-data": {
      const tabId = element.dataset.tabId;
      const tab = state.tabs.find(item => item.id === tabId);
      closePopover({ keepModalOpen: Boolean(tab) });
      if (!tab) break;
      let host = "";
      try {
        host = new URL(tab.url).hostname;
      } catch {
        break;
      }
      const confirmed = await requestConfirmation({
        title: "Clear site data?",
        message: `Cookies, storage, and caches that ${host} saved in this profile will be deleted, and the page will reload. This may sign you out of the site.`,
        confirmLabel: "Clear data",
      });
      if (confirmed) {
        const cleared = await runCommand(commands.clearSiteData, { id: tab.id });
        showToast(cleared ? `Data for ${host} was cleared.` : "Site data could not be cleared.");
      }
      break;
    }
    case "containers-menu":
      showContainersMenu(element);
      break;
    case "extensions-menu":
      showExtensionsMenu(element);
      break;
    case "now-playing-menu":
      await showNowPlayingMenu(element);
      break;
    case "now-playing-toggle": {
      const tabId = element.dataset.tabId;
      const playback = await runCommand(commands.toggleMediaPlayback, { id: tabId });
      if (playback === null) {
        showToast("The media on that page is no longer available.");
        closePopover();
      } else {
        const anchor = nowPlayingButton;
        closePopover();
        await showNowPlayingMenu(anchor);
      }
      break;
    }
    case "extension-open-popup": {
      const extensionId = element.dataset.extensionId;
      closePopover();
      const opened = await runCommand(commands.openExtensionPopup, { id: extensionId });
      if (!opened) showToast("This extension has no action popup.");
      break;
    }
    case "extension-install": {
      closePopover();
      const installed = await runCommand(commands.installExtension, {});
      if (installed === null) {
        showToast("No extension was installed.");
      }
      break;
    }
    case "extension-reload": {
      const extensionId = element.dataset.extensionId;
      closePopover();
      const reloaded = await runCommand(commands.reloadExtension, { id: extensionId });
      if (reloaded !== true) showToast("The extension could not be reloaded.");
      break;
    }
    case "extension-remove": {
      const extensionId = element.dataset.extensionId;
      const extension = state.extensions?.find(item => item.id === extensionId);
      closePopover({ keepModalOpen: Boolean(extension) });
      if (!extension) break;
      const confirmed = await requestConfirmation({
        title: "Remove extension?",
        message: `Removing “${extension.name}” unloads it from the browser. The extension folder on disk is not deleted.`,
        confirmLabel: "Remove extension",
      });
      if (confirmed) await runCommand(commands.removeExtension, { id: extension.id });
      break;
    }
    case "container-new-tab": {
      const containerId = element.dataset.containerId;
      closePopover();
      await runCommand(commands.createTab, { containerId });
      break;
    }
    case "container-create": {
      closePopover();
      const name = await requestText({
        title: "New container",
        label: "Container name",
        value: "Container",
        submitLabel: "Create",
        maxLength: 80,
      });
      if (name) await runCommand(commands.createContainer, { name });
      break;
    }
    case "container-rename": {
      const containerId = element.dataset.containerId;
      const container = state.containers?.find(item => item.id === containerId);
      closePopover({ keepModalOpen: Boolean(container) });
      if (!container) break;
      const name = await requestText({
        title: "Rename container",
        label: "Container name",
        value: container.name,
        submitLabel: "Rename",
        maxLength: 80,
      });
      if (name) {
        await runCommand(commands.renameContainer, {
          id: container.id,
          name: name.trim().slice(0, 80),
        });
      }
      break;
    }
    case "container-proxy": {
      const containerId = element.dataset.containerId;
      const container = state.containers?.find(item => item.id === containerId);
      closePopover({ keepModalOpen: Boolean(container) });
      if (!container) break;
      const value = await requestText({
        title: "Container proxy",
        label: "Proxy (scheme://host:port, blank for system)",
        value: container.proxy || "",
        submitLabel: "Save",
        maxLength: 256,
        allowEmpty: true,
      });
      if (value === null) break;
      const applied = await runCommand(commands.setContainerProxy, {
        id: container.id,
        proxy: value,
      });
      if (!applied) {
        showToast("Enter a proxy like socks5://host:1080 (http, https, socks4, socks5).");
      }
      break;
    }
    case "container-ua": {
      const containerId = element.dataset.containerId;
      const container = state.containers?.find(item => item.id === containerId);
      closePopover({ keepModalOpen: Boolean(container) });
      if (!container) break;
      const value = await requestText({
        title: "Container user agent",
        label: "User-Agent string (blank for default)",
        value: container.userAgent || "",
        submitLabel: "Save",
        maxLength: 512,
        allowEmpty: true,
      });
      if (value === null) break;
      const applied = await runCommand(commands.setContainerUserAgent, {
        id: container.id,
        userAgent: value,
      });
      if (!applied) {
        showToast("Enter a printable User-Agent string (no control characters).");
      }
      break;
    }
    case "container-delete": {
      const containerId = element.dataset.containerId;
      const container = state.containers?.find(item => item.id === containerId);
      closePopover({ keepModalOpen: Boolean(container) });
      if (!container) break;
      const memberCount = state.tabs.filter(tab => tab.containerId === container.id).length;
      const tabLabel = `${memberCount} ${memberCount === 1 ? "tab" : "tabs"}`;
      const confirmed = await requestConfirmation({
        title: "Delete container?",
        message: `Deleting “${container.name}” closes its ${tabLabel} and clears the container's cookies and site data. This cannot be undone.`,
        confirmLabel: "Delete container",
      });
      if (confirmed) await runCommand(commands.deleteContainer, { id: container.id });
      break;
    }
    case "bookmark-rename": {
      const bookmarkId = element.dataset.bookmarkId;
      const bookmark = state.bookmarks?.find(item => item.id === bookmarkId);
      closePopover({ keepModalOpen: Boolean(bookmark) });
      if (!bookmark) break;
      const title = await requestText({
        title: "Rename bookmark",
        label: "Bookmark name",
        value: bookmarkTitle(bookmark),
        submitLabel: "Rename",
        maxLength: 500,
      });
      if (title) {
        await runCommand(commands.renameBookmark, { id: bookmark.id, title });
      }
      break;
    }
    case "bookmark-move-to-new-folder": {
      const bookmarkId = element.dataset.bookmarkId;
      closePopover();
      const name = await requestText({
        title: "New bookmark folder",
        label: "Folder name",
        value: "Folder",
        submitLabel: "Create",
        maxLength: 80,
      });
      if (name) {
        await runCommand(commands.createBookmarkFolder, {
          name,
          bookmarkIds: [bookmarkId],
        });
      }
      break;
    }
    case "select-tab":
      closePopover();
      await runCommand(commands.selectTab, { id: tabId });
      break;
    case "close-tab":
      await runCommand(commands.closeTab, { id: tabId });
      break;
    case "toggle-mute":
      await runCommand(commands.toggleMute, { id: tabId });
      break;
    case "select-workspace":
      await runCommand(commands.selectWorkspace, { id: element.dataset.workspaceId });
      closePopover();
      break;
    case "workspace-menu":
      showWorkspaceMenu(element);
      break;
    case "new-workspace": {
      closePopover({ keepModalOpen: true });
      const name = await requestText({
        title: "New space",
        label: "Space name",
        value: `Space ${state.workspaces.length + 1}`,
        submitLabel: "Create",
      });
      if (name) await runCommand(commands.createWorkspace, { name });
      break;
    }
    case "rename-workspace": {
      const workspace = activeWorkspace();
      closePopover({ keepModalOpen: Boolean(workspace) });
      if (!workspace) break;
      const name = await requestText({
        title: "Rename space",
        label: "Space name",
        value: workspace.name,
        submitLabel: "Rename",
      });
      if (name) await runCommand(commands.renameWorkspace, { id: workspace.id, name });
      break;
    }
    case "delete-workspace": {
      const workspace = activeWorkspace();
      closePopover({ keepModalOpen: Boolean(workspace) });
      if (!workspace || state.workspaces.length <= 1) break;
      const tabCount = state.tabs.filter(tab => tab.workspaceId === workspace.id).length;
      const confirmed = await requestConfirmation({
        title: "Delete space?",
        message: `Deleting “${workspace.name}” will close its ${tabCount} ${tabCount === 1 ? "tab" : "tabs"}, folders, and split views. This cannot be undone.`,
        confirmLabel: "Delete space",
      });
      if (confirmed) {
        const deleted = await runCommand(commands.deleteWorkspace, {
          id: workspace.id,
        });
        if (deleted !== true) showToast("This space could not be deleted.");
      }
      break;
    }
    case "new-folder": {
      const name = await requestText({
        title: "New folder",
        label: "Folder name",
        value: "Folder",
        submitLabel: "Create",
        maxLength: 80,
      });
      if (name) await runCommand(commands.createFolder, { name, tabIds: [] });
      break;
    }
    case "toggle-folder":
      await runCommand(commands.toggleFolder, { id: element.dataset.folderId });
      break;
    case "folder-menu":
      showFolderMenu(element.dataset.folderId, element);
      break;
    case "folder-menu-toggle": {
      const folderId = element.dataset.folderId;
      closePopover();
      await runCommand(commands.toggleFolder, { id: folderId });
      break;
    }
    case "folder-rename": {
      const folderId = element.dataset.folderId;
      const folder = state.folders.find(item => item.id === folderId);
      closePopover({ keepModalOpen: Boolean(folder) });
      if (!folder) break;
      const name = await requestText({
        title: "Rename folder",
        label: "Folder name",
        value: folder.name,
        submitLabel: "Rename",
        maxLength: 80,
      });
      if (name) {
        await runCommand(commands.renameFolder, {
          id: folder.id,
          name: name.trim().slice(0, 80),
        });
      }
      break;
    }
    case "folder-delete": {
      const folderId = element.dataset.folderId;
      const folder = state.folders.find(item => item.id === folderId);
      closePopover({ keepModalOpen: Boolean(folder) });
      if (!folder) break;
      const tabLabel = `${folder.tabIds.length} ${folder.tabIds.length === 1 ? "tab" : "tabs"}`;
      const confirmed = await requestConfirmation({
        title: "Delete folder?",
        message: `Deleting “${folder.name}” only removes the folder. Its ${tabLabel} will stay open and return to the ungrouped tab list.`,
        confirmLabel: "Delete folder",
      });
      if (confirmed) await runCommand(commands.deleteFolder, { id: folder.id });
      break;
    }
    case "toggle-sidebar":
      closePopover();
      await runCommand(commands.toggleSidebar);
      break;
    case "split-row":
      await runCommand(splitForTab(state.activeTabId) ? commands.unsplitActive : commands.splitActive, { direction: "row" });
      break;
    case "appearance":
      showAppearance(element);
      break;
    case "downloads":
      showDownloads(element);
      break;
    case "download-pause":
      if (await runCommand(commands.pauseDownload, { id: element.dataset.downloadId }) === false) {
        showToast("This download cannot be paused.");
      }
      break;
    case "download-resume":
      if (await runCommand(commands.resumeDownload, { id: element.dataset.downloadId }) === false) {
        showToast("This download cannot be resumed.");
      }
      break;
    case "download-cancel":
      if (await runCommand(commands.cancelDownload, { id: element.dataset.downloadId }) === false) {
        showToast("This download cannot be cancelled.");
      }
      break;
    case "download-open":
      if (await runCommand(commands.openDownload, { id: element.dataset.downloadId }) !== true) {
        showToast("The downloaded file is no longer available.");
      }
      break;
    case "download-reveal":
      if (await runCommand(commands.revealDownload, { id: element.dataset.downloadId }) !== true) {
        showToast("The downloaded file is no longer available.");
      }
      break;
    case "download-remove":
      await runCommand(commands.removeDownload, { id: element.dataset.downloadId });
      break;
    case "download-clear-finished":
      await runCommand(commands.clearDownloads);
      break;
    case "address-suggestion": {
      const suggestion = suggestionItems[Number(element.dataset.index)];
      if (suggestion) {
        addressInput.value = suggestion.value;
        addressDirty = false;
        addressResults.hidden = true;
        await runCommand(commands.navigate, { id: state.activeTabId, input: suggestion.value });
      }
      break;
    }
    case "context-essential":
      await runCommand(commands.toggleEssential, { id: contextTabId });
      closePopover();
      break;
    case "context-pin":
      await runCommand(commands.togglePin, { id: contextTabId });
      closePopover();
      break;
    case "context-mute":
      await runCommand(commands.toggleMute, { id: contextTabId });
      closePopover();
      break;
    case "context-folder": {
      const folderTabId = contextTabId;
      const folderTab = state.tabs.find(tab => tab.id === folderTabId);
      if (!folderTab || folderTab.essential || folderTab.pinned) {
        closePopover();
        break;
      }
      closePopover({ keepModalOpen: true });
      const name = await requestText({
        title: "Move to new folder",
        label: "Folder name",
        value: "Folder",
        submitLabel: "Create",
      });
      if (name) {
        await runCommand(commands.createFolder, { name, tabIds: [folderTabId] });
      }
      break;
    }
    case "context-move-workspace": {
      const moveTabId = contextTabId;
      const workspaceId = element.dataset.workspaceId;
      const moved = await runCommand(commands.moveTabToWorkspace, {
        id: moveTabId,
        workspaceId,
      });
      closePopover();
      if (moved !== true) {
        showToast("Pinned, Essential, folder, and split tabs cannot be moved yet.");
      }
      break;
    }
    case "context-discard": {
      const discarded = await runCommand(commands.discardTab, { id: contextTabId });
      closePopover();
      if (discarded !== true) {
        showToast("Active, split, and crashed tabs cannot be unloaded.");
      }
      break;
    }
    case "context-ua-mode": {
      const mode = element.dataset.uaMode;
      const changed = await runCommand(commands.setTabUserAgentMode, {
        id: contextTabId,
        mode,
      });
      closePopover();
      if (!changed) showToast("The site identity could not be changed.");
      break;
    }
    case "context-reopen-container": {
      const reopenTabId = contextTabId;
      const containerId = element.dataset.containerId || "";
      const reopened = await runCommand(commands.reopenTabInContainer, {
        id: reopenTabId,
        containerId,
      });
      closePopover();
      if (!reopened) {
        showToast("Pinned, Essential, and split tabs cannot change containers.");
      }
      break;
    }
    case "context-split-row":
    case "context-split-column": {
      const splitTab = state.tabs.find(tab => tab.id === contextTabId);
      if (!splitTab || splitTab.essential || splitTab.pinned) {
        closePopover();
        break;
      }
      if (contextTabId !== state.activeTabId) await runCommand(commands.selectTab, { id: contextTabId });
      await runCommand(commands.splitActive, { direction: action.endsWith("column") ? "column" : "row" });
      closePopover();
      break;
    }
    case "context-unsplit": {
      const splitTab = state.tabs.find(tab => tab.id === contextTabId);
      if (!splitTab || splitTab.essential || splitTab.pinned) {
        closePopover();
        break;
      }
      if (contextTabId !== state.activeTabId) await runCommand(commands.selectTab, { id: contextTabId });
      await runCommand(commands.unsplitActive);
      closePopover();
      break;
    }
    case "context-devtools":
      await runCommand(commands.openDevTools, { id: contextTabId });
      closePopover();
      break;
    case "context-close":
      await runCommand(commands.closeTab, { id: contextTabId });
      closePopover();
      break;
  }
}

document.addEventListener("click", event => {
  if (suppressTabClick) {
    suppressTabClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const actionElement = event.target.closest("[data-action]");
  if (actionElement) {
    event.preventDefault();
    event.stopPropagation();
    void handleAction(actionElement.dataset.action, actionElement);
    return;
  }
  if (!event.target.closest(".popover")) closePopover();
});

document.addEventListener("dblclick", event => {
  if (event.target.closest(".tab-item, .folder")) return;
  if (event.target.closest("#tabs-scroll")) void runCommand(commands.createTab);
});

document.addEventListener("contextmenu", event => {
  const essentialItem = event.target.closest(".essential-item");
  if (essentialItem) {
    event.preventDefault();
    showEssentialMenu(essentialItem.dataset.tabId, essentialItem, {
      x: event.clientX,
      y: event.clientY,
    });
    return;
  }
  const row = event.target.closest(".tab-row, .pinned-tab");
  if (row) {
    event.preventDefault();
    showTabMenu(row.dataset.tabId, event.clientX, event.clientY);
    return;
  }
  const folder = event.target.closest(".folder");
  if (!folder) return;
  event.preventDefault();
  showFolderMenu(folder.dataset.folderId, null, {
    x: event.clientX,
    y: event.clientY,
  });
});

document.addEventListener("dragstart", event => {
  const workspace = event.target.closest?.(".workspace-dot");
  if (!workspace) return;
  draggedWorkspaceId = workspace.dataset.workspaceId || null;
  if (!draggedWorkspaceId) return;
  workspace.classList.add("is-dragging");
  event.dataTransfer?.setData("text/x-chroma-workspace", draggedWorkspaceId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
});

document.addEventListener("dragover", event => {
  const target = event.target.closest?.(".workspace-dot");
  if (!target || !draggedWorkspaceId || target.dataset.workspaceId === draggedWorkspaceId) {
    return;
  }
  event.preventDefault();
  document.querySelectorAll(".workspace-dot.is-drop-before, .workspace-dot.is-drop-after")
    .forEach(item => item.classList.remove("is-drop-before", "is-drop-after"));
  const bounds = target.getBoundingClientRect();
  target.classList.add(
    event.clientX < bounds.left + bounds.width / 2
      ? "is-drop-before"
      : "is-drop-after"
  );
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
});

document.addEventListener("drop", event => {
  const target = event.target.closest?.(".workspace-dot");
  const sourceId = draggedWorkspaceId ||
    event.dataTransfer?.getData("text/x-chroma-workspace");
  if (!target || !sourceId || target.dataset.workspaceId === sourceId) return;
  event.preventDefault();
  const bounds = target.getBoundingClientRect();
  void runCommand(commands.reorderWorkspace, {
    id: sourceId,
    targetId: target.dataset.workspaceId,
    position: event.clientX < bounds.left + bounds.width / 2 ? "before" : "after",
  });
});

document.addEventListener("dragend", () => {
  draggedWorkspaceId = null;
  document.querySelectorAll(
    ".workspace-dot.is-dragging, .workspace-dot.is-drop-before, .workspace-dot.is-drop-after"
  ).forEach(item => item.classList.remove(
    "is-dragging",
    "is-drop-before",
    "is-drop-after"
  ));
});

document.querySelector("#workspace-switcher").addEventListener("keydown", event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const current = event.target.closest?.(".workspace-dot");
  if (!current) return;
  const workspaces = [...event.currentTarget.querySelectorAll(".workspace-dot")];
  const currentIndex = workspaces.indexOf(current);
  if (currentIndex < 0) return;
  let nextIndex = currentIndex;
  if (event.key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + workspaces.length) % workspaces.length;
  } else if (event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % workspaces.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = workspaces.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  const nextWorkspace = workspaces[nextIndex];
  workspaces.forEach(workspace => {
    workspace.tabIndex = workspace === nextWorkspace ? 0 : -1;
  });
  nextWorkspace.focus({ preventScroll: true });
  nextWorkspace.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (nextWorkspace.dataset.workspaceId !== state.activeWorkspaceId) {
    void runCommand(commands.selectWorkspace, {
      id: nextWorkspace.dataset.workspaceId,
    });
  }
});

document.addEventListener("error", event => {
  if (!(event.target instanceof HTMLImageElement) || !event.target.classList.contains("favicon")) return;
  event.target.hidden = true;
  const fallback = event.target.nextElementSibling;
  if (fallback) fallback.hidden = false;
}, true);

function clearTabDropTarget() {
  if (dragTargetRow) {
    dragTargetRow.classList.remove(
      "is-drop-before",
      "is-drop-after",
      "is-split-before",
      "is-split-after",
      "is-drop-disabled"
    );
    delete dragTargetRow.dataset.dropMode;
  }
  document.querySelectorAll(".split-tab-group.is-detach-preview").forEach(group => {
    group.classList.remove("is-detach-preview");
  });
  document.querySelectorAll(".tab-row.is-swap-preview").forEach(row => {
    row.classList.remove("is-swap-preview");
    row.style.removeProperty("--split-swap-x");
    row.style.removeProperty("--split-swap-y");
    row.style.removeProperty("--split-swap-scale-x");
    row.style.removeProperty("--split-swap-scale-y");
  });
  document.querySelectorAll(".folder.is-drop-target, .ungrouped-tabs.is-drop-target").forEach(zone => {
    zone.classList.remove("is-drop-target");
  });
  dragTargetRow = null;
}

function updateTabDragChip(event, intent, message) {
  dragIntent = intent;
  tabDragChip.dataset.intent = intent;
  const status = tabDragChip.querySelector(".tab-drag-chip-status");
  if (status) status.textContent = message;
  const margin = 12;
  const bounds = tabDragChip.getBoundingClientRect();
  const x = Math.min(
    Math.max(margin, event.clientX + 14),
    Math.max(margin, window.innerWidth - bounds.width - margin)
  );
  const y = Math.min(
    Math.max(margin, event.clientY + 14),
    Math.max(margin, window.innerHeight - bounds.height - margin)
  );
  tabDragChip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

function pointInside(rect, x, y, inset = 0) {
  return x >= rect.left + inset && x <= rect.right - inset &&
    y >= rect.top + inset && y <= rect.bottom - inset;
}

function finishTabPointerDrag() {
  const session = tabPointerDrag;
  tabPointerDrag = null;
  clearTabDropTarget();
  session?.sourceRow?.classList.remove("is-drag-source");
  dragSplitTargetId = null;
  dragIntent = "none";
  dragTargetId = null;
  dragTargetFolderId = null;
  dragPlacement = "before";
  splitDropOverlay.hidden = true;
  tabDragChip.hidden = true;
  tabDragChip.removeAttribute("data-intent");
  tabDragChip.style.transform = "";
  document.body.classList.remove("is-tab-dragging");
  api.setTabDragActive(false);
  if (session && appElement.hasPointerCapture?.(session.pointerId)) {
    appElement.releasePointerCapture(session.pointerId);
  }
}

function updateSplitDropPreview(clientX, clientY) {
  const bounds = splitDropOverlay.getBoundingClientRect();
  const x = Math.max(0, Math.min(bounds.width, clientX - bounds.left));
  const y = Math.max(0, Math.min(bounds.height, clientY - bounds.top));
  const distances = [
    ["left", x / Math.max(1, bounds.width)],
    ["right", (bounds.width - x) / Math.max(1, bounds.width)],
    ["top", y / Math.max(1, bounds.height)],
    ["bottom", (bounds.height - y) / Math.max(1, bounds.height)],
  ];
  dragSplitEdge = distances.sort((left, right) => left[1] - right[1])[0][0];
  splitDropOverlay.dataset.edge = dragSplitEdge;
  splitDropLabel.textContent = `Split ${dragSplitEdge}`;
}

function splitPathFromElement(element) {
  const value = element?.dataset.splitPath || "";
  return value ? value.split("/").filter(Boolean) : [];
}

function renderSplitDividerPreview(session = splitDividerDrag) {
  const rect = viewportElement.getBoundingClientRect();
  renderPaneFrames(rect);
  if (session) updateSplitCapsuleGeometry(session.groupId, session.previewLayout);
}

function restoreSplitDividerPreview(session) {
  const group = state.splitGroups.find(item => item.id === session?.groupId);
  if (group) updateSplitCapsuleGeometry(group.id, normalizedSplitLayoutForRenderer(group));
  renderSplitDividerPreview(null);
}

function queueNativeSplitDividerPreview(session) {
  cancelAnimationFrame(splitDividerPreviewFrame);
  splitDividerPreviewFrame = requestAnimationFrame(() => {
    splitDividerPreviewFrame = 0;
    if (splitDividerDrag !== session) return;
    api.previewSplitRatio({
      groupId: session.groupId,
      path: session.path,
      ratio: session.ratio,
    });
  });
}

function releaseSplitDividerPointer(session) {
  if (!session || !paneFrameLayer.hasPointerCapture?.(session.pointerId)) return;
  try {
    paneFrameLayer.releasePointerCapture(session.pointerId);
  } catch {
    // The OS may already have cancelled the pointer during a window transition.
  }
}

function cancelSplitDividerDrag() {
  const session = splitDividerDrag;
  if (!session) return;
  splitDividerDrag = null;
  releaseSplitDividerPointer(session);
  cancelAnimationFrame(splitDividerPreviewFrame);
  splitDividerPreviewFrame = 0;
  document.body.classList.remove("is-resizing-split", "is-resizing-column");
  api.previewSplitRatio({
    groupId: session.groupId,
    path: session.path,
    cancel: true,
  });
  restoreSplitDividerPreview(session);
}

async function commitSplitDividerDrag() {
  const session = splitDividerDrag;
  if (!session) return;
  splitDividerDrag = null;
  releaseSplitDividerPointer(session);
  cancelAnimationFrame(splitDividerPreviewFrame);
  splitDividerPreviewFrame = 0;
  document.body.classList.remove("is-resizing-split", "is-resizing-column");
  const committed = await runCommand(commands.setSplitRatio, {
    groupId: session.groupId,
    path: session.path,
    ratio: session.ratio,
  });
  if (committed !== true) {
    api.previewSplitRatio({
      groupId: session.groupId,
      path: session.path,
      cancel: true,
    });
    restoreSplitDividerPreview(session);
  }
}

document.addEventListener("pointerdown", event => {
  const divider = event.target.closest?.(".pane-divider");
  if (!divider || event.button !== 0 || splitDividerDrag || tabPointerDrag) return;
  const group = state.splitGroups.find(item =>
    item.id === divider.dataset.splitGroupId
  );
  if (!group) return;
  const layout = sanitizeSplitLayout(group.layout, group.tabIds, {
    direction: group.direction === "column" ? "column" : "row",
  });
  splitDividerDrag = {
    pointerId: event.pointerId,
    groupId: group.id,
    path: splitPathFromElement(divider),
    direction: divider.dataset.splitDirection,
    availablePixels: Math.max(1, Number(divider.dataset.availablePixels) || 1),
    startRatio: Number(divider.dataset.splitRatio) || .5,
    ratio: Number(divider.dataset.splitRatio) || .5,
    startX: event.clientX,
    startY: event.clientY,
    previewLayout: layout,
  };
  try {
    // The divider DOM is rebuilt for every live preview. Capture on its stable
    // parent so a real OS drag survives those replacements.
    paneFrameLayer.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic runtime events do not own an OS pointer.
  }
  document.body.classList.add("is-resizing-split");
  document.body.classList.toggle(
    "is-resizing-column",
    splitDividerDrag.direction === "column"
  );
  event.preventDefault();
  event.stopPropagation();
});

document.addEventListener("pointermove", event => {
  const session = splitDividerDrag;
  if (!session || event.pointerId !== session.pointerId) return;
  if ((event.buttons & 1) === 0) {
    void commitSplitDividerDrag();
    return;
  }
  const delta = session.direction === "column"
    ? event.clientY - session.startY
    : event.clientX - session.startX;
  session.ratio = Math.min(.8, Math.max(.2,
    session.startRatio + delta / session.availablePixels
  ));
  session.previewLayout = setSplitRatio(
    session.previewLayout,
    session.path,
    session.ratio
  );
  renderSplitDividerPreview();
  queueNativeSplitDividerPreview(session);
  event.preventDefault();
  event.stopPropagation();
});

document.addEventListener("keydown", event => {
  const divider = event.target.closest?.(".pane-divider");
  if (!divider) return;
  const direction = divider.dataset.splitDirection;
  const decreasing = direction === "column" ? event.key === "ArrowUp" : event.key === "ArrowLeft";
  const increasing = direction === "column" ? event.key === "ArrowDown" : event.key === "ArrowRight";
  let ratio = Number(divider.dataset.splitRatio) || .5;
  if (decreasing) ratio -= .05;
  else if (increasing) ratio += .05;
  else if (event.key === "Home") ratio = .2;
  else if (event.key === "End") ratio = .8;
  else return;
  ratio = Math.min(.8, Math.max(.2, ratio));
  event.preventDefault();
  const groupId = divider.dataset.splitGroupId;
  const path = splitPathFromElement(divider);
  divider.dataset.splitRatio = String(ratio);
  divider.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  const group = state.splitGroups.find(item => item.id === groupId);
  if (group) {
    const optimisticLayout = setSplitRatio(
      normalizedSplitLayoutForRenderer(group),
      path,
      ratio
    );
    updateSplitCapsuleGeometry(groupId, optimisticLayout);
  }
  void runCommand(commands.setSplitRatio, {
    groupId,
    path,
    ratio,
  });
});

document.addEventListener("dblclick", event => {
  const divider = event.target.closest?.(".pane-divider");
  if (!divider) return;
  event.preventDefault();
  void runCommand(commands.setSplitPreset, { ratio: 0.5 });
});

document.addEventListener("pointerdown", event => {
  const row = event.target.closest?.(".tab-row");
  if (
    !row ||
    event.button !== 0 ||
    event.target.closest?.("button") ||
    tabPointerDrag
  ) {
    return;
  }
  const sourceId = row.dataset.tabId;
  const sourceGroupElement = row.closest(".split-tab-group");
  tabPointerDrag = {
    pointerId: event.pointerId,
    sourceId,
    sourceGroupId: splitForTab(sourceId)?.id || null,
    sourceFolderId: row.closest(".folder")?.dataset.folderId || null,
    splitGroupBounds: sourceGroupElement
      ? { ...sourceGroupElement.getBoundingClientRect().toJSON() }
      : null,
    splitSlots: sourceGroupElement
      ? [...sourceGroupElement.querySelectorAll(":scope > .tab-row")].map(item => ({
          id: item.dataset.tabId,
          row: item,
          rect: { ...item.getBoundingClientRect().toJSON() },
        }))
      : [],
    sourceRow: row,
    startX: event.clientX,
    startY: event.clientY,
    started: false,
  };
  const splitCandidates = tabsForWorkspace()
    .filter(tab => tab.id !== sourceId && !tab.essential && !tab.pinned)
    .sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  dragSplitTargetId = splitCandidates.some(tab => tab.id === state.activeTabId)
    ? state.activeTabId
    : splitCandidates[0]?.id || null;
});

document.addEventListener("pointermove", event => {
  const session = tabPointerDrag;
  if (!session || event.pointerId !== session.pointerId) return;
  if ((event.buttons & 1) === 0) {
    finishTabPointerDrag();
    return;
  }
  if (
    !session.started &&
    Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < 6
  ) {
    return;
  }
  if (!session.started) {
    session.started = true;
    try {
      // Capture only after crossing the drag threshold. Capturing on
      // pointerdown retargets a normal tab click to #app in Chromium.
      appElement.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic smoke events do not own an OS pointer, but still exercise
      // the same move/up state machine.
    }
    document.body.classList.add("is-tab-dragging");
    session.sourceRow.classList.add("is-drag-source");
    const sourceTab = state.tabs.find(tab => tab.id === session.sourceId);
    replaceTrustedMarkup(
      tabDragChip,
      `${sourceTab ? faviconMarkup(sourceTab) : ""}<span class="tab-drag-chip-copy">${escapeHtml(sourceTab?.title || "New Tab")}</span><span class="tab-drag-chip-status">Move tab</span>`
    );
    tabDragChip.hidden = false;
    api.setTabDragActive(true);
  }
  event.preventDefault();

  const sidebarBounds = sidebarElement.getBoundingClientRect();
  const overSidebar =
    sidebarBounds.width > 0 &&
    sidebarBounds.height > 0 &&
    pointInside(sidebarBounds, event.clientX, event.clientY);
  const viewportBounds = viewportElement.getBoundingClientRect();
  const overViewport =
    !overSidebar &&
    (!isSidebarOverlay || event.clientX > sidebarBounds.right) &&
    event.clientX >= viewportBounds.left &&
    event.clientX <= viewportBounds.right &&
    event.clientY >= viewportBounds.top &&
    event.clientY <= viewportBounds.bottom;
  if (overViewport && session.sourceGroupId) {
    clearTabDropTarget();
    dragTargetId = null;
    dragTargetFolderId = null;
    dragPlacement = "before";
    splitDropOverlay.hidden = true;
    const sourceGroup = document.querySelector(
      `[data-split-group-id="${CSS.escape(session.sourceGroupId)}"]`
    );
    sourceGroup?.classList.add("is-detach-preview");
    updateTabDragChip(event, "detach", "Remove from split");
    return;
  }
  if (overViewport && dragSplitTargetId) {
    clearTabDropTarget();
    dragTargetId = dragSplitTargetId;
    dragTargetFolderId = null;
    dragPlacement = "before";
    splitDropOverlay.hidden = false;
    updateSplitDropPreview(event.clientX, event.clientY);
    updateTabDragChip(event, "split-page", `Split ${dragSplitEdge}`);
    return;
  }

  splitDropOverlay.hidden = true;
  const hitElement = document.elementFromPoint(event.clientX, event.clientY);
  const hitFolder = hitElement?.closest?.(".folder") || null;
  const hitUngrouped = hitElement?.closest?.(".ungrouped-tabs") || null;
  const targetFolderId = hitFolder?.dataset.folderId || null;
  if (
    (hitFolder || hitUngrouped) &&
    targetFolderId !== session.sourceFolderId
  ) {
    clearTabDropTarget();
    dragTargetFolderId = targetFolderId;
    const hitRow = hitElement?.closest?.(".tab-row") || null;
    let targetId = hitRow?.dataset.tabId || null;
    let placement = "after";
    if (hitRow && targetId !== session.sourceId) {
      const hitBounds = hitRow.getBoundingClientRect();
      placement = event.clientY < hitBounds.top + hitBounds.height / 2
        ? "before"
        : "after";
      dragTargetRow = hitRow;
      hitRow.classList.toggle("is-drop-before", placement === "before");
      hitRow.classList.toggle("is-drop-after", placement === "after");
    } else if (hitFolder) {
      targetId = state.folders
        .find(folder => folder.id === targetFolderId)
        ?.tabIds.filter(id => id !== session.sourceId)
        .at(-1) || null;
    } else {
      targetId = null;
    }
    const dropZone = hitFolder || hitUngrouped;
    dropZone.classList.add("is-drop-target");
    dragTargetId = targetId;
    dragPlacement = placement;
    updateTabDragChip(
      event,
      session.sourceGroupId ? "detach-folder" : "folder-move",
      hitFolder ? "Move into folder" : "Remove from folder"
    );
    return;
  }
  if (
    session.sourceGroupId &&
    session.splitGroupBounds &&
    pointInside(session.splitGroupBounds, event.clientX, event.clientY)
  ) {
    const targetSlot = session.splitSlots.find(slot =>
      pointInside(slot.rect, event.clientX, event.clientY)
    );
    if (!targetSlot || targetSlot.id === session.sourceId) {
      clearTabDropTarget();
      dragTargetId = null;
      dragTargetFolderId = null;
      updateTabDragChip(event, "move", "Move split tab");
      return;
    }
    if (dragTargetId !== targetSlot.id || dragIntent !== "split-swap") {
      clearTabDropTarget();
      const sourceSlot = session.splitSlots.find(slot => slot.id === session.sourceId);
      if (sourceSlot) {
        const sourceX = targetSlot.rect.left - sourceSlot.rect.left;
        const sourceY = targetSlot.rect.top - sourceSlot.rect.top;
        const targetX = sourceSlot.rect.left - targetSlot.rect.left;
        const targetY = sourceSlot.rect.top - targetSlot.rect.top;
        session.sourceRow.classList.add("is-swap-preview");
        session.sourceRow.style.setProperty("--split-swap-x", `${sourceX}px`);
        session.sourceRow.style.setProperty("--split-swap-y", `${sourceY}px`);
        session.sourceRow.style.setProperty(
          "--split-swap-scale-x",
          String(targetSlot.rect.width / sourceSlot.rect.width)
        );
        session.sourceRow.style.setProperty(
          "--split-swap-scale-y",
          String(targetSlot.rect.height / sourceSlot.rect.height)
        );
        targetSlot.row.classList.add("is-swap-preview");
        targetSlot.row.style.setProperty("--split-swap-x", `${targetX}px`);
        targetSlot.row.style.setProperty("--split-swap-y", `${targetY}px`);
        targetSlot.row.style.setProperty(
          "--split-swap-scale-x",
          String(sourceSlot.rect.width / targetSlot.rect.width)
        );
        targetSlot.row.style.setProperty(
          "--split-swap-scale-y",
          String(sourceSlot.rect.height / targetSlot.rect.height)
        );
      }
    }
    dragTargetRow = targetSlot.row;
    dragTargetId = targetSlot.id;
    dragTargetFolderId = targetSlot.row.closest(".folder")?.dataset.folderId || null;
    dragPlacement = "after";
    updateTabDragChip(event, "split-swap", "Swap split tabs");
    return;
  }
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".tab-row");
  if (!row || row.dataset.tabId === session.sourceId) {
    clearTabDropTarget();
    dragTargetId = null;
    dragTargetFolderId = null;
    dragPlacement = "before";
    const sourceGroup = session.sourceGroupId
      ? document.querySelector(`[data-split-group-id="${CSS.escape(session.sourceGroupId)}"]`)
      : null;
    if (
      session.sourceGroupId &&
      pointInside(sidebarBounds, event.clientX, event.clientY) &&
      (!sourceGroup || !pointInside(sourceGroup.getBoundingClientRect(), event.clientX, event.clientY, 2))
    ) {
      sourceGroup?.classList.add("is-detach-preview");
      updateTabDragChip(event, "detach", "Remove from split");
    } else {
      updateTabDragChip(event, "move", "Move tab");
    }
    return;
  }
  if (dragTargetRow !== row) clearTabDropTarget();
  dragTargetRow = row;
  dragTargetId = row.dataset.tabId;
  dragTargetFolderId = row.closest(".folder")?.dataset.folderId || null;
  const bounds = row.getBoundingClientRect();
  const targetGroup = splitForTab(dragTargetId);
  const sameGroup = Boolean(
    session.sourceGroupId && targetGroup?.id === session.sourceGroupId
  );
  const verticalRatio = (event.clientY - bounds.top) / Math.max(1, bounds.height);
  const mergeTarget = sameGroup || (verticalRatio >= .2 && verticalRatio <= .8);
  const targetIsFull = Boolean(
    targetGroup &&
    targetGroup.id !== session.sourceGroupId &&
    targetGroup.tabIds.length >= 4
  );

  if (mergeTarget) {
    dragPlacement = event.clientX < bounds.left + bounds.width / 2
      ? "before"
      : "after";
    if (targetIsFull) {
      row.classList.add("is-drop-disabled");
      updateTabDragChip(event, "disabled", "Split is full");
      return;
    }
    row.classList.toggle("is-split-before", dragPlacement === "before");
    row.classList.toggle("is-split-after", dragPlacement === "after");
    updateTabDragChip(
      event,
      "split-tab",
      sameGroup
        ? (dragPlacement === "before" ? "Move split left" : "Move split right")
        : (dragPlacement === "before" ? "Split to the left" : "Split to the right")
    );
    return;
  }

  dragPlacement = verticalRatio < .5 ? "before" : "after";
  row.dataset.dropMode = dragPlacement;
  row.classList.toggle("is-drop-before", dragPlacement === "before");
  row.classList.toggle("is-drop-after", dragPlacement === "after");
  updateTabDragChip(
    event,
    session.sourceGroupId ? "detach-reorder" : "reorder",
    session.sourceGroupId ? "Remove from split and move" : "Move tab"
  );
});

document.addEventListener("pointerup", event => {
  if (splitDividerDrag?.pointerId !== event.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  void commitSplitDividerDrag();
});

document.addEventListener("pointerup", event => {
  const session = tabPointerDrag;
  if (!session || event.pointerId !== session.pointerId) return;
  const wasDragging = session.started;
  const dropIntent = dragIntent;
  const splitTargetId = dropIntent === "split-page" ? dragSplitTargetId : null;
  const splitEdge = dragSplitEdge;
  const pointerTargetId = dragTargetId;
  const pointerFolderId = dragTargetFolderId;
  const pointerPlacement = dragPlacement;
  if (wasDragging) {
    event.preventDefault();
    suppressTabClick = true;
    setTimeout(() => { suppressTabClick = false; }, 0);
  }
  finishTabPointerDrag();
  if (!wasDragging) return;
  if (splitTargetId) {
    void runCommand(commands.splitTabs, {
      sourceId: session.sourceId,
      targetId: splitTargetId,
      direction: splitEdge === "top" || splitEdge === "bottom" ? "column" : "row",
      placement: splitEdge === "left" || splitEdge === "top" ? "before" : "after",
    });
  } else if (
    (dropIntent === "split-tab" || dropIntent === "split-swap") &&
    pointerTargetId
  ) {
    void runCommand(commands.splitTabs, {
      sourceId: session.sourceId,
      targetId: pointerTargetId,
      direction: "row",
      placement: pointerPlacement,
    });
  } else if (
    dropIntent === "detach-reorder" &&
    pointerTargetId &&
    pointerTargetId !== session.sourceId
  ) {
    void runCommand(commands.detachSplitTab, {
      id: session.sourceId,
      targetId: pointerTargetId,
      position: pointerPlacement,
      folderId: pointerFolderId,
    });
  } else if (dropIntent === "detach-folder") {
    void runCommand(commands.detachSplitTab, {
      id: session.sourceId,
      targetId: pointerTargetId,
      position: pointerPlacement,
      moveToEnd: !pointerTargetId,
      folderId: pointerFolderId,
    });
  } else if (dropIntent === "folder-move") {
    void runCommand(commands.reorderTab, {
      id: session.sourceId,
      targetId: pointerTargetId,
      position: pointerPlacement,
      folderId: pointerFolderId,
    });
  } else if (dropIntent === "detach") {
    void runCommand(commands.detachSplitTab, { id: session.sourceId });
  } else if (
    dropIntent === "reorder" &&
    pointerTargetId &&
    pointerTargetId !== session.sourceId
  ) {
    void runCommand(commands.reorderTab, {
      id: session.sourceId,
      targetId: pointerTargetId,
      position: pointerPlacement,
      folderId: pointerFolderId,
    });
  }
});

document.addEventListener("pointercancel", event => {
  if (splitDividerDrag?.pointerId === event.pointerId) cancelSplitDividerDrag();
  if (tabPointerDrag?.pointerId === event.pointerId) finishTabPointerDrag();
});
appElement.addEventListener("lostpointercapture", event => {
  if (tabPointerDrag?.pointerId === event.pointerId) finishTabPointerDrag();
});
paneFrameLayer.addEventListener("lostpointercapture", event => {
  if (splitDividerDrag?.pointerId === event.pointerId) cancelSplitDividerDrag();
});
window.addEventListener("blur", () => {
  if (splitDividerDrag) cancelSplitDividerDrag();
  if (tabPointerDrag) finishTabPointerDrag();
  if (bookmarkPointerDrag) finishBookmarkPointerDrag();
});

function bookmarkDropTargetAt(x, y, session) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const folderSection = hit.closest?.(".bookmark-folder");
  if (folderSection) {
    const folderId = folderSection.dataset.bookmarkFolderId;
    if (session.kind === "folder" && folderId === session.id) return null;
    return { kind: "folder", folderId, heading: folderSection.querySelector(":scope > .bookmark-folder-heading") };
  }
  if (hit.closest?.("#bookmarks-list")) return { kind: "top", folderId: null, heading: null };
  return null;
}

function clearBookmarkDropHighlight() {
  for (const heading of bookmarksList.querySelectorAll(".is-drop-target")) {
    heading.classList.remove("is-drop-target");
  }
  bookmarksList.classList.remove("is-drop-top");
}

function finishBookmarkPointerDrag(commitEvent = null) {
  const session = bookmarkPointerDrag;
  bookmarkPointerDrag = null;
  if (!session) return;
  clearBookmarkDropHighlight();
  document.body.classList.remove("is-bookmark-dragging");
  session.sourceElement?.classList.remove("is-drag-source");
  try {
    appElement.releasePointerCapture(session.pointerId);
  } catch {
    // Synthetic pointers never held a capture.
  }
  if (!session.started) return;
  suppressTabClick = true;
  setTimeout(() => { suppressTabClick = false; }, 0);
  if (!commitEvent) return;
  const target = bookmarkDropTargetAt(commitEvent.clientX, commitEvent.clientY, session);
  if (!target) return;
  if (session.kind === "bookmark") {
    const targetFolderId = target.kind === "folder" ? target.folderId : null;
    if ((session.sourceFolderId || null) === targetFolderId) return;
    void runCommand(commands.moveBookmark, {
      id: session.id,
      folderId: targetFolderId,
    });
    return;
  }
  const parentId = target.kind === "folder" ? target.folderId : null;
  void runCommand(commands.moveBookmarkFolder, { id: session.id, parentId }).then(
    moved => {
      if (!moved) showToast("The folder cannot move there.");
    }
  );
}

document.addEventListener("pointerdown", event => {
  if (event.button !== 0 || bookmarkPointerDrag || tabPointerDrag) return;
  const bookmarkLabel = event.target.closest?.(".bookmark-open");
  const folderHeader = event.target.closest?.(".bookmark-folder-header");
  if (!bookmarkLabel && !folderHeader) return;
  if (!event.target.closest?.("#bookmarks-list")) return;
  if (bookmarkLabel) {
    const item = bookmarkLabel.closest(".bookmark-item");
    bookmarkPointerDrag = {
      pointerId: event.pointerId,
      kind: "bookmark",
      id: item?.dataset.bookmarkId,
      sourceFolderId: item?.closest(".bookmark-folder")?.dataset.bookmarkFolderId || null,
      sourceElement: item,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    };
  } else {
    const section = folderHeader.closest(".bookmark-folder");
    bookmarkPointerDrag = {
      pointerId: event.pointerId,
      kind: "folder",
      id: section?.dataset.bookmarkFolderId,
      sourceFolderId: null,
      sourceElement: section,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    };
  }
  if (!bookmarkPointerDrag.id) bookmarkPointerDrag = null;
});

document.addEventListener("pointermove", event => {
  const session = bookmarkPointerDrag;
  if (!session || event.pointerId !== session.pointerId) return;
  if ((event.buttons & 1) === 0) {
    finishBookmarkPointerDrag();
    return;
  }
  if (
    !session.started &&
    Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < 6
  ) {
    return;
  }
  if (!session.started) {
    session.started = true;
    try {
      appElement.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic smoke pointers still drive the same state machine.
    }
    document.body.classList.add("is-bookmark-dragging");
    session.sourceElement?.classList.add("is-drag-source");
  }
  event.preventDefault();
  clearBookmarkDropHighlight();
  const target = bookmarkDropTargetAt(event.clientX, event.clientY, session);
  if (target?.heading) target.heading.classList.add("is-drop-target");
  else if (target?.kind === "top") bookmarksList.classList.add("is-drop-top");
});

document.addEventListener("pointerup", event => {
  if (bookmarkPointerDrag?.pointerId === event.pointerId) {
    finishBookmarkPointerDrag(event);
  }
});

document.addEventListener("pointercancel", event => {
  if (bookmarkPointerDrag?.pointerId === event.pointerId) {
    finishBookmarkPointerDrag();
  }
});


addressForm.addEventListener("submit", event => {
  event.preventDefault();
  const selected = suggestionItems[selectedSuggestion];
  const input = selected?.value || addressInput.value;
  addressDirty = false;
  addressResults.hidden = true;
  void runCommand(commands.navigate, { id: state.activeTabId, input });
});

addressForm.addEventListener("pointerdown", event => {
  if (event.button !== 0 || addressWindowDrag || event.target.closest("button")) return;
  addressWindowDrag = {
    pointerId: event.pointerId,
    screenX: event.screenX,
    screenY: event.screenY,
    started: false,
  };
});

addressForm.addEventListener("pointermove", event => {
  if (!addressWindowDrag || event.pointerId !== addressWindowDrag.pointerId) return;
  if ((event.buttons & 1) === 0) {
    clearAddressWindowDrag();
    return;
  }
  const deltaX = event.screenX - addressWindowDrag.screenX;
  const deltaY = event.screenY - addressWindowDrag.screenY;
  if (!addressWindowDrag.started && Math.hypot(deltaX, deltaY) < 6) return;
  if (!addressWindowDrag.started) {
    addressWindowDrag.started = true;
    suppressAddressClick = true;
    addressForm.classList.add("is-window-dragging");
    addressInput.blur();
    document.getSelection()?.removeAllRanges();
    try {
      addressForm.setPointerCapture(event.pointerId);
    } catch {
      // The smoke test uses synthetic pointers without an OS capture target.
    }
    api.startWindowDrag(addressWindowDrag);
  }
  event.preventDefault();
  api.updateWindowDrag({ screenX: event.screenX, screenY: event.screenY });
});

function clearAddressWindowDrag({ preserveClickSuppression = false } = {}) {
  const session = addressWindowDrag;
  if (!session) return;
  addressWindowDrag = null;
  if (session.started) {
    api.endWindowDrag();
  }
  if (addressForm.hasPointerCapture?.(session.pointerId)) {
    addressForm.releasePointerCapture(session.pointerId);
  }
  addressForm.classList.remove("is-window-dragging");
  if (!preserveClickSuppression) suppressAddressClick = false;
}

function finishAddressWindowDrag(event) {
  const session = addressWindowDrag;
  if (!session || event.pointerId !== session.pointerId) return;
  if (session.started) {
    event.preventDefault();
    clearAddressWindowDrag({ preserveClickSuppression: true });
    setTimeout(() => { suppressAddressClick = false; }, 0);
  } else {
    clearAddressWindowDrag();
  }
}

addressForm.addEventListener("pointerup", finishAddressWindowDrag);
addressForm.addEventListener("pointercancel", event => {
  if (addressWindowDrag?.pointerId === event.pointerId) clearAddressWindowDrag();
});
addressForm.addEventListener("lostpointercapture", event => {
  if (addressWindowDrag?.pointerId === event.pointerId) clearAddressWindowDrag();
});
window.addEventListener("blur", () => {
  if (addressWindowDrag) clearAddressWindowDrag();
});
addressForm.addEventListener("click", event => {
  if (!suppressAddressClick) return;
  suppressAddressClick = false;
  event.preventDefault();
  event.stopPropagation();
}, true);

bookmarkSearchInput.addEventListener("input", () => {
  bookmarkSearchQuery = bookmarkSearchInput.value;
  renderBookmarks();
});

bookmarkSearchInput.addEventListener("keydown", event => {
  if (event.key === "Escape" && bookmarkSearchInput.value) {
    event.stopPropagation();
    bookmarkSearchInput.value = "";
    bookmarkSearchQuery = "";
    renderBookmarks();
  }
});

addressInput.addEventListener("focus", () => {
  addressDirty = false;
  addressInput.select();
  selectedSuggestion = -1;
  scheduleAddressSuggestions({ immediate: true });
});

addressInput.addEventListener("input", () => {
  addressDirty = true;
  selectedSuggestion = -1;
  scheduleAddressSuggestions();
});

addressInput.addEventListener("keydown", event => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!suggestionItems.length) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    selectedSuggestion = (selectedSuggestion + delta + suggestionItems.length) % suggestionItems.length;
    renderAddressSuggestions();
  } else if (event.key === "Escape") {
    addressInput.blur();
    addressResults.hidden = true;
    addressDirty = false;
    render();
  }
});

addressInput.addEventListener("blur", () => {
  clearTimeout(suggestionTimer);
  suggestionTimer = null;
  suggestionQueryToken += 1;
  setTimeout(() => {
    addressResults.hidden = true;
    addressDirty = false;
    render();
  }, 120);
});

historySearch.addEventListener("input", () => {
  scheduleHistoryQuery();
});

historySearch.addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  scheduleHistoryQuery({ immediate: true });
});

historyResults.addEventListener("scroll", () => {
  if (
    historyView.mode === "ready" &&
    historyView.hasMore &&
    historyResults.scrollTop + historyResults.clientHeight >= historyResults.scrollHeight - 120
  ) {
    void queryHistory({ append: true });
  }
});

historyClearForm.addEventListener("change", event => {
  if (!event.target.matches('input[name="history-clear-range"]')) return;
  const range = selectedHistoryClearRange();
  historyCustomRange.hidden = range !== "custom";
  historyAllTimeConfirmPending = false;
  historyClearWarning.hidden = true;
  historyClearError.hidden = true;
  historyClearSubmit.textContent = "Clear history";
  historyClearSubmit.classList.remove("danger");
});

historyClearForm.addEventListener("submit", event => {
  event.preventDefault();
  historyClearError.hidden = true;
  let payload;
  try {
    payload = historyClearPayload();
  } catch (error) {
    historyClearError.textContent = error.message;
    historyClearError.hidden = false;
    return;
  }
  if (payload.range === "all" && !historyAllTimeConfirmPending) {
    historyAllTimeConfirmPending = true;
    historyClearWarning.hidden = false;
    historyClearSubmit.textContent = "Clear all history";
    historyClearSubmit.classList.add("danger");
    historyClearSubmit.focus();
    return;
  }
  void clearHistory(payload);
});

historyClearDialog.addEventListener("cancel", event => {
  event.preventDefault();
  closeHistoryClearDialog();
});

historyClearDialog.addEventListener("click", event => {
  if (event.target === historyClearDialog) closeHistoryClearDialog();
});

historyClearDialog.addEventListener("close", () => {
  historyAllTimeConfirmPending = false;
  if (!historyPanel.hidden) requestAnimationFrame(() => historyClearButton.focus());
});

commandPaletteInput.addEventListener("input", () => {
  commandPaletteIndex = 0;
  renderCommandPalette();
});

commandPaletteInput.addEventListener("keydown", event => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    event.stopPropagation();
    moveCommandPaletteSelection(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    moveCommandPaletteSelection(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    void executeCommandPaletteItem();
  }
});

commandPaletteResults.addEventListener("pointermove", event => {
  const item = event.target.closest("[data-command-index]");
  if (!item) return;
  const index = Number(item.dataset.commandIndex);
  if (!Number.isInteger(index) || index === commandPaletteIndex) return;
  commandPaletteIndex = index;
  renderCommandPalette();
});

commandPaletteResults.addEventListener("click", event => {
  const item = event.target.closest("[data-command-index]");
  if (!item) return;
  event.preventDefault();
  event.stopPropagation();
  void executeCommandPaletteItem(Number(item.dataset.commandIndex));
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (splitDividerDrag) {
      event.preventDefault();
      cancelSplitDividerDrag();
      return;
    }
    if (!commandPalette.hidden) {
      event.preventDefault();
      closeCommandPalette();
      return;
    }
    if (historyClearDialog.open) {
      event.preventDefault();
      closeHistoryClearDialog();
      return;
    }
    if (!historyPanel.hidden) {
      event.preventDefault();
      if (historyView.selection.size) {
        historyView.selection.clear();
        historyView.announcement = "Selection cleared.";
        renderHistoryPanel();
      } else if (historyView.query) {
        historySearch.value = "";
        scheduleHistoryQuery({ immediate: true });
      } else {
        closeHistoryPanel();
      }
      return;
    }
    closePopover();
    if (isSidebarOverlay && !textPrompt.open) {
      api.updateSidebarOverlay({ open: false });
    }
    return;
  }
});

resizer.addEventListener("pointerdown", event => {
  if (state.settings.sidebarCollapsed) return;
  resizer.setPointerCapture(event.pointerId);
  resizer.classList.add("is-resizing");
});

resizer.addEventListener("pointermove", event => {
  if (!resizer.hasPointerCapture(event.pointerId)) return;
  appElement.style.setProperty("--sidebar-width", `${Math.max(220, Math.min(500, event.clientX))}px`);
  scheduleLayout();
});

resizer.addEventListener("pointerup", event => {
  if (!resizer.hasPointerCapture(event.pointerId)) return;
  resizer.releasePointerCapture(event.pointerId);
  resizer.classList.remove("is-resizing");
  void runCommand(commands.setSidebarWidth, { width: event.clientX });
});

new ResizeObserver(scheduleLayout).observe(viewportElement);
window.addEventListener("resize", () => {
  scheduleLayout();
  updateSidebarOverlayBounds();
});

trafficLightButtons.forEach(button => {
  button.addEventListener("pointerenter", () => button.classList.add("is-hovered"));
  button.addEventListener("pointerleave", () => button.classList.remove("is-hovered"));
});
window.addEventListener("blur", () => {
  trafficLightButtons.forEach(button => button.classList.remove("is-hovered"));
});

sidebarPeekTrigger.addEventListener("pointerenter", () => openSidebarOverlay());
sidebarPeekTrigger.addEventListener("click", () => openSidebarOverlay());
if (isSidebarOverlay) {
  appElement.addEventListener("pointerenter", () => {
    clearTimeout(sidebarOverlayCloseTimer);
    sidebarOverlayCloseTimer = null;
  });
  appElement.addEventListener("pointerleave", closeSidebarOverlaySoon);
  appElement.addEventListener("focusin", event => {
    if (event.target.matches?.("input, textarea, [contenteditable='true']")) {
      api.updateSidebarOverlay({ keepOpen: true });
    }
  });
  appElement.addEventListener("focusout", () => {
    queueMicrotask(() => {
      const editing = document.activeElement?.matches?.(
        "input, textarea, [contenteditable='true']"
      );
      if (!editing) api.updateSidebarOverlay({ keepOpen: false });
    });
  });
}

async function start() {
  initializeStaticIcons();
  if (!api) {
    appElement.classList.remove("is-loading");
    showToast("The secure browser bridge failed to load.");
    return;
  }
  api.onStateChanged(nextState => {
    state = nextState;
    render();
  });
  api.onFocusAddress(() => {
    const focus = () => {
      addressInput.focus();
      addressInput.select();
    };
    if (state?.settings.sidebarCollapsed && !isSidebarOverlay) {
      openSidebarOverlay({ focusAddress: true });
    } else {
      focus();
    }
  });
  api.onOpenHistory?.(() => {
    openHistoryPanel();
  });
  api.onOpenDownloads?.(() => {
    const anchor = document.querySelector('[data-action="downloads"]');
    if (anchor) showDownloads(anchor);
  });
  api.onOpenCommandPalette?.(() => {
    openCommandPalette();
  });
  state = await api.getState();
  render();
}

void start();
