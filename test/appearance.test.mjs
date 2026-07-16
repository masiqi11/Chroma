import assert from "node:assert/strict";
import test from "node:test";

import {
  APPEARANCE_THEMES,
  DEFAULT_APPEARANCE,
  sanitizeAppearance,
} from "../src/shared/appearance.mjs";

test("defines the supported appearance themes and immutable defaults", () => {
  assert.deepEqual(APPEARANCE_THEMES, ["system", "light", "dark"]);
  assert.deepEqual(DEFAULT_APPEARANCE, {
    theme: "system",
    reduceTransparency: false,
  });
  assert.equal(Object.isFrozen(APPEARANCE_THEMES), true);
  assert.equal(Object.isFrozen(DEFAULT_APPEARANCE), true);
});

test("accepts only exact theme and boolean appearance values", () => {
  for (const theme of APPEARANCE_THEMES) {
    assert.deepEqual(
      sanitizeAppearance({ theme, reduceTransparency: true }),
      { theme, reduceTransparency: true }
    );
  }

  for (const candidate of [
    null,
    undefined,
    [],
    "dark",
    { theme: "Dark", reduceTransparency: 1 },
    { theme: " dark ", reduceTransparency: "true" },
    { theme: "sepia", reduceTransparency: null },
  ]) {
    assert.deepEqual(sanitizeAppearance(candidate), DEFAULT_APPEARANCE);
  }
});

test("drops unknown fields and never mutates or aliases its input", () => {
  const candidate = {
    theme: "dark",
    reduceTransparency: true,
    css: "body { display: none }",
    nested: { keep: "unchanged" },
  };
  const before = structuredClone(candidate);

  const appearance = sanitizeAppearance(candidate);

  assert.deepEqual(candidate, before);
  assert.deepEqual(appearance, {
    theme: "dark",
    reduceTransparency: true,
  });
  assert.notEqual(appearance, candidate);
  appearance.theme = "light";
  assert.equal(candidate.theme, "dark");
});
