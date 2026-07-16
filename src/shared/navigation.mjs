import {
  DEFAULT_SEARCH_PROVIDER_ID,
  searchUrlForQuery,
} from "./search-providers.mjs";

const WEB_SCHEMES = new Set(["http:", "https:"]);
const INTERNAL_SCHEMES = new Set(["chroma:"]);

function looksLikeHost(value) {
  if (/^localhost(?::\d+)?(?:[/#?]|$)/i.test(value)) {
    return true;
  }

  if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/#?]|$)/.test(value)) {
    return true;
  }

  return /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}(?::\d+)?(?:[/#?]|$)/i.test(
    value
  );
}

export function normalizeNavigationInput(
  input,
  { searchProviderId = DEFAULT_SEARCH_PROVIDER_ID } = {}
) {
  const value = String(input ?? "").trim();
  if (!value) {
    return "chroma://newtab/";
  }

  if (/^about:(?:blank|newtab)$/i.test(value)) {
    return "chroma://newtab/";
  }

  try {
    const parsed = new URL(value);
    if (WEB_SCHEMES.has(parsed.protocol) || INTERNAL_SCHEMES.has(parsed.protocol)) {
      return parsed.href;
    }
  } catch {
    // A host without a scheme is handled below.
  }

  if (!/\s/.test(value) && looksLikeHost(value)) {
    const scheme = /^localhost(?::\d+)?(?:[/#?]|$)/i.test(value) ? "http" : "https";
    return new URL(`${scheme}://${value}`).href;
  }

  return searchUrlForQuery(value, searchProviderId);
}

export function displayNavigationUrl(url) {
  if (!url || url.startsWith("chroma://newtab")) {
    return "";
  }

  try {
    const parsed = new URL(url);
    if (WEB_SCHEMES.has(parsed.protocol)) {
      const suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      return `${parsed.host}${suffix === "/" ? "" : suffix}`;
    }
  } catch {
    // Preserve unexpected values for diagnostics in the address field.
  }

  return url;
}

export function isSafePageUrl(url) {
  try {
    const parsed = new URL(url);
    return WEB_SCHEMES.has(parsed.protocol) || INTERNAL_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}
