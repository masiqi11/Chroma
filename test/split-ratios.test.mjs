import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  createSplitLayout,
  dragSplitDivider,
  insertSplitPane,
  normalizeSplitLayout,
  removeSplitPane,
  reorderSplitPanes,
  sanitizeSplitLayout,
  setSplitRatio,
  splitDividerAtPath,
  splitLayoutPaneIds,
  splitLayoutRects,
  swapSplitPanes,
} from "../src/shared/split-ratios.mjs";

const bounds = { x: 10, y: 20, width: 1000, height: 800 };

test("creates canonical two-pane layouts in either direction", () => {
  assert.deepEqual(createSplitLayout(["a", "b"], "row"), {
    type: "split",
    direction: "row",
    ratio: 0.5,
    first: { type: "pane", paneId: "a" },
    second: { type: "pane", paneId: "b" },
  });
  assert.equal(createSplitLayout(["a", "b"], "column").direction, "column");
});

test("three row panes use a half-width primary and two quarter-area panes", () => {
  const layout = createSplitLayout(["a", "b", "c"], "row");
  const result = splitLayoutRects(bounds, layout);

  assert.deepEqual(result.paneIds, ["a", "b", "c"]);
  assert.deepEqual(result.frameRects, [
    { x: 10, y: 20, width: 496, height: 800 },
    { x: 514, y: 20, width: 496, height: 396 },
    { x: 514, y: 424, width: 496, height: 396 },
  ]);
  assert.deepEqual(result.dividers.map(item => item.path), [[], ["second"]]);
  assert.equal(result.frameRects[0].width * result.frameRects[0].height, 396_800);
  assert.equal(result.frameRects[1].width * result.frameRects[1].height, 196_416);
});

test("three column panes mirror the nested topology", () => {
  const result = splitLayoutRects(
    bounds,
    createSplitLayout(["a", "b", "c"], "column")
  );
  assert.deepEqual(result.frameRects, [
    { x: 10, y: 20, width: 1000, height: 396 },
    { x: 10, y: 424, width: 496, height: 396 },
    { x: 514, y: 424, width: 496, height: 396 },
  ]);
});

test("four panes match the existing two-by-two splitPaneRects grid", () => {
  const result = splitLayoutRects(
    bounds,
    createSplitLayout(["a", "b", "c", "d"], "row")
  );
  assert.deepEqual(result.frameRects, [
    { x: 10, y: 20, width: 496, height: 396 },
    { x: 514, y: 20, width: 496, height: 396 },
    { x: 10, y: 424, width: 496, height: 396 },
    { x: 514, y: 424, width: 496, height: 396 },
  ]);
  assert.deepEqual(result.viewRects[0], {
    x: 12,
    y: 22,
    width: 492,
    height: 392,
  });
  assert.deepEqual(result.dividers.map(item => item.path), [
    [],
    ["first"],
    ["second"],
  ]);
});

test("sanitizes every persisted ratio to a minimum 20 percent share", () => {
  const candidate = {
    type: "split",
    direction: "sideways",
    ratio: -1,
    first: { type: "pane", paneId: "a", ignored: true },
    second: {
      type: "split",
      direction: "column",
      ratio: 4,
      first: { type: "pane", paneId: "b" },
      second: { type: "pane", paneId: "c" },
    },
  };
  const result = sanitizeSplitLayout(candidate, ["a", "b", "c"]);

  assert.equal(result.direction, "row");
  assert.equal(result.ratio, MIN_SPLIT_RATIO);
  assert.equal(result.second.ratio, MAX_SPLIT_RATIO);
  assert.deepEqual(result.first, { type: "pane", paneId: "a" });
  assert.equal(candidate.ratio, -1, "sanitizing must not mutate persisted input");
});

test("rebuilds a canonical tree when persisted membership is stale", () => {
  const stale = createSplitLayout(["a", "gone", "c"], "row");
  const result = sanitizeSplitLayout(stale, ["a", "b", "c"], {
    direction: "column",
  });
  assert.deepEqual(splitLayoutPaneIds(result), ["a", "b", "c"]);
  assert.equal(result.direction, "column");
  assert.equal(result.second.direction, "row");
});

test("preserves a valid persisted topology, visual order, and ratios", () => {
  let layout = createSplitLayout(["a", "b", "c"], "row");
  layout = setSplitRatio(layout, [], 0.65);
  layout = swapSplitPanes(layout, "a", "c");
  const restored = sanitizeSplitLayout(
    JSON.parse(JSON.stringify(layout)),
    ["a", "b", "c"]
  );
  assert.deepEqual(restored, layout);
});

test("normalization drops duplicate, malformed, cyclic, and unary nodes", () => {
  const cyclic = { type: "split", direction: "row", ratio: 0.5 };
  cyclic.first = { type: "pane", paneId: "a" };
  cyclic.second = cyclic;
  assert.deepEqual(normalizeSplitLayout(cyclic), {
    type: "pane",
    paneId: "a",
  });

  const duplicate = {
    type: "split",
    direction: "row",
    first: { type: "pane", paneId: "a" },
    second: { type: "pane", paneId: "a" },
  };
  assert.deepEqual(normalizeSplitLayout(duplicate), {
    type: "pane",
    paneId: "a",
  });

  let tooDeep = { type: "pane", paneId: "tail" };
  for (let index = 0; index < 100; index += 1) {
    tooDeep = {
      type: "split",
      direction: "row",
      first: tooDeep,
      second: null,
    };
  }
  assert.equal(normalizeSplitLayout(tooDeep), null);
  assert.deepEqual(splitLayoutPaneIds(tooDeep), []);
});

