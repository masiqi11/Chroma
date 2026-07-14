import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  Menu,
  WebContentsView,
  clipboard,
  dialog,
  shell,
  screen,
  webContents,
} from "electron";

import { commands } from "../shared/channels.mjs";
import { splitPaneRects } from "../shared/layout.mjs";
import {
  isSafePageUrl,
  normalizeNavigationInput,
} from "../shared/navigation.mjs";
import { normalizeWorkspaceColor } from "../shared/model.mjs";
import { installInternalProtocol } from "./internal-pages.mjs";

const MAX_CLOSED_TABS = 25;
const MAX_HISTORY_ITEMS = 1000;
const SIDEBAR_OVERLAY_INSET = 5;
const SIDEBAR_OVERLAY_SHADOW_SPACE = 10;
const SIDEBAR_OVERLAY_ANIMATION_MS = 170;
const SIDEBAR_OVERLAY_URL = new URL(
  "../renderer/index.html?mode=sidebar-overlay",
  import.meta.url
).href;
const SHELL_PRELOAD_PATH = fileURLToPath(
  new URL("../preload/shell-preload.cjs", import.meta.url)
);
const ADAPTIVE_LAYOUT_DELAY_MS = 160;
const ADAPTIVE_LAYOUT_MAX_WIDTH = 960;
const ADAPTIVE_OVERFLOW_RATIO = 1.28;
const ADAPTIVE_OVERFLOW_PIXELS = 160;
const ALLOWED_PERMISSIONS = new Set([
  "media",
  "geolocation",
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
]);

function activeModifier(input) {
  return process.platform === "darwin" ? input.meta : input.control;
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length < 200;
}

function safeTitle(title, fallback = "New Tab") {
  const value = String(title || "").trim();
  return (value || fallback).slice(0, 500);
}

function withoutElectronUserAgent(userAgent) {
  return String(userAgent || "").replace(/\sElectron\/[\d.]+/i, "");
}

function mobileUserAgent() {
  return [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8)",
    "AppleWebKit/537.36 (KHTML, like Gecko)",
    `Chrome/${process.versions.chrome} Mobile Safari/537.36`,
  ].join(" ");
}

function isWebPageUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function tabSnapshot(tab) {
  return {
    id: tab.id,
    workspaceId: tab.workspaceId,
    url: tab.url,
    title: tab.title,
    favicon: tab.favicon,
    essential: tab.essential,
    pinned: tab.pinned,
    muted: tab.muted,
    lastActiveAt: tab.lastActiveAt,
  };
}

export class BrowserController {
  #window;
  #store;
  #state;
  #views = new Map();
  #viewReady = new Map();
  #navigationVersions = new Map();
  #adaptiveViews = new Map();
  #desktopUserAgent = "";
  #mobileUserAgent = mobileUserAgent();
  #contentBounds = null;
  #closedTabs = [];
  #configuredSessions = new WeakSet();
  #chromeModalOpen = false;
  #chromeModalUsesOverlay = false;
  #tabDragActive = false;
  #tabDragUsesOverlay = false;
  #sidebarOverlayView = null;
  #sidebarOverlayBounds = null;
  #sidebarOverlayOpen = false;
  #sidebarOverlayReady = false;
  #sidebarOverlayFocusAddressPending = false;
  #sidebarOverlayKeepOpen = false;
  #sidebarOverlayHideTimer = null;
  #sidebarOverlayPointerTimer = null;
  #sidebarOverlayOutsideSince = 0;
  #registerShellWebContents;
  #unregisterShellWebContents;
  #acceptCommands = true;
  #commandQueue = Promise.resolve();
  #destroyPromise = null;
  #destroying = false;

  constructor(
    browserWindow,
    state,
    stateStore,
    {
      registerShellWebContents = () => {},
      unregisterShellWebContents = () => {},
    } = {}
  ) {
    this.#window = browserWindow;
    this.#state = state;
    this.#store = stateStore;
    this.#registerShellWebContents = registerShellWebContents;
    this.#unregisterShellWebContents = unregisterShellWebContents;
  }

  get state() {
    return this.#state;
  }

