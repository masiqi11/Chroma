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

import { channels, commands } from "../shared/channels.mjs";
import { APPEARANCE_THEMES } from "../shared/appearance.mjs";
import {
  createSplitLayout,
  insertSplitPane,
  removeSplitPane,
  sanitizeSplitLayout,
  setSplitRatio,
  splitDividerAtPath,
  splitLayoutPaneIds,
  splitLayoutRects,
  swapSplitPanes,
} from "../shared/split-ratios.mjs";
import {
  isSafePageUrl,
  normalizeNavigationInput,
} from "../shared/navigation.mjs";
import {
  TAB_COUNT_LIMIT,
  TAB_URL_MAX_LENGTH,
  normalizeTabFavicon,
  normalizeWorkspaceColor,
} from "../shared/model.mjs";
import {
  FOLDER_MEMBER_LIMIT,
  LIBRARY_CONTAINER_LIMIT,
} from "../shared/state-invariants.mjs";
import { createDownloadService } from "./download-service.mjs";
import { createHistoryService } from "./history-service.mjs";
import { installInternalProtocol } from "./internal-pages.mjs";

const MAX_CLOSED_TABS = 25;
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
const APPEARANCE_THEME_SET = new Set(APPEARANCE_THEMES);
const ALLOWED_PERMISSIONS = new Set([
  "media",
  "geolocation",
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
]);
const MEDIA_PERMISSION_TYPES = new Set(["audio", "video"]);

function denyPermissionRequest(_webContents, _permission, callback) {
  callback(false);
}

function denyPermissionCheck() {
  return false;
}

function denyDevicePermission() {
  return false;
}

function normalizedMediaTypes(details) {
  if (!Array.isArray(details?.mediaTypes) || !details.mediaTypes.length) {
    return null;
  }
  const types = [...new Set(details.mediaTypes)];
  if (
    types.length > MEDIA_PERMISSION_TYPES.size ||
    !types.every(type => MEDIA_PERMISSION_TYPES.has(type))
  ) {
    return null;
  }
  return types.sort((left, right) =>
    Number(left === "video") - Number(right === "video")
  );
}

function mediaPermissionLabel(types) {
  if (types.length === 2) return "the microphone and camera";
  return types[0] === "audio" ? "the microphone" : "the camera";
}

function safeErrorCode(error) {
  const code = typeof error?.code === "string" || Number.isInteger(error?.code)
    ? String(error.code)
    : "UNKNOWN";
  return /^[A-Z\d_-]{1,80}$/i.test(code) ? code : "UNKNOWN";
}

function normalizeRuntimePageUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > TAB_URL_MAX_LENGTH
  ) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (["http:", "https:"].includes(url.protocol)) {
      url.username = "";
      url.password = "";
    } else if (url.protocol !== "chroma:") {
      return null;
    }
    return url.href.length <= TAB_URL_MAX_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeRequestedPageUrl(input) {
  const value = typeof input === "string" ? input : String(input ?? "");
  if (value.length > TAB_URL_MAX_LENGTH) return "chroma://newtab/";
  return normalizeRuntimePageUrl(normalizeNavigationInput(value)) ||
    "chroma://newtab/";
}

