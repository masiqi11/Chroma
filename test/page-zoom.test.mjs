import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PAGE_ZOOM_PERCENT,
  MAX_PAGE_ZOOM_PERCENT,
  MIN_PAGE_ZOOM_PERCENT,
  PAGE_ZOOM_PERCENT_STEPS,
  decrementPageZoom,
  incrementPageZoom,
  pageZoomFactorToPercent,
  pageZoomPercentToFactor,
  resetPageZoom,
  sanitizePageZoomPercent,
} from "../src/shared/page-zoom.mjs";

test("defines immutable bounded Chromium-style page zoom steps", () => {
  assert.deepEqual(PAGE_ZOOM_PERCENT_STEPS, [
    50,
    67,
    75,
    80,
    90,
    100,
    110,
    125,
    150,
    175,
    200,
  ]);
  assert.equal(Object.isFrozen(PAGE_ZOOM_PERCENT_STEPS), true);
  assert.equal(MIN_PAGE_ZOOM_PERCENT, 50);
  assert.equal(DEFAULT_PAGE_ZOOM_PERCENT, 100);
  assert.equal(MAX_PAGE_ZOOM_PERCENT, 200);
});

test("sanitizes finite percentages to a stable bounded step", () => {
  for (const step of PAGE_ZOOM_PERCENT_STEPS) {
    assert.equal(sanitizePageZoomPercent(step), step);
  }

  assert.equal(sanitizePageZoomPercent(-1_000), MIN_PAGE_ZOOM_PERCENT);
  assert.equal(sanitizePageZoomPercent(1_000), MAX_PAGE_ZOOM_PERCENT);
  assert.equal(sanitizePageZoomPercent(77.5), 75, "ties prefer the lower step");
  assert.equal(sanitizePageZoomPercent(119), 125);
});

test("invalid and coercion-shaped values fall back to the global default", () => {
  for (const candidate of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "125",
    "1e999",
    "<script>alert(1)</script>",
    null,
    undefined,
    {},
    [],
  ]) {
    assert.equal(sanitizePageZoomPercent(candidate), DEFAULT_PAGE_ZOOM_PERCENT);
    assert.equal(pageZoomPercentToFactor(candidate), 1);
    assert.equal(pageZoomFactorToPercent(candidate), DEFAULT_PAGE_ZOOM_PERCENT);
    assert.equal(incrementPageZoom(candidate), DEFAULT_PAGE_ZOOM_PERCENT);
    assert.equal(decrementPageZoom(candidate), DEFAULT_PAGE_ZOOM_PERCENT);
  }
});

test("increments and decrements exact steps without wrapping", () => {
  for (let index = 0; index < PAGE_ZOOM_PERCENT_STEPS.length; index += 1) {
    assert.equal(
      incrementPageZoom(PAGE_ZOOM_PERCENT_STEPS[index]),
      PAGE_ZOOM_PERCENT_STEPS[Math.min(
        index + 1,
        PAGE_ZOOM_PERCENT_STEPS.length - 1
      )]
    );
    assert.equal(
      decrementPageZoom(PAGE_ZOOM_PERCENT_STEPS[index]),
      PAGE_ZOOM_PERCENT_STEPS[Math.max(index - 1, 0)]
    );
  }

  assert.equal(incrementPageZoom(MAX_PAGE_ZOOM_PERCENT), MAX_PAGE_ZOOM_PERCENT);
  assert.equal(decrementPageZoom(MIN_PAGE_ZOOM_PERCENT), MIN_PAGE_ZOOM_PERCENT);
});

test("directionally snaps non-discrete percentages to the adjacent step", () => {
  assert.equal(incrementPageZoom(105), 110);
  assert.equal(decrementPageZoom(105), 100);
  assert.equal(incrementPageZoom(120), 125);
  assert.equal(decrementPageZoom(120), 110);
  assert.equal(incrementPageZoom(25), 50);
  assert.equal(decrementPageZoom(250), 200);

  assert.equal(incrementPageZoom("125"), DEFAULT_PAGE_ZOOM_PERCENT);
  assert.equal(decrementPageZoom("125"), DEFAULT_PAGE_ZOOM_PERCENT);
});

test("reset and factor conversion preserve 100 percent as factor one", () => {
  assert.equal(resetPageZoom(), DEFAULT_PAGE_ZOOM_PERCENT);
  assert.equal(pageZoomPercentToFactor(100), 1);
  assert.equal(pageZoomFactorToPercent(1), 100);

  for (const step of PAGE_ZOOM_PERCENT_STEPS) {
    assert.equal(pageZoomPercentToFactor(step), step / 100);
    assert.equal(pageZoomFactorToPercent(step / 100), step);
  }
});
