import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  Menu,
  WebContentsView,
  clipboard,
  dialog,
  globalShortcut,
  session,
  shell,
  screen,
  webContents,
} from "electron";

import { channels, commands } from "../shared/channels.mjs";
import { APPEARANCE_THEMES } from "../shared/appearance.mjs";
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  applySplitRatioPreset,
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
  decrementPageZoom,
  incrementPageZoom,
  pageZoomFactorToPercent,
  pageZoomPercentToFactor,
  resetPageZoom,
} from "../shared/page-zoom.mjs";
import { shortcutActionForInput } from "../shared/shortcut-registry.mjs";
import {
  BOOKMARK_IMPORT_MAX_BYTES,
  parseBookmarksHtml,
  serializeBookmarks,
} from "../shared/bookmark-io.mjs";
import {
  CONTAINER_LIMIT,
  LIVE_FOLDER_ITEM_LIMIT,
  LIVE_FOLDER_LIMIT,
  TAB_COUNT_LIMIT,
  TAB_URL_MAX_LENGTH,
  isPartitionSafeContainerId,
  normalizeLiveFolderSourceUrl,
  normalizeTabFavicon,
  normalizeContainerProxy,
  normalizeContainerUserAgent,
  normalizeWorkspaceColor,
} from "../shared/model.mjs";
import {
  BOOKMARK_FOLDER_DEPTH_LIMIT,
  BOOKMARK_FOLDER_LIMIT,
  BOOKMARK_FOLDER_MEMBER_LIMIT,
  FOLDER_MEMBER_LIMIT,
  LIBRARY_CONTAINER_LIMIT,
} from "../shared/state-invariants.mjs";
import { createDownloadService } from "./download-service.mjs";
import { createExtensionService } from "./extension-service.mjs";
import { fetchFeed } from "./feed-service.mjs";
import { createHistoryService } from "./history-service.mjs";
import { installInternalProtocol } from "./internal-pages.mjs";

const MAX_CLOSED_TABS = 25;
// Live folders only re-fetch a feed after this long, no matter how the
// refresh was triggered from the shell, so a hostile page cannot turn the
// browser into a request loop against the feed host.
const LIVE_FOLDER_MANUAL_REFRESH_MS = 30 * 1_000;
const LIVE_FOLDER_STALE_MS = 15 * 60 * 1_000;
const LIVE_FOLDER_SWEEP_MS = 5 * 60 * 1_000;
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