function normalizeCommittedPageUrl(value) {
  return isSafePageUrl(value) ? normalizeRuntimePageUrl(value) : null;
}

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
  #historyNavigationVersions = new Map();
  #historyRecordByTab = new Map();
  #historyNextTransitions = new Map();
  #historyService;
  #downloadService;
  #adaptiveViews = new Map();
  #desktopUserAgent = "";
  #mobileUserAgent = mobileUserAgent();
  #contentBounds = null;
  #closedTabs = [];
  #configuredSessions = new Map();
  #chromeModalOpen = false;
  #chromeModalUsesOverlay = false;
  #tabDragActive = false;
  #tabDragUsesOverlay = false;
  #splitLayoutPreviews = new Map();
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
  #applyAppearance;
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
      applyAppearance = () => {},
    } = {}
  ) {
    this.#window = browserWindow;
    this.#state = state;
    this.#store = stateStore;
    this.#historyService = createHistoryService(this.#state.history);
    this.#downloadService = createDownloadService(this.#state.downloads, {
      onChange: () => {
        if (!this.#destroying) this.#notify(false);
      },
      persist: () => {
        this.#store.scheduleSave(this.#state);
      },
      openPath: filePath => shell.openPath(filePath),
      revealPath: filePath => {
        shell.showItemInFolder(filePath);
        return true;
      },
    });
    this.#registerShellWebContents = registerShellWebContents;
    this.#unregisterShellWebContents = unregisterShellWebContents;
    this.#applyAppearance = typeof applyAppearance === "function"
      ? applyAppearance
      : () => {};
  }

  get state() {
    return this.#state;
  }

  async initialize() {
    this.#applyAppearance({ ...this.#state.settings.appearance });
    const { prunedCount } = this.#historyService.prune();
    if (prunedCount) this.#store.scheduleSave(this.#state);
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
    const { history, ...stateWithoutHistory } = this.#state;
    const publicState = structuredClone(stateWithoutHistory);
    return {
      ...publicState,
      downloads: this.#downloadService.snapshot(),
      historyRevision: history?.revision ?? 0,
      historyCount: history?.entries?.length ?? 0,
      historyPreferences: {
        recordingEnabled: history?.preferences?.recordingEnabled === true,
        retentionDays: history?.preferences?.retentionDays ?? 90,
        clearOnExit: history?.preferences?.clearOnExit === true,
      },
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
        canReopenTab: this.#closedTabs.length > 0,
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

  #runDetached(operation, context) {
    void Promise.resolve(operation).catch(error => {
      if (
        this.#destroying ||
        error?.code === "ERR_ABORTED" ||
        String(error?.message || "").includes("Browser window is closing")
      ) {
        return;
      }
      console.warn(`${context}:`, error);
    });
  }

  #dispatchNow(command, payload) {
    if (!this.#acceptCommands || this.#destroying) {
      throw new Error("Browser window is closing");
    }
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
          payload.position,
          Object.hasOwn(payload, "folderId") ? payload.folderId : undefined
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
      case commands.togglePin:
        return this.togglePin(payload.id);
      case commands.toggleEssential:
        return this.toggleEssential(payload.id);
      case commands.toggleBookmark:
        return this.toggleBookmark(payload.id);
      case commands.removeBookmark:
        return this.removeBookmark(payload.id);
      case commands.queryHistory:
        return this.queryHistory(payload);
      case commands.suggestHistory:
        return this.suggestHistory(payload);
      case commands.removeHistory:
        return this.removeHistory(payload);
      case commands.clearHistory:
        return this.clearHistory(payload);
      case commands.setHistoryPreferences:
        return this.setHistoryPreferences(payload);
      case commands.openHistory:
        return this.openHistory();
      case commands.pauseDownload:
        return this.#downloadService.pause(payload.id);
      case commands.resumeDownload:
        return this.#downloadService.resume(payload.id);
      case commands.cancelDownload:
        return this.#downloadService.cancel(payload.id);
      case commands.openDownload:
        return this.#downloadService.open(payload.id);
      case commands.revealDownload:
        return this.#downloadService.reveal(payload.id);
      case commands.removeDownload:
        return this.#downloadService.remove(payload.id);
      case commands.clearDownloads:
        return this.#downloadService.clearFinished();
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
          payload.moveToEnd === true,
          Object.hasOwn(payload, "folderId") ? payload.folderId : undefined
        );
      case commands.unsplitActive:
        return this.unsplitActive();
      case commands.setSplitRatio:
        return this.commitSplitRatio(payload);
      case commands.createFolder:
        return this.createFolder(payload);
      case commands.toggleFolder:
        return this.toggleFolder(payload.id);
      case commands.renameFolder:
        return this.renameFolder(payload.id, payload.name);
      case commands.deleteFolder:
        return this.deleteFolder(payload.id);
      case commands.toggleSidebar:
        return this.toggleSidebar();
      case commands.setSidebarWidth:
        return this.setSidebarWidth(payload.width);
      case commands.setAppearance:
        return this.setAppearance(payload);
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

  openCommandPalette() {
    if (
      this.#destroying ||
      this.#window.isDestroyed() ||
      this.#window.webContents.isDestroyed()
    ) {
      return false;
    }
    this.#window.webContents.send(channels.openCommandPalette);
    return true;
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

  previewSplitRatio({ groupId, path, ratio, cancel = false } = {}) {
    const group = this.#state.splitGroups.find(item => item.id === groupId);
    if (!group || this.#splitForTab(this.#state.activeTabId)?.id !== group.id) {
      return false;
    }
    if (cancel) {
      const removed = this.#splitLayoutPreviews.delete(group.id);
      if (removed) this.#syncVisibleViews();
      return removed;
    }
    const layout = this.#normalizedGroupLayout(group);
    if (
      !Array.isArray(path) ||
      path.length > 8 ||
      !path.every(part => part === "first" || part === "second") ||
      typeof ratio !== "number" ||
      !Number.isFinite(ratio) ||
      !splitDividerAtPath(layout, path)
    ) {
      return false;
    }
    const preview = setSplitRatio(layout, path, ratio);
    this.#splitLayoutPreviews.set(group.id, preview);
    this.#syncVisibleViews();
    return true;
  }

  commitSplitRatio({ groupId, path, ratio } = {}) {
    const group = this.#state.splitGroups.find(item => item.id === groupId);
    const layout = group ? this.#normalizedGroupLayout(group) : null;
    if (
      !group ||
      this.#splitForTab(this.#state.activeTabId)?.id !== group.id ||
      !Array.isArray(path) ||
      path.length > 8 ||
      !path.every(part => part === "first" || part === "second") ||
      typeof ratio !== "number" ||
      !Number.isFinite(ratio) ||
      !splitDividerAtPath(layout, path)
    ) {
      return false;
    }
    this.#applyGroupLayout(group, setSplitRatio(layout, path, ratio));
    this.#commit();
    return true;
  }

  async createTab({
    url = "chroma://newtab/",
    workspaceId = this.#state.activeWorkspaceId,
    activate = true,
    essential = false,
    pinned = false,
  } = {}) {
    if (this.#state.tabs.length >= TAB_COUNT_LIMIT) return null;
    const workspace = this.#workspace(workspaceId) || this.#activeWorkspace();
    const normalizedUrl = normalizeRequestedPageUrl(url);
    const isEssential = Boolean(essential);
    const tab = {
      id: randomUUID(),
      workspaceId: workspace.id,
      url: normalizedUrl,
      title: normalizedUrl.startsWith("chroma://newtab") ? "New Tab" : "Loading…",
      favicon: "",
      essential: isEssential,
      pinned: isEssential || Boolean(pinned),
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

    const wasActive = this.#state.activeTabId === tab.id;
    const split = this.#splitForTab(tab.id);
    const splitIndex = split?.tabIds.indexOf(tab.id) ?? -1;
    const preferredSiblingIds = split
      ? [
          ...split.tabIds.slice(splitIndex + 1),
          ...split.tabIds.slice(0, splitIndex).reverse(),
        ]
      : [];
    this.#closedTabs.unshift(tabSnapshot(tab));
    this.#closedTabs.length = Math.min(this.#closedTabs.length, MAX_CLOSED_TABS);

    let remaining = this.#tabsForWorkspace(tab.workspaceId).filter(
      item => item.id !== tab.id
    );
    let removedForCapacity = false;
    if (!remaining.length) {
      if (this.#state.tabs.length >= TAB_COUNT_LIMIT) {
        this.#removeTabFromFoldersAndSplits(tab.id);
        this.#state.tabs = this.#state.tabs.filter(item => item.id !== tab.id);
        removedForCapacity = true;
      }
      const replacementId = await this.createTab({
        workspaceId: tab.workspaceId,
        activate: wasActive,
      });
      if (!replacementId) return false;
      remaining = this.#tabsForWorkspace(tab.workspaceId).filter(
        item => item.id !== tab.id
      );
    }

    if (wasActive) {
      const preferred = preferredSiblingIds
        .map(siblingId => remaining.find(item => item.id === siblingId))
        .find(Boolean);
      const next = preferred || [...remaining].sort(
        (left, right) => right.lastActiveAt - left.lastActiveAt
      )[0];
      this.#state.activeWorkspaceId = next.workspaceId;
      this.#state.activeTabId = next.id;
      next.lastActiveAt = Date.now();
    }

    if (!removedForCapacity) {
      this.#removeTabFromFoldersAndSplits(tab.id);
      this.#state.tabs = this.#state.tabs.filter(item => item.id !== tab.id);
    }
    this.#commit();
    this.#focusTab(this.#state.activeTabId);
    await this.#destroyView(tab.id);
    this.#notify(false);
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

  // `folderId` is intentionally tri-state: omitted preserves legacy inference
  // from `targetId`, null targets the ungrouped list, and a string names an
  // explicit folder (including an empty one with no target tab).
  reorderTab(id, targetId = null, position = "before", folderId = undefined) {
    if (!this.#reorderTabState(id, targetId, position, folderId)) return false;
    this.#commit();
    return true;
  }

  #resolveTabMoveDestination(tab, targetId, folderId) {
    if (!tab || tab.essential || tab.pinned) return null;
    const target = targetId ? this.#tab(targetId) : null;
    if (
      (targetId && !target) ||
      (target && (
        target.essential ||
        target.pinned ||
        target.workspaceId !== tab.workspaceId ||
        target.id === tab.id
      ))
    ) {
      return null;
    }
    const targetGroup = target ? this.#splitForTab(target.id) : null;
    const targetBoundaryIds = targetGroup
      ? targetGroup.tabIds
      : target
        ? [target.id]
        : [];
    const inferredFolder = target
      ? this.#state.folders.find(folder => folder.tabIds.includes(target.id))?.id
      : null;
    let targetFolder = null;
    if (folderId === undefined) {
      targetFolder = inferredFolder
        ? this.#state.folders.find(folder => folder.id === inferredFolder) || null
        : null;
    } else if (folderId !== null) {
      if (!validId(folderId)) return null;
      targetFolder = this.#state.folders.find(folder => folder.id === folderId) || null;
      if (!targetFolder || targetFolder.workspaceId !== tab.workspaceId) return null;
    }

    if (target) {
      const expectedFolderId = targetFolder?.id || null;
      if ((inferredFolder || null) !== expectedFolderId) return null;
      if (targetGroup && targetGroup.tabIds.some(tabId => {
        const memberFolderId = this.#state.folders.find(folder =>
          folder.tabIds.includes(tabId)
        )?.id || null;
        return memberFolderId !== expectedFolderId;
      })) {
        return null;
      }
    }

    return { target, targetFolder, targetBoundaryIds };
  }

  #applyResolvedTabMove(tab, destination, position = "before") {
    const { target, targetFolder, targetBoundaryIds } = destination;
    const insertion = position === "after" ? "after" : "before";
    for (const folder of this.#state.folders) {
      folder.tabIds = folder.tabIds.filter(tabId => tabId !== tab.id);
    }
    if (targetFolder) {
      const targetIndexes = targetBoundaryIds
        .map(boundaryId => targetFolder.tabIds.indexOf(boundaryId))
        .filter(index => index >= 0);
      const targetIndex = !target || !targetIndexes.length
        ? targetFolder.tabIds.length
        : insertion === "after"
          ? Math.max(...targetIndexes)
          : Math.min(...targetIndexes);
      targetFolder.tabIds.splice(
        target && insertion === "after" ? targetIndex + 1 : targetIndex,
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
    const from = ordered.findIndex(item => item.id === tab.id);
    if (from < 0) return false;
    const [moved] = ordered.splice(from, 1);
    const targetIndexes = targetBoundaryIds
      .map(boundaryId => ordered.findIndex(item => item.id === boundaryId))
      .filter(index => index >= 0);
    const insertionIndex = !target || !targetIndexes.length
      ? ordered.length
      : insertion === "after"
        ? Math.max(...targetIndexes) + 1
        : Math.min(...targetIndexes);
    ordered.splice(insertionIndex, 0, moved);
    workspaceIndexes.forEach((stateIndex, index) => {
      this.#state.tabs[stateIndex] = ordered[index];
    });
    return true;
  }

  #reorderTabState(id, targetId = null, position = "before", folderId = undefined) {
    const tab = this.#tab(id);
    if (!tab || this.#splitForTab(tab.id)) return false;
    const destination = this.#resolveTabMoveDestination(tab, targetId, folderId);
    return destination
      ? this.#applyResolvedTabMove(tab, destination, position)
      : false;
  }

  navigate(id = this.#state.activeTabId, input) {
    const view = this.#viewFor(id);
    const tab = this.#tab(id);
    if (!view || !tab) return false;
    const url = normalizeRequestedPageUrl(input);
    this.#historyNextTransitions.set(id, "typed");
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
    this.#historyNextTransitions.set(id, "other");
    this.#prepareAdaptiveUserNavigation(id, view);
    contents.navigationHistory.goBack();
    return true;
  }

  goForward(id = this.#state.activeTabId) {
    const view = this.#viewFor(id);
    const contents = view?.webContents;
    if (!contents?.navigationHistory.canGoForward()) return false;
    this.#historyNextTransitions.set(id, "other");
    this.#prepareAdaptiveUserNavigation(id, view);
    contents.navigationHistory.goForward();
    return true;
  }

  reload(id = this.#state.activeTabId) {
    const view = this.#viewFor(id);
    const contents = view?.webContents;
    if (!contents) return false;
    this.#historyNextTransitions.set(id, "reload");
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

  togglePin(id = this.#state.activeTabId) {
    const tab = this.#tab(id);
    if (!tab || tab.essential) return false;
    const pinned = !tab.pinned;
    if (pinned) {
      this.#removeTabFromFoldersAndSplits(tab.id);
      const view = this.#viewFor(tab.id);
      if (view) this.#restoreDesktopLayout(tab.id, view);
    }
    tab.pinned = pinned;
    this.#commit();
    return pinned;
  }

  toggleEssential(id = this.#state.activeTabId) {
    const tab = this.#tab(id);
    if (!tab) return false;
    const essential = !tab.essential;
    if (essential) {
      this.#removeTabFromFoldersAndSplits(tab.id);
      const view = this.#viewFor(tab.id);
      if (view) this.#restoreDesktopLayout(tab.id, view);
    }
    tab.essential = essential;
    if (essential) tab.pinned = true;
    this.#commit();
    return essential;
  }

  toggleBookmark(id = this.#state.activeTabId) {
    const tab = this.#tab(id);
    if (!tab || !isWebPageUrl(tab.url)) return false;
    const url = new URL(tab.url).href;
    const bookmarks = Array.isArray(this.#state.bookmarks)
      ? this.#state.bookmarks
      : (this.#state.bookmarks = []);
    const existingIndex = bookmarks.findIndex(bookmark => bookmark.url === url);
    if (existingIndex >= 0) {
      bookmarks.splice(existingIndex, 1);
      this.#commit();
      return false;
    }
    bookmarks.push({
      id: randomUUID(),
      title: safeTitle(tab.title, url),
      url,
      createdAt: Date.now(),
    });
    this.#commit();
    return true;
  }

  removeBookmark(id) {
    if (!validId(id) || !Array.isArray(this.#state.bookmarks)) return false;
    const index = this.#state.bookmarks.findIndex(bookmark => bookmark.id === id);
    if (index < 0) return false;
    this.#state.bookmarks.splice(index, 1);
    this.#commit();
    return true;
  }

  queryHistory(payload = {}) {
    return this.#runHistoryRead(() => this.#historyService.query(payload));
  }

  suggestHistory(payload = {}) {
    return this.#runHistoryRead(() => this.#historyService.suggest(payload));
  }

  removeHistory(payload = {}) {
    return this.#commitHistoryMutation(() => this.#historyService.remove(payload));
  }

  clearHistory(payload = {}) {
    return this.#commitHistoryMutation(() => this.#historyService.clear(payload));
  }

  setHistoryPreferences(payload = {}) {
    return this.#commitHistoryMutation(() =>
      this.#historyService.setPreferences(payload)
    );
  }

  openHistory() {
    if (
      this.#destroying ||
      this.#window.isDestroyed() ||
      this.#window.webContents.isDestroyed()
    ) {
      return false;
    }
    this.#window.webContents.send(channels.openHistory);
    return true;
  }

  async createWorkspace({ name, icon, color } = {}) {
    if (this.#state.tabs.length >= TAB_COUNT_LIMIT) return null;
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
    if (!active || active.essential || active.pinned) return null;
    const existing = this.#splitForTab(active.id);
    if (existing && existing.tabIds.length >= 4) return existing.id;
    const newTabId = await this.createTab({
      workspaceId: active.workspaceId,
      activate: false,
    });
    if (!newTabId) return null;
    let group = existing;
    if (group) {
      this.#applyGroupLayout(
        group,
        this.#insertPaneIntoGroup(
          group,
          active.id,
          newTabId,
          direction,
          "after"
        )
      );
    } else {
      const layout = createSplitLayout([active.id, newTabId], direction);
      group = {
        id: randomUUID(),
        workspaceId: active.workspaceId,
        direction: layout?.direction === "column" ? "column" : "row",
        tabIds: splitLayoutPaneIds(layout),
        layout,
      };
      this.#state.splitGroups.push(group);
    }
    this.#coLocateSplitGroup(group, active.id);
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
      source.essential ||
      target.essential ||
      source.pinned ||
      target.pinned ||
      source.id === target.id ||
      source.workspaceId !== target.workspaceId
    ) {
      return false;
    }

    const sourceGroup = this.#splitForTab(source.id);
    const targetGroup = this.#splitForTab(target.id);
    if (sourceGroup && targetGroup && sourceGroup.id === targetGroup.id) {
      this.#applyGroupLayout(
        sourceGroup,
        swapSplitPanes(
          this.#normalizedGroupLayout(sourceGroup),
          source.id,
          target.id
        )
      );
      this.#coLocateSplitGroup(sourceGroup, target.id);
      this.#state.activeWorkspaceId = source.workspaceId;
      this.#state.activeTabId = source.id;
      source.lastActiveAt = Date.now();
      this.#commit();
      this.#focusTab(source.id);
      return sourceGroup.id;
    }
    if (targetGroup && targetGroup.tabIds.length >= 4) return false;

    if (sourceGroup) {
      const sourceLayout = removeSplitPane(
        this.#normalizedGroupLayout(sourceGroup),
        source.id
      );
      const remainingIds = splitLayoutPaneIds(sourceLayout);
      if (remainingIds.length < 2) {
        this.#state.splitGroups = this.#state.splitGroups.filter(
          group => group.id !== sourceGroup.id
        );
        this.#splitLayoutPreviews.delete(sourceGroup.id);
        for (const remainingId of remainingIds) {
          const remainingView = this.#viewFor(remainingId);
          if (remainingView) {
            this.#restoreDesktopLayout(remainingId, remainingView);
          }
        }
      } else {
        this.#applyGroupLayout(sourceGroup, sourceLayout);
      }
    }

    let group = targetGroup;
    if (group) {
      this.#applyGroupLayout(
        group,
        this.#insertPaneIntoGroup(
          group,
          target.id,
          source.id,
          direction,
          placement
        )
      );
    } else {
      const paneIds = placement === "before"
        ? [source.id, target.id]
        : [target.id, source.id];
      const layout = createSplitLayout(paneIds, direction);
      group = {
        id: randomUUID(),
        workspaceId: target.workspaceId,
        direction: layout?.direction === "column" ? "column" : "row",
        tabIds: splitLayoutPaneIds(layout),
        layout,
      };
      this.#state.splitGroups.push(group);
    }

    this.#coLocateSplitGroup(group, target.id);

    this.#state.activeWorkspaceId = source.workspaceId;
    this.#state.activeTabId = source.id;
    source.lastActiveAt = Date.now();
    this.#commit();
    this.#focusTab(source.id);
    return group.id;
  }

  detachSplitTab(
    id,
    targetId = null,
    position = "before",
    moveToEnd = false,
    folderId = undefined
  ) {
    const tab = this.#tab(id);
    const group = tab ? this.#splitForTab(tab.id) : null;
    if (!tab || tab.essential || tab.pinned || !group) return false;
    const shouldMove = Boolean(targetId) || moveToEnd || folderId !== undefined;
    const destination = shouldMove
      ? this.#resolveTabMoveDestination(tab, targetId, folderId)
      : null;
    if (shouldMove && !destination) return false;

    const remainingLayout = removeSplitPane(
      this.#normalizedGroupLayout(group),
      tab.id
    );
    const remainingIds = splitLayoutPaneIds(remainingLayout);
    if (remainingIds.length < 2) {
      this.#state.splitGroups = this.#state.splitGroups.filter(
        item => item.id !== group.id
      );
      this.#splitLayoutPreviews.delete(group.id);
      for (const remainingId of remainingIds) {
        const remainingView = this.#viewFor(remainingId);
        if (remainingView) this.#restoreDesktopLayout(remainingId, remainingView);
      }
    } else {
      this.#applyGroupLayout(group, remainingLayout);
    }

    const view = this.#viewFor(tab.id);
    if (view) this.#restoreDesktopLayout(tab.id, view);
    if (destination) {
      this.#applyResolvedTabMove(
        tab,
        destination,
        targetId ? position : "after"
      );
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
    this.#splitLayoutPreviews.delete(group.id);
    for (const id of group.tabIds) {
      const view = this.#viewFor(id);
      if (view) this.#restoreDesktopLayout(id, view);
    }
    this.#commit();
    return true;
  }

  createFolder(options = {}) {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      this.#state.folders.length >= LIBRARY_CONTAINER_LIMIT
    ) {
      return null;
    }
    const requestedTabIds = Object.hasOwn(options, "tabIds")
      ? options.tabIds
      : [this.#state.activeTabId];
    if (
      !Array.isArray(requestedTabIds) ||
      requestedTabIds.length > FOLDER_MEMBER_LIMIT
    ) {
      return null;
    }
    const usableTabIds = [];
    const seen = new Set();
    for (const requestedId of requestedTabIds) {
      if (!validId(requestedId)) return null;
      const requestedTab = this.#tab(requestedId);
      if (
        !requestedTab ||
        requestedTab.workspaceId !== this.#state.activeWorkspaceId ||
        requestedTab.essential ||
        requestedTab.pinned
      ) {
        return null;
      }
      const group = this.#splitForTab(requestedTab.id);
      const candidateIds = group ? group.tabIds : [requestedTab.id];
      for (const candidateId of candidateIds) {
        const candidate = this.#tab(candidateId);
        if (
          !candidate ||
          candidate.workspaceId !== this.#state.activeWorkspaceId ||
          candidate.essential ||
          candidate.pinned
        ) {
          return null;
        }
        if (!seen.has(candidateId)) {
          seen.add(candidateId);
          usableTabIds.push(candidateId);
        }
      }
    }
    if (usableTabIds.length > FOLDER_MEMBER_LIMIT) return null;
    for (const folder of this.#state.folders) {
      folder.tabIds = folder.tabIds.filter(id => !usableTabIds.includes(id));
    }
    const folder = {
      id: randomUUID(),
      workspaceId: this.#state.activeWorkspaceId,
      name: safeTitle(options.name, "Folder").slice(0, 80),
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

  renameFolder(id, name) {
    if (!validId(id) || typeof name !== "string") return false;
    const folder = this.#state.folders.find(item => item.id === id);
    const value = name.trim().slice(0, 80);
    if (!folder || !value) return false;
    if (folder.name === value) return true;
    folder.name = value;
    this.#commit();
    return true;
  }

  deleteFolder(id) {
    if (!validId(id)) return false;
    const index = this.#state.folders.findIndex(item => item.id === id);
    if (index < 0) return false;
    this.#state.folders.splice(index, 1);
    this.#commit();
    return true;
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

  setAppearance(payload = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }
    const {
      theme,
      reduceTransparency,
      workspaceId,
      workspaceColor,
    } = payload;
    const workspace = this.#workspace(workspaceId);
    const color = typeof workspaceColor === "string" &&
      /^#[\da-f]{6}$/i.test(workspaceColor)
      ? normalizeWorkspaceColor(workspaceColor, "")
      : "";
    if (
      !APPEARANCE_THEME_SET.has(theme) ||
      typeof reduceTransparency !== "boolean" ||
      !validId(workspaceId) ||
      workspaceId !== this.#state.activeWorkspaceId ||
      !workspace ||
      !color
    ) {
      return false;
    }

    const appearance = { theme, reduceTransparency };
    this.#applyAppearance({ ...appearance });
    this.#state.settings.appearance = appearance;
    workspace.color = color;
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
    this.#denyConfiguredSessionPermissions();
    this.#clearSidebarOverlayHideTimer();
    this.#stopSidebarOverlayPointerWatch();
    this.#splitLayoutPreviews.clear();
    for (const id of this.#adaptiveViews.keys()) {
      this.#cancelAdaptiveProbe(id, true);
    }
    this.#destroyPromise = (async () => {
      let remoteViewsDestroyed = false;
      try {
        await this.#commandQueue;
        if (this.#state.history.preferences.clearOnExit) {
          this.#historyService.clear({ range: "all" });
        }
        const remoteContents = [...this.#views.values()].flatMap(view => {
          try {
            return [view.webContents];
          } catch {
            return [];
          }
        });
        await Promise.all([...this.#views.keys()].map(id => this.#destroyView(id)));
        remoteViewsDestroyed = remoteContents.every(contents => {
          try {
            return contents.isDestroyed();
          } catch {
            return true;
          }
        });
        await this.#destroySidebarOverlay();
        await this.#downloadService.flush();
        await this.#store.flush(this.#state);
      } finally {
        this.#releaseConfiguredSessions({
          preservePermissionDeny: !remoteViewsDestroyed,
        });
        this.#downloadService.dispose();
      }
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
    this.#historyNavigationVersions.set(tab.id, 0);
    this.#historyRecordByTab.delete(tab.id);
    this.#historyNextTransitions.delete(tab.id);
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
        this.#tab(tab.id) !== tab ||
        this.#navigationVersions.get(tab.id) !== version ||
        contents.isDestroyed()
      ) {
        return;
      }
      return contents.loadURL(url);
    }).catch(error => {
      const becameDownload = error?.code === "ERR_FAILED" &&
        this.#downloadService.snapshot().some(download => download.url === error?.url);
      if (
        error?.code !== "ERR_ABORTED" &&
        !becameDownload &&
        this.#views.get(tab.id) === view &&
        this.#tab(tab.id) === tab &&
        !this.#destroying
      ) {
        console.warn(`${warning} [${safeErrorCode(error)}]`);
      }
    });
  }

  #isCurrentTabView(tab, view, contents) {
    return Boolean(
      !this.#destroying &&
      this.#views.get(tab.id) === view &&
      this.#tab(tab.id) === tab &&
      contents &&
      !contents.isDestroyed()
    );
  }

  #wireWebContents(tab, view) {
    const contents = view.webContents;
    const isCurrentView = () => this.#isCurrentTabView(tab, view, contents);

    contents.on("focus", () => {
      if (
        !isCurrentView() ||
        !view.getVisible() ||
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
      if (!isCurrentView()) return { action: "deny" };
      if (isSafePageUrl(details.url)) {
        this.#runDetached(this.dispatch(commands.createTab, {
          url: details.url,
          workspaceId: tab.workspaceId,
          activate: true,
        }), "Unable to open page-created tab");
      } else if (/^(mailto|tel):/i.test(details.url)) {
        this.#runDetached(
          this.#confirmExternalOpen(details.url),
          "Unable to open external application"
        );
      }
      return { action: "deny" };
    });

    contents.on("will-navigate", (event, legacyUrl) => {
      if (!isCurrentView()) {
        event.preventDefault();
        return;
      }
      const targetUrl = event.url || legacyUrl;
      if (isSafePageUrl(targetUrl)) return;
      if (/^(mailto|tel):/i.test(targetUrl)) {
        this.#runDetached(
          this.#confirmExternalOpen(targetUrl),
          "Unable to open external application"
        );
      }
      event.preventDefault();
    });

    contents.on("did-start-navigation", details => {
      if (
        !details.isMainFrame ||
        !isCurrentView()
      ) {
        return;
      }
      this.#beginHistoryNavigation(tab, view, contents, details);
      if (!details.isSameDocument) {
        this.#handleAdaptiveNavigationStart(tab.id, view, details.url);
      }
    });

    contents.on("did-redirect-navigation", details => {
      if (
        !details.isMainFrame ||
        !isCurrentView()
      ) {
        return;
      }
      const record = this.#historyRecordByTab.get(tab.id);
      if (record) {
        record.redirected = true;
        record.startedUrl = details.url;
      }
    });

    contents.on("did-start-loading", () => {
      if (!isCurrentView()) return;
      this.#cancelAdaptiveProbe(tab.id, true);
      tab.loading = true;
      tab.crashed = false;
      this.#notify(false);
    });

    contents.on("did-stop-loading", () => {
      if (
        !isCurrentView()
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
      const normalizedUrl = normalizeCommittedPageUrl(currentUrl);
      if (normalizedUrl && tab.url !== normalizedUrl) {
        tab.url = normalizedUrl;
        tab.title = safeTitle(
          contents.getTitle(),
          normalizedUrl.startsWith("chroma:") ? "New Tab" : normalizedUrl
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
      errorCode,
      _errorDescription,
      validatedUrl,
      isMainFrame
    ) => {
      if (!isMainFrame || !isCurrentView()) return;
      const adaptive = this.#adaptiveViews.get(tab.id);
      if (adaptive?.pending) {
        adaptive.pending.failed = true;
      }
      const record = this.#historyRecordByTab.get(tab.id);
      if (record && (!validatedUrl || record.startedUrl === validatedUrl)) {
        record.failed = true;
        record.aborted = errorCode === -3;
      }
    };
    contents.on("did-fail-load", markFailedAdaptiveLoad);
    contents.on("did-fail-provisional-load", markFailedAdaptiveLoad);

    const handleNavigation = (url, sameDocument = false) => {
      if (
        !isCurrentView()
      ) {
        return;
      }
      const normalizedUrl = normalizeCommittedPageUrl(url);
      if (!normalizedUrl) return;
      tab.url = normalizedUrl;
      tab.crashed = false;
      this.#refreshNavigationState(tab, contents);
      this.#recordHistory(tab, view, contents, normalizedUrl, sameDocument);
      this.#commit();
    };
    contents.on("did-navigate", (_event, url) => {
      if (!isCurrentView()) return;
      this.#markAdaptiveTransitionCommitted(tab.id, view);
      handleNavigation(url);
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame && isCurrentView()) handleNavigation(url, true);
    });

    contents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      if (!isCurrentView()) return;
      tab.title = safeTitle(title, tab.url.startsWith("chroma:") ? "New Tab" : tab.url);
      this.#updateLatestHistoryTitle(tab, view, contents, title);
      this.#commit();
    });

    contents.on("page-favicon-updated", (_event, favicons) => {
      if (!isCurrentView()) return;
      const favicon = Array.isArray(favicons)
        ? favicons
            .slice(0, 32)
            .map(normalizeTabFavicon)
            .find(Boolean)
        : "";
      if (!favicon) return;
      tab.favicon = favicon;
      this.#commit();
    });

    contents.on("media-started-playing", () => {
      if (!isCurrentView()) return;
      tab.audible = true;
      this.#notify(false);
    });
    contents.on("media-paused", () => {
      if (!isCurrentView()) return;
      tab.audible = false;
      this.#notify(false);
    });

    contents.on("render-process-gone", (_event, details) => {
      if (!isCurrentView()) return;
      tab.loading = false;
      tab.crashed = true;
      tab.title = details.reason === "killed" ? tab.title : "Tab crashed";
      this.#notify(false);
    });

    contents.on("context-menu", (_event, params) => {
      if (!isCurrentView()) return;
      this.#showContextMenu(tab, view, contents, params);
    });

    contents.on("before-input-event", (event, input) => {
      if (!isCurrentView()) return;
      if (
        !["keyDown", "rawKeyDown"].includes(input.type) ||
        input.isAutoRepeat
      ) {
        return;
      }
      const modifier = activeModifier(input);
      const key = String(input.key || "").toLowerCase();
      if (modifier && key === "l") {
        event.preventDefault();
        this.focusAddress();
      } else if (modifier && input.shift && !input.alt && key === "p") {
        event.preventDefault();
        this.openCommandPalette();
      } else if (
        modifier &&
        !input.shift &&
        !input.alt &&
        key === (process.platform === "darwin" ? "y" : "h")
      ) {
        event.preventDefault();
        this.openHistory();
      } else if (modifier && input.shift && key === "t") {
        event.preventDefault();
        this.#runDetached(
          this.dispatch(commands.reopenTab),
          "Unable to reopen closed tab"
        );
      } else if (modifier && key === "t") {
        event.preventDefault();
        this.#runDetached(this.dispatch(commands.createTab), "Unable to create tab");
      } else if (modifier && key === "w") {
        event.preventDefault();
        this.#runDetached(
          this.dispatch(commands.closeTab, { id: tab.id }),
          "Unable to close tab"
        );
      } else if (modifier && key === "r") {
        event.preventDefault();
        this.reload(tab.id);
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
    installInternalProtocol(browserSession.protocol);
    const permissionDecisions = new Map();
    browserSession.setUserAgent(
      withoutElectronUserAgent(browserSession.getUserAgent())
    );

    browserSession.setPermissionRequestHandler(
      (webContents, permission, callback, details) => {
        if (
          this.#destroying ||
          !this.#ownsPageWebContents(webContents) ||
          !ALLOWED_PERMISSIONS.has(permission)
        ) {
          callback(false);
          return;
        }

        let decisionKey;
        let mediaTypes = null;
        let mediaScope = null;
        let permissionLabel = permission;
        let origin = this.#webOrigin(
          details?.requestingUrl || webContents.getURL()
        );
        if (permission === "media") {
          mediaTypes = normalizedMediaTypes(details);
          mediaScope = this.#mediaPermissionScope(webContents, details, origin);
          if (!mediaTypes || !mediaScope) {
            callback(false);
            return;
          }
          origin = mediaScope.requestingOrigin;
          decisionKey = this.#mediaCombinationDecisionKey(mediaScope, mediaTypes);
          permissionLabel = mediaPermissionLabel(mediaTypes);
        } else {
          decisionKey = `${origin}|${permission}`;
        }
        if (!origin) {
          callback(false);
          return;
        }
        if (permissionDecisions.has(decisionKey)) {
          callback(permissionDecisions.get(decisionKey));
          return;
        }
        if (
          mediaScope &&
          mediaTypes.length > 1 &&
          mediaTypes.every(type =>
            permissionDecisions.get(
              this.#mediaTypeDecisionKey(mediaScope, type)
            ) === true
          )
        ) {
          permissionDecisions.set(decisionKey, true);
          callback(true);
          return;
        }
        if (mediaScope && mediaTypes.length === 1) {
          const typeDecisionKey = this.#mediaTypeDecisionKey(
            mediaScope,
            mediaTypes[0]
          );
          if (permissionDecisions.has(typeDecisionKey)) {
            const allowed = permissionDecisions.get(typeDecisionKey);
            permissionDecisions.set(decisionKey, allowed);
            callback(allowed);
            return;
          }
        }
        const host = new URL(origin).host;
        void dialog
          .showMessageBox(this.#window, {
            type: "question",
            buttons: ["Allow", "Block"],
            defaultId: 1,
            cancelId: 1,
            title: "Site permission",
            message: `${host} wants permission to use ${permissionLabel}.`,
            detail: "This decision applies until the browser is closed.",
          })
          .then(result => {
            const allowed = !this.#destroying &&
              this.#ownsPageWebContents(webContents) &&
              result.response === 0;
            permissionDecisions.set(decisionKey, allowed);
            if (allowed && mediaScope) {
              for (const type of mediaTypes) {
                permissionDecisions.set(
                  this.#mediaTypeDecisionKey(mediaScope, type),
                  true
                );
              }
            }
            callback(allowed);
          })
          .catch(() => callback(false));
      }
    );

    browserSession.setPermissionCheckHandler(
      (webContents, permission, requestingOrigin, details) => {
        if (
          this.#destroying ||
          !this.#ownsPageWebContents(webContents) ||
          !ALLOWED_PERMISSIONS.has(permission)
        ) {
          return false;
        }
        const origin = this.#webOrigin(details?.requestingUrl || requestingOrigin);
        if (permission === "media") {
          const mediaType = details?.mediaType;
          const mediaScope = MEDIA_PERMISSION_TYPES.has(mediaType)
            ? this.#mediaPermissionScope(webContents, details, origin)
            : null;
          return Boolean(
            mediaScope &&
            permissionDecisions.get(
              this.#mediaTypeDecisionKey(mediaScope, mediaType)
            ) === true
          );
        }
        return origin
          ? permissionDecisions.get(`${origin}|${permission}`) === true
          : false;
      }
    );

    browserSession.setDevicePermissionHandler(() => false);

    const willDownload = (_event, item) => {
      try {
        this.#downloadService.register(item);
      } catch (error) {
        if (!this.#destroying) console.warn("Unable to register download:", error);
      }
    };
    browserSession.on("will-download", willDownload);
    this.#configuredSessions.set(browserSession, { willDownload });
  }

  #denyConfiguredSessionPermissions() {
    for (const browserSession of this.#configuredSessions.keys()) {
      try {
        browserSession.setPermissionRequestHandler(denyPermissionRequest);
        browserSession.setPermissionCheckHandler(denyPermissionCheck);
        browserSession.setDevicePermissionHandler(denyDevicePermission);
      } catch (error) {
        console.warn(
          `Unable to lock down browser permissions [${safeErrorCode(error)}]`
        );
      }
    }
  }

  #releaseConfiguredSessions({ preservePermissionDeny = false } = {}) {
    for (const [browserSession, handlers] of this.#configuredSessions) {
      try {
        browserSession.removeListener("will-download", handlers.willDownload);
        if (preservePermissionDeny) {
          browserSession.setPermissionRequestHandler(denyPermissionRequest);
          browserSession.setPermissionCheckHandler(denyPermissionCheck);
          browserSession.setDevicePermissionHandler(denyDevicePermission);
        } else {
          browserSession.setPermissionRequestHandler(null);
          browserSession.setPermissionCheckHandler(null);
          browserSession.setDevicePermissionHandler(null);
        }
      } catch (error) {
        if (!this.#destroying) console.warn("Unable to release browser session:", error);
      }
    }
    this.#configuredSessions.clear();
  }

  #ownsPageWebContents(candidate) {
    if (!candidate) return false;
    try {
      if (candidate.isDestroyed()) return false;
    } catch {
      return false;
    }
    for (const view of this.#views.values()) {
      try {
        if (view.webContents === candidate) return true;
      } catch {
        // A view can be invalidated while the session is dispatching a check.
      }
    }
    return false;
  }

  #mediaPermissionScope(webContents, details = {}, fallbackOrigin = "") {
    const requestingOrigin = this.#webOrigin(
      details.requestingUrl || fallbackOrigin || webContents?.getURL()
    );
    const securityOrigin = this.#webOrigin(details.securityOrigin) || requestingOrigin;
    const isMainFrame = details.isMainFrame === true;
    const embeddingOrigin = isMainFrame
      ? requestingOrigin
      : this.#webOrigin(details.embeddingOrigin) ||
        this.#webOrigin(webContents?.getURL());
    if (!requestingOrigin || !securityOrigin || !embeddingOrigin) return null;
    return {
      requestingOrigin,
      securityOrigin,
      embeddingOrigin,
      isMainFrame,
    };
  }

  #mediaDecisionScopeKey(scope) {
    return JSON.stringify([
      scope.requestingOrigin,
      scope.securityOrigin,
      scope.embeddingOrigin,
      scope.isMainFrame,
    ]);
  }

  #mediaTypeDecisionKey(scope, type) {
    return `media:type:${type}:${this.#mediaDecisionScopeKey(scope)}`;
  }

  #mediaCombinationDecisionKey(scope, types) {
    return `media:set:${types.join("+")}:${this.#mediaDecisionScopeKey(scope)}`;
  }

  #showContextMenu(tab, view, contents, params) {
    if (!this.#isCurrentTabView(tab, view, contents)) return;
    const template = [];
    if (params.linkURL) {
      template.push(
        {
          label: "Open Link in New Tab",
          click: () => {
            if (!this.#isCurrentTabView(tab, view, contents)) return;
            this.#runDetached(this.dispatch(commands.createTab, {
              url: params.linkURL,
              workspaceId: tab.workspaceId,
            }), "Unable to open context-menu link");
          },
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
      {
        label: "Inspect",
        click: () => {
          if (this.#isCurrentTabView(tab, view, contents)) {
            contents.inspectElement(params.x, params.y);
          }
        },
      }
    );
    if (!this.#window.isDestroyed()) {
      Menu.buildFromTemplate(template).popup({ window: this.#window });
    }
  }

  async #confirmExternalOpen(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!["mailto:", "tel:"].includes(parsed.protocol)) return false;
    if (this.#destroying || this.#window.isDestroyed()) return false;
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

  #runHistoryRead(operation) {
    try {
      return operation();
    } catch (error) {
      if (
        typeof error?.code === "string" &&
        !String(error.message || "").includes(error.code)
      ) {
        error.message = `${error.code}: ${error.message}`;
      }
      throw error;
    }
  }

  #commitHistoryMutation(operation) {
    const revision = this.#state.history.revision;
    const result = this.#runHistoryRead(operation);
    if (this.#state.history.revision !== revision) this.#commit();
    return result;
  }

  #beginHistoryNavigation(tab, view, contents, details) {
    if (
      this.#destroying ||
      this.#views.get(tab.id) !== view ||
      this.#tab(tab.id) !== tab ||
      contents.isDestroyed()
    ) {
      return;
    }

    const version = (this.#historyNavigationVersions.get(tab.id) || 0) + 1;
    this.#historyNavigationVersions.set(tab.id, version);
    const requestedTransition = this.#historyNextTransitions.get(tab.id);
    this.#historyNextTransitions.delete(tab.id);
    const previousUrl = tab.url;
    const inferredTransition =
      details.isSameDocument !== true && details.url === previousUrl
        ? "reload"
        : details.initiator
          ? "link"
          : "other";
    this.#historyRecordByTab.set(tab.id, {
      version,
      previousUrl,
      startedUrl: details.url,
      sameDocument: details.isSameDocument === true,
      transition: requestedTransition || inferredTransition,
      redirected: false,
      failed: false,
      aborted: false,
      entryId: null,
      committedUrl: null,
    });
  }

  #recordHistory(tab, view, contents, url, sameDocument) {
    if (
      this.#destroying ||
      this.#views.get(tab.id) !== view ||
      this.#tab(tab.id) !== tab ||
      contents.isDestroyed()
    ) {
      return;
    }

    let record = this.#historyRecordByTab.get(tab.id);
    if (!record) {
      const version = (this.#historyNavigationVersions.get(tab.id) || 0) + 1;
      this.#historyNavigationVersions.set(tab.id, version);
      record = {
        version,
        previousUrl: tab.url,
        startedUrl: url,
        sameDocument: sameDocument === true,
        transition: "other",
        redirected: false,
        failed: false,
        aborted: false,
        entryId: null,
        committedUrl: null,
      };
      this.#historyRecordByTab.set(tab.id, record);
    }

    try {
      const result = this.#historyService.append({
        tabId: tab.id,
        navigationVersion: record.version,
        url,
        title: contents.getTitle(),
        transition: record.redirected ? "redirect" : record.transition,
        isMainFrame: true,
        committed: true,
        failed: record.failed,
        aborted: record.aborted,
        sameDocument: sameDocument === true || record.sameDocument,
        previousUrl: record.previousUrl,
      });
      if (result.recorded) {
        record.entryId = result.id;
        record.committedUrl = result.entry.url;
      }
    } catch (error) {
      if (!this.#destroying) console.warn("Unable to record browser history:", error);
    }
  }

  #updateLatestHistoryTitle(tab, view, contents, title) {
    if (
      this.#destroying ||
      this.#views.get(tab.id) !== view ||
      this.#tab(tab.id) !== tab ||
      contents.isDestroyed()
    ) {
      return;
    }
    const record = this.#historyRecordByTab.get(tab.id);
    if (!record?.entryId) return;
    try {
      this.#historyService.updateTitle({
        tabId: tab.id,
        navigationVersion: record.version,
        entryId: record.entryId,
        url: contents.getURL() || record.committedUrl,
        title,
      });
    } catch (error) {
      if (!this.#destroying) console.warn("Unable to update browser history title:", error);
    }
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
    let visibleIds = this.#visibleTabIds();
    let rects = [];
    if (this.#contentBounds && visibleIds.length) {
      const group = this.#splitForTab(this.#state.activeTabId);
      if (group) {
        const layout = this.#splitLayoutPreviews.get(group.id) ||
          this.#normalizedGroupLayout(group);
        const geometry = splitLayoutRects(this.#contentBounds, layout);
        const visibleSet = new Set(visibleIds);
        const visibleGeometry = geometry.paneIds
          .map((id, index) => ({ id, rect: geometry.viewRects[index] }))
          .filter(item => visibleSet.has(item.id) && item.rect);
        visibleIds = visibleGeometry.map(item => item.id);
        rects = visibleGeometry.map(item => item.rect);
      } else {
        rects = [{ ...this.#contentBounds }];
      }
    }
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
      if (this.#destroying) return;
      const view = this.#viewFor(id);
      if (view?.getVisible() && !view.webContents.isDestroyed()) view.webContents.focus();
    });
  }

  #removeTabFromFoldersAndSplits(id) {
    for (const folder of this.#state.folders) {
      folder.tabIds = folder.tabIds.filter(tabId => tabId !== id);
    }
    const splitGroups = [];
    for (const group of this.#state.splitGroups) {
      if (!group.tabIds.includes(id)) {
        splitGroups.push(group);
        continue;
      }
      let layout = removeSplitPane(this.#normalizedGroupLayout(group), id);
      let remainingIds = splitLayoutPaneIds(layout);
      // A three-pane grid can collapse to a column when its full-height pane
      // is removed. Two surviving panes use the canonical left/right layout,
      // independent of which grid leaf was closed.
      if (group.direction === "grid" && remainingIds.length === 2) {
        layout = createSplitLayout(remainingIds, "row");
        remainingIds = splitLayoutPaneIds(layout);
      }
      this.#splitLayoutPreviews.delete(group.id);
      if (remainingIds.length < 2) {
        for (const survivorId of remainingIds) {
          const survivorView = this.#viewFor(survivorId);
          if (survivorView) {
            this.#restoreDesktopLayout(survivorId, survivorView);
          }
        }
        continue;
      }
      this.#applyGroupLayout(group, layout);
      splitGroups.push(group);
    }
    this.#state.splitGroups = splitGroups;
  }

  #insertPaneIntoGroup(
    group,
    targetPaneId,
    newPaneId,
    direction = "row",
    placement = "after"
  ) {
    const layout = this.#normalizedGroupLayout(group);
    const paneIds = splitLayoutPaneIds(layout);
    if (
      !paneIds.includes(targetPaneId) ||
      paneIds.includes(newPaneId) ||
      paneIds.length >= 4
    ) {
      return layout;
    }
    return insertSplitPane(
      layout,
      targetPaneId,
      newPaneId,
      direction,
      placement
    );
  }

  #normalizedGroupLayout(group) {
    return sanitizeSplitLayout(group?.layout, group?.tabIds, {
      direction: group?.direction === "column" ? "column" : "row",
    });
  }

  #applyGroupLayout(group, layout) {
    if (!group) return [];
    this.#splitLayoutPreviews.delete(group.id);
    const normalized = sanitizeSplitLayout(layout, splitLayoutPaneIds(layout), {
      direction: group.direction === "column" ? "column" : "row",
    });
    const tabIds = splitLayoutPaneIds(normalized);
    group.layout = normalized;
    group.tabIds = tabIds;
    group.direction = tabIds.length > 2
      ? "grid"
      : normalized?.direction === "column"
        ? "column"
        : "row";
    return tabIds;
  }

  #coLocateSplitGroup(group, targetId) {
    if (!group || !group.tabIds.includes(targetId)) return;
    const groupIds = new Set(group.tabIds);
    const targetFolder = this.#state.folders.find(folder =>
      folder.workspaceId === group.workspaceId && folder.tabIds.includes(targetId)
    );
    const originalTargetIndex = targetFolder?.tabIds.indexOf(targetId) ?? -1;
    const insertAt = targetFolder
      ? targetFolder.tabIds
          .slice(0, originalTargetIndex)
          .filter(tabId => !groupIds.has(tabId)).length
      : -1;

    for (const folder of this.#state.folders) {
      folder.tabIds = folder.tabIds.filter(tabId => !groupIds.has(tabId));
    }
    if (targetFolder) {
      targetFolder.tabIds.splice(insertAt, 0, ...group.tabIds);
      targetFolder.expanded = true;
    }
  }

  async #destroyView(id) {
    const view = this.#views.get(id);
    if (!view) return;
    this.#cancelAdaptiveProbe(id, true);
    this.#adaptiveViews.delete(id);
    this.#views.delete(id);
    this.#viewReady.delete(id);
    this.#navigationVersions.delete(id);
    this.#historyNavigationVersions.delete(id);
    this.#historyRecordByTab.delete(id);
    this.#historyNextTransitions.delete(id);
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
