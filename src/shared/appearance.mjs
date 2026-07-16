export const APPEARANCE_THEMES = Object.freeze([
  "system",
  "light",
  "dark",
]);

export const DEFAULT_APPEARANCE = Object.freeze({
  theme: "system",
  reduceTransparency: false,
});

const appearanceThemes = new Set(APPEARANCE_THEMES);

export function sanitizeAppearance(candidate) {
  const source = candidate &&
    typeof candidate === "object" &&
    !Array.isArray(candidate)
    ? candidate
    : null;

  return {
    theme: source && appearanceThemes.has(source.theme)
      ? source.theme
      : DEFAULT_APPEARANCE.theme,
    reduceTransparency: source && typeof source.reduceTransparency === "boolean"
      ? source.reduceTransparency
      : DEFAULT_APPEARANCE.reduceTransparency,
  };
}
