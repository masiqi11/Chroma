import test from "node:test";
import assert from "node:assert/strict";

import {
  displayNavigationUrl,
  normalizeNavigationInput,
} from "../src/shared/navigation.mjs";

test("normalizes domains and explicit web URLs", () => {
  assert.equal(normalizeNavigationInput("example.com"), "https://example.com/");
  assert.equal(
    normalizeNavigationInput("https://example.com/docs?q=zen"),
    "https://example.com/docs?q=zen"
  );
  assert.equal(
    normalizeNavigationInput("localhost:5173/path"),
    "http://localhost:5173/path"
  );
});

test("turns free text and unsafe schemes into searches", () => {
  assert.equal(
    normalizeNavigationInput("chroma browser chromium"),
    "https://www.google.com/search?q=chroma%20browser%20chromium"
  );
  assert.equal(
    normalizeNavigationInput("  keep   spacing\nhere  "),
    "https://www.google.com/search?q=keep%20%20%20spacing%0Ahere"
  );
  assert.equal(
    normalizeNavigationInput("javascript:alert(1)"),
    "https://www.google.com/search?q=javascript%3Aalert(1)"
  );
  assert.equal(
    normalizeNavigationInput("data:text/html,unsafe"),
    "https://www.google.com/search?q=data%3Atext%2Fhtml%2Cunsafe"
  );
});

test("uses only explicit built-in search provider IDs", () => {
  assert.equal(
    normalizeNavigationInput("chroma browser", { searchProviderId: "bing" }),
    "https://www.bing.com/search?q=chroma%20browser"
  );
  assert.equal(
    normalizeNavigationInput("中文 浏览器", { searchProviderId: "baidu" }),
    "https://www.baidu.com/s?wd=%E4%B8%AD%E6%96%87%20%E6%B5%8F%E8%A7%88%E5%99%A8"
  );
  assert.equal(
    normalizeNavigationInput("private search", { searchProviderId: "duckduckgo" }),
    "https://duckduckgo.com/?q=private%20search"
  );
  assert.equal(
    normalizeNavigationInput("safe fallback", {
      searchProviderId: "javascript:alert(1)",
      searchTemplate: "javascript:%s",
    }),
    "https://www.google.com/search?q=safe%20fallback"
  );
});

test("maps blank/new-tab inputs to the internal page", () => {
  assert.equal(normalizeNavigationInput(""), "chroma://newtab/");
  assert.equal(normalizeNavigationInput("about:newtab"), "chroma://newtab/");
  assert.equal(displayNavigationUrl("chroma://newtab/"), "");
  assert.equal(
    displayNavigationUrl("https://example.com/a?q=1"),
    "example.com/a?q=1"
  );
});
