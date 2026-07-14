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
    normalizeNavigationInput("javascript:alert(1)"),
    "https://www.google.com/search?q=javascript%3Aalert(1)"
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
