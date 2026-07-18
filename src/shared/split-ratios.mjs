import {
  SPLIT_PANE_GAP,
  SPLIT_PANE_INSET,
} from "./layout.mjs";

export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 1 - MIN_SPLIT_RATIO;

const PANE = "pane";
const SPLIT = "split";
const FIRST = "first";
const SECOND = "second";
const MAX_PANES = 4;
const MAX_LAYOUT_NODES = 31;

function safeDirection(direction, fallback = "row") {
  return direction === "column" || direction === "row"
    ? direction
    : fallback;
}

function oppositeDirection(direction) {
  return direction === "column" ? "row" : "column";
}

function safeRatio(ratio) {
  const value = Number(ratio);
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
}

function safePaneIds(paneIds) {
  const result = [];
  for (const value of Array.isArray(paneIds) ? paneIds : []) {
    if (typeof value !== "string") continue;
    const paneId = value.trim();
    if (!paneId || result.includes(paneId)) continue;
    result.push(paneId);
    if (result.length === MAX_PANES) break;
  }
  return result;
}

function pane(paneId) {
  return { type: PANE, paneId };
}

function split(direction, first, second, ratio = 0.5) {
  return {
    type: SPLIT,
    direction: safeDirection(direction),
    ratio: safeRatio(ratio),
    first,
    second,
  };
}

/**
 * Creates the canonical 1-4 pane topology used by splitPaneRects.
 * A row divides left/right; a column divides top/bottom.
 */
export function createSplitLayout(paneIds, direction = "row") {
  const ids = safePaneIds(paneIds);
  if (!ids.length) return null;
  if (ids.length === 1) return pane(ids[0]);

  const primaryDirection = safeDirection(direction);
  if (ids.length === 2) {
    return split(primaryDirection, pane(ids[0]), pane(ids[1]));
  }

  if (ids.length === 3) {
    return split(
      primaryDirection,
      pane(ids[0]),
      split(oppositeDirection(primaryDirection), pane(ids[1]), pane(ids[2]))
    );
  }

  // Four panes match layoutRects: two rows containing two columns each.
  return split(
    "column",
    split("row", pane(ids[0]), pane(ids[1])),
    split("row", pane(ids[2]), pane(ids[3]))
  );
}

function normalizeNode(candidate, context, fallbackDirection) {
  if (!candidate || typeof candidate !== "object") return null;
  if (
    context.objects.has(candidate) ||
    context.nodeCount >= MAX_LAYOUT_NODES
  ) {
    return null;
  }
  context.objects.add(candidate);
  context.nodeCount += 1;

  if (candidate.type === PANE) {
    const paneId = typeof candidate.paneId === "string"
      ? candidate.paneId.trim()
      : "";
    if (
      !paneId ||
      context.paneIds.has(paneId) ||
      context.paneIds.size >= MAX_PANES
    ) {
      return null;
    }
    context.paneIds.add(paneId);
    return pane(paneId);
  }

  if (candidate.type !== SPLIT) return null;
  const direction = safeDirection(candidate.direction, fallbackDirection);
  const childFallback = oppositeDirection(direction);
  const first = normalizeNode(candidate.first, context, childFallback);
  const second = normalizeNode(candidate.second, context, childFallback);
  if (!first) return second;
  if (!second) return first;
  return split(direction, first, second, candidate.ratio);
}

/**
 * Removes malformed/unary/duplicate nodes and clamps every divider to 20%-80%.
 */
export function normalizeSplitLayout(layout, { direction = "row" } = {}) {
  return normalizeNode(
    layout,
    { objects: new WeakSet(), paneIds: new Set(), nodeCount: 0 },
    safeDirection(direction)
  );
}

