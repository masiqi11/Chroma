import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_STARTUP_MODE,
  STARTUP_ACTION_TYPES,
  STARTUP_MODES,
  STARTUP_NEW_TAB_URL,
  STARTUP_PAGE_LIMIT,
  STARTUP_URL_MAX_LENGTH,
  computeStartupActions,
  sanitizeExternalStartupUrls,
  sanitizeStartupPages,
  sanitizeStartupPreference,
  sanitizeStartupUrl,
} from "../src/main/startup-policy.mjs";

test("sanitizes persisted startup URLs without credentials or fragments", () => {
  const prefix = "https://example.com/";
  const boundedUrl = `${prefix}${"x".repeat(STARTUP_URL_MAX_LENGTH - prefix.length)}`;

  assert.equal(
    sanitizeStartupUrl(" https://alice:secret@Example.com:443/path?q=1#private "),
    "https://example.com/path?q=1"
  );
  assert.equal(sanitizeStartupUrl("http://example.com/#section"), "http://example.com/");
  assert.equal(sanitizeStartupUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeStartupUrl("file:///etc/passwd"), null);
  assert.equal(sanitizeStartupUrl("chroma://newtab/"), null);
  assert.equal(sanitizeStartupUrl("not a URL"), null);
  assert.equal(sanitizeStartupUrl(boundedUrl), boundedUrl);
  assert.equal(
    sanitizeStartupUrl(`https://example.com/${"x".repeat(STARTUP_URL_MAX_LENGTH)}`),
    null
  );
  assert.equal(sanitizeStartupUrl(null), null);
});

test("caps persisted pages while retaining valid input order and duplicates", () => {
  const candidates = ["file:///invalid"];
  for (let index = 0; index < STARTUP_PAGE_LIMIT + 4; index += 1) {
    candidates.push(`https://example.com/${index}#discarded`);
  }
  candidates.splice(4, 0, "https://example.com/2#another-fragment");

  const pages = sanitizeStartupPages(candidates);

  assert.equal(pages.length, STARTUP_PAGE_LIMIT);
  assert.deepEqual(pages.slice(0, 5), [
    "https://example.com/0",
    "https://example.com/1",
    "https://example.com/2",
    "https://example.com/2",
    "https://example.com/3",
  ]);
  assert.deepEqual(sanitizeStartupPages("https://example.com"), []);
});

test("sanitizes all three explicit startup preference modes", () => {
  assert.deepEqual(
    sanitizeStartupPreference({ mode: STARTUP_MODES.CONTINUE, pages: ["https://ignored.test"] }),
    { mode: STARTUP_MODES.CONTINUE, pages: [] }
  );
  assert.deepEqual(
    sanitizeStartupPreference({ mode: STARTUP_MODES.NEW_TAB, pages: ["https://ignored.test"] }),
    { mode: STARTUP_MODES.NEW_TAB, pages: [] }
  );
  assert.deepEqual(
    sanitizeStartupPreference({
      mode: STARTUP_MODES.SPECIFIC_PAGES,
      pages: ["https://one.test/a#private", "https://two.test/b"],
    }),
    {
      mode: STARTUP_MODES.SPECIFIC_PAGES,
      pages: ["https://one.test/a", "https://two.test/b"],
    }
  );
});

test("uses a safe explicit fallback for empty or corrupt preferences", () => {
  assert.equal(DEFAULT_STARTUP_MODE, STARTUP_MODES.CONTINUE);
  assert.deepEqual(
    sanitizeStartupPreference({
      mode: STARTUP_MODES.SPECIFIC_PAGES,
      pages: ["file:///invalid", "javascript:alert(1)"],
    }),
    { mode: STARTUP_MODES.NEW_TAB, pages: [] }
  );
  assert.deepEqual(sanitizeStartupPreference({ mode: "unknown" }), {
    mode: STARTUP_MODES.CONTINUE,
    pages: [],
  });
  assert.deepEqual(sanitizeStartupPreference(null), {
    mode: STARTUP_MODES.CONTINUE,
    pages: [],
  });
});

test("restores a clean continue session and avoids restoring a dirty session", () => {
  assert.deepEqual(
    computeStartupActions({
      preference: { mode: STARTUP_MODES.CONTINUE },
      cleanShutdown: true,
    }),
    [{ type: STARTUP_ACTION_TYPES.RESTORE_SESSION, source: "preference" }]
  );

  for (const cleanShutdown of [false, undefined, "true"]) {
    assert.deepEqual(
      computeStartupActions({
        preference: { mode: STARTUP_MODES.CONTINUE },
        cleanShutdown,
      }),
      [
        { type: STARTUP_ACTION_TYPES.START_FRESH_SESSION, source: "policy" },
        {
          type: STARTUP_ACTION_TYPES.OPEN_URL,
          source: "fallback",
          url: STARTUP_NEW_TAB_URL,
        },
      ]
    );
  }
});