// Artwork reaches the shell as an <img> source, so only http(s) URLs and
// bounded raster data URIs are allowed through.
function safeArtworkUrl(value) {
  if (typeof value !== "string" || !value || value.length > 262_144) return "";
  if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(value)) return value;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && value.length <= 2_048
      ? url.href
      : "";
  } catch {
    return "";
  }
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
  #extensionService = null;
  #extensionRegistryFile = null;
  #liveFolderFetch = null;
  #liveFolderRefreshes = new Set();
  #liveFolderSweepTimer = null;
  #glance = null;
  #extensionPopup = null;
  #mediaTabs = new Set();
  #mediaKeyRegistered = false;
  #pendingAuthRequests = [];
  #uaOverrides = new Map();
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
  #destroyingViewIds = new Set();
  #shellShortcutHandlers = new Map();

  constructor(
    browserWindow,
    state,
    stateStore,
    {
      registerShellWebContents = () => {},
      unregisterShellWebContents = () => {},
      applyAppearance = () => {},
      extensionRegistryFile = null,
      liveFolderFetch = null,
    } = {}
  ) {
    this.#extensionRegistryFile = extensionRegistryFile;
    this.#liveFolderFetch = liveFolderFetch;
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
    this.#wireShellShortcuts(this.#window.webContents);
    const { prunedCount } = this.#historyService.prune();
    if (prunedCount) this.#store.scheduleSave(this.#state);
    if (this.#extensionRegistryFile) {
      try {
        this.#extensionService = createExtensionService({
          browserSession: session.fromPartition("persist:chroma-main"),
          registryFile: this.#extensionRegistryFile,
          onChange: () => {
            if (!this.#destroying) this.#notify(false);
          },
        });
        const { failures } = await this.#extensionService.loadInstalled();
        for (const failure of failures) {
          console.warn(
            `Unable to restore extension at ${failure.path}: ${failure.message}`
          );
        }
      } catch (error) {
        this.#extensionService = null;
        console.warn(`Unable to start the extension service: ${error?.message}`);
      }
    }
    try {
      // Media-key registration can be refused by the OS (e.g. macOS without
      // accessibility trust); the browser works identically without it.
      this.#mediaKeyRegistered = globalShortcut.register("MediaPlayPause", () => {
        if (this.#destroying || !this.#acceptCommands) return;
        this.#runDetached(
          this.playPauseMostRecentMedia(),
          "Unable to handle the media key"
        );
      }) === true;
    } catch {
      this.#mediaKeyRegistered = false;
    }
    for (const container of this.#state.containers) {
      if (container.proxy) await this.#applyContainerProxy(container);
    }
    this.#liveFolderSweepTimer = setInterval(() => {
      this.#refreshStaleLiveFolders();
    }, LIVE_FOLDER_SWEEP_MS);
    this.#liveFolderSweepTimer.unref?.();
    this.#refreshStaleLiveFolders();
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
      glance: this.#glance
        ? { open: true, url: this.#glance.url, sourceTabId: this.#glance.sourceTabId }
        : { open: false },
      extensionPopup: this.#extensionPopup
        ? { open: true, extensionId: this.#extensionPopup.extensionId }
        : { open: false },
      mediaTabIds: [...this.#mediaTabs].filter(id =>
        this.#state.tabs.some(tab => tab.id === id)
      ),
      uaOverrides: Object.fromEntries(this.#uaOverrides),
      pendingAuth: this.#pendingAuthRequests.length
        ? {
            id: this.#pendingAuthRequests[0].id,
            host: this.#pendingAuthRequests[0].host,
            realm: this.#pendingAuthRequests[0].realm,
            isProxy: this.#pendingAuthRequests[0].isProxy,
          }
        : null,
      extensions: this.#extensionService?.snapshot() || [],
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
        sidebarOverlayVisible: this.#safeViewVisible(this.#sidebarOverlayView),
        sidebarOverlayReady: this.#sidebarOverlayReady,
        canReopenTab: this.#closedTabs.length > 0,
        sidebarOverlayBounds: this.#safeViewBounds(this.#sidebarOverlayView),
        ...(process.env.CHROMA_HEADLESS_SMOKE === "1"
          ? {
              windowBounds: this.#window.getBounds(),
              contentBounds: this.#contentBounds
                ? { ...this.#contentBounds }
                : null,
              viewBounds: Object.fromEntries(
                [...this.#views].map(([id, view]) => [
                  id,
                  this.#safeViewBounds(view),
                ])
              ),
            }
          : {}),
      },
    };
  }

  async getSmokeViewports(options = {}) {
    if (process.env.CHROMA_HEADLESS_SMOKE !== "1") {
      throw new Error("Viewport diagnostics are only available during smoke tests");
    }
    const forceCrashTabId = validId(options?.forceCrashTabId)
      ? options.forceCrashTabId
      : null;
    if (forceCrashTabId) {
      const contents = this.#safeViewContents(this.#viewFor(forceCrashTabId));
      if (!contents) return false;
      try {
        contents.forcefullyCrashRenderer();
        return true;
      } catch {
        return false;
      }
    }
    const entries = await Promise.all(
      [...this.#views].map(async ([id, view]) => {
        const bounds = this.#safeViewBounds(view);
        const contents = this.#safeViewContents(view, { allowDestroyed: true });
        const tab = this.#tab(id);
        if (!contents) return [id, { bounds, unavailable: true, destroyed: true }];
        if (tab?.crashed) {
          let destroyed = true;
          try {
            destroyed = contents.isDestroyed();
          } catch {
            // Treat an inaccessible wrapper as destroyed diagnostics.
          }
          return [id, {
            bounds,
            nativeVisible: this.#safeViewVisible(view),
            url: tab.url,
            crashed: true,
            destroyed,
          }];
        }
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
            nativeVisible: this.#safeViewVisible(view),
            url: contents.getURL(),
            adaptiveMode: this.#adaptiveViews.get(id)?.mode || "desktop",
            adaptivePendingMode: this.#adaptiveViews.get(id)?.pending?.mode || null,
            pageZoomFactor: contents.getZoomFactor(),
            ...viewport,
            destroyed: false,
          }];
        } catch {
          let destroyed = true;
          try {
            destroyed = contents.isDestroyed();
          } catch {
            // Treat an inaccessible wrapper as destroyed diagnostics.
          }
          return [id, { bounds, unavailable: true, destroyed }];
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
      case commands.recoverTab:
        return this.recoverTab(payload.id);
      case commands.discardTab:
        return this.discardTab(payload.id);
      case commands.reopenTab:
        return this.reopenClosedTab();
      case commands.reorderTab:
        return this.reorderTab(
          payload.id,
          payload.targetId || payload.beforeId || null,
          payload.position,
          Object.hasOwn(payload, "folderId") ? payload.folderId : undefined
        );
      case commands.moveTabToWorkspace:
        return this.moveTabToWorkspace(payload.id, payload.workspaceId);
      case commands.selectNextTab:
        return this.selectAdjacentTab(1);
      case commands.selectPreviousTab:
        return this.selectAdjacentTab(-1);
      case commands.navigate:
        return this.navigate(payload.id, payload.input);
      case commands.back:
        return this.goBack(payload.id);
      case commands.forward:
        return this.goForward(payload.id);
      case commands.reload:
        return this.reload(payload.id);
      case commands.reloadIgnoringCache:
        return this.reloadIgnoringCache(payload.id);
      case commands.stop:
        return this.stop(payload.id);
      case commands.toggleMediaPlayback:
        return this.toggleMediaPlayback(payload.id);
      case commands.queryNowPlaying:
        return this.queryNowPlaying();
      case commands.togglePictureInPicture:
        return this.togglePictureInPicture(payload.id);
      case commands.toggleMute:
        return this.toggleMute(payload.id);
      case commands.togglePin:
        return this.togglePin(payload.id);
      case commands.toggleEssential:
        return this.toggleEssential(payload.id);
      case commands.resetEssential:
        return this.resetEssential(payload.id);
      case commands.setTabUserAgentMode:
        return this.setTabUserAgentMode(payload.id, payload.mode);
      case commands.toggleBookmark:
        return this.toggleBookmark(payload.id);
      case commands.removeBookmark:
        return this.removeBookmark(payload.id);
      case commands.renameBookmark:
        return this.renameBookmark(payload.id, payload.title);
      case commands.moveBookmark:
        return this.moveBookmark(payload);
      case commands.importBookmarks:
        return this.importBookmarks(payload);
      case commands.exportBookmarks:
        return this.exportBookmarks(payload);
      case commands.createBookmarkFolder:
        return this.createBookmarkFolder(payload);
      case commands.toggleBookmarkFolder:
        return this.toggleBookmarkFolder(payload.id);
      case commands.renameBookmarkFolder:
        return this.renameBookmarkFolder(payload.id, payload.name);
      case commands.deleteBookmarkFolder:
        return this.deleteBookmarkFolder(payload.id);
      case commands.moveBookmarkFolder:
        return this.moveBookmarkFolder(payload);
      case commands.createLiveFolder:
        return this.createLiveFolder(payload);
      case commands.toggleLiveFolder:
        return this.toggleLiveFolder(payload.id);
      case commands.renameLiveFolder:
        return this.renameLiveFolder(payload.id, payload.name);
      case commands.deleteLiveFolder:
        return this.deleteLiveFolder(payload.id);
      case commands.refreshLiveFolder:
        return this.refreshLiveFolder(payload.id);
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
      case commands.deleteWorkspace:
        return this.deleteWorkspace(payload.id);
      case commands.reorderWorkspace:
        return this.reorderWorkspace(
          payload.id,
          payload.targetId,
          payload.position
        );
      case commands.selectNextWorkspace:
        return this.selectAdjacentWorkspace(1);
      case commands.selectPreviousWorkspace:
        return this.selectAdjacentWorkspace(-1);
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
      case commands.setSplitPreset:
        return this.setSplitPreset(payload);
      case commands.createFolder:
        return this.createFolder(payload);
      case commands.toggleFolder:
        return this.toggleFolder(payload.id);
      case commands.renameFolder:
        return this.renameFolder(payload.id, payload.name);
      case commands.deleteFolder:
        return this.deleteFolder(payload.id);
      case commands.createContainer:
        return this.createContainer(payload);
      case commands.renameContainer:
        return this.renameContainer(payload.id, payload.name);
      case commands.deleteContainer:
        return this.deleteContainer(payload.id);
      case commands.setContainerColor:
        return this.setContainerColor(payload.id, payload.color);
      case commands.setContainerProxy:
        return this.setContainerProxy(payload.id, payload.proxy);
      case commands.setContainerUserAgent:
        return this.setContainerUserAgent(payload.id, payload.userAgent);
      case commands.reopenTabInContainer:
        return this.reopenTabInContainer(payload.id, payload.containerId);
      case commands.clearSiteData:
        return this.clearSiteData(payload.id);
      case commands.submitAuthCredentials:
        return this.submitAuthCredentials(payload);
      case commands.cancelAuthRequest:
        return this.cancelAuthRequest(payload);
      case commands.openGlance:
        return this.openGlance(payload.url, payload.sourceTabId);
      case commands.closeGlance:
        return this.closeGlance();
      case commands.promoteGlance:
        return this.promoteGlance();
      case commands.openExtensionPopup:
        return this.openExtensionPopup(payload.id);
      case commands.closeExtensionPopup:
        return this.closeExtensionPopup();
      case commands.installExtension:
        return this.installExtension(payload.path);
      case commands.removeExtension:
        return this.removeExtension(payload.id);
      case commands.reloadExtension:
        return this.reloadExtension(payload.id);
      case commands.toggleSidebar:
        return this.toggleSidebar();
      case commands.setSidebarWidth:
        return this.setSidebarWidth(payload.width);
      case commands.setAppearance:
        return this.setAppearance(payload);
      case commands.zoomIn:
        return this.changePageZoom(payload.id, "in");
      case commands.zoomOut:
        return this.changePageZoom(payload.id, "out");
      case commands.zoomReset:
        return this.changePageZoom(payload.id, "reset");
      case commands.openDownloads:
        return this.openDownloads();
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

  setSplitPreset({ ratio } = {}) {
    const group = this.#splitForTab(this.#state.activeTabId);
    if (
      !group ||
      typeof ratio !== "number" ||
      !Number.isFinite(ratio) ||
      ratio < MIN_SPLIT_RATIO ||
      ratio > MAX_SPLIT_RATIO
    ) {
      return false;
    }
    const layout = this.#normalizedGroupLayout(group);
    if (!layout || layout.type !== "split") return false;
    this.#splitLayoutPreviews.delete(group.id);
    this.#applyGroupLayout(group, applySplitRatioPreset(layout, ratio));
    this.#commit();
    return true;
  }

  #createTabRecord({
    url = "chroma://newtab/",
    workspaceId = this.#state.activeWorkspaceId,
    containerId = "",
    essential = false,
    pinned = false,
  } = {}) {
    const workspace = this.#workspace(workspaceId) || this.#activeWorkspace();
    const normalizedUrl = normalizeRequestedPageUrl(url);
    const isEssential = Boolean(essential);
    const requestedContainerId = typeof containerId === "string" ? containerId : "";
    return {
      id: randomUUID(),
      workspaceId: workspace.id,
      containerId:
        this.#state.containers?.some(container => container.id === requestedContainerId)
          ? requestedContainerId
          : "",
      url: normalizedUrl,
      title: normalizedUrl.startsWith("chroma://newtab") ? "New Tab" : "Loading…",
      favicon: "",
      essential: isEssential,
      essentialUrl:
        isEssential && /^https?:\/\//i.test(normalizedUrl) ? normalizedUrl : "",
      pinned: isEssential || Boolean(pinned),
      muted: false,
      audible: false,
      loading: true,
      crashed: false,
      canGoBack: false,
      canGoForward: false,
      lastActiveAt: Date.now(),
    };
  }

  async createTab({
    url = "chroma://newtab/",
    workspaceId = this.#state.activeWorkspaceId,
    containerId = "",
    activate = true,
    essential = false,
    pinned = false,
  } = {}) {
    if (this.#state.tabs.length >= TAB_COUNT_LIMIT) return null;
    const tab = this.#createTabRecord({
      url,
      workspaceId,
      containerId,
      essential,
      pinned,
    });
    const workspace = this.#workspace(tab.workspaceId) || this.#activeWorkspace();
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
    this.#restoreDiscardedTab(tab);
    this.#state.activeWorkspaceId = tab.workspaceId;
    this.#state.activeTabId = tab.id;
    tab.lastActiveAt = Date.now();
    this.#commit();
    this.#focusTab(tab.id);
    return true;
  }

  selectAdjacentTab(delta) {
    if (delta !== 1 && delta !== -1) return false;
    const tabs = this.#tabsForWorkspace(this.#state.activeWorkspaceId);
    if (tabs.length < 2) return false;
    const currentIndex = tabs.findIndex(tab => tab.id === this.#state.activeTabId);
    const nextIndex = (Math.max(0, currentIndex) + delta + tabs.length) % tabs.length;
    return this.selectTab(tabs[nextIndex].id);
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

  async recoverTab(id = this.#state.activeTabId) {
    const tab = this.#tab(id);
    const currentView = this.#viewFor(id);
    if (!tab?.crashed || !currentView) return false;

    const contents = this.#safeViewContents(currentView);
    if (contents) {
      try {
        tab.crashed = false;
        tab.loading = true;
        this.#historyNextTransitions.set(id, "reload");
        this.#cancelAdaptiveProbe(id, true);
        contents.reload();
        this.#commit();
        this.#focusTab(id);
        return true;
      } catch {
        // A WebContents can be destroyed between isDestroyed() and reload().
        // Fall through to rebuilding the native view while preserving the tab.
        tab.crashed = true;
        tab.loading = false;
      }
    }

    const destroyed = await this.#destroyView(id);
    if (!destroyed || this.#destroying || this.#tab(id) !== tab) return false;
    this.#createView(tab);
    this.#commit();
    this.#focusTab(id);
    return true;
  }

  async discardTab(id) {
    if (!validId(id)) return false;
    const tab = this.#tab(id);
    if (
      !tab ||
      tab.discarded ||
      tab.crashed ||
      tab.id === this.#state.activeTabId ||
      this.#splitForTab(tab.id)
    ) {
      return false;
    }
    const destroyed = await this.#destroyView(tab.id);
    if (!destroyed || this.#destroying || this.#tab(id) !== tab) return false;
    tab.discarded = true;
    tab.loading = false;
    tab.audible = false;
    tab.crashed = false;
    this.#commit();
    return true;
  }

  #restoreDiscardedTab(tab) {
    if (!tab?.discarded) return;
    tab.discarded = false;
    if (!this.#views.has(tab.id)) this.#createView(tab);
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
    const contents = this.#safeViewContents(view);
    if (!contents) return false;
    try {
      if (!contents.navigationHistory.canGoBack()) return false;
      this.#historyNextTransitions.set(id, "other");
      this.#prepareAdaptiveUserNavigation(id, view);
      contents.navigationHistory.goBack();
      return true;
    } catch {
      return false;
    }
  }

  goForward(id = this.#state.activeTabId) {
    const view = this.#viewFor(id);
    const contents = this.#safeViewContents(view);
    if (!contents) return false;
    try {
      if (!contents.navigationHistory.canGoForward()) return false;
      this.#historyNextTransitions.set(id, "other");
      this.#prepareAdaptiveUserNavigation(id, view);
      contents.navigationHistory.goForward();
      return true;
    } catch {
      return false;
    }
  }

  reload(id = this.#state.activeTabId) {
    const view = this.#viewFor(id);
    const contents = this.#safeViewContents(view);
    if (!contents) return false;
    try {
      this.#historyNextTransitions.set(id, "reload");
      this.#prepareAdaptiveUserNavigation(id, view);
      contents.reload();
      return true;
    } catch {
      return false;
    }
  }

  reloadIgnoringCache(id = this.#state.activeTabId) {
    const view = this.#viewFor(id);
    const contents = this.#safeViewContents(view);
    if (!contents) return false;
    try {
      this.#historyNextTransitions.set(id, "reload");
      this.#prepareAdaptiveUserNavigation(id, view);
      contents.reloadIgnoringCache();
      return true;
    } catch {
      return false;
    }
  }

  changePageZoom(id = this.#state.activeTabId, direction = "reset") {
    const contents = this.#safeViewContents(this.#viewFor(id));
    if (!contents) return false;
    try {
      const current = pageZoomFactorToPercent(contents.getZoomFactor());
      const percent = direction === "in"
        ? incrementPageZoom(current)
        : direction === "out"
          ? decrementPageZoom(current)
          : direction === "reset"
            ? resetPageZoom()
            : null;
      if (percent === null) return false;
      contents.setZoomFactor(pageZoomPercentToFactor(percent));
      return percent;
    } catch {
      return false;
    }
  }

  stop(id = this.#state.activeTabId) {
    const view = this.#viewFor(id);
    const contents = this.#safeViewContents(view);
    if (!contents) return false;
    try {
      this.#suppressAdaptiveAfterUserStop(id, view);
      contents.stop();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reads now-playing information from every tab that has produced media:
   * the page's MediaSession metadata when it exists, plus whether anything
   * is currently playing. Tabs whose media never started, or whose script
   * fails, are skipped. Results are bounded and shaped in the host, so the
   * shell never renders raw page values beyond capped strings.
   */
  async queryNowPlaying() {
    const candidateIds = [...this.#mediaTabs].filter(id => this.#tab(id));
    const entries = [];
    for (const id of candidateIds) {
      const tab = this.#tab(id);
      if (tab.discarded || tab.crashed) continue;
      const contents = this.#safeViewContents(this.#viewFor(id));
      if (!contents) continue;
      try {
        const result = await contents.executeJavaScript(`(() => {
          const media = [...document.querySelectorAll("video, audio")];
          if (!media.length) return null;
          const playing = media.some(item => !item.paused && !item.ended);
          const metadata = navigator.mediaSession?.metadata;
          const artwork = Array.isArray(metadata?.artwork)
            ? [...metadata.artwork]
                .map(item => ({
                  src: typeof item?.src === "string" ? item.src : "",
                  area: (() => {
                    const match = /^(\\d+)x(\\d+)$/.exec(item?.sizes || "");
                    return match ? Number(match[1]) * Number(match[2]) : 0;
                  })(),
                }))
                .filter(item => item.src)
                .sort((left, right) => right.area - left.area)[0]?.src || ""
            : "";
          return {
            title: typeof metadata?.title === "string" ? metadata.title : "",
            artist: typeof metadata?.artist === "string" ? metadata.artist : "",
            artwork,
            playing,
          };
        })()`);
        if (!result || typeof result !== "object") continue;
        entries.push({
          tabId: id,
          title: String(result.title || "").slice(0, 300) || tab.title,
          artist: String(result.artist || "").slice(0, 300),
          artworkUrl: safeArtworkUrl(result.artwork),
          playing: result.playing === true,
        });
      } catch {
        // A navigated or torn-down page simply drops out of the list.
      }
    }
    return entries;
  }

  /**
   * Clears the active origin's stored site data (cookies, storage, caches)
   * inside the tab's own partition, then reloads the page. Only web pages
   * qualify — internal pages have no site data to clear.
   */
  async clearSiteData(id = this.#state.activeTabId) {
    const tab = this.#tab(id);
    if (!tab) return false;
    const origin = this.#webOrigin(tab.url);
    if (!origin) return false;
    try {
      const ses = session.fromPartition(this.#partitionForTab(tab));
      await ses.clearStorageData({ origin });
      this.reload(tab.id);
      return true;
    } catch (error) {
      console.warn(`Unable to clear site data [${safeErrorCode(error)}]`);
      return false;
    }
  }

  /**
   * Accepts an HTTP Basic/Proxy authentication challenge from Electron's
   * `app.on("login")` and surfaces it as a queued shell prompt. Credentials
   * pass straight through to Chromium's network stack and are never
   * persisted by Chroma. Returns false (letting the caller cancel the
   * challenge) when the controller is shutting down.
   */
  handleAuthRequest(authInfo, callback) {
    if (this.#destroying || typeof callback !== "function") return false;
    this.#pendingAuthRequests.push({
      id: randomUUID(),
      callback,
      host: String(authInfo?.host || "").slice(0, 300),
      realm: String(authInfo?.realm || "").slice(0, 300),
      isProxy: authInfo?.isProxy === true,
    });
    this.#notify(false);
    return true;
  }

  submitAuthCredentials({ id, username, password } = {}) {
    if (
      !validId(id) ||
      typeof username !== "string" ||
      typeof password !== "string" ||
      username.length > 500 ||
      password.length > 500
    ) {
      return false;
    }
    const index = this.#pendingAuthRequests.findIndex(entry => entry.id === id);
    if (index < 0) return false;
    const [entry] = this.#pendingAuthRequests.splice(index, 1);
    try {
      entry.callback(username, password);
    } catch (error) {
      console.warn(`Unable to submit credentials [${safeErrorCode(error)}]`);
    }
    this.#notify(false);
    return true;
  }

  cancelAuthRequest({ id } = {}) {
    const index = this.#pendingAuthRequests.findIndex(entry => entry.id === id);
    if (index < 0) return false;
    const [entry] = this.#pendingAuthRequests.splice(index, 1);
    try {
      entry.callback();
    } catch (error) {
      console.warn(`Unable to cancel the sign-in prompt [${safeErrorCode(error)}]`);
    }
    this.#notify(false);
    return true;
  }

  /**
   * Hardware media-key handler: toggles playback on the most recently
   * playing media tab, preferring one that is currently audible. Returns
   * the toggle outcome, or null when no media tab is available.
   */
  async playPauseMostRecentMedia() {
    const candidates = [...this.#mediaTabs].reverse().filter(id => {
      const tab = this.#tab(id);
      return tab && !tab.discarded && !tab.crashed;
    });
    if (!candidates.length) return null;
    const audibleId = candidates.find(id => this.#tab(id)?.audible);
    return this.toggleMediaPlayback(audibleId ?? candidates[0]);
  }

  /**
   * Toggles page media playback: pauses everything that is playing, or
   * resumes the most usable media element when everything is paused. The
   * script runs with a user gesture so autoplay policy cannot block the
   * explicit user action. Returns "paused"/"playing", or null when the page
   * has no media or refuses playback.
   */
  async toggleMediaPlayback(id = this.#state.activeTabId) {
    const tab = this.#tab(id);
    const contents = this.#safeViewContents(this.#viewFor(id));
    if (!tab || !contents || tab.discarded || tab.crashed) return null;
    try {
      const result = await contents.executeJavaScript(`(() => {
        const media = [...document.querySelectorAll("video, audio")];
        if (!media.length) return null;
        const playing = media.filter(item => !item.paused && !item.ended);
        if (playing.length) {
          for (const item of playing) item.pause();
          return "paused";
        }
        const target = media.find(item => item.readyState > 0) || media[0];
        return Promise.resolve(target.play()).then(() => "playing").catch(() => null);
      })()`, true);
      return result === "paused" || result === "playing" ? result : null;
    } catch {
      return null;
    }
  }

  /**
   * Enters Picture-in-Picture on the largest eligible video, or exits an
   * active PiP session. Returns "entered"/"exited", or null when the page
   * has no eligible video or the platform denies the request.
   */
  async togglePictureInPicture(id = this.#state.activeTabId) {
    const tab = this.#tab(id);
    const contents = this.#safeViewContents(this.#viewFor(id));
    if (!tab || !contents || tab.discarded || tab.crashed) return null;
    try {
      const result = await contents.executeJavaScript(`(() => {
        if (document.pictureInPictureElement) {
          return document.exitPictureInPicture().then(() => "exited").catch(() => null);
        }
        if (!document.pictureInPictureEnabled) return null;
        const target = [...document.querySelectorAll("video")]
          .filter(video => video.readyState > 0 && !video.disablePictureInPicture)
          .sort((left, right) =>
            right.clientWidth * right.clientHeight -
            left.clientWidth * left.clientHeight
          )[0];
        if (!target) return null;
        return target.requestPictureInPicture().then(() => "entered").catch(() => null);
      })()`, true);
      return result === "entered" || result === "exited" ? result : null;
    } catch {
      return null;
    }
  }

  toggleMute(id = this.#state.activeTabId) {
    const tab = this.#tab(id);
    const contents = this.#safeViewContents(this.#viewFor(id));
    if (!tab || !contents) return false;
    try {
      tab.muted = !contents.isAudioMuted();
      contents.setAudioMuted(tab.muted);
      this.#commit();
      return tab.muted;
    } catch {
      return false;
    }
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
    // An Essential remembers the page it was promoted on so "reset" can
    // return there after the user browses away.
    tab.essentialUrl =
      essential && /^https?:\/\//i.test(tab.url) ? new URL(tab.url).href : "";
    if (essential) tab.pinned = true;
    this.#commit();
    return essential;
  }

  /**
   * Sets a per-tab user-agent override: "mobile" or "desktop" pin the UA and
   * suspend the automatic narrow-pane adaptation for that tab; "auto"
   * removes the pin and hands control back. Every change reloads the page
   * so the site renders consistently for the new identity.
   */
  setTabUserAgentMode(id, mode) {
    if (!validId(id) || !["mobile", "desktop", "auto"].includes(mode)) {
      return false;
    }
    const tab = this.#tab(id);
    const view = this.#viewFor(id);
    const contents = this.#safeViewContents(view);
    if (!tab || !contents || tab.discarded || tab.crashed) return false;
    try {
      if (mode === "auto") {
        if (!this.#uaOverrides.has(id)) return true;
        this.#uaOverrides.delete(id);
        contents.setUserAgent(
          this.#defaultUserAgentForTab(tab) || contents.session.getUserAgent()
        );
      } else {
        if (this.#uaOverrides.get(id) === mode) return true;
        this.#cancelAdaptiveProbe(id, true);
        this.#uaOverrides.set(id, mode);
        contents.setUserAgent(
          mode === "mobile" ? this.#mobileUserAgent : this.#desktopUserAgent
        );
      }
      contents.reloadIgnoringCache();
      this.#notify(false);
      return true;
    } catch {
      this.#uaOverrides.delete(id);
      return false;
    }
  }

  /**
   * Returns an Essential to its saved page. Discarded Essentials get their
   * view back first, so reset always ends on a live page.
   */
  resetEssential(id) {
    if (!validId(id)) return false;
    const tab = this.#tab(id);
    if (!tab?.essential || !tab.essentialUrl) return false;
    this.#restoreDiscardedTab(tab);
    return this.navigate(tab.id, tab.essentialUrl);
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
      const [removed] = bookmarks.splice(existingIndex, 1);
      this.#removeBookmarkFromFolders(removed.id);
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
    this.#removeBookmarkFromFolders(id);
    this.#commit();
    return true;
  }

  renameBookmark(id, title) {
    if (!validId(id) || typeof title !== "string") return false;
    const bookmark = (this.#state.bookmarks || []).find(item => item.id === id);
    const value = title.trim().slice(0, 500);
    if (!bookmark || !value) return false;
    if (bookmark.title === value) return true;
    bookmark.title = value;
    this.#commit();
    return true;
  }

  moveBookmark({ id, folderId } = {}) {
    if (!validId(id)) return false;
    const bookmark = this.#state.bookmarks.find(item => item.id === id);
    if (!bookmark) return false;
    if (folderId !== null && !validId(folderId)) return false;
    let targetFolder = null;
    if (folderId !== null) {
      targetFolder = this.#state.bookmarkFolders.find(item => item.id === folderId);
      if (!targetFolder) return false;
      if (
        !targetFolder.bookmarkIds.includes(id) &&
        targetFolder.bookmarkIds.length >= BOOKMARK_FOLDER_MEMBER_LIMIT
      ) {
        return false;
      }
    }
    this.#removeBookmarkFromFolders(id);
    if (targetFolder) targetFolder.bookmarkIds.push(id);
    this.#commit();
    return true;
  }

  async exportBookmarks({ path: requestedPath } = {}) {
    if (this.#destroying) return null;
    let target = typeof requestedPath === "string" && requestedPath.trim()
      ? requestedPath
      : null;
    if (!target) {
      const picked = await dialog.showSaveDialog(this.#window, {
        title: "Export bookmarks",
        defaultPath: "chroma-bookmarks.html",
        filters: [{ name: "Bookmark HTML", extensions: ["html"] }],
      });
      if (picked.canceled || !picked.filePath) return null;
      target = picked.filePath;
    }
    try {
      await writeFile(target, serializeBookmarks(this.#state), "utf8");
      return { exported: this.#state.bookmarks.length, path: target };
    } catch (error) {
      console.warn(`Unable to export bookmarks: ${error?.message}`);
      return null;
    }
  }

  async importBookmarks({ path: requestedPath } = {}) {
    if (this.#destroying) return null;
    let source = typeof requestedPath === "string" && requestedPath.trim()
      ? requestedPath
      : null;
    if (!source) {
      const picked = await dialog.showOpenDialog(this.#window, {
        title: "Import bookmarks",
        properties: ["openFile"],
        filters: [{ name: "Bookmark HTML", extensions: ["html", "htm"] }],
      });
      if (picked.canceled || !picked.filePaths?.length) return null;
      source = picked.filePaths[0];
    }
    try {
      const info = await stat(source);
      if (info.size > BOOKMARK_IMPORT_MAX_BYTES) {
        console.warn("Unable to import bookmarks: the file is too large");
        return null;
      }
      const { items } = parseBookmarksHtml(await readFile(source, "utf8"));
      const knownUrls = new Set(this.#state.bookmarks.map(item => item.url));
      const folderKey = (name, parentId) => `${parentId} ${name}`;
      const foldersByKey = new Map(
        this.#state.bookmarkFolders.map(folder => [
          folderKey(folder.name, folder.parentId || ""),
          folder,
        ])
      );
      const ensureFolderChain = folderPath => {
        let parentId = "";
        let folder = null;
        const boundedPath = folderPath.slice(0, BOOKMARK_FOLDER_DEPTH_LIMIT);
        for (const rawName of boundedPath) {
          const name = rawName.slice(0, 80);
          const existing = foldersByKey.get(folderKey(name, parentId));
          if (existing) {
            folder = existing;
          } else {
            if (this.#state.bookmarkFolders.length >= BOOKMARK_FOLDER_LIMIT) {
              return folder;
            }
            folder = {
              id: randomUUID(),
              name,
              parentId,
              bookmarkIds: [],
              expanded: true,
            };
            this.#state.bookmarkFolders.push(folder);
            foldersByKey.set(folderKey(name, parentId), folder);
          }
          parentId = folder.id;
        }
        return folder;
      };
      let imported = 0;
      let skipped = 0;
      for (const item of items) {
        if (knownUrls.has(item.url)) {
          skipped += 1;
          continue;
        }
        const bookmark = {
          id: randomUUID(),
          title: item.title,
          url: item.url,
          createdAt: Date.now(),
        };
        this.#state.bookmarks.push(bookmark);
        knownUrls.add(item.url);
        imported += 1;
        if (!item.folderPath.length) continue;
        const folder = ensureFolderChain(item.folderPath);
        if (folder && folder.bookmarkIds.length < BOOKMARK_FOLDER_MEMBER_LIMIT) {
          folder.bookmarkIds.push(bookmark.id);
        }
      }
      if (imported) this.#commit();
      return { imported, skipped };
    } catch (error) {
      console.warn(`Unable to import bookmarks: ${error?.message}`);
      return null;
    }
  }

  createBookmarkFolder(options = {}) {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      this.#state.bookmarkFolders.length >= BOOKMARK_FOLDER_LIMIT
    ) {
      return null;
    }
    const requestedBookmarkIds = Object.hasOwn(options, "bookmarkIds")
      ? options.bookmarkIds
      : [];
    if (
      !Array.isArray(requestedBookmarkIds) ||
      requestedBookmarkIds.length > BOOKMARK_FOLDER_MEMBER_LIMIT
    ) {
      return null;
    }
    const usableBookmarkIds = [];
    const seen = new Set();
    for (const requestedId of requestedBookmarkIds) {
      if (!validId(requestedId)) return null;
      const bookmark = this.#state.bookmarks.find(item => item.id === requestedId);
      if (!bookmark) return null;
      if (!seen.has(requestedId)) {
        seen.add(requestedId);
        usableBookmarkIds.push(requestedId);
      }
    }
    for (const bookmarkId of usableBookmarkIds) {
      this.#removeBookmarkFromFolders(bookmarkId);
    }
    let parentId = "";
    if (Object.hasOwn(options, "parentId") && options.parentId !== null) {
      if (!validId(options.parentId)) return null;
      const parent = this.#state.bookmarkFolders.find(
        item => item.id === options.parentId
      );
      if (
        !parent ||
        this.#bookmarkFolderDepth(parent.id) + 1 >= BOOKMARK_FOLDER_DEPTH_LIMIT
      ) {
        return null;
      }
      parentId = parent.id;
    }
    const folder = {
      id: randomUUID(),
      name: safeTitle(options.name, "Folder").slice(0, 80),
      parentId,
      bookmarkIds: usableBookmarkIds,
      expanded: true,
    };
    this.#state.bookmarkFolders.push(folder);
    this.#commit();
    return folder.id;
  }

  /** Number of ancestors above a folder (0 for a top-level folder). */
  #bookmarkFolderDepth(id) {
    const foldersById = new Map(
      this.#state.bookmarkFolders.map(folder => [folder.id, folder])
    );
    let depth = 0;
    let current = foldersById.get(id);
    while (current?.parentId && depth < BOOKMARK_FOLDER_DEPTH_LIMIT + 1) {
      current = foldersById.get(current.parentId);
      depth += 1;
    }
    return depth;
  }

  #bookmarkFolderDescendantIds(id) {
    const descendants = new Set();
    let added = true;
    while (added) {
      added = false;
      for (const folder of this.#state.bookmarkFolders) {
        if (descendants.has(folder.id)) continue;
        if (folder.parentId === id || descendants.has(folder.parentId)) {
          descendants.add(folder.id);
          added = true;
        }
      }
    }
    return descendants;
  }

  moveBookmarkFolder({ id, parentId } = {}) {
    if (!validId(id)) return false;
    const folder = this.#state.bookmarkFolders.find(item => item.id === id);
    if (!folder) return false;
    let targetParentId = "";
    if (parentId !== null && parentId !== "") {
      if (!validId(parentId) || parentId === id) return false;
      const parent = this.#state.bookmarkFolders.find(item => item.id === parentId);
      if (!parent || this.#bookmarkFolderDescendantIds(id).has(parentId)) {
        return false;
      }
      // The moved subtree keeps its own height; the new chain must still fit.
      const subtreeHeight = Math.max(
        0,
        ...[...this.#bookmarkFolderDescendantIds(id)].map(
          childId => this.#bookmarkFolderDepth(childId) - this.#bookmarkFolderDepth(id)
        )
      );
      if (
        this.#bookmarkFolderDepth(parent.id) + 1 + subtreeHeight >=
        BOOKMARK_FOLDER_DEPTH_LIMIT
      ) {
        return false;
      }
      targetParentId = parent.id;
    }
    if (folder.parentId === targetParentId) return true;
    folder.parentId = targetParentId;
    this.#commit();
    return true;
  }

  toggleBookmarkFolder(id) {
    const folder = this.#state.bookmarkFolders.find(item => item.id === id);
    if (!folder) return false;
    folder.expanded = !folder.expanded;
    this.#commit();
    return folder.expanded;
  }

  renameBookmarkFolder(id, name) {
    if (!validId(id) || typeof name !== "string") return false;
    const folder = this.#state.bookmarkFolders.find(item => item.id === id);
    const value = name.trim().slice(0, 80);
    if (!folder || !value) return false;
    if (folder.name === value) return true;
    folder.name = value;
    this.#commit();
    return true;
  }

  deleteBookmarkFolder(id) {
    if (!validId(id)) return false;
    const index = this.#state.bookmarkFolders.findIndex(item => item.id === id);
    if (index < 0) return false;
    const [removed] = this.#state.bookmarkFolders.splice(index, 1);
    for (const folder of this.#state.bookmarkFolders) {
      if (folder.parentId === id) folder.parentId = removed.parentId || "";
    }
    this.#commit();
    return true;
  }

  async createLiveFolder({ url, name } = {}) {
    const sourceUrl = normalizeLiveFolderSourceUrl(url);
    if (
      !sourceUrl ||
      this.#state.liveFolders.length >= LIVE_FOLDER_LIMIT ||
      this.#state.liveFolders.some(folder => folder.sourceUrl === sourceUrl)
    ) {
      return null;
    }
    const folder = {
      id: randomUUID(),
      name: safeTitle(name, "Live Folder").slice(0, 80),
      sourceUrl,
      expanded: true,
      items: [],
      refreshedAt: 0,
      status: "ok",
    };
    this.#state.liveFolders.push(folder);
    this.#commit();
    await this.#refreshLiveFolder(folder.id, { manual: true });
    return folder.id;
  }

  toggleLiveFolder(id) {
    const folder = this.#state.liveFolders.find(item => item.id === id);
    if (!folder) return false;
    folder.expanded = !folder.expanded;
    this.#commit();
    return folder.expanded;
  }

  renameLiveFolder(id, name) {
    if (!validId(id) || typeof name !== "string") return false;
    const folder = this.#state.liveFolders.find(item => item.id === id);
    const value = name.trim().slice(0, 80);
    if (!folder || !value) return false;
    if (folder.name === value) return true;
    folder.name = value;
    this.#commit();
    return true;
  }

  deleteLiveFolder(id) {
    if (!validId(id)) return false;
    const index = this.#state.liveFolders.findIndex(item => item.id === id);
    if (index < 0) return false;
    this.#state.liveFolders.splice(index, 1);
    this.#commit();
    return true;
  }

  refreshLiveFolder(id) {
    if (!validId(id)) return Promise.resolve(false);
    return this.#refreshLiveFolder(id, { manual: true });
  }

  #refreshStaleLiveFolders() {
    for (const folder of this.#state.liveFolders) {
      void this.#refreshLiveFolder(folder.id);
    }
  }

  async #refreshLiveFolder(id, { manual = false } = {}) {
    const folder = this.#state.liveFolders.find(item => item.id === id);
    if (!folder || this.#destroying || this.#liveFolderRefreshes.has(id)) {
      return false;
    }
    const minimumAge = manual
      ? LIVE_FOLDER_MANUAL_REFRESH_MS
      : LIVE_FOLDER_STALE_MS;
    if (folder.refreshedAt && Date.now() - folder.refreshedAt < minimumAge) {
      return false;
    }
    const initialRefresh = folder.refreshedAt === 0;
    this.#liveFolderRefreshes.add(id);
    try {
      const feed = await fetchFeed(folder.sourceUrl, {
        fetchImpl: this.#liveFolderFetch || globalThis.fetch,
      });
      const target = this.#state.liveFolders.find(item => item.id === id);
      if (!target || this.#destroying) return false;
      const itemUrls = new Set();
      const items = [];
      for (const entry of feed.items) {
        if (items.length === LIVE_FOLDER_ITEM_LIMIT) break;
        const itemUrl = normalizeLiveFolderSourceUrl(entry.url);
        if (!itemUrl || itemUrls.has(itemUrl)) continue;
        itemUrls.add(itemUrl);
        items.push({
          url: itemUrl,
          title: safeTitle(entry.title, itemUrl).slice(0, 300),
        });
      }
      target.items = items;
      target.status = "ok";
      target.refreshedAt = Date.now();
      if (initialRefresh && target.name === "Live Folder" && feed.title) {
        target.name = feed.title.slice(0, 80);
      }
      this.#commit();
      return true;
    } catch {
      const target = this.#state.liveFolders.find(item => item.id === id);
      if (!target || this.#destroying) return false;
      target.status = "error";
      target.refreshedAt = Date.now();
      this.#commit();
      return false;
    } finally {
      this.#liveFolderRefreshes.delete(id);
    }
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
    this.#hideSidebarOverlayForShellSurface();
    this.#window.webContents.send(channels.openHistory);
    return true;
  }

  openDownloads() {
    if (
      this.#destroying ||
      this.#window.isDestroyed() ||
      this.#window.webContents.isDestroyed()
    ) {
      return false;
    }
    this.#hideSidebarOverlayForShellSurface();
    this.#window.webContents.send(channels.openDownloads);
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

  selectAdjacentWorkspace(delta) {
    if ((delta !== 1 && delta !== -1) || this.#state.workspaces.length < 2) {
      return false;
    }
    const currentIndex = this.#state.workspaces.findIndex(
      workspace => workspace.id === this.#state.activeWorkspaceId
    );
    const nextIndex = (
      Math.max(0, currentIndex) + delta + this.#state.workspaces.length
    ) % this.#state.workspaces.length;
    return this.selectWorkspace(this.#state.workspaces[nextIndex].id);
  }

  renameWorkspace(id, name) {
    const workspace = this.#workspace(id);
    const value = String(name || "").trim();
    if (!workspace || !value) return false;
    workspace.name = value.slice(0, 80);
    this.#commit();
    return true;
  }

  async deleteWorkspace(id) {
    const workspaceIndex = this.#state.workspaces.findIndex(item => item.id === id);
    if (workspaceIndex < 0 || this.#state.workspaces.length <= 1) return false;

    const removedTabIds = this.#tabsForWorkspace(id).map(tab => tab.id);
    const removedTabIdSet = new Set(removedTabIds);
    const removedGroupIds = this.#state.splitGroups
      .filter(group => group.workspaceId === id)
      .map(group => group.id);
    const deletingActive = this.#state.activeWorkspaceId === id ||
      removedTabIdSet.has(this.#state.activeTabId);
    const fallbackWorkspace = this.#state.workspaces[workspaceIndex + 1] ||
      this.#state.workspaces[workspaceIndex - 1];
    const fallbackTab = deletingActive
      ? [...this.#tabsForWorkspace(fallbackWorkspace.id)].sort(
          (left, right) => right.lastActiveAt - left.lastActiveAt
        )[0]
      : null;
    if (deletingActive && !fallbackTab) return false;

    this.#state.workspaces.splice(workspaceIndex, 1);
    this.#state.tabs = this.#state.tabs.filter(tab => tab.workspaceId !== id);
    this.#state.folders = this.#state.folders.filter(folder => folder.workspaceId !== id);
    this.#state.splitGroups = this.#state.splitGroups.filter(
      group => group.workspaceId !== id
    );
    for (const groupId of removedGroupIds) this.#splitLayoutPreviews.delete(groupId);
    this.#closedTabs = this.#closedTabs.filter(snapshot => snapshot.workspaceId !== id);

    if (deletingActive) {
      this.#state.activeWorkspaceId = fallbackWorkspace.id;
      this.#state.activeTabId = fallbackTab.id;
      fallbackTab.lastActiveAt = Date.now();
    }

    this.#commit();
    if (deletingActive) this.#focusTab(this.#state.activeTabId);
    await Promise.all(removedTabIds.map(tabId => this.#destroyView(tabId)));
    this.#notify(false);
    return true;
  }

  reorderWorkspace(id, targetId, position = "before") {
    if (!validId(id) || !validId(targetId) || id === targetId) return false;
    const fromIndex = this.#state.workspaces.findIndex(item => item.id === id);
    const targetIndex = this.#state.workspaces.findIndex(item => item.id === targetId);
    if (fromIndex < 0 || targetIndex < 0) return false;
    const [workspace] = this.#state.workspaces.splice(fromIndex, 1);
    const currentTargetIndex = this.#state.workspaces.findIndex(
      item => item.id === targetId
    );
    const insertionIndex = position === "after"
      ? currentTargetIndex + 1
      : currentTargetIndex;
    this.#state.workspaces.splice(insertionIndex, 0, workspace);
    this.#commit();
    return true;
  }

  moveTabToWorkspace(id, workspaceId) {
    const tab = this.#tab(id);
    const targetWorkspace = this.#workspace(workspaceId);
    if (
      !tab ||
      !targetWorkspace ||
      tab.workspaceId === targetWorkspace.id ||
      tab.essential ||
      tab.pinned ||
      this.#splitForTab(tab.id) ||
      this.#state.folders.some(folder => folder.tabIds.includes(tab.id))
    ) {
      return false;
    }

    const sourceWorkspaceId = tab.workspaceId;
    const sourceTabs = this.#tabsForWorkspace(sourceWorkspaceId);
    // Moving the only tab must leave a usable replacement behind. At the
    // global cap that would create a transient 513th record which the disk
    // sanitizer would later truncate, silently losing the moved tab.
    if (sourceTabs.length === 1 && this.#state.tabs.length >= TAB_COUNT_LIMIT) {
      return false;
    }
    const tabIndex = this.#state.tabs.findIndex(item => item.id === tab.id);
    if (tabIndex < 0) return false;
    this.#state.tabs.splice(tabIndex, 1);

    if (sourceTabs.length === 1) {
      const replacement = this.#createTabRecord({ workspaceId: sourceWorkspaceId });
      this.#state.tabs.splice(tabIndex, 0, replacement);
      this.#createView(replacement);
    }

    tab.workspaceId = targetWorkspace.id;
    tab.lastActiveAt = Date.now();
    this.#state.tabs.push(tab);
    const movingActive = this.#state.activeTabId === tab.id;
    if (movingActive) this.#state.activeWorkspaceId = targetWorkspace.id;
    this.#commit();
    if (movingActive) this.#focusTab(tab.id);
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

    this.#restoreDiscardedTab(source);
    this.#restoreDiscardedTab(target);

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

  #container(id) {
    return this.#state.containers.find(container => container.id === id);
  }

  createContainer(options = {}) {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      this.#state.containers.length >= CONTAINER_LIMIT
    ) {
      return null;
    }
    const container = {
      id: randomUUID(),
      name: safeTitle(options.name, "Container").slice(0, 80),
      color: normalizeWorkspaceColor(options.color, "#7cc4ff"),
      proxy: "",
      userAgent: "",
    };
    this.#state.containers.push(container);
    this.#commit();
    return container.id;
  }

  renameContainer(id, name) {
    if (!validId(id) || typeof name !== "string") return false;
    const container = this.#container(id);
    const value = name.trim().slice(0, 80);
    if (!container || !value) return false;
    if (container.name === value) return true;
    container.name = value;
    this.#commit();
    return true;
  }

  setContainerColor(id, color) {
    if (!validId(id)) return false;
    const container = this.#container(id);
    if (!container) return false;
    const value = normalizeWorkspaceColor(color, "");
    if (!value) return false;
    if (container.color === value) return true;
    container.color = value;
    this.#commit();
    return true;
  }

  async setContainerProxy(id, proxy) {
    if (!validId(id) || typeof proxy !== "string") return false;
    const container = this.#container(id);
    if (!container) return false;
    const raw = proxy.trim();
    const value = raw ? normalizeContainerProxy(raw) : "";
    if (raw && !value) return false;
    if (container.proxy === value) return true;
    container.proxy = value;
    await this.#applyContainerProxy(container);
    this.#commit();
    return true;
  }

  /**
   * The pinned identity for a tab's container, or "" when its container
   * (if any) does not pin one. A container User-Agent replaces the default
   * desktop identity everywhere except an explicit per-tab
   * Request Mobile/Desktop override, which stays strongest.
   */
  #containerUserAgentForTab(tab) {
    if (!tab?.containerId) return "";
    return this.#container(tab.containerId)?.userAgent || "";
  }

  #defaultUserAgentForTab(tab) {
    return this.#containerUserAgentForTab(tab) || this.#desktopUserAgent;
  }

  setContainerUserAgent(id, userAgent) {
    if (!validId(id) || typeof userAgent !== "string") return false;
    const container = this.#container(id);
    if (!container) return false;
    const raw = userAgent.trim();
    const value = raw ? normalizeContainerUserAgent(raw) : "";
    if (raw && !value) return false;
    if (container.userAgent === value) return true;
    container.userAgent = value;
    for (const tab of this.#state.tabs) {
      if (tab.containerId !== id) continue;
      if (this.#uaOverrides.has(tab.id)) continue;
      const contents = this.#safeViewContents(this.#viewFor(tab.id));
      if (!contents) continue;
      if (value) this.#cancelAdaptiveProbe(tab.id, true);
      try {
        contents.setUserAgent(
          value || this.#desktopUserAgent || contents.session.getUserAgent()
        );
        if (!tab.discarded && !tab.crashed) contents.reloadIgnoringCache();
      } catch {
        // A teardown-raced view keeps the policy change; the next view
        // creation applies the container identity from state.
      }
    }
    this.#commit();
    return true;
  }

  async #applyContainerProxy(container) {
    try {
      const partitionSession = session.fromPartition(
        `persist:chroma-container-${container.id}`
      );
      await partitionSession.setProxy(
        container.proxy
          ? { proxyRules: container.proxy }
          : { mode: "system" }
      );
    } catch (error) {
      console.warn(
        `Unable to apply the container proxy [${safeErrorCode(error)}]`
      );
    }
  }

  async deleteContainer(id) {
    if (!validId(id)) return false;
    const index = this.#state.containers.findIndex(item => item.id === id);
    if (index < 0) return false;
    const memberTabs = this.#state.tabs.filter(tab => tab.containerId === id);
    if (memberTabs.length && this.#state.tabs.length === memberTabs.length) {
      // Closing every member of the only remaining tab set would leave the
      // window empty; create a replacement default-container tab first.
      const replacement = this.#createTabRecord({
        workspaceId: this.#state.activeWorkspaceId,
      });
      if (this.#state.tabs.length >= TAB_COUNT_LIMIT) return false;
      this.#state.tabs.push(replacement);
      this.#createView(replacement);
      this.#state.activeTabId = replacement.id;
    }
    for (const tab of memberTabs) {
      await this.closeTab(tab.id);
    }
    this.#state.containers.splice(index, 1);
    this.#commit();
    try {
      const partitionSession = session.fromPartition(
        `persist:chroma-container-${id}`
      );
      await partitionSession.setProxy({ mode: "system" });
      await partitionSession.clearStorageData();
    } catch (error) {
      console.warn(
        `Unable to clear deleted container storage [${safeErrorCode(error)}]`
      );
    }
    return true;
  }

  async reopenTabInContainer(id, containerId) {
    if (!validId(id)) return null;
    const tab = this.#tab(id);
    if (!tab || tab.essential || tab.pinned || this.#splitForTab(tab.id)) {
      return null;
    }
    const targetContainerId = typeof containerId === "string" ? containerId : "";
    if (targetContainerId && !this.#container(targetContainerId)) return null;
    if (tab.containerId === targetContainerId) return tab.id;
    if (this.#state.tabs.length >= TAB_COUNT_LIMIT) return null;

    // A WebContents cannot swap storage partitions in place, so reopening
    // replaces the tab record while preserving its list position and folder
    // membership under a new isolated view.
    const wasActive = this.#state.activeTabId === tab.id;
    const replacement = this.#createTabRecord({
      url: tab.url,
      workspaceId: tab.workspaceId,
      containerId: targetContainerId,
    });
    replacement.title = tab.title;
    const index = this.#state.tabs.indexOf(tab);
    this.#state.tabs.splice(index + 1, 0, replacement);
    for (const folder of this.#state.folders) {
      const memberIndex = folder.tabIds.indexOf(tab.id);
      if (memberIndex >= 0) folder.tabIds.splice(memberIndex + 1, 0, replacement.id);
    }
    this.#createView(replacement);
    if (wasActive) {
      this.#state.activeWorkspaceId = replacement.workspaceId;
      this.#state.activeTabId = replacement.id;
    }
    this.#commit();
    await this.closeTab(tab.id);
    if (wasActive && this.#state.activeTabId !== replacement.id) {
      this.selectTab(replacement.id);
    }
    return replacement.id;
  }

  #glanceBounds() {
    if (!this.#contentBounds) return null;
    const insetX = Math.round(this.#contentBounds.width * 0.08);
    const insetY = Math.round(this.#contentBounds.height * 0.08);
    return {
      x: this.#contentBounds.x + insetX,
      y: this.#contentBounds.y + insetY,
      width: Math.max(320, this.#contentBounds.width - insetX * 2),
      height: Math.max(240, this.#contentBounds.height - insetY * 2),
    };
  }

  openGlance(url, sourceTabId = this.#state.activeTabId) {
    if (this.#destroying) return false;
    const sourceTab = this.#tab(sourceTabId);
    if (!sourceTab || sourceTab.id !== this.#state.activeTabId) return false;
    // Glance previews take a literal link URL, not address-bar input, so an
    // unsafe scheme is rejected outright instead of becoming a search query.
    if (
      typeof url !== "string" ||
      url.length > TAB_URL_MAX_LENGTH ||
      !isSafePageUrl(url) ||
      !/^https?:\/\//i.test(url)
    ) {
      return false;
    }
    const targetUrl = new URL(url).href;
    const bounds = this.#glanceBounds();
    if (!bounds) return false;
    this.closeGlance();

    const view = new WebContentsView({
      webPreferences: {
        partition: this.#partitionForTab(sourceTab),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true,
      },
    });
    view.setBorderRadius(process.platform === "darwin" ? 14 : 10);
    this.#window.contentView.addChildView(view);
    view.setBounds(bounds);
    view.setVisible(true);
    const glance = { view, sourceTabId: sourceTab.id, url: targetUrl };
    this.#glance = glance;

    const contents = view.webContents;
    this.#configureSession(contents.session);
    contents.setUserAgent(
      this.#defaultUserAgentForTab(sourceTab) || contents.session.getUserAgent()
    );
    contents.setWindowOpenHandler(({ url: popupUrl }) => {
      if (this.#glance === glance && isSafePageUrl(popupUrl)) {
        this.#runDetached(this.dispatch(commands.createTab, {
          url: popupUrl,
          workspaceId: sourceTab.workspaceId,
        }), "Unable to open a Glance popup as a tab");
      }
      return { action: "deny" };
    });
    contents.on("before-input-event", (event, input) => {
      if (this.#glance !== glance || input.type !== "keyDown") return;
      if (input.key === "Escape") {
        event.preventDefault();
        this.closeGlance();
      } else if (
        input.key === "Enter" &&
        (process.platform === "darwin" ? input.meta : input.control)
      ) {
        event.preventDefault();
        this.#runDetached(
          Promise.resolve(this.promoteGlance()),
          "Unable to promote the Glance preview"
        );
      }
    });
    contents.once("render-process-gone", () => {
      if (this.#glance === glance) this.closeGlance();
    });
    void contents.loadURL(targetUrl).catch(error => {
      if (this.#glance === glance && error?.code !== "ERR_ABORTED") {
        console.warn(`Unable to load the Glance preview [${safeErrorCode(error)}]`);
      }
    });
    contents.focus();
    this.#notify(false);
    return true;
  }

  closeGlance() {
    const glance = this.#glance;
    if (!glance) return false;
    this.#glance = null;
    try {
      glance.view.setVisible(false);
      if (!this.#window.isDestroyed()) {
        this.#window.contentView.removeChildView(glance.view);
      }
      const contents = this.#safeViewContents(glance.view, { allowDestroyed: true });
      if (contents && !contents.isDestroyed()) {
        contents.close({ waitForBeforeUnload: false });
      }
    } catch (error) {
      console.warn(`Unable to close the Glance preview [${safeErrorCode(error)}]`);
    }
    if (!this.#destroying) {
      this.#focusTab(this.#state.activeTabId);
      this.#notify(false);
    }
    return true;
  }

  async promoteGlance() {
    const glance = this.#glance;
    if (!glance) return null;
    let currentUrl = glance.url;
    try {
      const contents = this.#safeViewContents(glance.view);
      const liveUrl = contents?.getURL();
      if (liveUrl && isSafePageUrl(liveUrl)) currentUrl = liveUrl;
    } catch {
      // Fall back to the originally requested URL.
    }
    this.closeGlance();
    return this.createTab({ url: currentUrl });
  }

  #syncGlance() {
    const glance = this.#glance;
    if (!glance) return;
    if (
      this.#state.activeTabId !== glance.sourceTabId ||
      (this.#chromeModalOpen && !this.#chromeModalUsesOverlay) ||
      (this.#tabDragActive && !this.#tabDragUsesOverlay)
    ) {
      this.closeGlance();
      return;
    }
    const bounds = this.#glanceBounds();
    if (!bounds) return;
    try {
      glance.view.setBounds(bounds);
    } catch {
      this.closeGlance();
    }
  }

  #extensionPopupBounds() {
    if (!this.#contentBounds) return null;
    const width = Math.min(380, Math.max(300, Math.round(this.#contentBounds.width * 0.3)));
    const height = Math.min(520, Math.max(240, Math.round(this.#contentBounds.height * 0.7)));
    return {
      x: this.#contentBounds.x + this.#contentBounds.width - width - 12,
      y: this.#contentBounds.y + 12,
      width,
      height,
    };
  }

  /**
   * Opens an extension's action popup as a transient overlay anchored to the
   * top-right of the page area. The popup document comes only from the
   * extension's own chrome-extension:// origin; http(s) links it opens are
   * routed to real tabs. Invoking it again for the same extension closes it.
   */
  openExtensionPopup(id) {
    if (this.#destroying || !this.#extensionService || !validId(id)) return false;
    if (this.#extensionPopup?.extensionId === id) {
      this.closeExtensionPopup();
      return true;
    }
    const entry = this.#extensionService
      .snapshot()
      .find(extension => extension.id === id);
    if (!entry?.popupPath) return false;
    const bounds = this.#extensionPopupBounds();
    if (!bounds) return false;
    this.closeExtensionPopup();

    const view = new WebContentsView({
      webPreferences: {
        partition: "persist:chroma-main",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    view.setBorderRadius(process.platform === "darwin" ? 12 : 8);
    this.#window.contentView.addChildView(view);
    view.setBounds(bounds);
    view.setVisible(true);
    const popup = { view, extensionId: entry.id };
    this.#extensionPopup = popup;

    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url: openedUrl }) => {
      if (this.#extensionPopup === popup && isSafePageUrl(openedUrl)) {
        this.#runDetached(this.dispatch(commands.createTab, {
          url: openedUrl,
        }), "Unable to open an extension-popup link as a tab");
      }
      return { action: "deny" };
    });
    contents.on("before-input-event", (event, input) => {
      if (this.#extensionPopup !== popup || input.type !== "keyDown") return;
      if (input.key === "Escape") {
        event.preventDefault();
        this.closeExtensionPopup();
      }
    });
    contents.once("render-process-gone", () => {
      if (this.#extensionPopup === popup) this.closeExtensionPopup();
    });
    const popupUrl = `chrome-extension://${entry.id}/${entry.popupPath}`;
    void contents.loadURL(popupUrl).catch(error => {
      if (this.#extensionPopup === popup && error?.code !== "ERR_ABORTED") {
        console.warn(`Unable to load the extension popup [${safeErrorCode(error)}]`);
        this.closeExtensionPopup();
      }
    });
    contents.focus();
    this.#notify(false);
    return true;
  }

  closeExtensionPopup() {
    const popup = this.#extensionPopup;
    if (!popup) return false;
    this.#extensionPopup = null;
    try {
      popup.view.setVisible(false);
      if (!this.#window.isDestroyed()) {
        this.#window.contentView.removeChildView(popup.view);
      }
      const contents = this.#safeViewContents(popup.view, { allowDestroyed: true });
      if (contents && !contents.isDestroyed()) {
        contents.close({ waitForBeforeUnload: false });
      }
    } catch (error) {
      console.warn(`Unable to close the extension popup [${safeErrorCode(error)}]`);
    }
    if (!this.#destroying) {
      this.#focusTab(this.#state.activeTabId);
      this.#notify(false);
    }
    return true;
  }

  #syncExtensionPopup() {
    const popup = this.#extensionPopup;
    if (!popup) return;
    if (
      (this.#chromeModalOpen && !this.#chromeModalUsesOverlay) ||
      (this.#tabDragActive && !this.#tabDragUsesOverlay)
    ) {
      this.closeExtensionPopup();
      return;
    }
    const bounds = this.#extensionPopupBounds();
    if (!bounds) return;
    try {
      popup.view.setBounds(bounds);
    } catch {
      this.closeExtensionPopup();
    }
  }

  async installExtension(sourcePath) {
    if (!this.#extensionService || this.#destroying) return null;
    let directory = typeof sourcePath === "string" && sourcePath.trim()
      ? sourcePath
      : null;
    if (!directory) {
      const picked = await dialog.showOpenDialog(this.#window, {
        title: "Choose an unpacked extension folder",
        properties: ["openDirectory"],
      });
      if (picked.canceled || !picked.filePaths?.length) return null;
      directory = picked.filePaths[0];
    }
    try {
      const entry = await this.#extensionService.install(directory);
      return entry?.id || null;
    } catch (error) {
      console.warn(`Unable to install extension: ${error?.message}`);
      return null;
    }
  }

  async removeExtension(id) {
    if (!this.#extensionService || !validId(id)) return false;
    try {
      return await this.#extensionService.remove(id);
    } catch (error) {
      console.warn(`Unable to remove extension: ${error?.message}`);
      return false;
    }
  }

  async reloadExtension(id) {
    if (!this.#extensionService || !validId(id)) return false;
    try {
      return await this.#extensionService.reload(id);
    } catch (error) {
      console.warn(`Unable to reload extension: ${error?.message}`);
      return false;
    }
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
    const contents = this.#safeViewContents(this.#viewFor(id));
    if (!contents) return false;
    try {
      contents.openDevTools({ mode: "detach" });
      return true;
    } catch {
      return false;
    }
  }

  destroy() {
    if (this.#destroyPromise) return this.#destroyPromise;
    this.#acceptCommands = false;
    this.#destroying = true;
    this.closeGlance();
    this.closeExtensionPopup();
    for (const entry of this.#pendingAuthRequests.splice(0)) {
      try {
        entry.callback();
      } catch {
        // Cancelling a challenge during teardown is best-effort.
      }
    }
    if (this.#mediaKeyRegistered) {
      try {
        globalShortcut.unregister("MediaPlayPause");
      } catch {
        // Shutdown continues regardless of shortcut teardown.
      }
      this.#mediaKeyRegistered = false;
    }
    clearInterval(this.#liveFolderSweepTimer);
    this.#liveFolderSweepTimer = null;
    this.#denyConfiguredSessionPermissions();
    this.#clearSidebarOverlayHideTimer();
    this.#stopSidebarOverlayPointerWatch();
    this.#splitLayoutPreviews.clear();
    for (const [contents, handler] of this.#shellShortcutHandlers) {
      if (!contents.isDestroyed()) contents.removeListener("before-input-event", handler);
    }
    this.#shellShortcutHandlers.clear();
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
    this.#wireShellShortcuts(contents);

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

  #hideSidebarOverlayForShellSurface() {
    if (!this.#sidebarOverlayOpen) return;
    this.#sidebarOverlayOpen = false;
    this.#sidebarOverlayKeepOpen = false;
    this.#sidebarOverlayFocusAddressPending = false;
    this.#syncSidebarOverlay();
    this.#notify(false);
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
    const contents = this.#safeViewContents(this.#sidebarOverlayView);
    if (
      !this.#sidebarOverlayFocusAddressPending ||
      !this.#sidebarOverlayReady ||
      !contents
    ) {
      return;
    }
    this.#sidebarOverlayFocusAddressPending = false;
    try {
      contents.focus();
      contents.send("chroma:focus-address");
    } catch {
      this.#sidebarOverlayReady = false;
      this.#sidebarOverlayOpen = false;
    }
  }

  #syncSidebarOverlay() {
    const view = this.#sidebarOverlayView;
    if (!view || this.#destroying || this.#window.isDestroyed()) return;
    if (!this.#safeViewContents(view, { allowDestroyed: true })) {
      this.#stopSidebarOverlayPointerWatch();
      this.#sidebarOverlayView = null;
      this.#sidebarOverlayReady = false;
      this.#sidebarOverlayOpen = false;
      return;
    }
    try {
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
            try {
              view.setVisible(false);
            } catch {
              this.#syncSidebarOverlay();
            }
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
          try {
            if (this.#sidebarOverlayOpen && this.#sidebarOverlayView === view) {
              view.setBounds(desiredBounds, {
                animate: { duration: SIDEBAR_OVERLAY_ANIMATION_MS },
              });
              this.#focusSidebarOverlayAddress();
            }
          } catch {
            this.#syncSidebarOverlay();
          }
        });
      } else {
        view.setBounds(desiredBounds);
        this.#focusSidebarOverlayAddress();
      }
    } catch {
      if (this.#sidebarOverlayView === view) {
        this.#stopSidebarOverlayPointerWatch();
        this.#sidebarOverlayView = null;
        this.#sidebarOverlayReady = false;
        this.#sidebarOverlayOpen = false;
      }
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
    const contents = this.#safeViewContents(view, { allowDestroyed: true });
    try {
      view.setVisible(false);
      if (!this.#window.isDestroyed()) {
        this.#window.contentView.removeChildView(view);
      }
      if (!contents || contents.isDestroyed()) return;
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

  #partitionForTab(tab) {
    const containerId = typeof tab?.containerId === "string" ? tab.containerId : "";
    if (
      containerId &&
      isPartitionSafeContainerId(containerId) &&
      this.#state.containers?.some(container => container.id === containerId)
    ) {
      return `persist:chroma-container-${containerId}`;
    }
    return "persist:chroma-main";
  }

  #createView(tab) {
    tab.loading = true;
    tab.crashed = false;
    const view = new WebContentsView({
      webPreferences: {
        partition: this.#partitionForTab(tab),
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
    view.webContents.setUserAgent(this.#defaultUserAgentForTab(tab));
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
      const contents = this.#safeViewContents(view);
      if (
        this.#destroying ||
        this.#views.get(tab.id) !== view ||
        this.#tab(tab.id) !== tab ||
        this.#navigationVersions.get(tab.id) !== version ||
        !contents
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
    if (
      this.#destroying ||
      this.#views.get(tab.id) !== view ||
      this.#tab(tab.id) !== tab ||
      !contents
    ) {
      return false;
    }
    try {
      return !contents.isDestroyed();
    } catch {
      return false;
    }
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
      // Re-inserting keeps the set ordered by most recent playback, which
      // is what the hardware media key targets.
      this.#mediaTabs.delete(tab.id);
      this.#mediaTabs.add(tab.id);
      this.#notify(false);
    });
    contents.on("media-paused", () => {
      if (!isCurrentView()) return;
      tab.audible = false;
      this.#notify(false);
    });

    contents.on("render-process-gone", (_event, _details) => {
      if (!isCurrentView()) return;
      tab.loading = false;
      tab.crashed = true;
      this.#cancelAdaptiveProbe(tab.id, true);
      this.#syncVisibleViews();
      this.#notify(false);
    });

    contents.once("destroyed", () => {
      if (!this.#markUnexpectedViewFailure(tab.id, view)) return;
      this.#syncVisibleViews();
      this.#notify(false);
    });

    contents.on("context-menu", (_event, params) => {
      if (!isCurrentView()) return;
      this.#showContextMenu(tab, view, contents, params);
    });

    contents.on("before-input-event", (event, input) => {
      if (!isCurrentView()) return;
      this.#handleShortcutInput(event, input, tab.id);
    });
  }

  #wireShellShortcuts(contents) {
    if (!contents || this.#shellShortcutHandlers.has(contents)) return;
    const handler = (event, input) => {
      if (this.#destroying || !this.#acceptCommands) return;
      this.#handleShortcutInput(event, input, this.#state.activeTabId);
    };
    this.#shellShortcutHandlers.set(contents, handler);
    contents.on("before-input-event", handler);
    contents.once("destroyed", () => {
      this.#shellShortcutHandlers.delete(contents);
    });
  }

  #handleShortcutInput(event, input, sourceTabId) {
    if (this.#destroying || !this.#acceptCommands) return false;
    const action = shortcutActionForInput(input, process.platform);
    if (!action) return false;
    // Browser-owned chords must never leak into the page just because the
    // current action is unavailable (for example Back on an empty history).
    // Keep the native event boundary fail-closed as views tear down.
    try {
      this.#performShortcutAction(action, sourceTabId);
    } catch (error) {
      if (!this.#destroying) {
        console.warn("Unable to handle browser shortcut:", error);
      }
    }
    try {
      event.preventDefault();
    } catch {
      // The originating WebContents may disappear during the action.
    }
    return true;
  }

  #performShortcutAction(action, sourceTabId = this.#state.activeTabId) {
    const tab = this.#tab(sourceTabId) || this.#tab(this.#state.activeTabId);
    switch (action) {
      case "address:focus":
        this.focusAddress();
        return true;
      case "history:open":
        return this.openHistory();
      case "downloads:open":
        return this.openDownloads();
      case "tab:create":
        if (this.#state.tabs.length >= TAB_COUNT_LIMIT) return false;
        this.#runDetached(this.dispatch(commands.createTab), "Unable to create tab");
        return true;
      case "tab:reopen":
        if (!this.#closedTabs.length) return false;
        this.#runDetached(
          this.dispatch(commands.reopenTab),
          "Unable to reopen closed tab"
        );
        return true;
      case "tab:close":
        if (!tab) return false;
        this.#runDetached(
          this.dispatch(commands.closeTab, { id: tab.id }),
          "Unable to close tab"
        );
        return true;
      case "tab:next":
        return this.selectAdjacentTab(1);
      case "tab:previous":
        return this.selectAdjacentTab(-1);
      case "navigation:reload":
        if (tab?.crashed) {
          this.#runDetached(
            this.dispatch(commands.recoverTab, { id: tab.id }),
            "Unable to recover crashed tab"
          );
          return true;
        }
        return Boolean(tab && this.reload(tab.id));
      case "navigation:reload-ignore-cache":
        if (tab?.crashed) {
          this.#runDetached(
            this.dispatch(commands.recoverTab, { id: tab.id }),
            "Unable to recover crashed tab"
          );
          return true;
        }
        return Boolean(tab && this.reloadIgnoringCache(tab.id));
      case "navigation:back":
        return Boolean(tab && this.goBack(tab.id));
      case "navigation:forward":
        return Boolean(tab && this.goForward(tab.id));
      case "bookmark:toggle":
        if (!tab || !isWebPageUrl(tab.url)) return false;
        this.toggleBookmark(tab.id);
        return true;
      case "sidebar:toggle":
        this.toggleSidebar();
        return true;
      case "workspace:next":
        return this.selectAdjacentWorkspace(1);
      case "workspace:previous":
        return this.selectAdjacentWorkspace(-1);
      case "split:row":
      case "split:column": {
        const group = tab ? this.#splitForTab(tab.id) : null;
        if (!tab || tab.essential || tab.pinned || group?.tabIds.length >= 4) {
          return false;
        }
        this.#runDetached(
          this.dispatch(commands.splitActive, {
            direction: action === "split:column" ? "column" : "row",
          }),
          "Unable to create split from shortcut"
        );
        return true;
      }
      case "split:remove":
        if (!tab || !this.#splitForTab(tab.id)) return false;
        this.unsplitActive();
        return true;
      case "page:zoom-in":
        return tab ? this.changePageZoom(tab.id, "in") !== false : false;
      case "page:zoom-out":
        return tab ? this.changePageZoom(tab.id, "out") !== false : false;
      case "page:zoom-reset":
        return tab ? this.changePageZoom(tab.id, "reset") !== false : false;
      case "developer:open-tools":
        return Boolean(tab && this.openDevTools(tab.id));
      default:
        return false;
    }
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
        {
          label: "Preview Link in Glance",
          click: () => {
            if (!this.#isCurrentTabView(tab, view, contents)) return;
            this.openGlance(params.linkURL, tab.id);
          },
        },
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" }
      );
    }
    if (["video", "audio"].includes(params.mediaType)) {
      template.push({
        label: "Play or Pause Media",
        click: () => {
          if (!this.#isCurrentTabView(tab, view, contents)) return;
          this.#runDetached(
            this.toggleMediaPlayback(tab.id),
            "Unable to toggle media playback"
          );
        },
      });
      if (params.mediaType === "video") {
        template.push({
          label: "Toggle Picture in Picture",
          click: () => {
            if (!this.#isCurrentTabView(tab, view, contents)) return;
            this.#runDetached(
              this.togglePictureInPicture(tab.id),
              "Unable to toggle Picture in Picture"
            );
          },
        });
      }
      template.push({ type: "separator" });
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
    const uaOverride = this.#uaOverrides.get(tab.id) || "auto";
    template.push(
      { label: "Back", enabled: tab.canGoBack, click: () => this.goBack(tab.id) },
      { label: "Forward", enabled: tab.canGoForward, click: () => this.goForward(tab.id) },
      { label: "Reload", click: () => this.reload(tab.id) },
      { type: "separator" },
      {
        label: uaOverride === "mobile" ? "Request Desktop Site" : "Request Mobile Site",
        click: () => {
          if (!this.#isCurrentTabView(tab, view, contents)) return;
          this.setTabUserAgentMode(
            tab.id,
            uaOverride === "mobile" ? "auto" : "mobile"
          );
        },
      },
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
        try {
          view.setVisible(false);
        } catch {
          this.#markUnexpectedViewFailure(id, view);
        }
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
    let recoveredFromNativeFailure = false;
    for (const [id, view] of this.#views) {
      const index = visibleIds.indexOf(id);
      const visible = index >= 0 && Boolean(rects[index]) && !this.#tab(id)?.crashed;
      // Apply the native view size before attaching it to the compositor. When
      // a tab-drag preview temporarily hides every WebContentsView, showing a
      // view first can race its previous full-width surface back on screen and
      // the renderer can miss the corresponding resize notification.
      try {
        if (visible) view.setBounds(rects[index]);
        view.setVisible(visible);
        if (visible) {
          this.#scheduleAdaptiveLayout(id, view);
        } else {
          this.#cancelAdaptiveProbe(id, true);
        }
      } catch {
        recoveredFromNativeFailure = this.#markUnexpectedViewFailure(id, view) ||
          recoveredFromNativeFailure;
      }
    }
    this.#syncSidebarOverlay();
    this.#syncGlance();
    this.#syncExtensionPopup();
    if (recoveredFromNativeFailure) this.#notify(false);
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
    // A manual Request Mobile/Desktop override owns this tab's UA outright;
    // the automatic narrow-pane machinery stands down until "auto" returns.
    // A container-pinned User-Agent is likewise a fixed identity, so the
    // mobile-adaptation machinery must not rewrite it.
    if (this.#uaOverrides.has(id)) return;
    if (this.#containerUserAgentForTab(this.#tab(id))) return;
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
      const contents = this.#safeViewContents(view);
      if (!contents) return;
      try {
        if (view.getVisible()) contents.focus();
      } catch {
        if (this.#markUnexpectedViewFailure(id, view)) {
          this.#syncVisibleViews();
          this.#notify(false);
        }
      }
    });
  }

  #removeBookmarkFromFolders(id) {
    for (const folder of this.#state.bookmarkFolders) {
      folder.bookmarkIds = folder.bookmarkIds.filter(bookmarkId => bookmarkId !== id);
    }
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
    if (!view) return true;
    if (this.#destroyingViewIds.has(id)) return false;
    this.#destroyingViewIds.add(id);
    this.#mediaTabs.delete(id);
    this.#uaOverrides.delete(id);
    this.#cancelAdaptiveProbe(id, true);
    let closed = false;
    let contents = null;
    try {
      contents = this.#safeViewContents(view, { allowDestroyed: true });
      try {
        view.setVisible(false);
      } catch {
        // A destroyed native wrapper is already no longer compositable.
      }
      // Detach first. Keeping the view in the hierarchy until `destroyed` retains
      // its WebContents and can prevent close() from completing on Electron 43.
      if (!this.#window.isDestroyed()) {
        try {
          this.#window.contentView.removeChildView(view);
        } catch {
          // Continue closing the WebContents even if Electron already detached it.
        }
      }
      if (!contents) {
        closed = true;
      } else if (!contents.isDestroyed()) {
        // Cancel an in-flight navigation before destruction. Closing a detached
        // view in the same task while its renderer is committing can orphan the
        // target in Electron 43.
        try {
          contents.stop();
        } catch {
          // It may have been destroyed between the guard and stop().
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      if (contents && !contents.isDestroyed()) {
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
      closed = !contents || contents.isDestroyed();
    } catch (error) {
      if (!this.#destroying) console.warn("Unable to destroy tab view:", error);
      try {
        closed = !contents || contents.isDestroyed();
      } catch {
        closed = true;
      }
    } finally {
      this.#destroyingViewIds.delete(id);
    }
    if (!closed) return false;
    if (this.#views.get(id) === view) {
      this.#views.delete(id);
      this.#adaptiveViews.delete(id);
      this.#viewReady.delete(id);
      this.#navigationVersions.delete(id);
      this.#historyNavigationVersions.delete(id);
      this.#historyRecordByTab.delete(id);
      this.#historyNextTransitions.delete(id);
    }
    return true;
  }

  #commit() {
    if (this.#destroying) return;
    this.#store.scheduleSave(this.#state);
    this.#syncVisibleViews();
    this.#notify(false);
  }

  #notify() {
    try {
      if (this.#window.isDestroyed() || this.#window.webContents.isDestroyed()) return;
      const publicState = this.getPublicState();
      this.#window.webContents.send("chroma:state-changed", publicState);
      const overlayContents = this.#safeViewContents(this.#sidebarOverlayView);
      if (overlayContents) {
        overlayContents.send("chroma:state-changed", publicState);
      }
    } catch (error) {
      if (!this.#destroying && !/destroyed/i.test(String(error?.message || ""))) {
        console.warn("Unable to publish browser state:", error);
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

  #safeViewContents(view, { allowDestroyed = false } = {}) {
    try {
      const contents = view?.webContents;
      if (!contents) return null;
      if (!allowDestroyed && contents.isDestroyed()) return null;
      return contents;
    } catch {
      return null;
    }
  }

  #safeViewVisible(view) {
    try {
      return Boolean(view?.getVisible());
    } catch {
      return false;
    }
  }

  #safeViewBounds(view) {
    try {
      return view ? view.getBounds() : null;
    } catch {
      return null;
    }
  }

  #markUnexpectedViewFailure(id, view) {
    if (
      this.#destroying ||
      this.#destroyingViewIds.has(id) ||
      this.#views.get(id) !== view
    ) {
      return false;
    }
    const tab = this.#tab(id);
    if (!tab) return false;
    const changed = tab.crashed !== true || tab.loading !== false;
    tab.crashed = true;
    tab.loading = false;
    this.#cancelAdaptiveProbe(id, true);
    return changed;
  }
}