export function splitLayoutPaneIds(layout) {
  const result = [];
  const visited = new WeakSet();
  let nodeCount = 0;
  const visit = node => {
    if (
      !node ||
      typeof node !== "object" ||
      visited.has(node) ||
      nodeCount >= MAX_LAYOUT_NODES
    ) {
      return;
    }
    visited.add(node);
    nodeCount += 1;
    if (node.type === PANE) {
      if (typeof node.paneId === "string") result.push(node.paneId);
      return;
    }
    if (node.type !== SPLIT) return;
    visit(node.first);
    visit(node.second);
  };
  visit(layout);
  return result;
}

/**
 * Sanitizes persisted layout data against the panes that still belong to a group.
 * A valid tree keeps its topology, order, and ratios. A membership mismatch falls
 * back to the canonical topology so stale pane IDs cannot survive restoration.
 */
export function sanitizeSplitLayout(
  layout,
  paneIds,
  { direction = "row" } = {}
) {
  const expected = safePaneIds(paneIds);
  if (!expected.length) return null;
  const normalized = normalizeSplitLayout(layout, { direction });
  const actual = splitLayoutPaneIds(normalized);
  if (
    actual.length === expected.length &&
    actual.every(paneId => expected.includes(paneId))
  ) {
    return normalized;
  }
  return createSplitLayout(expected, direction);
}

function roundedFinite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function safeBounds(bounds) {
  return {
    x: Math.max(0, roundedFinite(bounds?.x)),
    y: Math.max(0, roundedFinite(bounds?.y)),
    width: Math.max(1, roundedFinite(bounds?.width)),
    height: Math.max(1, roundedFinite(bounds?.height)),
  };
}

function inset(bounds, amount) {
  return {
    x: bounds.x + amount,
    y: bounds.y + amount,
    width: Math.max(1, bounds.width - amount * 2),
    height: Math.max(1, bounds.height - amount * 2),
  };
}

function splitExtents(total, ratio, gap) {
  const safeGap = Math.min(
    Math.max(0, roundedFinite(gap)),
    Math.max(0, total - 2)
  );
  const available = total - safeGap;
  let firstExtent = Math.floor(available * safeRatio(ratio));
  if (available >= 2) {
    firstExtent = Math.max(1, Math.min(available - 1, firstExtent));
  } else {
    firstExtent = Math.max(1, available);
  }
  const secondExtent = Math.max(1, total - safeGap - firstExtent);
  return { available, firstExtent, safeGap, secondExtent };
}

function divideRect(bounds, direction, ratio, gap) {
  const total = direction === "column" ? bounds.height : bounds.width;
  const { available, firstExtent, safeGap, secondExtent } = splitExtents(
    total,
    ratio,
    gap
  );
  if (direction === "column") {
    return {
      first: { ...bounds, height: firstExtent },
      second: {
        x: bounds.x,
        y: bounds.y + firstExtent + safeGap,
        width: bounds.width,
        height: secondExtent,
      },
      divider: {
        x: bounds.x,
        y: bounds.y + firstExtent,
        width: bounds.width,
        height: safeGap,
      },
      available,
    };
  }

  return {
    first: { ...bounds, width: firstExtent },
    second: {
      x: bounds.x + firstExtent + safeGap,
      y: bounds.y,
      width: secondExtent,
      height: bounds.height,
    },
    divider: {
      x: bounds.x + firstExtent,
      y: bounds.y,
      width: safeGap,
      height: bounds.height,
    },
    available,
  };
}

/**
 * Resolves a ratio tree into the same frame/view rectangle shape as
 * splitPaneRects. Divider paths ([], ["first"], ["second"], ...) can be fed
 * directly to setSplitRatio or dragSplitDivider.
 */
