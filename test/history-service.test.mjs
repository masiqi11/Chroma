import test from "node:test";
import assert from "node:assert/strict";

import {
  HISTORY_CURSOR_STALE,
  HistoryService,
  HistoryServiceError,
  createHistoryService,
} from "../src/main/history-service.mjs";
import {
  HISTORY_DEFAULT_PREFERENCES,
  HISTORY_ENTRY_LIMIT,
  createDefaultHistory,
} from "../src/shared/model.mjs";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 6, 16, 12);

function visit(id, visitedAt, overrides = {}) {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Visit ${id}`,
    visitedAt,
    transition: "link",
    ...overrides,
  };
}

function historyWith(entries = [], overrides = {}) {
  return {
    revision: overrides.revision ?? 0,
    entries,
    preferences: {
      ...HISTORY_DEFAULT_PREFERENCES,
      ...overrides.preferences,
    },
  };
}

function sequentialIds(prefix = "record") {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

test("queries use AND matching, deterministic pagination, and bound cursors", () => {
  let now = NOW;
  const history = historyWith(
    [
      visit("a", NOW - 4_000, { title: "Alpha reference" }),
      visit("b", NOW - 3_000, {
        title: "Alpha beta",
        url: "https://example.org/guide",
      }),
      visit("c", NOW - 2_000, { title: "Charlie" }),
      visit("d", NOW - 2_000, { title: "Delta" }),
    ],
    { revision: 7 }
  );
  const service = new HistoryService(history, { clock: () => now });

  const filtered = service.query({ query: "  ALPHA   example.org  " });
  assert.deepEqual(filtered.items.map(item => item.id), ["b"]);
  assert.equal(filtered.revision, 7);

  const first = service.query({ range: "last-hour", limit: 2 });
  assert.deepEqual(first.items.map(item => item.id), ["d", "c"]);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, "string");

  now += 30 * 60 * 1_000;
  const second = service.query({
    range: "last-hour",
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(second.items.map(item => item.id), ["b", "a"]);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);

  assert.throws(
    () => service.query({ query: "different", cursor: first.nextCursor }),
    error => error instanceof HistoryServiceError && error.code === HISTORY_CURSOR_STALE
  );
  assert.throws(
    () => service.query({ cursor: `${first.nextCursor}tampered` }),
    error => error.code === HISTORY_CURSOR_STALE
  );

  const staleCursor = service.query({ limit: 1 }).nextCursor;
  service.remove({ ids: ["a"] });
  assert.throws(
    () => service.query({ limit: 1, cursor: staleCursor }),
    error => error.code === HISTORY_CURSOR_STALE
  );
});

test("custom query ranges are inclusive at from and exclusive at to", () => {
  const history = historyWith([
    visit("before", 99),
    visit("from", 100),
    visit("inside", 199),
    visit("to", 200),
  ]);
  const service = createHistoryService(history, { clock: () => NOW });

  assert.deepEqual(
    service.query({ range: "custom", from: 100, to: 200 }).items.map(item => item.id),
    ["inside", "from"]
  );
  assert.throws(() => service.query({ range: "custom", from: 2, to: 2 }), TypeError);
  assert.throws(() => service.query({ range: "all", from: 0 }), TypeError);
});

test("suggestions are newest-first, URL-unique, local AND matches", () => {
  const history = historyWith(
    [
      visit("old", NOW - 3_000, {
        url: "https://example.com/same",
        title: "Old documentation",
      }),
      visit("other", NOW - 2_000, {
        url: "https://example.org/docs",
        title: "Other documentation",
      }),
      visit("new", NOW - 1_000, {
        url: "https://example.com/same",
        title: "New documentation",
      }),
    ],
    { revision: 4 }
  );
  const service = createHistoryService(history);

  assert.deepEqual(service.suggest({ query: "new example", limit: 10 }), {
    items: [
      {
        url: "https://example.com/same",
        title: "New documentation",
        visitedAt: NOW - 1_000,
      },
    ],
    revision: 4,
  });
  assert.deepEqual(
    service.suggest({ query: "documentation", limit: 2 }).items.map(item => item.title),
    ["New documentation", "Other documentation"]
  );
  assert.throws(() => service.suggest({ query: "x", limit: 11 }), TypeError);
});

test("remove validates before mutation and is idempotent", () => {
  const history = historyWith([visit("a", 1), visit("b", 2)], { revision: 10 });
  const service = createHistoryService(history);

  assert.throws(() => service.remove({ ids: ["a", "a"] }), TypeError);
  assert.deepEqual(history.entries.map(item => item.id), ["a", "b"]);
  assert.equal(history.revision, 10);

  assert.deepEqual(service.remove({ ids: ["a", "unknown"] }), {
    removedCount: 1,
    revision: 11,
  });
  assert.deepEqual(service.remove({ ids: ["a"] }), {
    removedCount: 0,
    revision: 11,
  });
  assert.deepEqual(history.entries.map(item => item.id), ["b"]);
});

test("clear respects bounded ranges and all-time clearing is idempotent", () => {
  const history = historyWith(
    [
      visit("old", NOW - 2 * DAY_MS),
      visit("from", NOW - DAY_MS),
      visit("inside", NOW - 1_000),
      visit("to", NOW),
    ],
    { revision: 2 }
  );
  const service = createHistoryService(history, { clock: () => NOW });

  assert.throws(() => service.clear({}), TypeError);
  assert.equal(history.revision, 2);
  assert.deepEqual(
    service.clear({ range: "custom", from: NOW - DAY_MS, to: NOW }),
    { removedCount: 2, revision: 3 }
  );
  assert.deepEqual(history.entries.map(item => item.id), ["old", "to"]);
  assert.deepEqual(service.clear({ range: "all" }), { removedCount: 2, revision: 4 });
  assert.deepEqual(service.clear({ range: "all" }), { removedCount: 0, revision: 4 });
});

test("preference updates prune atomically and reject invalid payloads", () => {
  const history = historyWith(
    [visit("expired", NOW - 7 * DAY_MS - 1), visit("boundary", NOW - 7 * DAY_MS)],
    { revision: 5 }
  );
  const service = createHistoryService(history, { clock: () => NOW });

  assert.deepEqual(service.setPreferences({ retentionDays: 7, recordingEnabled: false }), {
    preferences: {
      recordingEnabled: false,
      retentionDays: 7,
      clearOnExit: false,
    },
    prunedCount: 1,
    revision: 6,
  });
  assert.deepEqual(history.entries.map(item => item.id), ["boundary"]);
  assert.deepEqual(service.setPreferences({ retentionDays: 7, recordingEnabled: false }), {
    preferences: {
      recordingEnabled: false,
      retentionDays: 7,
      clearOnExit: false,
    },
    prunedCount: 0,
    revision: 6,
  });

  const snapshot = structuredClone(history);
  assert.throws(() => service.setPreferences({ retentionDays: 8 }), TypeError);
  assert.throws(() => service.setPreferences({ unknown: true }), TypeError);
  assert.deepEqual(history, snapshot);
});

test("append enforces recording policy and privacy-safe URL normalization", () => {
  const history = createDefaultHistory();
  const service = createHistoryService(history, {
    clock: () => NOW,
    idFactory: sequentialIds(),
  });

  assert.equal(
    service.append({
      tabId: "tab",
      navigationVersion: 1,
      url: "https://example.com/subframe",
      isMainFrame: false,
    }).reason,
    "not-main-frame"
  );
  assert.equal(
    service.append({
      tabId: "tab",
      navigationVersion: 2,
      url: "https://example.com/failed",
      failed: true,
    }).reason,
    "unsuccessful-navigation"
  );
  assert.equal(
    service.append({
      tabId: "tab",
      navigationVersion: 3,
      url: "data:text/html,private",
    }).reason,
    "unsafe-url"
  );
  assert.equal(history.revision, 0);

  const result = service.append({
    tabId: "tab",
    navigationVersion: 4,
    url: "https://user:secret@example.com/path?q=kept#fragment",
    title: `  ${"T".repeat(510)}  `,
    visitedAt: NOW + 5 * 60 * 1_000 + 1,
    transition: "unexpected",
  });
  assert.equal(result.recorded, true);
  assert.equal(result.revision, 1);
  assert.equal(history.entries[0].url, "https://example.com/path?q=kept");
  assert.equal(history.entries[0].title.length, 500);
  assert.equal(history.entries[0].visitedAt, NOW);
  assert.equal(history.entries[0].transition, "other");

  assert.throws(
    () => service.append({
      tabId: "tab",
      navigationVersion: 6,
      url: "https://example.com/retry",
      title: 123,
    }),
    TypeError
  );
  assert.equal(
    service.append({
      tabId: "tab",
      navigationVersion: 6,
      url: "https://example.com/retry",
      title: "Valid retry",
    }).recorded,
    true
  );

  service.setPreferences({ recordingEnabled: false });
  assert.equal(
    service.append({
      tabId: "tab",
      navigationVersion: 5,
      url: "https://example.com/disabled",
    }).reason,
    "recording-disabled"
  );
  assert.equal(history.entries.length, 2);
});

test("navigation versions deduplicate visits and reject stale delayed titles", () => {
  const history = createDefaultHistory();
  const service = createHistoryService(history, {
    clock: () => NOW,
    idFactory: sequentialIds("nav"),
  });

  const first = service.append({
    tabId: "tab",
    navigationVersion: "v1",
    url: "https://example.com/page#first",
    title: "Loading",
    transition: "redirect",
  });
  assert.equal(first.recorded, true);
  assert.equal(
    service.append({
      tabId: "tab",
      navigationVersion: "v1",
      url: "https://example.com/duplicate",
    }).reason,
    "duplicate-navigation"
  );

  assert.deepEqual(
    service.updateTitle({
      tabId: "tab",
      navigationVersion: "v1",
      entryId: first.id,
      url: "https://example.com/page#updated-fragment",
      title: "Committed title",
    }),
    {
      updated: true,
      entry: {
        id: first.id,
        url: "https://example.com/page",
        title: "Committed title",
        visitedAt: NOW,
        transition: "redirect",
      },
      revision: 2,
    }
  );

  assert.equal(
    service.append({
      tabId: "tab",
      navigationVersion: "v2",
      url: "https://example.com/page#second",
      previousUrl: "https://example.com/page#first",
      sameDocument: true,
    }).reason,
    "fragment-only"
  );
  const current = service.append({
    tabId: "tab",
    navigationVersion: "v3",
    url: "https://example.com/page?chapter=2#section",
    previousUrl: "https://example.com/page#second",
    sameDocument: true,
    transition: "reload",
  });
  assert.equal(current.recorded, true);
  assert.equal(history.entries.length, 2);

  assert.equal(
    service.updateTitle({
      tabId: "tab",
      navigationVersion: "v1",
      entryId: first.id,
      url: "https://example.com/page",
      title: "Late stale title",
    }).reason,
    "stale-navigation"
  );
  assert.equal(
    service.updateTitle({
      tabId: "tab",
      navigationVersion: "v3",
      entryId: current.id,
      url: "https://example.com/page?chapter=2#ignored",
      title: "Current title",
    }).updated,
    true
  );
  assert.equal(history.entries.find(item => item.id === first.id).title, "Committed title");
  assert.equal(history.entries.find(item => item.id === current.id).title, "Current title");
});

test("append prunes retention and the hard cap in the same revision transaction", () => {
  const entries = Array.from({ length: HISTORY_ENTRY_LIMIT }, (_, index) =>
    visit(`existing-${index}`, NOW - HISTORY_ENTRY_LIMIT + index)
  );
  const history = historyWith(entries, {
    revision: 8,
    preferences: { retentionDays: 0 },
  });
  const service = createHistoryService(history, {
    clock: () => NOW,
    idFactory: () => "newest",
  });

  const result = service.append({
    tabId: "tab",
    navigationVersion: 1,
    url: "https://example.com/newest",
    visitedAt: NOW,
  });
  assert.equal(result.recorded, true);
  assert.equal(result.prunedCount, 1);
  assert.equal(result.revision, 9);
  assert.equal(history.entries.length, HISTORY_ENTRY_LIMIT);
  assert.equal(history.entries[0].id, "existing-1");
  assert.equal(history.entries.at(-1).id, "newest");
});

test("explicit prune increments only when data changes", () => {
  const history = historyWith(
    [visit("expired", NOW - 90 * DAY_MS - 1), visit("kept", NOW - 90 * DAY_MS)],
    { revision: 1 }
  );
  const service = createHistoryService(history, { clock: () => NOW });

  assert.deepEqual(service.prune(), { prunedCount: 1, revision: 2 });
  assert.deepEqual(service.prune(), { prunedCount: 0, revision: 2 });
  assert.deepEqual(history.entries.map(item => item.id), ["kept"]);
});
