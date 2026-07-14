import { commands } from "../shared/channels.mjs";
import { splitPaneRects } from "../shared/layout.mjs";
import { displayNavigationUrl } from "../shared/navigation.mjs";

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
const popoverLayer = document.querySelector("#popover-layer");
const toastLayer = document.querySelector("#toast-layer");
const resizer = document.querySelector("#sidebar-resizer");
const textPrompt = document.querySelector("#text-prompt");
const textPromptForm = document.querySelector("#text-prompt-form");
const textPromptTitle = document.querySelector("#text-prompt-title");
const textPromptLabel = document.querySelector("#text-prompt-label");
const textPromptInput = document.querySelector("#text-prompt-input");
const textPromptCancel = document.querySelector("#text-prompt-cancel");
const textPromptSubmit = document.querySelector("#text-prompt-submit");
const splitDropOverlay = document.querySelector("#split-drop-overlay");
const splitDropLabel = document.querySelector("#split-drop-label");
const tabDragChip = document.querySelector("#tab-drag-chip");
const trafficLightButtons = [...document.querySelectorAll(".traffic-light")];

let state = null;
let addressDirty = false;
let selectedSuggestion = -1;
let suggestionItems = [];
let contextTabId = null;
let layoutFrame = 0;
let tabPointerDrag = null;
let dragTargetRow = null;
let dragSplitTargetId = null;
let dragSplitEdge = "right";
let dragIntent = "none";
let dragTargetId = null;
let dragPlacement = "before";
let suppressTabClick = false;
let addressWindowDrag = null;
let suppressAddressClick = false;
let sidebarOverlayCloseTimer = null;