export function splitLayoutRects(
  bounds,
  layout,
  { gap = SPLIT_PANE_GAP, inset: insetAmount = SPLIT_PANE_INSET } = {}
) {
  const normalized = normalizeSplitLayout(layout);
  if (!normalized) {
    return { paneIds: [], frameRects: [], viewRects: [], dividers: [] };
  }

  const paneIds = [];
  const frameRects = [];
  const dividers = [];
  const visit = (node, rect, path) => {
    if (node.type === PANE) {
      paneIds.push(node.paneId);
      frameRects.push(rect);
      return;
    }
    const divided = divideRect(rect, node.direction, node.ratio, gap);
    dividers.push({
      path: [...path],
      direction: node.direction,
      ratio: node.ratio,
      rect: divided.divider,
      bounds: { ...rect },
      availablePixels: divided.available,
    });
    visit(node.first, divided.first, [...path, FIRST]);
    visit(node.second, divided.second, [...path, SECOND]);
  };
  visit(normalized, safeBounds(bounds), []);

  const safeInset = Math.max(0, roundedFinite(insetAmount));
  const isSplit = frameRects.length > 1;
  const viewRects = frameRects.map(rect =>
    isSplit ? inset(rect, safeInset) : { ...rect }
  );
  return { paneIds, frameRects, viewRects, dividers };
}

function validPath(path) {
  return Array.isArray(path) && path.every(part => part === FIRST || part === SECOND);
}

function nodeAtPath(layout, path) {
  let node = layout;
  for (const part of path) {
    if (node?.type !== SPLIT) return null;
    node = node[part];
  }
  return node;
}

/**
 * Returns sanitized metadata only when `path` addresses a real divider.
 * Callers can validate stale renderer paths without receiving a mutable tree
 * node or duplicating the layout traversal rules.
 */
export function splitDividerAtPath(layout, path) {
  const normalized = normalizeSplitLayout(layout);
  if (!normalized || !validPath(path)) return null;
  const target = nodeAtPath(normalized, path);
  if (target?.type !== SPLIT) return null;
  return {
    direction: target.direction,
    ratio: target.ratio,
  };
}

function updateAtPath(node, path, index, update) {
  if (index === path.length) return update(node);
  if (node?.type !== SPLIT) return node;
  const part = path[index];
  return {
    ...node,
    [part]: updateAtPath(node[part], path, index + 1, update),
  };
}

function panePath(node, paneId, path = []) {
  if (node?.type === PANE) return node.paneId === paneId ? path : null;
  if (node?.type !== SPLIT) return null;
  return panePath(node.first, paneId, [...path, FIRST]) ||
    panePath(node.second, paneId, [...path, SECOND]);
}

/**
 * Inserts one pane next to an existing leaf without rebuilding the surrounding
 * ratio tree. `direction` accepts row/column plus the convenient visual edges
 * left/right/top/bottom; `placement` is before/after for row/column calls.
 */
export function insertSplitPane(
  layout,
  targetPaneId,
  newPaneId,
  direction = "row",
  placement = "after"
) {
  const normalized = normalizeSplitLayout(layout);
  if (!normalized) return null;
  const paneIds = splitLayoutPaneIds(normalized);
  const targetId = typeof targetPaneId === "string" ? targetPaneId.trim() : "";
  const insertedId = typeof newPaneId === "string" ? newPaneId.trim() : "";
  if (
    !targetId ||
    !insertedId ||
    paneIds.length >= MAX_PANES ||
    paneIds.includes(insertedId)
  ) {
    return normalized;
  }
  const path = panePath(normalized, targetId);
  if (!path) return normalized;

  let splitDirection = direction;
  let splitPlacement = placement;
  if (["left", "right", "top", "bottom"].includes(direction)) {
    splitDirection = ["top", "bottom"].includes(direction) ? "column" : "row";
    splitPlacement = ["left", "top"].includes(direction) ? "before" : "after";
  }
  splitDirection = safeDirection(splitDirection);
  splitPlacement = splitPlacement === "before" ? "before" : "after";

  return updateAtPath(normalized, path, 0, target =>
    splitPlacement === "before"
      ? split(splitDirection, pane(insertedId), target)
      : split(splitDirection, target, pane(insertedId))
  );
}

