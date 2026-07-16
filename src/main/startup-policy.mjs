export const STARTUP_MODES = Object.freeze({
  CONTINUE: "continue",
  NEW_TAB: "new-tab",
  SPECIFIC_PAGES: "specific-pages",
});

export const DEFAULT_STARTUP_MODE = STARTUP_MODES.CONTINUE;
export const STARTUP_PAGE_LIMIT = 16;
export const STARTUP_URL_MAX_LENGTH = 8_192;
export const STARTUP_NEW_TAB_URL = "chroma://newtab/";

function normalizeHttpStartupUrl(value, { stripFragment }) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > STARTUP_URL_MAX_LENGTH) return null;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    url.username = "";
    url.password = "";
    if (stripFragment) url.hash = "";

    const normalized = url.href;
    return normalized.length <= STARTUP_URL_MAX_LENGTH ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Sanitizes one page that may be persisted as a startup preference.
 * Fragments and credentials are deliberately excluded from stored state.
 */
export function sanitizeStartupUrl(value) {
  return normalizeHttpStartupUrl(value, { stripFragment: true });
}

/**
 * Returns at most STARTUP_PAGE_LIMIT safe, bounded pages in input order.
 */
export function sanitizeStartupPages(values) {
  if (!Array.isArray(values)) return [];

  const pages = [];
  for (const value of values) {
    const url = sanitizeStartupUrl(value);
    if (!url) continue;
    pages.push(url);
    if (pages.length === STARTUP_PAGE_LIMIT) break;
  }
  return pages;
}

/**
 * Produces the complete persisted preference shape without mutating the input.
 * Corrupt modes use the historical continue default. An empty specific-pages
 * preference cannot create a blank startup and therefore becomes new-tab.
 */
export function sanitizeStartupPreference(candidate) {
  const mode = Object.values(STARTUP_MODES).includes(candidate?.mode)
    ? candidate.mode
    : DEFAULT_STARTUP_MODE;
  const pages = mode === STARTUP_MODES.SPECIFIC_PAGES
    ? sanitizeStartupPages(candidate?.pages)
    : [];

  if (mode === STARTUP_MODES.SPECIFIC_PAGES && pages.length === 0) {
    return { mode: STARTUP_MODES.NEW_TAB, pages: [] };
  }
  return { mode, pages };
}

/**
 * External startup targets are transient, so their fragments remain useful for
 * navigation. They are not de-duplicated or capped: every valid OS-delivered
 * target must become one action in the same order in which it arrived.
 */
export function sanitizeExternalStartupUrls(values) {
  if (!Array.isArray(values)) return [];
  const urls = [];
  for (const value of values) {
    const url = normalizeHttpStartupUrl(value, { stripFragment: false });
    if (url) urls.push(url);
  }
  return urls;
}

function preferredStartupActions(preference, cleanShutdown) {
  if (preference.mode === STARTUP_MODES.CONTINUE) {
    return cleanShutdown === true
      ? [{ type: "restore-session", source: "preference" }]
      : [{
          type: "open-url",
          source: "fallback",
          url: STARTUP_NEW_TAB_URL,
        }];
  }

  if (preference.mode === STARTUP_MODES.SPECIFIC_PAGES) {
    return preference.pages.map(url => ({
      type: "open-url",
      source: "preference",
      url,
    }));
  }

  return [{
    type: "open-url",
    source: "preference",
    url: STARTUP_NEW_TAB_URL,
  }];
}

/**
 * Computes startup work without reading state or performing side effects.
 * Preference actions always precede transient external targets. A dirty or
 * unknown shutdown never restores automatically; callers may add recovery UI
 * separately without changing this policy.
 */
export function computeStartupActions({
  preference,
  cleanShutdown = false,
  externalStartupUrls = [],
} = {}) {
  const sanitizedPreference = sanitizeStartupPreference(preference);
  const actions = preferredStartupActions(sanitizedPreference, cleanShutdown);

  for (const url of sanitizeExternalStartupUrls(externalStartupUrls)) {
    actions.push({ type: "open-url", source: "external", url });
  }
  return actions;
}
