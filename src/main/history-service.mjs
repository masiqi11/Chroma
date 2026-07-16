import { randomUUID } from "node:crypto";

import {
  HISTORY_DEFAULT_PREFERENCES,
  HISTORY_ENTRY_LIMIT,
  normalizeHistoryUrl,
} from "../shared/model.mjs";

export const HISTORY_CURSOR_STALE = "HISTORY_CURSOR_STALE";

const DAY_MS = 24 * 60 * 60 * 1_000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const MAX_QUERY_LENGTH = 200;
const MAX_TITLE_LENGTH = 500;
const MAX_REMOVE_IDS = 200;
const MAX_CURSOR_LENGTH = 4_096;
const MAX_RUNTIME_NAVIGATIONS = HISTORY_ENTRY_LIMIT * 2;

const RETENTION_DAYS = new Set([0, 7, 30, 90, 365]);
const TRANSITIONS = new Set([
  "typed",
  "link",
  "form-submit",
  "reload",
  "redirect",
  "other",
]);
const RANGES = new Set([
  "all",
  "last-hour",
  "last-day",
  "last-week",
  "last-four-weeks",
  "custom",
]);

export class HistoryServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HistoryServiceError";
    this.code = code;
  }
}

function cursorStale(message = "The history cursor is stale or invalid") {
  return new HistoryServiceError(HISTORY_CURSOR_STALE, message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) throw new TypeError(`${label} must be an object`);
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not supported`);
  }
}

function currentTime(clock) {
  const value = clock();
  return Number.isFinite(value) ? value : Date.now();
}

function incrementRevision(revision) {
  const value = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

function normalizeQuery(value = "") {
  if (typeof value !== "string") throw new TypeError("query must be a string");
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length > MAX_QUERY_LENGTH) {
    throw new TypeError(`query must not exceed ${MAX_QUERY_LENGTH} characters`);
  }
  return normalized.toLowerCase();
}

function queryTokens(query) {
  return query ? query.split(" ") : [];
}

function searchableText(entry) {
  return `${entry.title ?? ""} ${entry.url ?? ""}`
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function matchesTokens(entry, tokens) {
  if (!tokens.length) return true;
  const text = searchableText(entry);
  return tokens.every(token => text.includes(token));
}

function compareNewestFirst(left, right) {
  if (left.visitedAt !== right.visitedAt) return right.visitedAt - left.visitedAt;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

function normalizeLimit(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`limit must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function normalizeRange(payload, now) {
  const range = payload.range ?? "all";
  if (!RANGES.has(range)) throw new TypeError("range is not supported");

  if (range === "custom") {
    if (!Number.isFinite(payload.from) || !Number.isFinite(payload.to)) {
      throw new TypeError("custom history ranges require finite from and to values");
    }
    if (payload.from >= payload.to) {
      throw new TypeError("custom history range from must be less than to");
    }
    return {
      binding: { range, from: payload.from, to: payload.to },
      effectiveFrom: payload.from,
      effectiveTo: payload.to,
    };
  }

  if (payload.from !== undefined || payload.to !== undefined) {
    throw new TypeError("from and to are supported only for custom history ranges");
  }

  const duration = {
    "last-hour": 60 * 60 * 1_000,
    "last-day": DAY_MS,
    "last-week": 7 * DAY_MS,
    "last-four-weeks": 28 * DAY_MS,
  }[range];

  return {
    binding: { range, from: null, to: null },
    effectiveFrom: duration === undefined ? Number.NEGATIVE_INFINITY : now - duration,
    effectiveTo: duration === undefined ? Number.POSITIVE_INFINITY : now + 1,
  };
}

function inRange(entry, from, to) {
  return entry.visitedAt >= from && entry.visitedAt < to;
}

function cursorBoundaryValue(value, fallback) {
  return value === null ? fallback : value;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (typeof value !== "string" || !value || value.length > MAX_CURSOR_LENGTH) {
    throw cursorStale();
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isObject(decoded)) throw new Error("invalid cursor object");
    return decoded;
  } catch {
    throw cursorStale();
  }
}

function sameBinding(cursor, binding, query, revision) {
  return (
    cursor.version === 1 &&
    cursor.revision === revision &&
    cursor.query === query &&
    cursor.range === binding.range &&
    cursor.from === binding.from &&
    cursor.to === binding.to
  );
}

