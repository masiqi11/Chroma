import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SEARCH_PROVIDER_ID,
  SEARCH_PROVIDERS,
  SEARCH_PROVIDER_IDS,
  SEARCH_QUERY_MAX_LENGTH,
  getSearchProvider,
  normalizeSearchQuery,
  sanitizeSearchProviderId,
  searchUrlForQuery,
} from "../src/shared/search-providers.mjs";

test("exposes only the immutable built-in HTTPS provider registry", () => {
  assert.equal(DEFAULT_SEARCH_PROVIDER_ID, "google");
  assert.deepEqual(SEARCH_PROVIDER_IDS, [
    "google",
    "bing",
    "duckduckgo",
    "baidu",
  ]);
  assert.equal(Object.isFrozen(SEARCH_PROVIDERS), true);
  assert.equal(Object.isFrozen(SEARCH_PROVIDER_IDS), true);

  for (const provider of SEARCH_PROVIDERS) {
    assert.equal(Object.isFrozen(provider), true);
    assert.match(provider.id, /^[a-z]+$/);
    assert.ok(provider.label);
    assert.ok(provider.queryParameter);
    for (const value of [provider.homepageUrl, provider.searchUrl]) {
      const url = new URL(value);
      assert.equal(url.protocol, "https:");
      assert.equal(url.username, "");
      assert.equal(url.password, "");
      assert.equal(url.hash, "");
    }
  }
});

test("sanitizes provider IDs without accepting URLs or executable schemes", () => {
  assert.equal(sanitizeSearchProviderId("  BAIDU  "), "baidu");
  assert.equal(sanitizeSearchProviderId("duckduckgo"), "duckduckgo");
  assert.equal(sanitizeSearchProviderId("javascript:alert(1)"), "google");
  assert.equal(sanitizeSearchProviderId("data:text/html,owned"), "google");
  assert.equal(sanitizeSearchProviderId("https://search.example/"), "google");
  assert.equal(sanitizeSearchProviderId(null, "bing"), "bing");
  assert.equal(sanitizeSearchProviderId("unknown", "also-unknown"), "google");
  assert.equal(getSearchProvider("javascript:alert(1)").id, "google");
});

test("builds provider-specific search URLs for English and Chinese queries", () => {
  assert.equal(
    searchUrlForQuery("  Chroma   browser\nChromium  "),
    "https://www.google.com/search?q=Chroma%20%20%20browser%0AChromium"
  );
  assert.equal(
    searchUrlForQuery("privacy browser", "bing"),
    "https://www.bing.com/search?q=privacy%20browser"
  );
  assert.equal(
    searchUrlForQuery("private search", "duckduckgo"),
    "https://duckduckgo.com/?q=private%20search"
  );

  const baidu = new URL(searchUrlForQuery("  中文   浏览器  ", "baidu"));
  assert.equal(baidu.origin, "https://www.baidu.com");
  assert.equal(baidu.pathname, "/s");
  assert.equal(baidu.searchParams.get("wd"), "中文   浏览器");
});

test("normalizes blank input and bounds long Unicode queries by code point", () => {
  assert.equal(normalizeSearchQuery(" \n\t "), "");
  assert.equal(
    new URL(searchUrlForQuery(" \n\t ")).searchParams.get("q"),
    ""
  );

  const longQuery = `${"搜".repeat(SEARCH_QUERY_MAX_LENGTH + 20)}😀tail`;
  const normalized = normalizeSearchQuery(longQuery);
  assert.equal([...normalized].length, SEARCH_QUERY_MAX_LENGTH);
  assert.equal(normalized, "搜".repeat(SEARCH_QUERY_MAX_LENGTH));
  assert.equal(
    [...new URL(searchUrlForQuery(longQuery)).searchParams.get("q")].length,
    SEARCH_QUERY_MAX_LENGTH
  );
});

test("treats executable-looking text only as encoded search data", () => {
  for (const query of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
  ]) {
    const result = new URL(searchUrlForQuery(query, "javascript:owned"));
    assert.equal(result.protocol, "https:");
    assert.equal(result.origin, "https://www.google.com");
    assert.equal(result.searchParams.get("q"), query);
  }
});
