function inset(bounds, amount) {
  return {
    x: bounds.x + amount,
    y: bounds.y + amount,
    width: Math.max(1, bounds.width - amount * 2),
    height: Math.max(1, bounds.height - amount * 2),
  };
}

export const SPLIT_PANE_GAP = 8;
export const SPLIT_PANE_INSET = 2;
export const SPLIT_PANE_RADIUS = 14;

function twoColumns(bounds, gap) {
  const firstWidth = Math.floor((bounds.width - gap) / 2);
  return [
    { ...bounds, width: firstWidth },
    {
      x: bounds.x + firstWidth + gap,
      y: bounds.y,
      width: bounds.width - firstWidth - gap,
      height: bounds.height,
    },
  ];
}

function twoRows(bounds, gap) {
  const firstHeight = Math.floor((bounds.height - gap) / 2);
  return [
    { ...bounds, height: firstHeight },
    {
      x: bounds.x,
      y: bounds.y + firstHeight + gap,
      width: bounds.width,
      height: bounds.height - firstHeight - gap,
    },
  ];
}

export function layoutRects(bounds, count, direction = "row", gap = 8) {
  const safeBounds = {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
  const safeCount = Math.max(1, Math.min(4, Math.floor(count)));

  if (safeCount === 1) return [safeBounds];
  if (safeCount === 2) {
    return direction === "column"
      ? twoRows(safeBounds, gap)
      : twoColumns(safeBounds, gap);
  }

  if (safeCount === 3 && direction !== "column") {
    const [left, right] = twoColumns(safeBounds, gap);
    return [left, ...twoRows(right, gap)];
  }

  if (safeCount === 3) {
    const [top, bottom] = twoRows(safeBounds, gap);
    return [top, ...twoColumns(bottom, gap)];
  }

  const [top, bottom] = twoRows(safeBounds, gap);
  return [...twoColumns(top, gap), ...twoColumns(bottom, gap)];
}

export function splitPaneRects(bounds, count, direction = "row") {
  const frameRects = layoutRects(
    bounds,
    count,
    direction,
    SPLIT_PANE_GAP
  );
  const split = frameRects.length > 1;
  const viewRects = frameRects.map(rect =>
    split ? inset(rect, SPLIT_PANE_INSET) : { ...rect }
  );
  return { frameRects, viewRects };
}

export function glanceRect(bounds) {
  const horizontal = Math.max(24, Math.round(bounds.width * 0.07));
  const vertical = Math.max(24, Math.round(bounds.height * 0.06));
  return inset(
    {
      x: bounds.x + horizontal,
      y: bounds.y + vertical,
      width: bounds.width - horizontal * 2,
      height: bounds.height - vertical * 2,
    },
    0
  );
}