function normalizeTitle(value, fallback) {
  if (value !== undefined && typeof value !== "string") {
    throw new TypeError("title must be a string");
  }
  return (value ?? "").trim().slice(0, MAX_TITLE_LENGTH) || fallback;
}

function normalizeVisitedAt(value, now) {
  if (value === undefined) return now;
  if (!Number.isFinite(value)) throw new TypeError("visitedAt must be finite");
  return value > now + FUTURE_TOLERANCE_MS ? now : value;
}

function normalizeTransition(value) {
  return TRANSITIONS.has(value) ? value : "other";
}

function normalizeNavigationVersion(value) {
  if (typeof value === "string" && value.trim()) return `string:${value.trim()}`;
  if (Number.isSafeInteger(value) && value >= 0) return `number:${value}`;
  throw new TypeError("navigationVersion must be a non-empty string or non-negative integer");
}

function navigationKey(tabId, navigationVersion) {
  if (typeof tabId !== "string" || !tabId.trim()) {
    throw new TypeError("tabId must be a non-empty string");
  }
  return `${tabId.trim()}\u0000${normalizeNavigationVersion(navigationVersion)}`;
}

function historyCutoff(preferences, now) {
  return preferences.retentionDays
    ? now - preferences.retentionDays * DAY_MS
    : Number.NEGATIVE_INFINITY;
}

function pruneEntries(entries, preferences, now) {
  const cutoff = historyCutoff(preferences, now);
  return entries
    .filter(entry => entry.visitedAt >= cutoff)
    .sort((left, right) => {
      if (left.visitedAt !== right.visitedAt) return left.visitedAt - right.visitedAt;
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    })
    .slice(-HISTORY_ENTRY_LIMIT);
}

function cloneEntry(entry) {
  return {
    id: entry.id,
    url: entry.url,
    title: entry.title,
    visitedAt: entry.visitedAt,
    transition: entry.transition,
  };
}

/**
 * Pure history-domain service. Persistent mutations are applied to the supplied
 * history object, while navigation-version metadata stays transient in memory.
 */
export class HistoryService {
  #history;
  #clock;
  #idFactory;
  #currentNavigationByTab = new Map();
  #navigationRecords = new Map();
  #seenNavigationVersions = new Map();

