import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BROWSER_COMMANDS,
  createCommandCatalog,
  isCommandEnabled,
  normalizeCommandItem,
  normalizeCommandText,
  normalizeCommandTokens,
  searchCommands,
} from "../src/shared/command-search.mjs";

function command(id, title, extra = {}) {
  return {
    id,
    title,
    action: `test:${id}`,
    ...extra,
  };
}

test("normalizes Unicode width, case, punctuation, whitespace and CJK text", () => {
  assert.equal(
    normalizeCommandText("  ＮＥＷ—ＴＡＢ　新建【标签】  "),
    "new tab 新建 标签"
  );
  assert.deepEqual(normalizeCommandTokens(" Tab, tab　新建标签 "), ["tab", "新建标签"]);
  assert.equal(normalizeCommandText(null), "");
});

test("validates, trims and deeply freezes catalog item search data", () => {
  const item = normalizeCommandItem({
    id: "  demo  ",
    title: "  Demo command ",
    action: " demo:run ",
    aliases: [" Demo ", "ＤＥＭＯ", "", "Another name"],
    keywords: ["keyword"],
  });

  assert.equal(item.id, "demo");
  assert.equal(item.category, "General");
  assert.deepEqual(item.aliases, ["Demo", "Another name"]);
  assert.ok(Object.isFrozen(item));
  assert.ok(Object.isFrozen(item.aliases));
  assert.throws(() => normalizeCommandItem(null), /must be objects/);
  assert.throws(
    () => normalizeCommandItem(command("bad", "Bad", { enabled: "sometimes" })),
    /boolean or function/
  );
  assert.throws(
    () => normalizeCommandItem(command("bad", "Bad", { keywords: ["ok", 1] })),
    /only strings/
  );
});

test("creates a unique immutable catalog", () => {
  const catalog = createCommandCatalog([
    command("one", "One"),
    command("two", "Two", { category: "Tests" }),
  ]);

  assert.ok(Object.isFrozen(catalog));
  assert.equal(catalog[1].category, "Tests");
  assert.throws(
    () => createCommandCatalog([command("same", "One"), command("same", "Two")]),
    /duplicate command id/
  );
  assert.throws(() => createCommandCatalog({}), /must be an array/);
});

test("ships the expected browser action catalog with unique IDs", () => {
  assert.ok(Object.isFrozen(DEFAULT_BROWSER_COMMANDS));
  assert.deepEqual(
    DEFAULT_BROWSER_COMMANDS.map(item => item.action),
    [
      "address:focus",
      "tab:create",
      "tab:close",
      "tab:reopen",
      "navigation:reload",
      "bookmark:toggle",
      "sidebar:toggle",
      "split:active",
      "split:set-preset",
      "split:set-preset",
      "split:set-preset",
      "media:toggle-playback",
      "media:toggle-pip",
      "history:open",
      "downloads:open",
      "developer:open-tools",
    ]
  );
  assert.equal(
    new Set(DEFAULT_BROWSER_COMMANDS.map(item => item.id)).size,
    DEFAULT_BROWSER_COMMANDS.length
  );
  assert.ok(DEFAULT_BROWSER_COMMANDS.every(item => item.aliases.length > 0));
  assert.ok(DEFAULT_BROWSER_COMMANDS.every(item => item.keywords.length > 0));
});

test("empty search filters disabled commands, preserves source order and applies limit", () => {
  const catalog = [
    command("first", "First"),
    command("hidden", "Hidden", { enabled: false }),
    command("contextual", "Contextual", { enabled: context => context.ready }),
    command("last", "Last"),
  ];

  assert.deepEqual(
    searchCommands("", { catalog, context: { ready: true }, limit: 3 }).map(item => item.id),
    ["first", "contextual", "last"]
  );
  assert.deepEqual(
    searchCommands("", { catalog, context: { ready: false } }).map(item => item.id),
    ["first", "last"]
  );
});

test("enabled predicates are isolated and require an affirmative result", () => {
  assert.equal(isCommandEnabled({ enabled: true }), true);
  assert.equal(isCommandEnabled({ enabled: false }), false);
  assert.equal(isCommandEnabled({ enabled: () => true }, {}), true);
  assert.equal(isCommandEnabled({ enabled: () => "yes" }, {}), false);
  assert.equal(
    isCommandEnabled({ enabled: () => { throw new Error("bad context"); } }, {}),
    false
  );
});

test("ranks title exact matches ahead of prefixes and prefixes ahead of containment", () => {
  const catalog = [
    command("contains", "Open a new workspace"),
    command("prefix", "New window"),
    command("exact", "New"),
  ];

  assert.deepEqual(
    searchCommands("new", { catalog }).map(item => item.id),
    ["exact", "prefix", "contains"]
  );
});

test("uses aliases and keywords while requiring every query token to match", () => {
  const catalog = [
    command("restore", "Reopen closed tab", {
      aliases: ["恢复关闭的标签页", "restore tab"],
      keywords: ["recent page"],
    }),
    command("history", "Open history", {
      aliases: ["历史记录"],
      keywords: ["recent page"],
    }),
  ];

  assert.deepEqual(
    searchCommands("恢复 tab", { catalog }).map(item => item.id),
    ["restore"]
  );
  assert.deepEqual(
    searchCommands("recent page", { catalog }).map(item => item.id),
    ["restore", "history"]
  );
  assert.deepEqual(searchCommands("recent missing", { catalog }), []);
});

test("matches case-insensitive English, full-width input and unspaced Chinese substrings", () => {
  assert.equal(searchCommands("ＮＥＷ ＴＡＢ")[0].id, "new-tab");
  assert.equal(searchCommands("新建标签")[0].id, "new-tab");
  assert.equal(searchCommands("DEVTOOLS")[0].id, "open-developer-tools");
  assert.equal(searchCommands("历史记录")[0].id, "open-history");
});

test("keeps equal-scoring results in catalog order", () => {
  const catalog = [
    command("z-first", "Unrelated", { aliases: ["shared alias"] }),
    command("a-second", "Different", { aliases: ["shared alias"] }),
    command("m-third", "Other", { aliases: ["shared alias"] }),
  ];

  assert.deepEqual(
    searchCommands("shared alias", { catalog }).map(item => item.id),
    ["z-first", "a-second", "m-third"]
  );
});

test("default contextual gates hide unavailable tab and browser actions", () => {
  const context = {
    hasActiveTab: false,
    tabCount: 0,
    canRestoreTab: false,
    historyAvailable: false,
    downloadsAvailable: false,
    developerToolsAllowed: false,
  };
  const ids = searchCommands("", { context, limit: 99 }).map(item => item.id);

  assert.deepEqual(ids, ["focus-address", "new-tab", "toggle-sidebar"]);
});

test("supports zero limit and rejects ambiguous limit values", () => {
  assert.deepEqual(searchCommands("tab", { limit: 0 }), []);
  assert.throws(() => searchCommands("tab", { limit: -1 }), /non-negative/);
  assert.throws(() => searchCommands("tab", { limit: 1.5 }), /safe integer/);
  assert.throws(() => searchCommands("tab", { limit: Number.POSITIVE_INFINITY }), /safe integer/);
});

