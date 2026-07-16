/**
 * @typedef {object} CommandCatalogItem
 * @property {string} id Stable identifier used by selection state.
 * @property {string} title User-facing command label.
 * @property {string} action Renderer or browser-controller action identifier.
 * @property {string} category User-facing command group.
 * @property {string} description Optional supporting copy.
 * @property {readonly string[]} aliases Alternative natural-language names.
 * @property {readonly string[]} keywords Search-only terms.
 * @property {string} shortcut Optional keyboard shortcut label.
 * @property {string} icon Optional renderer-owned icon identifier.
 * @property {boolean | ((context: object) => boolean)} enabled Context gate.
 */

const DEFAULT_RESULT_LIMIT = 12;

const FIELD_WEIGHTS = Object.freeze({
  title: 600,
  aliases: 450,
  keywords: 300,
  description: 180,
  category: 120,
  identity: 80,
});

const MATCH_WEIGHTS = Object.freeze({
  exact: 400,
  prefix: 250,
  wordPrefix: 180,
  contains: 100,
});

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`command ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new TypeError(`command ${field} must be a string`);
  }
  return value.trim();
}

function stringList(value, field) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new TypeError(`command ${field} must be an array of strings`);
  }

  const seen = new Set();
  const result = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") {
      throw new TypeError(`command ${field} must contain only strings`);
    }
    const displayValue = candidate.trim();
    const normalized = normalizeCommandText(displayValue);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(displayValue);
  }
  return Object.freeze(result);
}

/**
 * Normalizes Latin case, full-width characters and punctuation without
 * attempting to split CJK text into words. Substring matching consequently
 * remains useful for unspaced Chinese queries.
 */
export function normalizeCommandText(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeCommandTokens(value) {
  const normalized = normalizeCommandText(value);
  return normalized ? [...new Set(normalized.split(" "))] : [];
}

/**
 * Validates and freezes one catalog item. Search terms retain their display
 * spelling; normalization is applied only by the matching index.
 *
 * @param {Partial<CommandCatalogItem>} candidate
 * @returns {Readonly<CommandCatalogItem>}
 */
export function normalizeCommandItem(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("command catalog items must be objects");
  }

  const enabled = candidate.enabled ?? true;
  if (typeof enabled !== "boolean" && typeof enabled !== "function") {
    throw new TypeError("command enabled must be a boolean or function");
  }

  return Object.freeze({
    id: requiredString(candidate.id, "id"),
    title: requiredString(candidate.title, "title"),
    action: requiredString(candidate.action, "action"),
    category: optionalString(candidate.category, "category") || "General",
    description: optionalString(candidate.description, "description"),
    aliases: stringList(candidate.aliases, "aliases"),
    keywords: stringList(candidate.keywords, "keywords"),
    shortcut: optionalString(candidate.shortcut, "shortcut"),
    icon: optionalString(candidate.icon, "icon"),
    enabled,
  });
}

/**
 * @param {readonly Partial<CommandCatalogItem>[]} items
 * @returns {readonly Readonly<CommandCatalogItem>[]}
 */
export function createCommandCatalog(items) {
  if (!Array.isArray(items)) throw new TypeError("command catalog must be an array");

  const ids = new Set();
  const catalog = items.map(candidate => {
    const item = normalizeCommandItem(candidate);
    if (ids.has(item.id)) throw new TypeError(`duplicate command id: ${item.id}`);
    ids.add(item.id);
    return item;
  });
  return Object.freeze(catalog);
}

function hasActiveTab(context) {
  return context?.hasActiveTab !== false && context?.tabCount !== 0;
}

function canRestoreTab(context) {
  if (typeof context?.canRestoreTab === "boolean") return context.canRestoreTab;
  if (typeof context?.canReopenTab === "boolean") return context.canReopenTab;
  if (Number.isFinite(context?.closedTabCount)) return context.closedTabCount > 0;
  return true;
}

export const DEFAULT_BROWSER_COMMANDS = createCommandCatalog([
  {
    id: "focus-address",
    title: "Focus address bar",
    action: "address:focus",
    category: "Navigation",
    description: "Search the web or enter an address",
    aliases: ["address bar", "location bar", "omnibox", "地址栏", "搜索栏", "网址"],
    keywords: ["search", "url", "navigate", "搜索", "输入网址"],
    icon: "search",
  },
  {
    id: "new-tab",
    title: "New tab",
    action: "tab:create",
    category: "Tabs",
    aliases: ["open tab", "create tab", "新标签页", "新建标签", "打开标签页"],
    keywords: ["tab", "page", "标签", "页面"],
    icon: "plus",
  },
  {
    id: "close-tab",
    title: "Close tab",
    action: "tab:close",
    category: "Tabs",
    aliases: ["close page", "关闭标签页", "关闭页面", "关掉页面"],
    keywords: ["tab", "remove", "标签", "关闭"],
    icon: "close",
    enabled: hasActiveTab,
  },
  {
    id: "restore-tab",
    title: "Reopen closed tab",
    action: "tab:reopen",
    category: "Tabs",
    aliases: [
      "restore tab",
      "undo close tab",
      "恢复关闭的标签页",
      "重新打开标签页",
      "撤销关闭",
    ],
    keywords: ["recent tab", "closed", "恢复", "标签"],
    icon: "restore",
    enabled: canRestoreTab,
  },
  {
    id: "reload",
    title: "Reload page",
    action: "navigation:reload",
    category: "Navigation",
    aliases: ["refresh", "reload tab", "刷新", "重新加载", "刷新页面"],
    keywords: ["page", "website", "页面", "网页"],
    icon: "reload",
    enabled: context => hasActiveTab(context) && context?.canReload !== false,
  },
  {
    id: "toggle-bookmark",
    title: "Add or remove bookmark",
    action: "bookmark:toggle",
    category: "Library",
    aliases: ["bookmark page", "favorite", "书签", "收藏", "添加书签", "移除书签"],
    keywords: ["save page", "saved", "保存网页", "收藏夹"],
    icon: "star",
    enabled: context => hasActiveTab(context) && context?.canBookmark !== false,
  },
  {
    id: "toggle-sidebar",
    title: "Toggle sidebar",
    action: "sidebar:toggle",
    category: "View",
    aliases: ["show sidebar", "hide sidebar", "侧边栏", "边栏", "显示侧栏", "隐藏侧栏"],
    keywords: ["panel", "tabs", "面板", "标签栏"],
    icon: "sidebar",
  },
  {
    id: "split-view",
    title: "Split view",
    action: "split:active",
    category: "View",
    aliases: ["split tab", "side by side", "分屏", "拆分视图", "左右分屏", "并排显示"],
    keywords: ["layout", "pane", "window", "布局", "窗口"],
    icon: "split",
    enabled: context => hasActiveTab(context) && context?.canSplit !== false,
  },
  {
    id: "open-history",
    title: "Open history",
    action: "history:open",
    category: "Library",
    aliases: ["browsing history", "history manager", "历史记录", "浏览记录", "打开历史"],
    keywords: ["visited", "recent pages", "访问记录", "最近网页"],
    icon: "history",
    enabled: context => context?.historyAvailable !== false,
  },
  {
    id: "open-downloads",
    title: "Open downloads",
    action: "downloads:open",
    category: "Library",
    aliases: ["download manager", "downloads", "下载", "下载内容", "下载管理"],
    keywords: ["files", "transfers", "文件", "传输"],
    icon: "download",
    enabled: context => context?.downloadsAvailable !== false,
  },
  {
    id: "open-developer-tools",
    title: "Open developer tools",
    action: "developer:open-tools",
    category: "Developer",
    aliases: ["devtools", "developer tools", "inspect", "开发者工具", "检查元素", "调试工具"],
    keywords: ["console", "debug", "elements", "控制台", "调试"],
    icon: "developer",
    enabled: context => context?.developerToolsAllowed !== false,
  },
]);

export function isCommandEnabled(item, context = {}) {
  if (item.enabled === false) return false;
  if (item.enabled === true || item.enabled === undefined) return true;
  if (typeof item.enabled !== "function") return false;

  try {
    return item.enabled(context && typeof context === "object" ? context : {}) === true;
  } catch {
    return false;
  }
}

function matchKind(field, token) {
  if (field === token) return "exact";
  if (field.startsWith(token)) return "prefix";
  if (field.split(" ").some(word => word.startsWith(token))) return "wordPrefix";
  return field.includes(token) ? "contains" : null;
}

function searchableFields(item) {
  return [
    { value: normalizeCommandText(item.title), weight: FIELD_WEIGHTS.title },
    ...item.aliases.map(value => ({
      value: normalizeCommandText(value),
      weight: FIELD_WEIGHTS.aliases,
    })),
    ...item.keywords.map(value => ({
      value: normalizeCommandText(value),
      weight: FIELD_WEIGHTS.keywords,
    })),
    { value: normalizeCommandText(item.description), weight: FIELD_WEIGHTS.description },
    { value: normalizeCommandText(item.category), weight: FIELD_WEIGHTS.category },
    { value: normalizeCommandText(`${item.id} ${item.action}`), weight: FIELD_WEIGHTS.identity },
  ].filter(field => field.value);
}

function phraseBonus(item, query) {
  const title = normalizeCommandText(item.title);
  const aliases = item.aliases.map(normalizeCommandText);
  if (title === query) return 3_000;
  if (title.startsWith(query)) return 2_000;
  if (aliases.includes(query)) return 1_800;
  if (aliases.some(alias => alias.startsWith(query))) return 1_200;
  if (title.includes(query)) return 900;
  if (aliases.some(alias => alias.includes(query))) return 600;
  return 0;
}

function scoreCommand(item, normalizedQuery, tokens) {
  const fields = searchableFields(item);
  let score = phraseBonus(item, normalizedQuery);

  for (const token of tokens) {
    let best = 0;
    for (const field of fields) {
      const kind = matchKind(field.value, token);
      if (!kind) continue;
      best = Math.max(best, field.weight + MATCH_WEIGHTS[kind]);
    }
    if (!best) return null;
    score += best;
  }
  return score;
}

function normalizedLimit(limit) {
  if (limit === undefined) return DEFAULT_RESULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("command result limit must be a non-negative safe integer");
  }
  return limit;
}

/**
 * Searches the built-in browser catalog by default. Every query token must
 * match at least one field. Exact and prefix matches outrank containment, and
 * source index is the final tie-breaker for deterministic stable ordering.
 *
 * @param {unknown} query
 * @param {object} [options]
 * @param {readonly Partial<CommandCatalogItem>[]} [options.catalog]
 * @param {object} [options.context]
 * @param {number} [options.limit]
 * @returns {readonly Readonly<CommandCatalogItem>[]}
 */
export function searchCommands(
  query,
  { catalog = DEFAULT_BROWSER_COMMANDS, context = {}, limit } = {}
) {
  const resultLimit = normalizedLimit(limit);
  if (resultLimit === 0) return [];

  const source = catalog === DEFAULT_BROWSER_COMMANDS
    ? DEFAULT_BROWSER_COMMANDS
    : createCommandCatalog(catalog);
  const normalizedQuery = normalizeCommandText(query);
  const tokens = normalizeCommandTokens(normalizedQuery);

  const enabled = source
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isCommandEnabled(item, context));

  if (!tokens.length) return enabled.slice(0, resultLimit).map(({ item }) => item);

  return enabled
    .map(({ item, index }) => ({
      item,
      index,
      score: scoreCommand(item, normalizedQuery, tokens),
    }))
    .filter(result => result.score !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, resultLimit)
    .map(({ item }) => item);
}