  constructor(history, { clock = Date.now, idFactory = randomUUID } = {}) {
    assertObject(history, "history");
    if (!Array.isArray(history.entries)) throw new TypeError("history.entries must be an array");
    assertObject(history.preferences, "history.preferences");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");

    this.#history = history;
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  get history() {
    return this.#history;
  }

  query(payload = {}) {
    assertObject(payload, "history query");
    assertAllowedKeys(
      payload,
      new Set(["query", "range", "from", "to", "cursor", "limit"]),
      "history query"
    );

    const query = normalizeQuery(payload.query);
    const tokens = queryTokens(query);
    const limit = normalizeLimit(payload.limit, 50, 100);
    const range = normalizeRange(payload, currentTime(this.#clock));
    let effectiveFrom = range.effectiveFrom;
    let effectiveTo = range.effectiveTo;
    let cursor = null;

    if (payload.cursor !== undefined) {
      cursor = decodeCursor(payload.cursor);
      if (!sameBinding(cursor, range.binding, query, this.#history.revision)) {
        throw cursorStale();
      }
      if (
        !Number.isFinite(cursor.lastVisitedAt) ||
        typeof cursor.lastId !== "string" ||
        !cursor.lastId ||
        (cursor.effectiveFrom !== null && !Number.isFinite(cursor.effectiveFrom)) ||
        (cursor.effectiveTo !== null && !Number.isFinite(cursor.effectiveTo))
      ) {
        throw cursorStale();
      }
      effectiveFrom = cursorBoundaryValue(cursor.effectiveFrom, Number.NEGATIVE_INFINITY);
      effectiveTo = cursorBoundaryValue(cursor.effectiveTo, Number.POSITIVE_INFINITY);
    }

    const matches = this.#history.entries
      .filter(entry => inRange(entry, effectiveFrom, effectiveTo) && matchesTokens(entry, tokens))
      .sort(compareNewestFirst);

    let start = 0;
    if (cursor) {
      const boundaryIndex = matches.findIndex(
        entry => entry.visitedAt === cursor.lastVisitedAt && entry.id === cursor.lastId
      );
      if (boundaryIndex < 0) throw cursorStale();
      start = boundaryIndex + 1;
    }

    const page = matches.slice(start, start + limit);
    const hasMore = start + page.length < matches.length;
    const last = page.at(-1);
    const nextCursor = hasMore && last
      ? encodeCursor({
          version: 1,
          revision: this.#history.revision,
          query,
          range: range.binding.range,
          from: range.binding.from,
          to: range.binding.to,
          effectiveFrom: Number.isFinite(effectiveFrom) ? effectiveFrom : null,
          effectiveTo: Number.isFinite(effectiveTo) ? effectiveTo : null,
          lastVisitedAt: last.visitedAt,
          lastId: last.id,
        })
      : null;

    return {
      items: page.map(cloneEntry),
      nextCursor,
      hasMore,
      revision: this.#history.revision,
    };
  }

  suggest(payload = {}) {
    assertObject(payload, "history suggestion");
    assertAllowedKeys(payload, new Set(["query", "limit"]), "history suggestion");
    const query = normalizeQuery(payload.query);
    const tokens = queryTokens(query);
    const limit = normalizeLimit(payload.limit, 10, 10);
    const seenUrls = new Set();
    const items = [];

    for (const entry of [...this.#history.entries].sort(compareNewestFirst)) {
      if (seenUrls.has(entry.url) || !matchesTokens(entry, tokens)) continue;
      seenUrls.add(entry.url);
      items.push({
        url: entry.url,
        title: entry.title,
        visitedAt: entry.visitedAt,
      });
      if (items.length === limit) break;
    }

    return { items, revision: this.#history.revision };
  }

  remove(payload) {
    assertObject(payload, "history removal");
    assertAllowedKeys(payload, new Set(["ids"]), "history removal");
    if (!Array.isArray(payload.ids) || payload.ids.length < 1 || payload.ids.length > MAX_REMOVE_IDS) {
      throw new TypeError(`ids must contain between 1 and ${MAX_REMOVE_IDS} entries`);
    }

    const ids = payload.ids.map(id => {
      if (typeof id !== "string" || !id.trim()) {
        throw new TypeError("history ids must be non-empty strings");
      }
      return id.trim();
    });
    if (new Set(ids).size !== ids.length) throw new TypeError("history ids must be unique");

    const removedIds = new Set(ids);
    const entries = this.#history.entries.filter(entry => !removedIds.has(entry.id));
    const removedCount = this.#history.entries.length - entries.length;
    if (removedCount) {
      this.#history.entries = entries;
      this.#history.revision = incrementRevision(this.#history.revision);
      this.#forgetRemovedRecords(removedIds);
    }
    return { removedCount, revision: this.#history.revision };
  }

  clear(payload) {
    assertObject(payload, "history clear");
    assertAllowedKeys(payload, new Set(["range", "from", "to"]), "history clear");
    if (!Object.hasOwn(payload, "range")) {
      throw new TypeError("history clear requires an explicit range");
    }
    const range = normalizeRange(payload, currentTime(this.#clock));
    const removedIds = new Set();
    const entries = this.#history.entries.filter(entry => {
      const remove = inRange(entry, range.effectiveFrom, range.effectiveTo);
      if (remove) removedIds.add(entry.id);
      return !remove;
    });
    const removedCount = removedIds.size;
    if (removedCount) {
      this.#history.entries = entries;
      this.#history.revision = incrementRevision(this.#history.revision);
      this.#forgetRemovedRecords(removedIds);
    }
    return { removedCount, revision: this.#history.revision };
  }

  setPreferences(payload) {
    assertObject(payload, "history preferences");
    const allowed = new Set(["recordingEnabled", "retentionDays", "clearOnExit"]);
    assertAllowedKeys(payload, allowed, "history preferences");

    const preferences = { ...this.#history.preferences };
    if (Object.hasOwn(payload, "recordingEnabled")) {
      if (typeof payload.recordingEnabled !== "boolean") {
        throw new TypeError("recordingEnabled must be a boolean");
      }
      preferences.recordingEnabled = payload.recordingEnabled;
    }
    if (Object.hasOwn(payload, "retentionDays")) {
      if (!RETENTION_DAYS.has(payload.retentionDays)) {
        throw new TypeError("retentionDays is not supported");
      }
      preferences.retentionDays = payload.retentionDays;
    }
    if (Object.hasOwn(payload, "clearOnExit")) {
      if (typeof payload.clearOnExit !== "boolean") {
        throw new TypeError("clearOnExit must be a boolean");
      }
      preferences.clearOnExit = payload.clearOnExit;
    }

    const changed = [...allowed].some(key => preferences[key] !== this.#history.preferences[key]);
    const retentionChanged = preferences.retentionDays !== this.#history.preferences.retentionDays;
    const entries = retentionChanged
      ? pruneEntries(this.#history.entries, preferences, currentTime(this.#clock))
      : this.#history.entries;
    const prunedCount = this.#history.entries.length - entries.length;
    const keptIds = new Set(entries.map(entry => entry.id));
    const removedIds = prunedCount
      ? new Set(this.#history.entries.filter(entry => !keptIds.has(entry.id)).map(entry => entry.id))
      : new Set();

    if (changed || prunedCount) {
      this.#history.preferences = preferences;
      this.#history.entries = entries;
      this.#history.revision = incrementRevision(this.#history.revision);
      this.#forgetRemovedRecords(removedIds);
    }

    return {
      preferences: { ...this.#history.preferences },
      prunedCount,
      revision: this.#history.revision,
    };
  }

  prune() {
    const entries = pruneEntries(
      this.#history.entries,
      this.#history.preferences,
      currentTime(this.#clock)
    );
    const prunedCount = this.#history.entries.length - entries.length;
    if (prunedCount) {
      const kept = new Set(entries.map(entry => entry.id));
      const removedIds = new Set(
        this.#history.entries.filter(entry => !kept.has(entry.id)).map(entry => entry.id)
      );
      this.#history.entries = entries;
      this.#history.revision = incrementRevision(this.#history.revision);
      this.#forgetRemovedRecords(removedIds);
    }
    return { prunedCount, revision: this.#history.revision };
  }

  append(payload) {
    assertObject(payload, "history append");
    assertAllowedKeys(
      payload,
      new Set([
        "tabId",
        "navigationVersion",
        "url",
        "title",
        "visitedAt",
        "transition",
        "isMainFrame",
        "committed",
        "privateProfile",
        "failed",
        "aborted",
        "interstitial",
        "sameDocument",
        "previousUrl",
      ]),
      "history append"
    );

    const tabId = typeof payload.tabId === "string" ? payload.tabId.trim() : payload.tabId;
    const key = navigationKey(tabId, payload.navigationVersion);
    for (const flag of [
      "isMainFrame",
      "committed",
      "privateProfile",
      "failed",
      "aborted",
      "interstitial",
      "sameDocument",
    ]) {
      if (Object.hasOwn(payload, flag) && typeof payload[flag] !== "boolean") {
        throw new TypeError(`${flag} must be a boolean`);
      }
    }
    if (payload.isMainFrame === false) return this.#notRecorded("not-main-frame");
    if (payload.committed === false) return this.#notRecorded("not-committed");
    if (payload.failed === true || payload.aborted === true || payload.interstitial === true) {
      return this.#notRecorded("unsuccessful-navigation");
    }
    if (this.#seenNavigationVersions.has(key)) return this.#notRecorded("duplicate-navigation");

    const url = normalizeHistoryUrl(payload.url);
    const previousUrl = normalizeHistoryUrl(payload.previousUrl);
    const previousCurrent = this.#currentNavigationByTab.get(tabId);
    const fragmentOnly =
      payload.sameDocument === true &&
      (previousUrl === url || (url !== null && previousCurrent?.url === url));
    const shouldRecord =
      url !== null &&
      payload.privateProfile !== true &&
      !fragmentOnly &&
      this.#history.preferences.recordingEnabled === true;
    const now = currentTime(this.#clock);
    let entry = null;
    if (shouldRecord) {
      const title = normalizeTitle(payload.title, url);
      const visitedAt = normalizeVisitedAt(payload.visitedAt, now);
      entry = {
        id: this.#nextId(),
        url,
        title,
        visitedAt,
        transition: normalizeTransition(payload.transition),
      };
    }

    this.#rememberSeenNavigation(key);
    const current = { key, entryId: null, url };
    this.#currentNavigationByTab.set(tabId, current);

    if (!url) return this.#notRecorded("unsafe-url");
    if (payload.privateProfile === true) return this.#notRecorded("private-profile");
    if (fragmentOnly) return this.#notRecorded("fragment-only");
    if (this.#history.preferences.recordingEnabled !== true) {
      return this.#notRecorded("recording-disabled");
    }

    const id = entry.id;
    const before = this.#history.entries.length;
    const previousEntries = this.#history.entries;
    const entries = pruneEntries(
      [...previousEntries, entry],
      this.#history.preferences,
      now
    );
    const retained = entries.some(item => item.id === id);
    const prunedCount = before + 1 - entries.length;
    const keptIds = new Set(entries.map(item => item.id));
    const removedIds = new Set(
      previousEntries.filter(item => !keptIds.has(item.id)).map(item => item.id)
    );

    this.#history.entries = entries;
    this.#history.revision = incrementRevision(this.#history.revision);
    this.#forgetRemovedRecords(removedIds);
    if (retained) {
      current.entryId = id;
      const metadata = { tabId, key, entryId: id, url };
      this.#navigationRecords.set(key, metadata);
      this.#trimRuntimeMap(this.#navigationRecords);
    }

    return {
      recorded: retained,
      reason: retained ? null : "retention",
      id,
      entry: retained ? cloneEntry(entry) : null,
      prunedCount,
      revision: this.#history.revision,
    };
  }

  updateTitle(payload) {
    assertObject(payload, "history title update");
    assertAllowedKeys(
      payload,
      new Set(["tabId", "navigationVersion", "entryId", "url", "title"]),
      "history title update"
    );
    const tabId = typeof payload.tabId === "string" ? payload.tabId.trim() : payload.tabId;
    const key = navigationKey(tabId, payload.navigationVersion);
    const url = normalizeHistoryUrl(payload.url);
    const current = this.#currentNavigationByTab.get(tabId);
    const metadata = this.#navigationRecords.get(key);

    if (
      !url ||
      typeof payload.entryId !== "string" ||
      !current ||
      current.key !== key ||
      current.entryId !== payload.entryId ||
      current.url !== url ||
      !metadata ||
      metadata.entryId !== payload.entryId ||
      metadata.url !== url
    ) {
      return { updated: false, reason: "stale-navigation", revision: this.#history.revision };
    }

    const index = this.#history.entries.findIndex(
      entry => entry.id === payload.entryId && entry.url === url
    );
    if (index < 0) {
      return { updated: false, reason: "missing-entry", revision: this.#history.revision };
    }

    const title = normalizeTitle(payload.title, url);
    if (this.#history.entries[index].title === title) {
      return { updated: false, reason: "unchanged", revision: this.#history.revision };
    }

    this.#history.entries = this.#history.entries.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, title } : entry
    );
    this.#history.revision = incrementRevision(this.#history.revision);
    return { updated: true, entry: cloneEntry(this.#history.entries[index]), revision: this.#history.revision };
  }

  #notRecorded(reason) {
    return { recorded: false, reason, revision: this.#history.revision };
  }

  #nextId() {
    const used = new Set(this.#history.entries.map(entry => entry.id));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = String(this.#idFactory() ?? "").trim();
      if (id && !used.has(id)) return id;
    }
    let suffix = used.size + 1;
    while (used.has(`history-${suffix}`)) suffix += 1;
    return `history-${suffix}`;
  }

  #rememberSeenNavigation(key) {
    const tabId = key.slice(0, key.indexOf("\u0000"));
    this.#seenNavigationVersions.set(key, {
      previousCurrent: this.#currentNavigationByTab.get(tabId) ?? null,
    });
    this.#trimRuntimeMap(this.#seenNavigationVersions);
  }

  #trimRuntimeMap(map) {
    while (map.size > MAX_RUNTIME_NAVIGATIONS) map.delete(map.keys().next().value);
  }

  #forgetRemovedRecords(removedIds) {
    if (!removedIds.size) return;
    for (const [key, metadata] of this.#navigationRecords) {
      if (removedIds.has(metadata.entryId)) this.#navigationRecords.delete(key);
    }
    for (const [tabId, metadata] of this.#currentNavigationByTab) {
      if (removedIds.has(metadata.entryId)) {
        this.#currentNavigationByTab.set(tabId, { ...metadata, entryId: null });
      }
    }
  }
}

export function createHistoryService(history, options) {
  return new HistoryService(history, options);
}