const iconPaths = Object.freeze({
  back: '<path d="m15 5-7 7 7 7"/><path d="M8 12h11"/>',
  forward: '<path d="m9 5 7 7-7 7"/><path d="M5 12h11"/>',
  reload: '<path d="M19 8a8 8 0 1 0 .4 7"/><path d="M19 4v4h-4"/>',
  stop: '<path d="M7 7h10v10H7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  split: '<rect x="3" y="5" width="8" height="14" rx="2"/><rect x="13" y="5" width="8" height="14" rx="2"/>',
  splitColumn: '<rect x="5" y="3" width="14" height="8" rx="2"/><rect x="5" y="13" width="14" height="8" rx="2"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  folder: '<path d="M3 7.5h7l2 2h9v9.5H3z"/><path d="M3 7.5V5h7l2 2"/>',
  chevron: '<path d="m9 7 5 5-5 5"/>',
  collapse: '<path d="M4 5h16v14H4z"/><path d="M9 5v14"/><path d="m16 9-3 3 3 3"/>',
  expand: '<path d="M4 5h16v14H4z"/><path d="M9 5v14"/><path d="m13 9 3 3-3 3"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  volume: '<path d="M4 10v4h4l5 4V6l-5 4z"/><path d="M16 9c1.5 1.7 1.5 4.3 0 6"/>',
  muted: '<path d="M4 10v4h4l5 4V6l-5 4z"/><path d="m17 10 4 4m0-4-4 4"/>',
  pin: '<path d="m9 3 6 6"/><path d="m14 4 6 6-4 2-4 4-4-4 4-4z"/><path d="m9 15-5 5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/>',
  history: '<path d="M4 8V4m0 0h4"/><path d="M5 5a9 9 0 1 1-2 9"/><path d="M12 7v5l3 2"/>',
  tools: '<path d="m14 6 4-3 3 3-3 4"/><path d="M17 8 8 17l-1 4-4-4 4-1 9-9"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  space: '<path d="M4.7 13.5a7.5 7.5 0 1 0 11.8-7.1"/><path d="M3.1 8.6c-1.8 1.5-2.4 2.9-1.7 3.8 1.2 1.6 6.8-.1 12.4-3.8s9-8 7.8-9.6c-.6-.8-2.3-.7-4.5.1"/><path d="M18.4 8.8c3.1-.3 4.6.1 4.9 1 .5 1.6-3.1 4.3-8 6.1-4.9 1.8-9.3 2-9.8.4"/>',
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
    "split-row": "split",
    downloads: "download",
    "new-folder": "folder",
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
}

function render() {
  if (!state) return;
  const tab = activeTab();
  const workspace = activeWorkspace();
  const collapsed = Boolean(state.settings.sidebarCollapsed);
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
  renderTabs();
  renderWorkspaces();
  const toggle = document.querySelector('[data-action="toggle-sidebar"]');
  replaceTrustedMarkup(toggle, icon(collapsed ? "expand" : "collapse"));
  toggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";

  document.querySelector("#empty-state").hidden = Boolean(tab);
  if (document.activeElement === addressInput) updateAddressSuggestions();
  scheduleLayout();
  if (!isSidebarOverlay) updateSidebarOverlayBounds();
}

function renderEssentials() {
  const essentials = tabsForWorkspace().filter(tab => tab.essential);
  const grid = document.querySelector("#essentials-grid");
  replaceTrustedMarkup(
    grid,
    essentials
      .map(tab => `<button class="essential-item${tab.id === state.activeTabId ? " is-active" : ""}" data-action="select-tab" data-tab-id="${escapeHtml(tab.id)}" title="${escapeHtml(tab.title)}">${faviconMarkup(tab)}</button>`)
      .join("")
  );
}

function tabMarkup(tab) {
  const split = splitForTab(tab.id);
  const status = tab.audible || tab.muted
    ? `<button class="tab-status" data-action="toggle-mute" data-tab-id="${escapeHtml(tab.id)}" title="${tab.muted ? "Unmute" : "Mute"}">${icon(tab.muted ? "muted" : "volume")}</button>`
    : tab.crashed
      ? `<span class="tab-status" title="Tab crashed">!</span>`
      : "";
  return `<div class="tab-row" data-tab-id="${escapeHtml(tab.id)}">
    <div class="tab-item${tab.id === state.activeTabId ? " is-active" : ""}${split ? " is-split" : ""}" data-action="select-tab" data-tab-id="${escapeHtml(tab.id)}" role="tab" aria-selected="${tab.id === state.activeTabId}" tabindex="0">
      ${faviconMarkup(tab)}
      <span class="tab-copy">${escapeHtml(tab.title || "New Tab")}</span>
      <span class="tab-indicators">${status}<button class="tab-close" data-action="close-tab" data-tab-id="${escapeHtml(tab.id)}" title="Close tab">${icon("close")}</button></span>
    </div>
  </div>`;
}

function splitGroupMarkup(group, tabs) {
  const current = tabs.some(tab => tab.id === state.activeTabId) ? " is-current" : "";
  return `<div class="split-tab-group${current}" data-split-group-id="${escapeHtml(group.id)}" data-count="${tabs.length}" data-direction="${escapeHtml(group.direction || "row")}" role="group" aria-label="Split tabs">
    ${tabs.map(tabMarkup).join("")}
  </div>`;
}

function renderTabSequence(tabs, renderedSplitGroups) {
  const availableIds = new Set(
    tabsForWorkspace().filter(tab => !tab.essential).map(tab => tab.id)
  );
  const markup = [];
  for (const tab of tabs) {
    const group = splitForTab(tab.id);
    if (!group) {
      markup.push(tabMarkup(tab));
      continue;
    }
    if (renderedSplitGroups.has(group.id)) continue;
    renderedSplitGroups.add(group.id);
    const groupTabs = group.tabIds
      .filter(id => availableIds.has(id))
      .map(id => state.tabs.find(candidate => candidate.id === id))
      .filter(Boolean);
    markup.push(
      groupTabs.length > 1
        ? splitGroupMarkup(group, groupTabs)
        : groupTabs.map(tabMarkup).join("")
    );
  }
  return markup.join("");
}

function renderTabs() {
  const list = document.querySelector("#tabs-list");
  const tabs = tabsForWorkspace().filter(tab => !tab.essential);
  const folders = state.folders.filter(folder => folder.workspaceId === state.activeWorkspaceId);
  const folderTabIds = new Set(folders.flatMap(folder => folder.tabIds));
  const ungrouped = tabs.filter(tab => !folderTabIds.has(tab.id));
  const renderedSplitGroups = new Set();
  const folderMarkup = folders
    .map(folder => {
      const childTabs = folder.tabIds.map(id => tabs.find(tab => tab.id === id)).filter(Boolean);
      if (!childTabs.length) return "";
      return `<section class="folder${folder.expanded ? " is-expanded" : ""}" data-folder-id="${escapeHtml(folder.id)}">
        <button class="folder-header" data-action="toggle-folder" data-folder-id="${escapeHtml(folder.id)}">
          ${icon(folder.expanded ? "folder" : "folder")}
          <span class="folder-name">${escapeHtml(folder.name)}</span>
          <span class="folder-count">${childTabs.length}</span>
        </button>
        <div class="folder-tabs">${renderTabSequence(childTabs, renderedSplitGroups)}</div>
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
  replaceTrustedMarkup(
    switcher,
    state.workspaces
      .map(workspace => `<button class="workspace-dot${workspace.id === state.activeWorkspaceId ? " is-active" : ""}" data-action="select-workspace" data-workspace-id="${escapeHtml(workspace.id)}" title="${escapeHtml(workspace.name)}"><span class="workspace-dot-mark" style="--workspace-color:${escapeHtml(workspace.color)}"></span></button>`)
      .join("")
  );
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

function requestText({ title, label, value = "", submitLabel = "Save" }) {
  if (textPrompt.open) return Promise.resolve(null);
  textPromptTitle.textContent = title;
  textPromptLabel.textContent = label;
  textPromptInput.value = value;
  textPromptSubmit.textContent = submitLabel;
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
      const result = textPromptInput.value.trim();
      if (result) finish(result);
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

window.addEventListener("beforeunload", () => {
  api?.setChromeModalOpen(false);
  api?.setTabDragActive(false);
  api?.endWindowDrag();
});

function closePopover({ keepModalOpen = false } = {}) {
  const wasOpen = popoverLayer.childElementCount > 0;
  popoverLayer.replaceChildren();
  contextTabId = null;
  if (wasOpen && !keepModalOpen) api.setChromeModalOpen(false);
  if (wasOpen && !keepModalOpen) closeSidebarOverlaySoon();
}

function presentPopover(popover, tabId = null) {
  popoverLayer.replaceChildren(popover);
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
  replaceTrustedMarkup(popover, `<div class="popover-title">Spaces</div>${state.workspaces.map(workspace => `<button class="menu-item" data-action="select-workspace" data-workspace-id="${escapeHtml(workspace.id)}"><span class="workspace-dot-mark" style="--workspace-color:${escapeHtml(workspace.color)}"></span><span>${escapeHtml(workspace.name)}</span></button>`).join("")}<div class="menu-separator"></div><button class="menu-item" data-action="new-workspace">${icon("plus")}<span>New space</span></button><button class="menu-item" data-action="rename-workspace">${icon("tools")}<span>Rename current space</span></button>`);
  positionPopover(popover, anchor.getBoundingClientRect());
  presentPopover(popover);
}

function showDownloads(anchor) {
  const popover = document.createElement("div");
  popover.className = "popover";
  const downloads = state.downloads.slice(0, 8);
  replaceTrustedMarkup(popover, `<div class="popover-title">Downloads</div>${downloads.length ? downloads.map(download => {
    const percent = download.totalBytes > 0 ? Math.min(100, Math.round(download.receivedBytes / download.totalBytes * 100)) : 0;
    return `<div class="download-row"><div class="download-name">${escapeHtml(download.filename)}</div><div class="download-meta">${escapeHtml(download.state)}${download.totalBytes ? ` · ${percent}%` : ""}</div><div class="download-progress"><span style="width:${percent}%"></span></div></div>`;
  }).join("") : '<div class="download-row"><div class="download-meta">No downloads yet</div></div>'}`);
  positionPopover(popover, anchor.getBoundingClientRect());
  presentPopover(popover);
}

function showTabMenu(tabId, x, y) {
  const tab = state.tabs.find(item => item.id === tabId);
  if (!tab) return;
  const group = splitForTab(tabId);
  const popover = document.createElement("div");
  popover.className = "popover";
  replaceTrustedMarkup(popover, `<button class="menu-item" data-action="context-essential">${icon("pin")}<span>${tab.essential ? "Remove from Essentials" : "Add to Essentials"}</span></button><button class="menu-item" data-action="context-mute">${icon(tab.muted ? "volume" : "muted")}<span>${tab.muted ? "Unmute tab" : "Mute tab"}</span></button><button class="menu-item" data-action="context-folder">${icon("folder")}<span>Move to new folder</span></button><div class="menu-separator"></div>${group ? `<button class="menu-item" data-action="context-unsplit">${icon("grid")}<span>Exit split view</span></button>` : `<button class="menu-item" data-action="context-split-row">${icon("split")}<span>Split side by side</span></button><button class="menu-item" data-action="context-split-column">${icon("splitColumn")}<span>Split top and bottom</span></button>`}<button class="menu-item" data-action="context-devtools">${icon("tools")}<span>Developer tools</span></button><div class="menu-separator"></div><button class="menu-item" data-action="context-close">${icon("close")}<span>Close tab</span></button>`);
  const fakeRect = { left: x, right: x, top: y, bottom: y };
  positionPopover(popover, fakeRect);
  presentPopover(popover, tabId);
}

function updateAddressSuggestions() {
  if (!state || document.activeElement !== addressInput) {
    addressResults.hidden = true;
    return;
  }
  const query = addressInput.value.trim().toLowerCase();
  const seen = new Set();
  const history = [...state.history]
    .reverse()
    .filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return !query || item.url.toLowerCase().includes(query) || item.title.toLowerCase().includes(query);
    })
    .slice(0, 5)
    .map(item => ({ type: "history", title: item.title, url: item.url, value: item.url }));
  suggestionItems = query
    ? [{ type: "search", title: `Search for “${addressInput.value.trim()}”`, url: "Google Search", value: addressInput.value.trim() }, ...history]
    : history;
  selectedSuggestion = Math.min(selectedSuggestion, suggestionItems.length - 1);
  replaceTrustedMarkup(addressResults, suggestionItems
    .map((item, index) => `<button class="address-result${index === selectedSuggestion ? " is-selected" : ""}" data-action="address-suggestion" data-index="${index}">${icon(item.type === "history" ? "history" : "search")}<span class="address-result-copy"><div class="address-result-title">${escapeHtml(item.title)}</div><div class="address-result-url">${escapeHtml(item.url)}</div></span></button>`)
    .join(""));
  addressResults.hidden = !suggestionItems.length;
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

function renderPaneFrames(viewportRect) {
  const ids = visiblePaneIds();
  if (ids.length < 2) {
    replaceTrustedMarkup(paneFrameLayer, "");
    return;
  }
  const direction = splitForTab(state.activeTabId)?.direction || "row";
  const { frameRects } = splitPaneRects(
    { x: 0, y: 0, width: viewportRect.width, height: viewportRect.height },
    ids.length,
    direction
  );
  replaceTrustedMarkup(
    paneFrameLayer,
    frameRects.map((rect, index) => {
      const id = ids[index];
      const active = id === state.activeTabId ? " is-active" : "";
      return `<div class="pane-frame${active}" data-tab-id="${escapeHtml(id)}" style="left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px"></div>`;
    }).join("")
  );
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
    case "new-folder": {
      const name = await requestText({
        title: "New folder",
        label: "Folder name",
        value: "Folder",
        submitLabel: "Create",
      });
      if (name) await runCommand(commands.createFolder, { name });
      break;
    }
    case "toggle-folder":
      await runCommand(commands.toggleFolder, { id: element.dataset.folderId });
      break;
    case "toggle-sidebar":
      closePopover();
      await runCommand(commands.toggleSidebar);
      break;
    case "split-row":
      await runCommand(splitForTab(state.activeTabId) ? commands.unsplitActive : commands.splitActive, { direction: "row" });
      break;
    case "downloads":
      showDownloads(element);
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
    case "context-mute":
      await runCommand(commands.toggleMute, { id: contextTabId });
      closePopover();
      break;
    case "context-folder": {
      const folderTabId = contextTabId;
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
    case "context-split-row":
    case "context-split-column":
      if (contextTabId !== state.activeTabId) await runCommand(commands.selectTab, { id: contextTabId });
      await runCommand(commands.splitActive, { direction: action.endsWith("column") ? "column" : "row" });
      closePopover();
      break;
    case "context-unsplit":
      if (contextTabId !== state.activeTabId) await runCommand(commands.selectTab, { id: contextTabId });
      await runCommand(commands.unsplitActive);
      closePopover();
      break;
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
  if (event.target.closest(".tab-item")) return;
  if (event.target.closest("#tabs-scroll")) void runCommand(commands.createTab);
});

document.addEventListener("contextmenu", event => {
  const row = event.target.closest(".tab-row");
  if (!row) return;
  event.preventDefault();
  showTabMenu(row.dataset.tabId, event.clientX, event.clientY);
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
  dragSplitTargetId = state.activeTabId === sourceId
    ? [...tabsForWorkspace()]
        .filter(tab => tab.id !== sourceId)
        .sort((left, right) => right.lastActiveAt - left.lastActiveAt)[0]?.id || null
    : state.activeTabId;
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

  const viewportBounds = viewportElement.getBoundingClientRect();
  const overViewport =
    event.clientX >= viewportBounds.left &&
    event.clientX <= viewportBounds.right &&
    event.clientY >= viewportBounds.top &&
    event.clientY <= viewportBounds.bottom;
  if (overViewport && session.sourceGroupId) {
    clearTabDropTarget();
    dragTargetId = null;
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
    dragPlacement = "after";
    updateTabDragChip(event, "split-swap", "Swap split tabs");
    return;
  }
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".tab-row");
  if (!row || row.dataset.tabId === session.sourceId) {
    clearTabDropTarget();
    dragTargetId = null;
    dragPlacement = "before";
    const sidebarBounds = sidebarElement.getBoundingClientRect();
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
  const session = tabPointerDrag;
  if (!session || event.pointerId !== session.pointerId) return;
  const wasDragging = session.started;
  const dropIntent = dragIntent;
  const splitTargetId = dropIntent === "split-page" ? dragSplitTargetId : null;
  const splitEdge = dragSplitEdge;
  const pointerTargetId = dragTargetId;
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
    });
  } else if (dropIntent === "detach-folder") {
    void runCommand(commands.detachSplitTab, {
      id: session.sourceId,
      targetId: pointerTargetId,
      position: pointerPlacement,
      moveToEnd: !pointerTargetId,
    });
  } else if (dropIntent === "folder-move") {
    void runCommand(commands.reorderTab, {
      id: session.sourceId,
      targetId: pointerTargetId,
      position: pointerPlacement,
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
    });
  }
});

document.addEventListener("pointercancel", event => {
  if (tabPointerDrag?.pointerId === event.pointerId) finishTabPointerDrag();
});
appElement.addEventListener("lostpointercapture", event => {
  if (tabPointerDrag?.pointerId === event.pointerId) finishTabPointerDrag();
});
window.addEventListener("blur", () => {
  if (tabPointerDrag) finishTabPointerDrag();
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
  if (event.button !== 0 || addressWindowDrag) return;
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

addressInput.addEventListener("focus", () => {
  addressDirty = false;
  addressInput.select();
  selectedSuggestion = -1;
  updateAddressSuggestions();
});

addressInput.addEventListener("input", () => {
  addressDirty = true;
  selectedSuggestion = -1;
  updateAddressSuggestions();
});

addressInput.addEventListener("keydown", event => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!suggestionItems.length) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    selectedSuggestion = (selectedSuggestion + delta + suggestionItems.length) % suggestionItems.length;
    updateAddressSuggestions();
  } else if (event.key === "Escape") {
    addressInput.blur();
    addressResults.hidden = true;
    addressDirty = false;
    render();
  }
});

addressInput.addEventListener("blur", () => {
  setTimeout(() => {
    addressResults.hidden = true;
    addressDirty = false;
    render();
  }, 120);
});

document.addEventListener("keydown", event => {
  const modifier = navigator.platform.includes("Mac") ? event.metaKey : event.ctrlKey;
  const key = event.key.toLowerCase();
  if (event.key === "Escape") {
    closePopover();
    if (isSidebarOverlay && !textPrompt.open) {
      api.updateSidebarOverlay({ open: false });
    }
    return;
  }
  if (!modifier) return;
  if (key === "l") {
    event.preventDefault();
    if (state.settings.sidebarCollapsed && !isSidebarOverlay) {
      openSidebarOverlay({ focusAddress: true });
    } else {
      addressInput.focus();
    }
  } else if (key === "t" && event.shiftKey) {
    event.preventDefault();
    void runCommand(commands.reopenTab);
  } else if (key === "t") {
    event.preventDefault();
    void runCommand(commands.createTab);
  } else if (key === "w") {
    event.preventDefault();
    void runCommand(commands.closeTab, { id: state.activeTabId });
  } else if (key === "r") {
    event.preventDefault();
    void runCommand(commands.reload, { id: state.activeTabId });
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
  state = await api.getState();
  render();
}

void start();