test("sets root and nested divider ratios immutably", () => {
  const original = createSplitLayout(["a", "b", "c"], "row");
  const rootChanged = setSplitRatio(original, [], 0.7);
  const nestedChanged = setSplitRatio(rootChanged, ["second"], 0.25);

  assert.equal(original.ratio, 0.5);
  assert.equal(original.second.ratio, 0.5);
  assert.equal(nestedChanged.ratio, 0.7);
  assert.equal(nestedChanged.second.ratio, 0.25);
  assert.equal(setSplitRatio(original, [], 99).ratio, MAX_SPLIT_RATIO);
  assert.deepEqual(setSplitRatio(original, ["first"], 0.7), original);
});

test("queries only paths that resolve to real split dividers", () => {
  const layout = setSplitRatio(
    createSplitLayout(["a", "b", "c"], "row"),
    ["second"],
    0.3
  );

  assert.deepEqual(splitDividerAtPath(layout, []), {
    direction: "row",
    ratio: 0.5,
  });
  assert.deepEqual(splitDividerAtPath(layout, ["second"]), {
    direction: "column",
    ratio: 0.3,
  });
  assert.equal(splitDividerAtPath(layout, ["first"]), null);
  assert.equal(splitDividerAtPath(layout, ["second", "first"]), null);
  assert.equal(splitDividerAtPath(layout, ["invalid"]), null);
  assert.equal(splitDividerAtPath(null, []), null);
});

test("inserts a third pane beside a target without losing existing ratios", () => {
  const original = setSplitRatio(createSplitLayout(["a", "b"], "row"), [], 0.65);
  const inserted = insertSplitPane(original, "b", "c", "column", "before");

  assert.equal(original.ratio, 0.65);
  assert.equal(inserted.ratio, 0.65);
  assert.equal(inserted.second.direction, "column");
  assert.deepEqual(splitLayoutPaneIds(inserted), ["a", "c", "b"]);
  assert.deepEqual(splitLayoutPaneIds(original), ["a", "b"]);
});

test("maps left, right, top, and bottom edges to visual insertion order", () => {
  const original = createSplitLayout(["target"]);
  const cases = [
    ["left", "row", ["new", "target"]],
    ["right", "row", ["target", "new"]],
    ["top", "column", ["new", "target"]],
    ["bottom", "column", ["target", "new"]],
  ];

  for (const [edge, direction, expectedIds] of cases) {
    const inserted = insertSplitPane(original, "target", "new", edge);
    assert.equal(inserted.direction, direction);
    assert.deepEqual(splitLayoutPaneIds(inserted), expectedIds);
  }
});

test("inserts a fourth pane into a nested leaf while preserving every ancestor", () => {
  let original = createSplitLayout(["a", "b", "c"], "row");
  original = setSplitRatio(original, [], 0.7);
  original = setSplitRatio(original, ["second"], 0.3);
  const inserted = insertSplitPane(original, "c", "d", "right");

  assert.equal(inserted.ratio, 0.7);
  assert.equal(inserted.second.ratio, 0.3);
  assert.equal(inserted.second.second.direction, "row");
  assert.deepEqual(splitLayoutPaneIds(inserted), ["a", "b", "c", "d"]);
});

test("rejects invalid and over-capacity pane insertion immutably", () => {
  const layout = createSplitLayout(["a", "b", "c", "d"]);
  assert.deepEqual(insertSplitPane(layout, "a", "e", "right"), layout);
  assert.deepEqual(insertSplitPane(layout, "missing", "e", "right"), layout);
  assert.deepEqual(insertSplitPane(layout, "a", "b", "right"), layout);
  assert.deepEqual(insertSplitPane(layout, "a", "", "right"), layout);
  assert.deepEqual(splitLayoutPaneIds(layout), ["a", "b", "c", "d"]);
});

test("nested ratio updates change only that nested rectangle", () => {
  let layout = createSplitLayout(["a", "b", "c"], "row");
  layout = setSplitRatio(layout, ["second"], 0.25);
  const result = splitLayoutRects(bounds, layout);
  assert.deepEqual(result.frameRects, [
    { x: 10, y: 20, width: 496, height: 800 },
    { x: 514, y: 20, width: 496, height: 198 },
    { x: 514, y: 226, width: 496, height: 594 },
  ]);
});