/**
 * Applies a ratio preset to a whole layout: the root divider takes the
 * requested ratio while every nested divider returns to an equal 50/50, so
 * "70/30" reads as "70% for the first side" regardless of pane count.
 * Returns null (unchanged semantics of normalize) for empty layouts and the
 * bare pane for single-pane layouts.
 */
export function applySplitRatioPreset(layout, ratio) {
  const normalized = normalizeSplitLayout(layout);
  if (!normalized || normalized.type !== SPLIT) return normalized;
  const equalize = node => node.type === SPLIT
    ? split(node.direction, equalize(node.first), equalize(node.second), 0.5)
    : pane(node.paneId);
  return split(
    normalized.direction,
    equalize(normalized.first),
    equalize(normalized.second),
    safeRatio(ratio)
  );
}

export function setSplitRatio(layout, path, ratio) {
  const normalized = normalizeSplitLayout(layout);
  if (!normalized || !validPath(path) || nodeAtPath(normalized, path)?.type !== SPLIT) {
    return normalized;
  }
  return updateAtPath(normalized, path, 0, node => ({
    ...node,
    ratio: safeRatio(ratio),
  }));
}

/**
 * Applies a divider drag without mutating persisted layout state.
 * availablePixels is the divider's usable axis length (returned by dividers).
 */
export function dragSplitDivider(
  layout,
  path,
  { deltaPixels = 0, availablePixels = 0 } = {}
) {
  const normalized = normalizeSplitLayout(layout);
  if (!normalized || !validPath(path)) return normalized;
  const target = nodeAtPath(normalized, path);
  const delta = Number(deltaPixels);
  const available = Number(availablePixels);
  if (
    target?.type !== SPLIT ||
    !Number.isFinite(delta) ||
    !Number.isFinite(available) ||
    available <= 0
  ) {
    return normalized;
  }
  return setSplitRatio(normalized, path, target.ratio + delta / available);
}

function replacePaneOrder(node, paneIds, cursor) {
  if (node.type === PANE) {
    const replacement = paneIds[cursor.index];
    cursor.index += 1;
    return pane(replacement);
  }
  return {
    ...node,
    first: replacePaneOrder(node.first, paneIds, cursor),
    second: replacePaneOrder(node.second, paneIds, cursor),
  };
}

/** Keeps geometry intact while assigning panes to a new visual order. */
export function reorderSplitPanes(layout, paneIds) {
  const normalized = normalizeSplitLayout(layout);
  if (!normalized) return null;
  const current = splitLayoutPaneIds(normalized);
  const requested = safePaneIds(paneIds);
  if (
    current.length !== requested.length ||
    !current.every(paneId => requested.includes(paneId))
  ) {
    return normalized;
  }
  return replacePaneOrder(normalized, requested, { index: 0 });
}

export function swapSplitPanes(layout, firstPaneId, secondPaneId) {
  const normalized = normalizeSplitLayout(layout);
  if (!normalized || firstPaneId === secondPaneId) return normalized;
  const paneIds = splitLayoutPaneIds(normalized);
  const firstIndex = paneIds.indexOf(firstPaneId);
  const secondIndex = paneIds.indexOf(secondPaneId);
  if (firstIndex < 0 || secondIndex < 0) return normalized;
  [paneIds[firstIndex], paneIds[secondIndex]] = [
    paneIds[secondIndex],
    paneIds[firstIndex],
  ];
  return reorderSplitPanes(normalized, paneIds);
}

function removePane(node, paneId) {
  if (node.type === PANE) return node.paneId === paneId ? null : node;
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

/** Removes a pane and collapses every now-unary split node. */
export function removeSplitPane(layout, paneId) {
  const normalized = normalizeSplitLayout(layout);
  if (!normalized || typeof paneId !== "string") return normalized;
  return normalizeSplitLayout(removePane(normalized, paneId));
}