  async initialize() {
    for (const tab of this.#state.tabs) {
      if (!this.#views.has(tab.id)) this.#createView(tab);
    }
    this.#createSidebarOverlay();
    this.#syncVisibleViews();
    this.#notify(false);
  }

  getPublicState() {
    const liveWebContents = webContents
      .getAllWebContents()
      .filter(contents => !contents.isDestroyed());
    return {
      ...structuredClone(this.#state),
      runtime: {
        chromiumVersion: process.versions.chrome,
        electronVersion: process.versions.electron,
        platform: process.platform,
        managedViewCount: this.#views.size,
        liveWebContentsCount: liveWebContents.length,
        chromeModalOpen: this.#chromeModalOpen,
        tabDragActive: this.#tabDragActive,
        sidebarOverlayOpen: this.#sidebarOverlayOpen,
        sidebarOverlayVisible: Boolean(this.#sidebarOverlayView?.getVisible()),
        sidebarOverlayReady: this.#sidebarOverlayReady,
        sidebarOverlayBounds: this.#sidebarOverlayView
          ? this.#sidebarOverlayView.getBounds()
          : null,
        ...(process.env.CHROMA_HEADLESS_SMOKE === "1"
          ? {
              windowBounds: this.#window.getBounds(),
              contentBounds: this.#contentBounds
                ? { ...this.#contentBounds }
                : null,
              viewBounds: Object.fromEntries(
                [...this.#views].map(([id, view]) => [id, view.getBounds()])
              ),
            }
          : {}),
      },
    };
  }

  async getSmokeViewports() {
    if (process.env.CHROMA_HEADLESS_SMOKE !== "1") {
      throw new Error("Viewport diagnostics are only available during smoke tests");
    }
    const entries = await Promise.all(
      [...this.#views].map(async ([id, view]) => {
        const bounds = view.getBounds();
        const contents = view.webContents;
        if (contents.isDestroyed()) return [id, { bounds, destroyed: true }];
        try {
          const viewport = await contents.executeJavaScript(`({
            width: innerWidth,
            height: innerHeight,
            visibilityState: document.visibilityState,
            resizeCount: Number(globalThis.__chromaSmokeResizeCount || 0),
            scrollWidth: Math.max(
              document.documentElement?.scrollWidth || 0,
              document.body?.scrollWidth || 0
            ),
            splitFitZoom: Number.parseFloat(
              getComputedStyle(document.documentElement).zoom || "1"
            ) || 1,
            userAgent: navigator.userAgent,
            hasViewportMeta: Boolean(
              document.querySelector('meta[name="viewport" i]')
            ),
            layoutMode:
              document.documentElement?.dataset?.chromaSmokeLayout || "",
            bodyFontSize: Number.parseFloat(
              getComputedStyle(document.body || document.documentElement).fontSize
            ) || 0
          })`);
          return [id, {
            bounds,
            nativeVisible: view.getVisible(),
            url: contents.getURL(),
            adaptiveMode: this.#adaptiveViews.get(id)?.mode || "desktop",
            adaptivePendingMode: this.#adaptiveViews.get(id)?.pending?.mode || null,
            pageZoomFactor: contents.getZoomFactor(),
            ...viewport,
            destroyed: false,
          }];
        } catch {
          return [id, { bounds, unavailable: true, destroyed: contents.isDestroyed() }];
        }
      })
    );
    return Object.fromEntries(entries);
  }

  dispatch(command, payload = {}) {
    if (!this.#acceptCommands) {
      return Promise.reject(new Error("Browser window is closing"));
    }
    const operation = this.#commandQueue.then(() => this.#dispatchNow(command, payload));
    this.#commandQueue = operation.catch(() => {});
    return operation;
  }

  #dispatchNow(command, payload) {
    switch (command) {
      case commands.createTab:
        return this.createTab(payload);
      case commands.selectTab:
        return this.selectTab(payload.id);
      case commands.closeTab:
        return this.closeTab(payload.id);
      case commands.reopenTab:
        return this.reopenClosedTab();
      case commands.reorderTab:
        return this.reorderTab(
          payload.id,
          payload.targetId || payload.beforeId || null,
          payload.position
        );
      case commands.navigate:
        return this.navigate(payload.id, payload.input);
      case commands.back:
        return this.goBack(payload.id);
      case commands.forward:
        return this.goForward(payload.id);
      case commands.reload:
        return this.reload(payload.id);
      case commands.stop:
        return this.stop(payload.id);
      case commands.toggleMute:
        return this.toggleMute(payload.id);
      case commands.toggleEssential:
        return this.toggleEssential(payload.id);
      case commands.createWorkspace:
        return this.createWorkspace(payload);
      case commands.selectWorkspace:
        return this.selectWorkspace(payload.id);
      case commands.renameWorkspace:
        return this.renameWorkspace(payload.id, payload.name);
      case commands.splitActive:
        return this.splitActive(payload.direction);
      case commands.splitTabs:
        return this.splitTabs(
          payload.sourceId,
          payload.targetId,
          payload.direction,
          payload.placement
        );
      case commands.detachSplitTab:
        return this.detachSplitTab(
          payload.id,
          payload.targetId || null,
          payload.position,
          payload.moveToEnd === true
        );
      case commands.unsplitActive:
        return this.unsplitActive();
      case commands.createFolder:
        return this.createFolder(payload);
      case commands.toggleFolder:
        return this.toggleFolder(payload.id);
      case commands.toggleSidebar:
        return this.toggleSidebar();
      case commands.setSidebarWidth:
        return this.setSidebarWidth(payload.width);
      case commands.openDevTools:
        return this.openDevTools(payload.id);
      default:
        throw new Error(`Unsupported browser command: ${command}`);
    }
  }

  setContentBounds(bounds) {
    if (!bounds || typeof bounds !== "object") return;
    const windowBounds = this.#window.getContentBounds();
    const next = {
      x: Math.max(0, Math.round(Number(bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(1, Math.round(Number(bounds.width) || 1)),
      height: Math.max(1, Math.round(Number(bounds.height) || 1)),
    };
    next.width = Math.min(next.width, Math.max(1, windowBounds.width - next.x));
    next.height = Math.min(next.height, Math.max(1, windowBounds.height - next.y));
    this.#contentBounds = next;
    this.#syncVisibleViews();
  }

  updateSidebarOverlay(options = {}) {
    if (!options || typeof options !== "object") return false;
    if (options.bounds && typeof options.bounds === "object") {
      const windowBounds = this.#window.getContentBounds();
      const x = Math.max(0, Math.round(Number(options.bounds.x) || 0));
      const y = Math.max(0, Math.round(Number(options.bounds.y) || 0));
      this.#sidebarOverlayBounds = {
        x,
        y,
        width: Math.max(
          1,
          Math.min(
            Math.round(Number(options.bounds.width) || 1),
            Math.max(1, windowBounds.width - x)
          )
        ),
        height: Math.max(
          1,
          Math.min(
            Math.round(Number(options.bounds.height) || 1),
            Math.max(1, windowBounds.height - y)
          )
        ),
      };
    }
    if (typeof options.open === "boolean") {
      this.#sidebarOverlayOpen = options.open && this.#state.settings.sidebarCollapsed;
    }
    if (options.focusAddress === true) {
      this.#sidebarOverlayOpen = this.#state.settings.sidebarCollapsed;
      this.#sidebarOverlayFocusAddressPending = this.#sidebarOverlayOpen;
    }
    if (typeof options.keepOpen === "boolean") {
      this.#sidebarOverlayKeepOpen = options.keepOpen &&
        this.#state.settings.sidebarCollapsed;
    }
    this.#syncSidebarOverlay();
    return true;
  }

  focusAddress() {
    if (this.#state.settings.sidebarCollapsed) {
      this.updateSidebarOverlay({ open: true, focusAddress: true });
      return;
    }
    if (!this.#window.webContents.isDestroyed()) {
      this.#window.webContents.send("chroma:focus-address");
    }
  }

  windowControl(action) {
    if (this.#window.isDestroyed()) return false;
    if (action === "close") {
      this.#window.close();
      return true;
    }
    if (action === "minimize") {
      this.#window.minimize();
      return true;
    }
    if (action === "maximize") {
      if (this.#window.isMaximized()) this.#window.unmaximize();
      else this.#window.maximize();
      return true;
    }
    return false;
  }

  setChromeModalOpen(open, usesOverlay = false) {
    this.#chromeModalOpen = open === true;
    this.#chromeModalUsesOverlay = this.#chromeModalOpen && usesOverlay === true;
    this.#syncVisibleViews();
  }

  setTabDragActive(active, usesOverlay = false) {
    this.#tabDragActive = active === true;
    this.#tabDragUsesOverlay = this.#tabDragActive && usesOverlay === true;
    this.#syncVisibleViews();
  }

  async createTab({
    url = "chroma://newtab/",
    workspaceId = this.#state.activeWorkspaceId,
    activate = true,
    essential = false,
    pinned = false,
  } = {}) {
    const workspace = this.#workspace(workspaceId) || this.#activeWorkspace();
    const normalizedUrl = isSafePageUrl(url)
      ? new URL(url).href
      : normalizeNavigationInput(url);
    const tab = {
      id: randomUUID(),
      workspaceId: workspace.id,
      url: normalizedUrl,
      title: normalizedUrl.startsWith("chroma://newtab") ? "New Tab" : "Loading…",
      favicon: "",
      essential: Boolean(essential),
      pinned: Boolean(pinned),
      muted: false,
      audible: false,
      loading: true,
      crashed: false,
      canGoBack: false,
      canGoForward: false,
      lastActiveAt: Date.now(),
    };
    this.#state.tabs.push(tab);
    this.#createView(tab);
    if (activate) {
      this.#state.activeWorkspaceId = workspace.id;
      this.#state.activeTabId = tab.id;
    }
    this.#commit();
    if (activate) this.#focusTab(tab.id);
    return tab.id;
  }

  selectTab(id) {
    const tab = this.#tab(id);
    if (!tab) return false;
    this.#state.activeWorkspaceId = tab.workspaceId;
    this.#state.activeTabId = tab.id;
    tab.lastActiveAt = Date.now();
    this.#commit();
    this.#focusTab(tab.id);
    return true;
  }

  async closeTab(id = this.#state.activeTabId) {
    const tab = this.#tab(id);
    if (!tab) return false;

    this.#closedTabs.unshift(tabSnapshot(tab));
    this.#closedTabs.length = Math.min(this.#closedTabs.length, MAX_CLOSED_TABS);
    this.#removeTabFromFoldersAndSplits(tab.id);
    this.#state.tabs = this.#state.tabs.filter(item => item.id !== tab.id);
    await this.#destroyView(tab.id);

    const remaining = this.#tabsForWorkspace(tab.workspaceId);
    if (!remaining.length) {
      const replacementId = await this.createTab({
        workspaceId: tab.workspaceId,
        activate: tab.workspaceId === this.#state.activeWorkspaceId,
      });
      if (this.#state.activeTabId === tab.id) this.#state.activeTabId = replacementId;
    } else if (this.#state.activeTabId === tab.id) {
      const next = remaining.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      this.#state.activeTabId = next.id;
    }

    this.#commit();
    this.#focusTab(this.#state.activeTabId);
    return true;
  }

  async reopenClosedTab() {
    const snapshot = this.#closedTabs.shift();
    if (!snapshot) return null;
    return this.createTab({
      url: snapshot.url,
      workspaceId: this.#workspace(snapshot.workspaceId)
        ? snapshot.workspaceId
        : this.#state.activeWorkspaceId,
      activate: true,
      essential: snapshot.essential,
      pinned: snapshot.pinned,
    });
  }

  reorderTab(id, targetId = null, position = "before") {
    if (!this.#reorderTabState(id, targetId, position)) return false;
    this.#commit();
    return true;
  }

  #reorderTabState(id, targetId = null, position = "before") {
    const tab = this.#tab(id);
    const target = targetId ? this.#tab(targetId) : null;
    if (!tab || (target && (
      target.workspaceId !== tab.workspaceId ||
      target.id === tab.id
    ))) {
      return false;
    }
    const insertion = position === "after" ? "after" : "before";
    const targetFolderId = target
      ? this.#state.folders.find(folder => folder.tabIds.includes(target.id))?.id
      : null;
    for (const folder of this.#state.folders) {
      folder.tabIds = folder.tabIds.filter(tabId => tabId !== tab.id);
    }
    this.#state.folders = this.#state.folders.filter(folder => folder.tabIds.length);
    const targetFolder = targetFolderId
      ? this.#state.folders.find(folder => folder.id === targetFolderId)
      : null;
    if (targetFolder && target) {
      const targetIndex = targetFolder.tabIds.indexOf(target.id);
      targetFolder.tabIds.splice(
        insertion === "after" ? targetIndex + 1 : targetIndex,
        0,
        tab.id
      );
      targetFolder.expanded = true;
    }

    const workspaceIndexes = [];
    const ordered = [];
    this.#state.tabs.forEach((item, index) => {
      if (item.workspaceId === tab.workspaceId) {
        workspaceIndexes.push(index);
        ordered.push(item);
      }
    });
    const from = ordered.findIndex(item => item.id === id);
    if (from < 0) return false;
    const [moved] = ordered.splice(from, 1);
    const targetIndex = target ? ordered.findIndex(item => item.id === target.id) : -1;
    const insertionIndex = targetIndex < 0
      ? ordered.length
      : targetIndex + (insertion === "after" ? 1 : 0);
    ordered.splice(insertionIndex, 0, moved);
    workspaceIndexes.forEach((stateIndex, index) => {
      this.#state.tabs[stateIndex] = ordered[index];
    });
    return true;
  }

  navigate(id = this.#state.activeTabId, input) {
    const view = this.#viewFor(id);
    const tab = this.#tab(id);
    if (!view || !tab) return false;
    const url = normalizeNavigationInput(input);
    const version = (this.#navigationVersions.get(id) || 0) + 1;
    this.#navigationVersions.set(id, version);
    this.#prepareAdaptiveExplicitNavigation(id, view, url);
    tab.url = url;
    tab.title = url.startsWith("chroma://newtab") ? "New Tab" : "Loading…";
    tab.loading = true;
    tab.crashed = false;
    this.#commit();
    this.#queueViewNavigation(tab, view, url, version, "Navigation failed:");
    return true;
  }

  goBack(id = this.#state.activeTabId) {
    const view = this.#viewFor(id);
    const contents = view?.webContents;
    if (!contents?.navigationHistory.canGoBack()) return false;
    this.#prepareAdaptiveUserNavigation(id, view);
    contents.navigationHistory.goBack();
    return true;
  }

  goForward(id = this.#state.activeTabId) {
    const view = this.#viewFor(id);
    const contents = view?.webContents;
    if (!contents?.navigationHistory.canGoForward()) return false;
    this.#prepareAdaptiveUserNavigation(id, view);
    contents.navigationHistory.goForward();
    return true;
  }

  reload(id = this.#state.activeTabId) {
    const view = this.#viewFor(id);
    const contents = view?.webContents;
    if (!contents) return false;
    this.#prepareAdaptiveUserNavigation(id, view);
    contents.reload();
    return true;
  }

  stop(id = this.#state.activeTabId) {
    const view = this.#viewFor(id);
    const contents = view?.webContents;
    if (!contents) return false;
    this.#suppressAdaptiveAfterUserStop(id, view);
    contents.stop();
    return true;
  }

  toggleMute(id = this.#state.activeTabId) {
    const tab = this.#tab(id);
    const contents = this.#viewFor(id)?.webContents;
    if (!tab || !contents) return false;
    tab.muted = !contents.isAudioMuted();
    contents.setAudioMuted(tab.muted);
    this.#commit();
    return tab.muted;
  }

  toggleEssential(id = this.#state.activeTabId) {
    const tab = this.#tab(id);
    if (!tab) return false;
    tab.essential = !tab.essential;
    if (tab.essential) tab.pinned = true;
    this.#commit();
    return tab.essential;
  }

  async createWorkspace({ name, icon, color } = {}) {
    const palette = ["#e4a8ff", "#8dd7ff", "#a9e6bd", "#ffd28f", "#ff9fba"];
    const workspace = {
      id: randomUUID(),
      name: safeTitle(name, `Space ${this.#state.workspaces.length + 1}`).slice(0, 80),
      icon: validId(icon) ? icon : "sparkles",
      color: normalizeWorkspaceColor(
        color,
        palette[this.#state.workspaces.length % palette.length]
      ),
    };
    this.#state.workspaces.push(workspace);
    this.#state.activeWorkspaceId = workspace.id;
    const tabId = await this.createTab({ workspaceId: workspace.id, activate: true });
    this.#state.activeTabId = tabId;
    this.#commit();
    return workspace.id;
  }

  selectWorkspace(id) {
    const workspace = this.#workspace(id);
    if (!workspace) return false;
    this.#state.activeWorkspaceId = workspace.id;
    const tabs = this.#tabsForWorkspace(workspace.id);
    const selected = tabs.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (selected) {
      this.#state.activeTabId = selected.id;
      selected.lastActiveAt = Date.now();
    }
    this.#commit();
    this.#focusTab(this.#state.activeTabId);
    return true;
  }

  renameWorkspace(id, name) {
    const workspace = this.#workspace(id);
    const value = String(name || "").trim();
    if (!workspace || !value) return false;
    workspace.name = value.slice(0, 80);
    this.#commit();
    return true;
  }

  async splitActive(direction = "row") {
    const active = this.#tab(this.#state.activeTabId);
    if (!active) return null;
    const existing = this.#splitForTab(active.id);
    if (existing && existing.tabIds.length >= 4) return existing.id;
    const newTabId = await this.createTab({
      workspaceId: active.workspaceId,
      activate: false,
    });
    if (existing) {
      existing.tabIds.push(newTabId);
      existing.direction = existing.tabIds.length > 2 ? "grid" : direction;
    } else {
      this.#state.splitGroups.push({
        id: randomUUID(),
        workspaceId: active.workspaceId,
        direction: ["row", "column"].includes(direction) ? direction : "row",
        tabIds: [active.id, newTabId],
      });
    }
    this.#state.activeTabId = newTabId;
    this.#commit();
    this.#focusTab(newTabId);
    return newTabId;
  }

  splitTabs(sourceId, targetId, direction = "row", placement = "after") {
    const source = this.#tab(sourceId);
    const target = this.#tab(targetId);
    if (
      !source ||
      !target ||
      source.id === target.id ||
      source.workspaceId !== target.workspaceId
    ) {
      return false;
    }

    const sourceGroup = this.#splitForTab(source.id);
    const targetGroup = this.#splitForTab(target.id);
    if (sourceGroup && targetGroup && sourceGroup.id === targetGroup.id) {
      const sourceIndex = sourceGroup.tabIds.indexOf(source.id);
      const targetIndex = sourceGroup.tabIds.indexOf(target.id);
      [sourceGroup.tabIds[sourceIndex], sourceGroup.tabIds[targetIndex]] = [
        sourceGroup.tabIds[targetIndex],
        sourceGroup.tabIds[sourceIndex],
      ];
      this.#state.activeWorkspaceId = source.workspaceId;
      this.#state.activeTabId = source.id;
      source.lastActiveAt = Date.now();
      this.#commit();
      this.#focusTab(source.id);
      return sourceGroup.id;
    }
    if (targetGroup && targetGroup.tabIds.length >= 4) return false;

    if (sourceGroup) {
      sourceGroup.tabIds = sourceGroup.tabIds.filter(id => id !== source.id);
      if (sourceGroup.tabIds.length < 2) {
        this.#state.splitGroups = this.#state.splitGroups.filter(
          group => group.id !== sourceGroup.id
        );
        for (const remainingId of sourceGroup.tabIds) {
          const remainingView = this.#viewFor(remainingId);
          if (remainingView) {
            this.#restoreDesktopLayout(remainingId, remainingView);
          }
        }
      } else if (
        sourceGroup.direction === "grid" &&
        sourceGroup.tabIds.length === 2
      ) {
        sourceGroup.direction = "row";
      }
    }

    let group = targetGroup;
    if (group) {
      const targetIndex = group.tabIds.indexOf(target.id);
      const insertAt = placement === "before" ? targetIndex : targetIndex + 1;
      group.tabIds.splice(insertAt, 0, source.id);
      if (group.tabIds.length > 2) group.direction = "grid";
    } else {
      group = {
        id: randomUUID(),
        workspaceId: target.workspaceId,
        direction: ["row", "column"].includes(direction) ? direction : "row",
        tabIds: placement === "before"
          ? [source.id, target.id]
          : [target.id, source.id],
      };
      this.#state.splitGroups.push(group);
    }

    this.#state.activeWorkspaceId = source.workspaceId;
    this.#state.activeTabId = source.id;
    source.lastActiveAt = Date.now();
    this.#commit();
    this.#focusTab(source.id);
    return group.id;
  }

  detachSplitTab(id, targetId = null, position = "before", moveToEnd = false) {
    const tab = this.#tab(id);
    const group = tab ? this.#splitForTab(tab.id) : null;
    if (!tab || !group) return false;

    const remainingIds = group.tabIds.filter(tabId => tabId !== tab.id);
    group.tabIds = remainingIds;
    if (remainingIds.length < 2) {
      this.#state.splitGroups = this.#state.splitGroups.filter(
        item => item.id !== group.id
      );
      for (const remainingId of remainingIds) {
        const remainingView = this.#viewFor(remainingId);
        if (remainingView) this.#restoreDesktopLayout(remainingId, remainingView);
      }
    } else if (group.direction === "grid" && remainingIds.length === 2) {
      group.direction = "row";
    }

    const view = this.#viewFor(tab.id);
    if (view) this.#restoreDesktopLayout(tab.id, view);
    if (targetId && targetId !== tab.id) {
      this.#reorderTabState(tab.id, targetId, position);
    } else if (moveToEnd) {
      this.#reorderTabState(tab.id, null, "after");
    }

    this.#state.activeWorkspaceId = tab.workspaceId;
    this.#state.activeTabId = tab.id;
    tab.lastActiveAt = Date.now();
    this.#commit();
    this.#focusTab(tab.id);
    return true;
  }

  unsplitActive() {
    const group = this.#splitForTab(this.#state.activeTabId);
    if (!group) return false;
    this.#state.splitGroups = this.#state.splitGroups.filter(item => item.id !== group.id);
    for (const id of group.tabIds) {
      const view = this.#viewFor(id);
      if (view) this.#restoreDesktopLayout(id, view);
    }
    this.#commit();
    return true;
  }

  createFolder({ name = "Folder", tabIds = [this.#state.activeTabId] } = {}) {
    const usableTabIds = [...new Set(tabIds)]
      .filter(id => {
        const tab = this.#tab(id);
        return tab?.workspaceId === this.#state.activeWorkspaceId && !tab.essential;
      });
    if (!usableTabIds.length) return null;
    for (const folder of this.#state.folders) {
      folder.tabIds = folder.tabIds.filter(id => !usableTabIds.includes(id));
    }
    const folder = {
      id: randomUUID(),
      workspaceId: this.#state.activeWorkspaceId,
      name: safeTitle(name, "Folder").slice(0, 80),
      tabIds: usableTabIds,
      expanded: true,
    };
    this.#state.folders.push(folder);
    this.#commit();
    return folder.id;
  }

  toggleFolder(id) {
    const folder = this.#state.folders.find(item => item.id === id);
    if (!folder) return false;
    folder.expanded = !folder.expanded;
    this.#commit();
    return folder.expanded;
  }

  toggleSidebar() {
    this.#state.settings.sidebarCollapsed = !this.#state.settings.sidebarCollapsed;
    if (!this.#state.settings.sidebarCollapsed) {
      this.#sidebarOverlayOpen = false;
      this.#sidebarOverlayFocusAddressPending = false;
    }
    this.#commit();
    return this.#state.settings.sidebarCollapsed;
  }

  setSidebarWidth(width) {
    const value = Number(width);
    if (!Number.isFinite(value)) return false;
    this.#state.settings.sidebarWidth = Math.max(220, Math.min(500, Math.round(value)));
    this.#commit();
    return true;
  }

  openDevTools(id = this.#state.activeTabId) {
    const contents = this.#viewFor(id)?.webContents;
    if (!contents) return false;
    contents.openDevTools({ mode: "detach" });
    return true;
  }

  destroy() {
    if (this.#destroyPromise) return this.#destroyPromise;
    this.#acceptCommands = false;
    this.#destroying = true;
    this.#clearSidebarOverlayHideTimer();
    this.#stopSidebarOverlayPointerWatch();
    for (const id of this.#adaptiveViews.keys()) {
      this.#cancelAdaptiveProbe(id, true);
    }
    this.#destroyPromise = (async () => {
      await this.#commandQueue;
      await Promise.all([...this.#views.keys()].map(id => this.#destroyView(id)));
      await this.#destroySidebarOverlay();
      await this.#store.flush(this.#state);
    })();
    return this.#destroyPromise;
  }

  #createSidebarOverlay() {
    if (this.#sidebarOverlayView || this.#destroying) return;
    const view = new WebContentsView({
      webPreferences: {
        preload: SHELL_PRELOAD_PATH,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        transparent: true,
      },
    });
    const contents = view.webContents;
    const contentsId = contents.id;
    view.setVisible(false);
    view.setBackgroundColor("#00000000");
    this.#sidebarOverlayView = view;
    this.#window.contentView.addChildView(view);
    this.#registerShellWebContents(contents);

    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", event => event.preventDefault());
    contents.on("preload-error", (_event, preloadPath, error) => {
      console.error(`Sidebar overlay preload failed (${preloadPath}):`, error);
    });
    contents.on("console-message", event => {
      if (event?.level === "error") {
        console.error("Sidebar overlay renderer:", event.message);
      }
    });
    contents.on("did-finish-load", () => {
      if (this.#destroying || contents.isDestroyed()) return;
      this.#sidebarOverlayReady = true;
      contents.send("chroma:state-changed", this.getPublicState());
      this.#syncSidebarOverlay();
    });
    contents.once("destroyed", () => {
      this.#unregisterShellWebContents(contentsId);
      if (this.#sidebarOverlayView === view) {
        this.#stopSidebarOverlayPointerWatch();
        this.#sidebarOverlayView = null;
        this.#sidebarOverlayReady = false;
      }
    });
    void contents.loadURL(SIDEBAR_OVERLAY_URL).catch(error => {
      if (!this.#destroying && !contents.isDestroyed()) {
        console.warn("Unable to load the sidebar overlay:", error);
      }
    });
  }

  #defaultSidebarOverlayBounds() {
    const windowBounds = this.#window.getContentBounds();
    const x = 0;
    const y = 0;
    return {
      x,
      y,
      width: Math.max(
        1,
        Math.min(
          this.#state.settings.sidebarWidth +
            SIDEBAR_OVERLAY_INSET +
            SIDEBAR_OVERLAY_SHADOW_SPACE,
          windowBounds.width - x
        )
      ),
      height: Math.max(1, windowBounds.height),
    };
  }

  #sidebarOverlayOffscreenBounds(bounds) {
    return {
      ...bounds,
      x: -bounds.width,
    };
  }

  #clearSidebarOverlayHideTimer() {
    if (!this.#sidebarOverlayHideTimer) return;
    clearTimeout(this.#sidebarOverlayHideTimer);
    this.#sidebarOverlayHideTimer = null;
  }

  #stopSidebarOverlayPointerWatch() {
    if (this.#sidebarOverlayPointerTimer) {
      clearInterval(this.#sidebarOverlayPointerTimer);
      this.#sidebarOverlayPointerTimer = null;
    }
    this.#sidebarOverlayOutsideSince = 0;
  }

  #startSidebarOverlayPointerWatch() {
    if (
      this.#sidebarOverlayPointerTimer ||
      process.env.CHROMA_HEADLESS_SMOKE === "1"
    ) {
      return;
    }
    this.#sidebarOverlayPointerTimer = setInterval(() => {
      const view = this.#sidebarOverlayView;
      let contents;
      let visible = false;
      try {
        contents = view?.webContents;
        visible = Boolean(view?.getVisible());
      } catch {
        this.#stopSidebarOverlayPointerWatch();
        return;
      }
      if (
        this.#destroying ||
        this.#window.isDestroyed() ||
        !this.#sidebarOverlayOpen ||
        !visible ||
        !contents ||
        contents.isDestroyed()
      ) {
        this.#stopSidebarOverlayPointerWatch();
        return;
      }
      if (
        this.#sidebarOverlayKeepOpen ||
        this.#chromeModalOpen ||
        this.#tabDragActive
      ) {
        this.#sidebarOverlayOutsideSince = 0;
        return;
      }

      let cursor;
      let windowBounds;
      try {
        cursor = screen.getCursorScreenPoint();
        windowBounds = this.#window.getContentBounds();
      } catch {
        this.#stopSidebarOverlayPointerWatch();
        return;
      }
      const panelLeft = windowBounds.x + SIDEBAR_OVERLAY_INSET;
      const panelTop = windowBounds.y + SIDEBAR_OVERLAY_INSET;
      const panelRight = panelLeft + this.#state.settings.sidebarWidth;
      const panelBottom = windowBounds.y + windowBounds.height - SIDEBAR_OVERLAY_INSET;
      const insidePanel = cursor.x >= panelLeft && cursor.x <= panelRight &&
        cursor.y >= panelTop && cursor.y <= panelBottom;
      const insideTrigger = cursor.x >= windowBounds.x &&
        cursor.x <= windowBounds.x + 8 &&
        cursor.y >= windowBounds.y &&
        cursor.y <= windowBounds.y + windowBounds.height;
      if (insidePanel || insideTrigger) {
        this.#sidebarOverlayOutsideSince = 0;
        return;
      }

      if (!this.#sidebarOverlayOutsideSince) {
        this.#sidebarOverlayOutsideSince = Date.now();
        return;
      }
      if (Date.now() - this.#sidebarOverlayOutsideSince < 240) return;
      this.#sidebarOverlayOpen = false;
      this.#stopSidebarOverlayPointerWatch();
      this.#syncSidebarOverlay();
      this.#notify(false);
    }, 60);
  }

  #focusSidebarOverlayAddress() {
    const contents = this.#sidebarOverlayView?.webContents;
    if (
      !this.#sidebarOverlayFocusAddressPending ||
      !this.#sidebarOverlayReady ||
      !contents ||
      contents.isDestroyed()
    ) {
      return;
    }
    this.#sidebarOverlayFocusAddressPending = false;
    contents.focus();
    contents.send("chroma:focus-address");
  }

  #syncSidebarOverlay() {
    const view = this.#sidebarOverlayView;
    if (!view || this.#destroying || this.#window.isDestroyed()) return;
    const shouldShow = this.#state.settings.sidebarCollapsed && this.#sidebarOverlayOpen;
    const desiredBounds = this.#tabDragActive
      ? {
          x: 0,
          y: 0,
          width: Math.max(1, this.#window.getContentBounds().width),
          height: Math.max(1, this.#window.getContentBounds().height),
        }
      : this.#sidebarOverlayBounds || this.#defaultSidebarOverlayBounds();

    if (!shouldShow) {
      this.#stopSidebarOverlayPointerWatch();
      this.#sidebarOverlayFocusAddressPending = false;
      this.#sidebarOverlayKeepOpen = false;
      if (!view.getVisible()) {
        view.setBounds(desiredBounds);
        return;
      }
      this.#clearSidebarOverlayHideTimer();
      if (!this.#state.settings.sidebarCollapsed || this.#tabDragActive) {
        view.setVisible(false);
        view.setBounds(desiredBounds);
        return;
      }
      const offscreenBounds = this.#sidebarOverlayOffscreenBounds(desiredBounds);
      if (process.env.CHROMA_HEADLESS_SMOKE === "1") {
        view.setBounds(offscreenBounds);
        view.setVisible(false);
        return;
      }
      view.setBounds(offscreenBounds, {
        animate: { duration: SIDEBAR_OVERLAY_ANIMATION_MS },
      });
      this.#sidebarOverlayHideTimer = setTimeout(() => {
        this.#sidebarOverlayHideTimer = null;
        if (
          !this.#sidebarOverlayOpen &&
          this.#sidebarOverlayView === view &&
          !this.#destroying
        ) {
          view.setVisible(false);
        }
      }, SIDEBAR_OVERLAY_ANIMATION_MS + 30);
      return;
    }

    this.#clearSidebarOverlayHideTimer();
    this.#startSidebarOverlayPointerWatch();
    const wasVisible = view.getVisible();
    if (!wasVisible && !this.#tabDragActive) {
      view.setBounds(this.#sidebarOverlayOffscreenBounds(desiredBounds));
    }
    view.setVisible(true);
    // Re-adding an existing child View is Electron's supported way to make it
    // topmost, which keeps the floating sidebar above every page view.
    this.#window.contentView.addChildView(view);
    if (!wasVisible && process.env.CHROMA_HEADLESS_SMOKE !== "1") {
      queueMicrotask(() => {
        if (this.#sidebarOverlayOpen && this.#sidebarOverlayView === view) {
          view.setBounds(desiredBounds, {
            animate: { duration: SIDEBAR_OVERLAY_ANIMATION_MS },
          });
          this.#focusSidebarOverlayAddress();
        }
      });
    } else {
      view.setBounds(desiredBounds);
      this.#focusSidebarOverlayAddress();
    }
  }

  async #destroySidebarOverlay() {
    const view = this.#sidebarOverlayView;
    if (!view) return;
    this.#clearSidebarOverlayHideTimer();
    this.#stopSidebarOverlayPointerWatch();
    this.#sidebarOverlayOpen = false;
    this.#sidebarOverlayReady = false;
    this.#sidebarOverlayKeepOpen = false;
    const contents = view.webContents;
    try {
      view.setVisible(false);
      if (!this.#window.isDestroyed()) {
        this.#window.contentView.removeChildView(view);
      }
      if (contents.isDestroyed()) return;
      await new Promise((resolve, reject) => {
        const onDestroyed = () => {
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(() => {
          contents.removeListener("destroyed", onDestroyed);
          reject(new Error(`Timed out destroying sidebar WebContents ${contents.id}`));
        }, 5_000);
        contents.once("destroyed", onDestroyed);
        contents.close({ waitForBeforeUnload: false });
      });
    } catch (error) {
      console.warn("Unable to destroy the sidebar overlay:", error);
    }
  }

  #createView(tab) {
    tab.loading = true;
    tab.crashed = false;
    const view = new WebContentsView({
      webPreferences: {
        partition: "persist:chroma-main",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true,
      },
    });
    view.setVisible(false);
    view.setBorderRadius(process.platform === "darwin" ? 12 : 8);
    this.#window.contentView.addChildView(view);
    this.#views.set(tab.id, view);
    this.#navigationVersions.set(tab.id, 0);
    this.#configureSession(view.webContents.session);
    this.#desktopUserAgent ||= withoutElectronUserAgent(
      view.webContents.session.getUserAgent()
    );
    this.#adaptiveViews.set(tab.id, {
      mode: "desktop",
      pending: null,
      followupMode: null,
      suppressedTransition: "",
      epoch: 0,
      signature: "",
      timer: null,
    });
    this.#wireWebContents(tab, view);
    view.webContents.setUserAgent(this.#desktopUserAgent);
    view.webContents.setAudioMuted(Boolean(tab.muted));
    // Electron 43 initializes sandbox startup data asynchronously. Queue every
    // navigation behind the initial blank document, and version requests so a
    // newly typed URL cannot be overwritten by the tab's startup URL.
    let ready = false;
    let resolveReady;
    const readyPromise = new Promise(resolve => { resolveReady = resolve; });
    const markReady = () => {
      if (ready) return;
      ready = true;
      clearTimeout(readinessFallback);
      resolveReady();
    };
    const readinessFallback = setTimeout(markReady, 100);
    view.webContents.once("dom-ready", markReady);
    view.webContents.once("destroyed", markReady);
    this.#viewReady.set(tab.id, readyPromise);
    this.#queueViewNavigation(tab, view, tab.url, 0, "Unable to restore tab:");
    return view;
  }

  #queueViewNavigation(tab, view, url, version, warning) {
    const readiness = this.#viewReady.get(tab.id) || Promise.resolve();
    void readiness.then(() => {
      const contents = view.webContents;
      if (
        this.#destroying ||
        this.#views.get(tab.id) !== view ||
        this.#navigationVersions.get(tab.id) !== version ||
        contents.isDestroyed()
      ) {
        return;
      }
      return contents.loadURL(url);
    }).catch(error => {
      if (
        error?.code !== "ERR_ABORTED" &&
        this.#views.get(tab.id) === view &&
        !this.#destroying
      ) {
        console.warn(warning, error);
      }
    });
  }

  #wireWebContents(tab, view) {
    const contents = view.webContents;

    contents.on("focus", () => {
      if (
        !view.getVisible() ||
        !this.#tab(tab.id) ||
        this.#state.activeTabId === tab.id
      ) {
        return;
      }
      this.#state.activeWorkspaceId = tab.workspaceId;
      this.#state.activeTabId = tab.id;
      tab.lastActiveAt = Date.now();
      this.#commit();
    });

    contents.setWindowOpenHandler(details => {
      if (isSafePageUrl(details.url)) {
        void this.dispatch(commands.createTab, {
          url: details.url,
          workspaceId: tab.workspaceId,
          activate: true,
        });
      } else if (/^(mailto|tel):/i.test(details.url)) {
        void this.#confirmExternalOpen(details.url);
      }
      return { action: "deny" };
    });

    contents.on("will-navigate", (event, legacyUrl) => {
      const targetUrl = event.url || legacyUrl;
      if (isSafePageUrl(targetUrl)) return;
      if (/^(mailto|tel):/i.test(targetUrl)) void this.#confirmExternalOpen(targetUrl);
      event.preventDefault();
    });

    contents.on("did-start-navigation", details => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.#handleAdaptiveNavigationStart(tab.id, view, details.url);
    });

