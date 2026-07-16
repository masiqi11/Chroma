export const DEFAULT_SEARCH_PROVIDER_ID = "google";
export const SEARCH_QUERY_MAX_LENGTH = 512;

const providerDefinitions = [
  {
    id: "google",
    label: "Google",
    homepageUrl: "https://www.google.com/",
    searchUrl: "https://www.google.com/search",
    queryParameter: "q",
  },
  {
    id: "bing",
    label: "Bing",
    homepageUrl: "https://www.bing.com/",
    searchUrl: "https://www.bing.com/search",
    queryParameter: "q",
  },
  {
    id: "duckduckgo",
    label: "DuckDuckGo",
    homepageUrl: "https://duckduckgo.com/",
    searchUrl: "https://duckduckgo.com/",
    queryParameter: "q",
  },
  {
    id: "baidu",
    label: "Baidu",
    homepageUrl: "https://www.baidu.com/",
    searchUrl: "https://www.baidu.com/s",
    queryParameter: "wd",
  },
];

export const SEARCH_PROVIDERS = Object.freeze(
  providerDefinitions.map(provider => Object.freeze({ ...provider }))
);
export const SEARCH_PROVIDER_IDS = Object.freeze(
  SEARCH_PROVIDERS.map(provider => provider.id)
);

const providersById = new Map(
  SEARCH_PROVIDERS.map(provider => [provider.id, provider])
);

export function sanitizeSearchProviderId(
  value,
  fallback = DEFAULT_SEARCH_PROVIDER_ID
) {
  const normalizedFallback = typeof fallback === "string"
    ? fallback.trim().toLowerCase()
    : "";
  const safeFallback = providersById.has(normalizedFallback)
    ? normalizedFallback
    : DEFAULT_SEARCH_PROVIDER_ID;
  if (typeof value !== "string") return safeFallback;
  const candidate = value.trim().toLowerCase();
  return providersById.has(candidate) ? candidate : safeFallback;
}

export function getSearchProvider(value = DEFAULT_SEARCH_PROVIDER_ID) {
  return providersById.get(sanitizeSearchProviderId(value));
}

export function normalizeSearchQuery(value) {
  const trimmed = String(value ?? "").trim();
  return [...trimmed].slice(0, SEARCH_QUERY_MAX_LENGTH).join("");
}

export function searchUrlForQuery(
  query,
  providerId = DEFAULT_SEARCH_PROVIDER_ID
) {
  const provider = getSearchProvider(providerId);
  const encodedQuery = encodeURIComponent(normalizeSearchQuery(query));
  return `${provider.searchUrl}?${provider.queryParameter}=${encodedQuery}`;
}