test("computes new-tab and specific-pages actions independently of shutdown state", () => {
  assert.deepEqual(
    computeStartupActions({
      preference: { mode: STARTUP_MODES.NEW_TAB },
      cleanShutdown: true,
    }),
    [
      { type: STARTUP_ACTION_TYPES.START_FRESH_SESSION, source: "policy" },
      {
        type: STARTUP_ACTION_TYPES.OPEN_URL,
        source: "preference",
        url: STARTUP_NEW_TAB_URL,
      },
    ]
  );

  const preference = {
    mode: STARTUP_MODES.SPECIFIC_PAGES,
    pages: ["https://one.test/#secret", "https://two.test/path"],
  };
  const snapshot = structuredClone(preference);
  assert.deepEqual(
    computeStartupActions({ preference, cleanShutdown: false }),
    [
      { type: STARTUP_ACTION_TYPES.START_FRESH_SESSION, source: "policy" },
      {
        type: STARTUP_ACTION_TYPES.OPEN_URL,
        source: "preference",
        url: "https://one.test/",
      },
      {
        type: STARTUP_ACTION_TYPES.OPEN_URL,
        source: "preference",
        url: "https://two.test/path",
      },
    ]
  );
  assert.deepEqual(preference, snapshot);
});

test("keeps every valid external startup URL in stable order", () => {
  const fragmentRouterUrl = "https://alice:secret@router.test/#/account/private";
  const externalStartupUrls = [
    "https://alice:secret@external.test/first#anchor",
    "https://external.test/repeated#same",
    "file:///invalid",
    "https://external.test/repeated#same",
    "http://external.test/last",
  ];

  assert.equal(sanitizeStartupUrl(fragmentRouterUrl), "https://router.test/");
  assert.deepEqual(sanitizeExternalStartupUrls([fragmentRouterUrl]), [
    "https://router.test/#/account/private",
  ]);
  assert.deepEqual(sanitizeExternalStartupUrls(externalStartupUrls), [
    "https://external.test/first#anchor",
    "https://external.test/repeated#same",
    "https://external.test/repeated#same",
    "http://external.test/last",
  ]);

  assert.deepEqual(
    computeStartupActions({
      preference: {
        mode: STARTUP_MODES.SPECIFIC_PAGES,
        pages: ["https://preference.test/#not-persisted"],
      },
      cleanShutdown: true,
      externalStartupUrls,
    }),
    [
      { type: STARTUP_ACTION_TYPES.START_FRESH_SESSION, source: "policy" },
      {
        type: STARTUP_ACTION_TYPES.OPEN_URL,
        source: "preference",
        url: "https://preference.test/",
      },
      {
        type: STARTUP_ACTION_TYPES.OPEN_URL,
        source: "external",
        url: "https://external.test/first#anchor",
      },
      {
        type: STARTUP_ACTION_TYPES.OPEN_URL,
        source: "external",
        url: "https://external.test/repeated#same",
      },
      {
        type: STARTUP_ACTION_TYPES.OPEN_URL,
        source: "external",
        url: "https://external.test/repeated#same",
      },
      {
        type: STARTUP_ACTION_TYPES.OPEN_URL,
        source: "external",
        url: "http://external.test/last",
      },
    ]
  );
});

test("appends all external targets after every base mode", () => {
  const externalStartupUrls = Array.from(
    { length: STARTUP_PAGE_LIMIT + 3 },
    (_value, index) => `https://external.test/${index}`
  );

  const cases = [
    {
      preference: { mode: STARTUP_MODES.CONTINUE },
      cleanShutdown: true,
      base: [{ type: STARTUP_ACTION_TYPES.RESTORE_SESSION, source: "preference" }],
    },
    {
      preference: { mode: STARTUP_MODES.CONTINUE },
      cleanShutdown: false,
      base: [{ type: STARTUP_ACTION_TYPES.START_FRESH_SESSION, source: "policy" }],
    },
    {
      preference: { mode: STARTUP_MODES.NEW_TAB },
      cleanShutdown: true,
      base: [{ type: STARTUP_ACTION_TYPES.START_FRESH_SESSION, source: "policy" }],
    },
  ];

  for (const { preference, cleanShutdown, base } of cases) {
    const actions = computeStartupActions({
      preference,
      cleanShutdown,
      externalStartupUrls,
    });
    assert.deepEqual(actions.slice(0, base.length), base);
    assert.deepEqual(
      actions.slice(base.length).map(action => action.url),
      externalStartupUrls
    );
    assert.equal(actions.every((action, index) => (
      index < base.length || action.source === "external"
    )), true);
  }
});

test("default planning is deterministic, pure, and does not mutate inputs", () => {
  const input = {
    preference: { mode: STARTUP_MODES.NEW_TAB },
    cleanShutdown: false,
    externalStartupUrls: ["https://example.test/path#anchor"],
  };
  const snapshot = structuredClone(input);

  const first = computeStartupActions(input);
  const second = computeStartupActions(input);

  assert.deepEqual(first, second);
  assert.deepEqual(input, snapshot);
  assert.notEqual(first, second);
  assert.deepEqual(computeStartupActions(), [
    { type: STARTUP_ACTION_TYPES.START_FRESH_SESSION, source: "policy" },
    {
      type: STARTUP_ACTION_TYPES.OPEN_URL,
      source: "fallback",
      url: STARTUP_NEW_TAB_URL,
    },
  ]);
  for (const invalidInput of [null, "invalid", []]) {
    assert.deepEqual(computeStartupActions(invalidInput), [
      { type: STARTUP_ACTION_TYPES.START_FRESH_SESSION, source: "policy" },
      {
        type: STARTUP_ACTION_TYPES.OPEN_URL,
        source: "fallback",
        url: STARTUP_NEW_TAB_URL,
      },
    ]);
  }
});