    contents.on("did-start-loading", () => {
      this.#cancelAdaptiveProbe(tab.id, true);
      tab.loading = true;
      tab.crashed = false;
      this.#notify(false);
    });

    contents.on("did-stop-loading", () => {
      if (
        this.#destroying ||
        this.#views.get(tab.id) !== view ||
        contents.isDestroyed()
      ) {
        return;
      }
      const currentUrl = contents.getURL();
      if (!currentUrl || currentUrl === "about:blank") return;
      const pending = this.#adaptiveViews.get(tab.id)?.pending;
      if (pending?.committed) {
        this.#finishAdaptiveTransition(tab.id, view);
      } else if (pending) {
        this.#rollbackAdaptiveTransition(tab.id, view, { suppress: true });
      }
      if (isSafePageUrl(currentUrl) && tab.url !== currentUrl) {
        tab.url = currentUrl;
        tab.title = safeTitle(
          contents.getTitle(),
          currentUrl.startsWith("chroma:") ? "New Tab" : currentUrl
        );
        tab.crashed = false;
      }
      tab.loading = false;
      this.#refreshNavigationState(tab, contents);
      this.#cancelAdaptiveProbe(tab.id, true);
      this.#runAdaptiveFollowup(tab.id, view);
      this.#syncVisibleViews();
      this.#notify(false);
    });

