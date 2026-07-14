import test from "node:test";
import assert from "node:assert/strict";

import {
  SPLIT_PANE_GAP,
  SPLIT_PANE_INSET,
  layoutRects,
  splitPaneRects,
} from "../src/shared/layout.mjs";

test("lays two views out without overlap", () => {
  const rects = layoutRects({ x: 10, y: 20, width: 1000, height: 700 }, 2, "row", 8);
  assert.deepEqual(rects, [
    { x: 10, y: 20, width: 496, height: 700 },
    { x: 514, y: 20, width: 496, height: 700 },
  ]);
});

test("lays four views in a grid and preserves the outer bounds", () => {
  const rects = layoutRects({ x: 0, y: 0, width: 1000, height: 800 }, 4, "grid", 8);
  assert.equal(rects.length, 4);
  assert.deepEqual(rects[0], { x: 0, y: 0, width: 496, height: 396 });
  assert.deepEqual(rects[3], { x: 504, y: 404, width: 496, height: 396 });
});

test("keeps a single pane flush with the content bounds", () => {
  const bounds = { x: 10, y: 20, width: 1001, height: 701 };
  const { frameRects, viewRects } = splitPaneRects(bounds, 1, "row");

  assert.deepEqual(frameRects, [bounds]);
  assert.deepEqual(viewRects, [bounds]);
});

test("insets every native view in layouts with two through four panes", () => {
  const bounds = { x: 10, y: 20, width: 1001, height: 701 };
  const layouts = [
    [2, "row"],
    [2, "column"],
    [3, "row"],
    [3, "column"],
    [4, "grid"],
  ];

  for (const [count, direction] of layouts) {
    const { frameRects, viewRects } = splitPaneRects(
      bounds,
      count,
      direction
    );
    assert.equal(frameRects.length, count);
    assert.equal(viewRects.length, count);

    frameRects.forEach((frame, index) => {
      const view = viewRects[index];
      assert.deepEqual(view, {
        x: frame.x + SPLIT_PANE_INSET,
        y: frame.y + SPLIT_PANE_INSET,
        width: frame.width - SPLIT_PANE_INSET * 2,
        height: frame.height - SPLIT_PANE_INSET * 2,
      });
    });
  }
});

test("preserves frame gap and adds both pane insets to the native gap", () => {
  const { frameRects, viewRects } = splitPaneRects(
    { x: 10, y: 20, width: 1001, height: 701 },
    2,
    "row"
  );
  const frameGap = frameRects[1].x -
    (frameRects[0].x + frameRects[0].width);
  const viewGap = viewRects[1].x -
    (viewRects[0].x + viewRects[0].width);

  assert.equal(frameGap, SPLIT_PANE_GAP);
  assert.equal(viewGap, SPLIT_PANE_GAP + SPLIT_PANE_INSET * 2);
  assert.deepEqual(frameRects, [
    { x: 10, y: 20, width: 496, height: 701 },
    { x: 514, y: 20, width: 497, height: 701 },
  ]);
  assert.deepEqual(viewRects, [
    { x: 12, y: 22, width: 492, height: 697 },
    { x: 516, y: 22, width: 493, height: 697 },
  ]);
});
