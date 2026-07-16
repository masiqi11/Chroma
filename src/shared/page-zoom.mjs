export const PAGE_ZOOM_PERCENT_STEPS = Object.freeze([
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

export const MIN_PAGE_ZOOM_PERCENT = PAGE_ZOOM_PERCENT_STEPS[0];
export const MAX_PAGE_ZOOM_PERCENT = PAGE_ZOOM_PERCENT_STEPS.at(-1);
export const DEFAULT_PAGE_ZOOM_PERCENT = 100;

function finitePercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Returns a supported Chromium-style page-zoom percentage. This value is
 * intended for WebContents page zoom, which preserves the page's real
 * viewport and normal responsive reflow behavior.
 */
export function sanitizePageZoomPercent(value) {
  const percent = finitePercent(value);
  if (percent === null) return DEFAULT_PAGE_ZOOM_PERCENT;

  let nearest = PAGE_ZOOM_PERCENT_STEPS[0];
  let nearestDistance = Math.abs(percent - nearest);
  for (const step of PAGE_ZOOM_PERCENT_STEPS.slice(1)) {
    const distance = Math.abs(percent - step);
    if (distance < nearestDistance) {
      nearest = step;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function incrementPageZoom(value) {
  const percent = finitePercent(value);
  if (percent === null) return DEFAULT_PAGE_ZOOM_PERCENT;
  return PAGE_ZOOM_PERCENT_STEPS.find(step => step > percent) ??
    MAX_PAGE_ZOOM_PERCENT;
}

export function decrementPageZoom(value) {
  const percent = finitePercent(value);
  if (percent === null) return DEFAULT_PAGE_ZOOM_PERCENT;
  for (let index = PAGE_ZOOM_PERCENT_STEPS.length - 1; index >= 0; index -= 1) {
    if (PAGE_ZOOM_PERCENT_STEPS[index] < percent) {
      return PAGE_ZOOM_PERCENT_STEPS[index];
    }
  }
  return MIN_PAGE_ZOOM_PERCENT;
}

export function resetPageZoom() {
  return DEFAULT_PAGE_ZOOM_PERCENT;
}

export function pageZoomPercentToFactor(value) {
  return sanitizePageZoomPercent(value) / 100;
}

export function pageZoomFactorToPercent(value) {
  return finitePercent(value) === null
    ? DEFAULT_PAGE_ZOOM_PERCENT
    : sanitizePageZoomPercent(value * 100);
}