    const markFailedAdaptiveLoad = (
      _event,
      _errorCode,
      _errorDescription,
      _validatedUrl,
      isMainFrame
    ) => {
      const adaptive = this.#adaptiveViews.get(tab.id);
      if (isMainFrame && this.#views.get(tab.id) === view && adaptive?.pending) {
        adaptive.pending.failed = true;
      }
    };
    contents.on("did-fail-load", markFailedAdaptiveLoad);
    contents.on("did-fail-provisional-load", markFailedAdaptiveLoad);

    const handleNavigation = url => {
      if (!isSafePageUrl(url)) return;
      tab.url = url;
      tab.crashed = false;
      this.#refreshNavigationState(tab, contents);
      this.#recordHistory(tab);
      this.#commit();
    };
    contents.on("did-navigate", (_event, url) => {
      this.#markAdaptiveTransitionCommitted(tab.id, view);
      handleNavigation(url);
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) handleNavigation(url);
    });

    contents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      tab.title = safeTitle(title, tab.url.startsWith("chroma:") ? "New Tab" : tab.url);
      this.#updateLatestHistoryTitle(tab);
      this.#commit();
    });

    contents.on("page-favicon-updated", (_event, favicons) => {
      const favicon = favicons.find(value => /^https?:|^data:image\//.test(value));
      if (!favicon) return;
      tab.favicon = favicon;
      this.#commit();
    });

    contents.on("media-started-playing", () => {
      tab.audible = true;
      this.#notify(false);
    });
    contents.on("media-paused", () => {
      tab.audible = false;
      this.#notify(false);
    });

    contents.on("render-process-gone", (_event, details) => {
      tab.loading = false;
      tab.crashed = true;
      tab.title = details.reason === "killed" ? tab.title : "Tab crashed";
      this.#notify(false);
    });

    contents.on("context-menu", (_event, params) => {
      this.#showContextMenu(tab, contents, params);
    });

    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isAutoRepeat) return;
      const modifier = activeModifier(input);
      const key = String(input.key || "").toLowerCase();
      if (modifier && key === "l") {
        event.preventDefault();
        this.focusAddress();
      } else if (modifier && input.shift && key === "t") {
        event.preventDefault();
        void this.dispatch(commands.reopenTab);
      } else if (modifier && key === "t") {
        event.preventDefault();
        void this.dispatch(commands.createTab);
      } else if (modifier && key === "w") {
        event.preventDefault();
        void this.dispatch(commands.closeTab, { id: tab.id });
      } else if (modifier && key === "r") {
        event.preventDefault();
        contents.reload();
      } else if (modifier && key === "[") {
        event.preventDefault();
        this.goBack(tab.id);
      } else if (modifier && key === "]") {
        event.preventDefault();
        this.goForward(tab.id);
      }
    });
  }

  #configureSession(browserSession) {
    if (this.#configuredSessions.has(browserSession)) return;
    this.#configuredSessions.add(browserSession);
    installInternalProtocol(browserSession.protocol);
    const permissionDecisions = new Map();
    browserSession.setUserAgent(
      withoutElectronUserAgent(browserSession.getUserAgent())
    );

    browserSession.setPermissionRequestHandler(
      (webContents, permission, callback, details) => {
        if (!ALLOWED_PERMISSIONS.has(permission)) {
          callback(false);
          return;
        }
        const origin = this.#webOrigin(details.requestingUrl || webContents.getURL());
        if (!origin) {
          callback(false);
          return;
        }
        const decisionKey = `${origin}|${permission}`;
        if (permissionDecisions.has(decisionKey)) {
          callback(permissionDecisions.get(decisionKey));
          return;
        }
        const host = new URL(origin).host;
        void dialog
          .showMessageBox(this.#window, {
            type: "question",
            buttons: ["Allow", "Block"],
            defaultId: 1,
            cancelId: 1,
            title: "Site permission",
            message: `${host} wants permission to use ${permission}.`,
            detail: "This decision applies until the browser is closed.",
          })
          .then(result => {
            const allowed = result.response === 0;
            permissionDecisions.set(decisionKey, allowed);
            callback(allowed);
          })
          .catch(() => callback(false));
      }
    );

    browserSession.setPermissionCheckHandler(
      (_webContents, permission, requestingOrigin) => {
        if (!ALLOWED_PERMISSIONS.has(permission)) return false;
        const origin = this.#webOrigin(requestingOrigin);
        return origin
          ? permissionDecisions.get(`${origin}|${permission}`) === true
          : false;
      }
    );

    browserSession.setDevicePermissionHandler(() => false);

    browserSession.on("will-download", (_event, item) => {
      const download = {
        id: randomUUID(),
        filename: item.getFilename(),
        url: item.getURL(),
        state: "progressing",
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        startedAt: Date.now(),
        savePath: "",
      };
      this.#state.downloads.unshift(download);
      this.#state.downloads = this.#state.downloads.slice(0, 100);
      this.#notify(false);
      item.on("updated", (_itemEvent, state) => {
        download.state = state;
        download.receivedBytes = item.getReceivedBytes();
        download.totalBytes = item.getTotalBytes();
        this.#notify(false);
      });
      item.once("done", (_itemEvent, state) => {
        download.state = state;
        download.receivedBytes = item.getReceivedBytes();
        download.totalBytes = item.getTotalBytes();
        download.savePath = item.getSavePath();
        this.#notify(false);
      });
    });
  }

  #showContextMenu(tab, contents, params) {
    const template = [];
    if (params.linkURL) {
      template.push(
        {
          label: "Open Link in New Tab",
          click: () => void this.dispatch(commands.createTab, {
            url: params.linkURL,
            workspaceId: tab.workspaceId,
          }),
        },
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" }
      );
    }
    if (params.isEditable) {
      template.push(
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" }
      );
    } else if (params.selectionText) {
      template.push({ role: "copy" }, { type: "separator" });
    }
    template.push(
      { label: "Back", enabled: tab.canGoBack, click: () => this.goBack(tab.id) },
      { label: "Forward", enabled: tab.canGoForward, click: () => this.goForward(tab.id) },
      { label: "Reload", click: () => this.reload(tab.id) },
      { type: "separator" },
      { label: tab.essential ? "Remove from Essentials" : "Add to Essentials", click: () => this.toggleEssential(tab.id) },
      { label: "Inspect", click: () => contents.inspectElement(params.x, params.y) }
    );
    Menu.buildFromTemplate(template).popup({ window: this.#window });
  }

  async #confirmExternalOpen(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!["mailto:", "tel:"].includes(parsed.protocol)) return false;
    const result = await dialog.showMessageBox(this.#window, {
      type: "question",
      buttons: ["Open", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Open external application?",
      message: `This page wants to open a ${parsed.protocol.slice(0, -1)} link in another application.`,
      detail: parsed.href.slice(0, 300),
    });
    if (result.response !== 0) return false;
    await shell.openExternal(parsed.href);
    return true;
  }

  #webOrigin(value) {
    try {
      const parsed = new URL(value);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : null;
    } catch {
      return null;
    }
  }

  #recordHistory(tab) {
    if (!tab.url.startsWith("http")) return;
    this.#state.history.push({
      url: tab.url,
      title: tab.title || tab.url,
      visitedAt: Date.now(),
    });
    if (this.#state.history.length > MAX_HISTORY_ITEMS) {
      this.#state.history.splice(0, this.#state.history.length - MAX_HISTORY_ITEMS);
    }
  }

  #updateLatestHistoryTitle(tab) {
    const entry = [...this.#state.history].reverse().find(item => item.url === tab.url);
    if (entry) entry.title = tab.title;
  }

  #refreshNavigationState(tab, contents) {
    if (contents.isDestroyed()) return;
    tab.canGoBack = contents.navigationHistory.canGoBack();
    tab.canGoForward = contents.navigationHistory.canGoForward();
  }

  #syncVisibleViews() {
    if (this.#destroying) return;
    if (
      (this.#chromeModalOpen && !this.#chromeModalUsesOverlay) ||
      (this.#tabDragActive && !this.#tabDragUsesOverlay)
    ) {
      for (const [id, view] of this.#views) {
        view.setVisible(false);
        this.#cancelAdaptiveProbe(id, true);
      }
      this.#syncSidebarOverlay();
      return;
    }
    const visibleIds = this.#visibleTabIds();
    const rects = this.#contentBounds
      ? splitPaneRects(
          this.#contentBounds,
          visibleIds.length,
          this.#splitForTab(this.#state.activeTabId)?.direction || "row"
        ).viewRects
      : [];
    for (const [id, view] of this.#views) {
      const index = visibleIds.indexOf(id);
      const visible = index >= 0 && Boolean(rects[index]);
      // Apply the native view size before attaching it to the compositor. When
      // a tab-drag preview temporarily hides every WebContentsView, showing a
      // view first can race its previous full-width surface back on screen and
      // the renderer can miss the corresponding resize notification.
      if (visible) view.setBounds(rects[index]);
      view.setVisible(visible);
      if (visible) {
        this.#scheduleAdaptiveLayout(id, view);
      } else {
        this.#cancelAdaptiveProbe(id, true);
      }
    }
    this.#syncSidebarOverlay();
  }

  #isCompactPane(id, view) {
    if (!this.#contentBounds || !view.getVisible()) return false;
    const visibleIds = this.#visibleTabIds();
    if (visibleIds.length < 2 || !visibleIds.includes(id)) return false;
    const bounds = view.getBounds();
    return bounds.width < this.#contentBounds.width - 1 &&
      bounds.width < ADAPTIVE_LAYOUT_MAX_WIDTH;
  }

  #scheduleAdaptiveLayout(id, view) {
    const adaptive = this.#adaptiveViews.get(id);
    const tab = this.#tab(id);
    const contents = this.#liveAdaptiveContents(id, view);
    if (
      !adaptive ||
      !tab ||
      tab.loading ||
      !contents ||
      !view.getVisible()
    ) {
      return;
    }

    const compact = this.#isCompactPane(id, view);
    const url = contents.getURL();
    if (adaptive.suppressedTransition) {
      const currentTransition = this.#adaptiveTransitionSignature(
        id,
        view,
        compact ? "mobile" : "desktop",
        contents
      );
      if (currentTransition !== adaptive.suppressedTransition) {
        adaptive.suppressedTransition = "";
      }
    }
    if (adaptive.pending) {
      const desiredMode = compact ? "mobile" : "desktop";
      adaptive.followupMode = adaptive.pending.mode === desiredMode
        ? null
        : desiredMode;
      this.#cancelAdaptiveProbe(id);
      adaptive.signature = `pending|${desiredMode}|${view.getBounds().width}|${url}`;
      return;
    }
    const modeAlreadyMatches = compact
      ? adaptive.mode === "mobile"
      : adaptive.mode === "desktop";
    if (modeAlreadyMatches || (compact && !isWebPageUrl(url))) {
      this.#cancelAdaptiveProbe(id);
      adaptive.signature = `${adaptive.mode}|${compact}|${view.getBounds().width}|${url}`;
      return;
    }

    const signature = [
      adaptive.mode,
      compact,
      view.getBounds().width,
      view.getBounds().height,
      url,
      this.#navigationVersions.get(id) || 0,
    ].join("|");
    if (adaptive.signature === signature) return;

    this.#cancelAdaptiveProbe(id);
    adaptive.signature = signature;
    const expected = {
      adaptive,
      compact,
      epoch: adaptive.epoch,
      navigationVersion: this.#navigationVersions.get(id) || 0,
      url,
    };
    adaptive.timer = setTimeout(() => {
      adaptive.timer = null;
      void this.#applyAdaptiveLayout(id, view, expected).catch(error => {
        if (!this.#destroying) {
          console.warn("Unable to inspect responsive page layout:", error);
        }
      });
    }, ADAPTIVE_LAYOUT_DELAY_MS);
  }

  async #applyAdaptiveLayout(id, view, expected) {
    if (!this.#adaptiveContextMatches(id, view, expected)) return;
    const contents = view.webContents;

    if (!expected.compact) {
      this.#switchAdaptiveLayout(id, view, "desktop");
      return;
    }
    const adaptive = expected.adaptive;
    if (adaptive.mode !== "desktop" || !isWebPageUrl(expected.url)) return;

    let metrics;
    try {
      metrics = await contents.executeJavaScript(`(() => {
        const root = document.documentElement;
        const body = document.body;
        return {
          viewportWidth: Math.max(1, window.innerWidth || root?.clientWidth || 1),
          scrollWidth: Math.max(
            root?.scrollWidth || 0,
            body?.scrollWidth || 0
          ),
          hasViewportMeta: Boolean(
            document.querySelector('meta[name="viewport" i]')
          )
        };
      })()`);
    } catch {
      return;
    }

    if (!this.#adaptiveContextMatches(id, view, expected, {
      compact: true,
      mode: "desktop",
    })) return;

    const viewportWidth = Math.max(1, Number(metrics?.viewportWidth) || 1);
    const scrollWidth = Math.max(viewportWidth, Number(metrics?.scrollWidth) || 0);
    const overflows = scrollWidth >= viewportWidth * ADAPTIVE_OVERFLOW_RATIO &&
      scrollWidth - viewportWidth >= ADAPTIVE_OVERFLOW_PIXELS;
    if (!metrics?.hasViewportMeta && overflows) {
      this.#switchAdaptiveLayout(id, view, "mobile");
    }
  }

  #adaptiveContextMatches(
    id,
    view,
    expected,
    { compact = expected.compact, mode } = {}
  ) {
    const adaptive = this.#adaptiveViews.get(id);
    const tab = this.#tab(id);
    if (
      this.#destroying ||
      this.#views.get(id) !== view ||
      adaptive !== expected.adaptive ||
      !tab
    ) {
      return false;
    }
    let contents;
    try {
      contents = view.webContents;
    } catch {
      return false;
    }
    return adaptive === expected.adaptive &&
      !tab.loading &&
      !adaptive.pending &&
      !contents.isDestroyed() &&
      view.getVisible() &&
      adaptive.epoch === expected.epoch &&
      (mode === undefined || adaptive.mode === mode) &&
      (this.#navigationVersions.get(id) || 0) === expected.navigationVersion &&
      contents.getURL() === expected.url &&
      this.#isCompactPane(id, view) === compact;
  }

  #liveAdaptiveContents(id, view) {
    if (this.#destroying || this.#views.get(id) !== view) return null;
    try {
      const contents = view.webContents;
      return contents.isDestroyed() ? null : contents;
    } catch {
      return null;
    }
  }

  #adaptiveTransitionSignature(
    id,
    view,
    mode,
    contents,
    url = contents.getURL()
  ) {
    const bounds = view.getBounds();
    return [
      mode,
      url,
      bounds.width,
      bounds.height,
      this.#navigationVersions.get(id) || 0,
    ].join("|");
  }

  #switchAdaptiveLayout(id, view, mode) {
    const adaptive = this.#adaptiveViews.get(id);
    const contents = this.#liveAdaptiveContents(id, view);
    if (
      !adaptive ||
      !contents ||
      adaptive.pending ||
      adaptive.mode === mode
    ) {
      return false;
    }

    const transitionSignature = this.#adaptiveTransitionSignature(
      id,
      view,
      mode,
      contents
    );
    if (adaptive.suppressedTransition === transitionSignature) return false;

    this.#cancelAdaptiveProbe(id);
    if (adaptive.followupMode === mode) adaptive.followupMode = null;
    adaptive.pending = {
      mode,
      previousMode: adaptive.mode,
      started: false,
      committed: false,
      failed: false,
      requestedUrl: contents.getURL(),
      navigationUrl: "",
      signature: transitionSignature,
    };
    adaptive.epoch += 1;
    adaptive.signature = "";
    try {
      contents.setUserAgent(
        mode === "mobile" ? this.#mobileUserAgent : this.#desktopUserAgent
      );
      contents.reloadIgnoringCache();
      return true;
    } catch (error) {
      this.#rollbackAdaptiveTransition(id, view, { suppress: true });
      if (!this.#destroying) {
        console.warn("Unable to change responsive page mode:", error);
      }
      return false;
    }
  }

  #handleAdaptiveNavigationStart(id, view, url) {
    const adaptive = this.#adaptiveViews.get(id);
    if (!adaptive || this.#views.get(id) !== view) return;
    this.#cancelAdaptiveProbe(id, true);
    if (adaptive.pending) {
      adaptive.pending.started = true;
      adaptive.pending.navigationUrl = String(url || "");
    } else {
      adaptive.suppressedTransition = "";
    }
  }

  #markAdaptiveTransitionCommitted(id, view) {
    const adaptive = this.#adaptiveViews.get(id);
    if (
      adaptive?.pending?.started &&
      this.#views.get(id) === view &&
      !this.#destroying
    ) {
      adaptive.pending.committed = true;
      adaptive.mode = adaptive.pending.mode;
      adaptive.suppressedTransition = "";
    }
  }

  #finishAdaptiveTransition(id, view) {
    const adaptive = this.#adaptiveViews.get(id);
    const pending = adaptive?.pending;
    if (
      !pending?.started ||
      !pending.committed ||
      !this.#liveAdaptiveContents(id, view)
    ) {
      return false;
    }
    adaptive.pending = null;
    adaptive.epoch += 1;
    adaptive.signature = "";
    return true;
  }

  #rollbackAdaptiveTransition(id, view, { suppress = false } = {}) {
    const adaptive = this.#adaptiveViews.get(id);
    const pending = adaptive?.pending;
    if (!pending || this.#views.get(id) !== view) return false;
    adaptive.mode = pending.previousMode;
    adaptive.pending = null;
    if (suppress) adaptive.suppressedTransition = pending.signature;
    adaptive.epoch += 1;
    adaptive.signature = "";
    const contents = this.#liveAdaptiveContents(id, view);
    if (!contents) return true;
    try {
      contents.setUserAgent(
        adaptive.mode === "mobile" ? this.#mobileUserAgent : this.#desktopUserAgent
      );
    } catch {
      // A closing view no longer needs its per-page user agent restored.
    }
    return true;
  }

  #restoreDesktopLayout(id, view) {
    const adaptive = this.#adaptiveViews.get(id);
    if (!adaptive) return false;
    if (adaptive.pending) {
      adaptive.followupMode = adaptive.pending.mode === "desktop"
        ? null
        : "desktop";
      return true;
    }
    adaptive.followupMode = null;
    if (adaptive.mode === "mobile") {
      return this.#switchAdaptiveLayout(id, view, "desktop");
    }
    const contents = this.#liveAdaptiveContents(id, view);
    if (!contents) return false;
    try {
      contents.setUserAgent(this.#desktopUserAgent);
      return true;
    } catch {
      return false;
    }
  }

  #resetAdaptiveLayoutForNavigation(id, view) {
    const adaptive = this.#adaptiveViews.get(id);
    if (!adaptive) return;
    this.#cancelAdaptiveProbe(id, true);
    adaptive.mode = "desktop";
    adaptive.pending = null;
    adaptive.followupMode = null;
    adaptive.suppressedTransition = "";
    adaptive.signature = "";
    const contents = this.#liveAdaptiveContents(id, view);
    if (!contents) return;
    try {
      contents.setUserAgent(this.#desktopUserAgent);
    } catch {
      // The versioned navigation will be discarded if the view is closing.
    }
  }

  #prepareAdaptiveUserNavigation(id, view) {
    const adaptive = this.#adaptiveViews.get(id);
    if (!adaptive || this.#views.get(id) !== view) return;
    if (adaptive.pending) {
      if (adaptive.pending.committed) {
        this.#finishAdaptiveTransition(id, view);
      } else if (
        adaptive.pending.previousMode === "desktop" &&
        adaptive.pending.mode === "mobile"
      ) {
        this.#resetAdaptiveLayoutForNavigation(id, view);
      }
      return;
    }
    this.#cancelAdaptiveProbe(id, true);
    adaptive.followupMode = null;
    adaptive.suppressedTransition = "";
    adaptive.signature = "";
  }

  #prepareAdaptiveExplicitNavigation(id, view, url) {
    const adaptive = this.#adaptiveViews.get(id);
    const contents = this.#liveAdaptiveContents(id, view);
    if (!adaptive || !contents) return;
    this.#cancelAdaptiveProbe(id, true);
    if (adaptive.pending?.committed) {
      this.#finishAdaptiveTransition(id, view);
    } else if (adaptive.pending) {
      adaptive.pending = null;
      adaptive.epoch += 1;
    }
    adaptive.followupMode = null;
    adaptive.suppressedTransition = "";
    adaptive.signature = "";
    if (adaptive.mode === "mobile") {
      adaptive.pending = {
        mode: "desktop",
        previousMode: "mobile",
        started: false,
        committed: false,
        failed: false,
        requestedUrl: url,
        navigationUrl: "",
        signature: this.#adaptiveTransitionSignature(
          id,
          view,
          "desktop",
          contents,
          url
        ),
      };
      adaptive.epoch += 1;
    }
    try {
      contents.setUserAgent(this.#desktopUserAgent);
    } catch {
      // The versioned navigation will be discarded if the view is closing.
    }
  }

  #suppressAdaptiveAfterUserStop(id, view) {
    const adaptive = this.#adaptiveViews.get(id);
    const contents = this.#liveAdaptiveContents(id, view);
    if (!adaptive || !contents) return;
    this.#cancelAdaptiveProbe(id, true);
    if (!adaptive.pending && adaptive.mode === "desktop" &&
        this.#isCompactPane(id, view)) {
      adaptive.suppressedTransition = this.#adaptiveTransitionSignature(
        id,
        view,
        "mobile",
        contents
      );
    }
  }

  #runAdaptiveFollowup(id, view) {
    const adaptive = this.#adaptiveViews.get(id);
    if (!adaptive || adaptive.pending || !adaptive.followupMode) return false;
    const mode = adaptive.followupMode;
    adaptive.followupMode = null;
    if (adaptive.mode === mode) return true;
    return this.#switchAdaptiveLayout(id, view, mode);
  }

  #cancelAdaptiveProbe(id, invalidate = false) {
    const adaptive = this.#adaptiveViews.get(id);
    if (!adaptive) return;
    if (adaptive.timer) {
      clearTimeout(adaptive.timer);
      adaptive.timer = null;
    }
    if (invalidate) {
      adaptive.epoch += 1;
      adaptive.signature = "";
    }
  }

  #visibleTabIds() {
    const active = this.#tab(this.#state.activeTabId);
    if (!active || active.workspaceId !== this.#state.activeWorkspaceId) return [];
    const group = this.#splitForTab(active.id);
    if (!group) return [active.id];
    return group.tabIds.filter(id => this.#tab(id)?.workspaceId === active.workspaceId);
  }

  #focusTab(id) {
    queueMicrotask(() => {
      const view = this.#viewFor(id);
      if (view?.getVisible() && !view.webContents.isDestroyed()) view.webContents.focus();
    });
  }

  #removeTabFromFoldersAndSplits(id) {
    for (const folder of this.#state.folders) {
      folder.tabIds = folder.tabIds.filter(tabId => tabId !== id);
    }
    this.#state.folders = this.#state.folders.filter(folder => folder.tabIds.length);
    for (const group of this.#state.splitGroups) {
      group.tabIds = group.tabIds.filter(tabId => tabId !== id);
    }
    this.#state.splitGroups = this.#state.splitGroups.filter(group => group.tabIds.length >= 2);
  }

  async #destroyView(id) {
    const view = this.#views.get(id);
    if (!view) return;
    this.#cancelAdaptiveProbe(id, true);
    this.#adaptiveViews.delete(id);
    this.#views.delete(id);
    this.#viewReady.delete(id);
    this.#navigationVersions.delete(id);
    try {
      const contents = view.webContents;
      view.setVisible(false);
      // Detach first. Keeping the view in the hierarchy until `destroyed` retains
      // its WebContents and can prevent close() from completing on Electron 43.
      if (!this.#window.isDestroyed()) this.#window.contentView.removeChildView(view);
      if (!contents.isDestroyed()) {
        // Cancel an in-flight navigation before destruction. Closing a detached
        // view in the same task while its renderer is committing can orphan the
        // target in Electron 43.
        contents.stop();
        await new Promise(resolve => setImmediate(resolve));
      }
      if (!contents.isDestroyed()) {
        await new Promise((resolve, reject) => {
          const onDestroyed = () => {
            clearTimeout(timeout);
            resolve();
          };
          const timeout = setTimeout(() => {
            contents.removeListener("destroyed", onDestroyed);
            reject(new Error(`Timed out destroying tab WebContents ${contents.id}`));
          }, 5_000);
          contents.once("destroyed", onDestroyed);
          contents.close({ waitForBeforeUnload: false });
        });
      }
    } catch (error) {
      if (!this.#destroying) console.warn("Unable to destroy tab view:", error);
    }
  }

  #commit() {
    if (this.#destroying) return;
    this.#store.scheduleSave(this.#state);
    this.#syncVisibleViews();
    this.#notify(false);
  }

  #notify() {
    if (!this.#window.isDestroyed() && !this.#window.webContents.isDestroyed()) {
      const publicState = this.getPublicState();
      this.#window.webContents.send("chroma:state-changed", publicState);
      const overlayContents = this.#sidebarOverlayView?.webContents;
      if (overlayContents && !overlayContents.isDestroyed()) {
        overlayContents.send("chroma:state-changed", publicState);
      }
    }
  }

  #tab(id) {
    return this.#state.tabs.find(tab => tab.id === id);
  }

  #workspace(id) {
    return this.#state.workspaces.find(workspace => workspace.id === id);
  }

  #activeWorkspace() {
    return this.#workspace(this.#state.activeWorkspaceId) || this.#state.workspaces[0];
  }

  #tabsForWorkspace(id) {
    return this.#state.tabs.filter(tab => tab.workspaceId === id);
  }

  #splitForTab(id) {
    return this.#state.splitGroups.find(group => group.tabIds.includes(id));
  }

  #viewFor(id) {
    return this.#views.get(id);
  }
}