test("divider drags use available pixels and clamp at both boundaries", () => {
  const layout = createSplitLayout(["a", "b"], "row");
  const dragged = dragSplitDivider(layout, [], {
    deltaPixels: 100,
    availablePixels: 1_000,
  });
  assert.equal(dragged.ratio, 0.6);
  assert.equal(dragSplitDivider(dragged, [], {
    deltaPixels: 1_000,
    availablePixels: 1_000,
  }).ratio, MAX_SPLIT_RATIO);
  assert.equal(dragSplitDivider(dragged, [], {
    deltaPixels: -1_000,
    availablePixels: 1_000,
  }).ratio, MIN_SPLIT_RATIO);
  assert.deepEqual(dragSplitDivider(layout, [], {
    deltaPixels: 10,
    availablePixels: 0,
  }), layout);
});

test("rect metadata supplies the exact nested divider drag extent", () => {
  const result = splitLayoutRects(
    bounds,
    createSplitLayout(["a", "b", "c"], "row")
  );
  assert.equal(result.dividers[0].availablePixels, 992);
  assert.equal(result.dividers[1].availablePixels, 792);
  assert.deepEqual(result.dividers[1].bounds, {
    x: 514,
    y: 20,
    width: 496,
    height: 800,
  });
});

test("reorders and swaps pane assignments without changing geometry", () => {
  let layout = createSplitLayout(["a", "b", "c", "d"], "row");
  layout = setSplitRatio(layout, [], 0.6);
  const beforeRects = splitLayoutRects(bounds, layout).frameRects;
  const reordered = reorderSplitPanes(layout, ["d", "b", "a", "c"]);
  const swapped = swapSplitPanes(reordered, "d", "c");

  assert.deepEqual(splitLayoutPaneIds(reordered), ["d", "b", "a", "c"]);
  assert.deepEqual(splitLayoutPaneIds(swapped), ["c", "b", "a", "d"]);
  assert.deepEqual(splitLayoutRects(bounds, reordered).frameRects, beforeRects);
  assert.deepEqual(splitLayoutRects(bounds, swapped).frameRects, beforeRects);
  assert.deepEqual(splitLayoutPaneIds(layout), ["a", "b", "c", "d"]);
});

test("rejects reorder requests that lose or inject a pane", () => {
  const layout = createSplitLayout(["a", "b", "c"], "row");
  assert.deepEqual(reorderSplitPanes(layout, ["a", "b"]), layout);
  assert.deepEqual(reorderSplitPanes(layout, ["a", "b", "x"]), layout);
  assert.deepEqual(swapSplitPanes(layout, "a", "x"), layout);
});

test("removing a pane collapses unary split nodes and preserves survivors", () => {
  const layout = createSplitLayout(["a", "b", "c", "d"], "row");
  const removed = removeSplitPane(layout, "b");
  assert.deepEqual(splitLayoutPaneIds(removed), ["a", "c", "d"]);
  assert.deepEqual(removed, {
    type: "split",
    direction: "column",
    ratio: 0.5,
    first: { type: "pane", paneId: "a" },
    second: {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: { type: "pane", paneId: "c" },
      second: { type: "pane", paneId: "d" },
    },
  });
  assert.deepEqual(removeSplitPane(
    createSplitLayout(["a", "b"], "row"),
    "a"
  ), { type: "pane", paneId: "b" });
  assert.equal(removeSplitPane({ type: "pane", paneId: "a" }, "a"), null);
});

test("handles count, ratio, and tiny-bound edges safely", () => {
  assert.equal(createSplitLayout([], "row"), null);
  assert.deepEqual(splitLayoutPaneIds(
    createSplitLayout(["a", "a", "", null, "b", "c", "d", "e"])
  ), ["a", "b", "c", "d"]);

  const layout = sanitizeSplitLayout({
    type: "split",
    direction: "row",
    ratio: Number.NaN,
    first: { type: "pane", paneId: "a" },
    second: { type: "pane", paneId: "b" },
  }, ["a", "b"]);
  assert.equal(layout.ratio, 0.5);

  const tiny = splitLayoutRects(
    { x: -10, y: -20, width: 1, height: 1 },
    createSplitLayout(["a", "b", "c", "d"])
  );
  assert.equal(tiny.frameRects.length, 4);
  assert.ok(tiny.frameRects.every(rect => rect.width >= 1 && rect.height >= 1));
  assert.ok(tiny.viewRects.every(rect => rect.width >= 1 && rect.height >= 1));

  const nonFinite = splitLayoutRects(
    { x: Number.NaN, y: Number.NEGATIVE_INFINITY, width: Infinity, height: NaN },
    createSplitLayout(["a", "b"]),
    { gap: Infinity, inset: Infinity }
  );
  assert.deepEqual(nonFinite.frameRects, [
    { x: 0, y: 0, width: 1, height: 1 },
    { x: 1, y: 0, width: 1, height: 1 },
  ]);
  assert.ok(nonFinite.viewRects.every(rect =>
    Object.values(rect).every(Number.isFinite)
  ));
});

test("custom ratio rectangles respect the 20%-80% bound", () => {
  const layout = setSplitRatio(createSplitLayout(["a", "b"]), [], 0.01);
  const result = splitLayoutRects(
    { x: 0, y: 0, width: 1_000, height: 600 },
    layout,
    { gap: 0, inset: 0 }
  );
  assert.deepEqual(result.frameRects.map(rect => rect.width), [200, 800]);
});
