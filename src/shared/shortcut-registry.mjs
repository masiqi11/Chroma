const PLATFORM_NAMES = new Set(["darwin", "win32", "linux"]);

function chord(code, modifiers = {}, platforms = null) {
  return Object.freeze({
    code,
    primary: modifiers.primary === true,
    control: modifiers.control === true,
    meta: modifiers.meta === true,
    alt: modifiers.alt === true,
    shift: modifiers.shift === true,
    platforms: platforms ? Object.freeze([...platforms]) : null,
  });
}

function shortcut(id, action, title, chords) {
  return Object.freeze({
    id,
    action,
    title,
    chords: Object.freeze(chords),
  });
}

export const BROWSER_SHORTCUTS = Object.freeze([
  shortcut("focus-address", "address:focus", "Focus address bar", [
    chord("KeyL", { primary: true }),
  ]),
  shortcut("new-tab", "tab:create", "New tab", [
    chord("KeyT", { primary: true }),
  ]),
  shortcut("reopen-tab", "tab:reopen", "Reopen closed tab", [
    chord("KeyT", { primary: true, shift: true }),
  ]),
  shortcut("close-tab", "tab:close", "Close tab", [
    chord("KeyW", { primary: true }),
  ]),
  shortcut("reload", "navigation:reload", "Reload page", [
    chord("KeyR", { primary: true }),
  ]),
  shortcut("hard-reload", "navigation:reload-ignore-cache", "Reload without cache", [
    chord("KeyR", { primary: true, shift: true }),
  ]),
  shortcut("bookmark", "bookmark:toggle", "Add or remove bookmark", [
    chord("KeyD", { primary: true }),
  ]),
  shortcut("toggle-sidebar", "sidebar:toggle", "Toggle sidebar", [
    chord("KeyS", { primary: true }),
  ]),
  shortcut("history-mac", "history:open", "Open history", [
    chord("KeyY", { primary: true }, ["darwin"]),
  ]),
  shortcut("history-other", "history:open", "Open history", [
    chord("KeyH", { primary: true }, ["win32", "linux"]),
  ]),
  shortcut("downloads", "downloads:open", "Open downloads", [
    chord("KeyJ", { primary: true, shift: true }, ["darwin"]),
    chord("KeyJ", { primary: true }, ["win32", "linux"]),
  ]),
  shortcut("next-tab", "tab:next", "Select next tab", [
    chord("Tab", { control: true }),
  ]),
  shortcut("previous-tab", "tab:previous", "Select previous tab", [
    chord("Tab", { control: true, shift: true }),
  ]),
  shortcut("back", "navigation:back", "Go back", [
    chord("ArrowLeft", { alt: true }),
  ]),
  shortcut("forward", "navigation:forward", "Go forward", [
    chord("ArrowRight", { alt: true }),
  ]),
  shortcut("previous-workspace", "workspace:previous", "Previous workspace", [
    chord("ArrowLeft", { primary: true, alt: true }),
  ]),
  shortcut("next-workspace", "workspace:next", "Next workspace", [
    chord("ArrowRight", { primary: true, alt: true }),
  ]),
  shortcut("split-row", "split:row", "Split side by side", [
    chord("KeyV", { primary: true, alt: true }),
  ]),
  shortcut("split-column", "split:column", "Split top and bottom", [
    chord("KeyH", { primary: true, alt: true }),
  ]),
  shortcut("split-remove", "split:remove", "Exit split view", [
    chord("KeyU", { primary: true, alt: true }),
  ]),
  shortcut("zoom-in", "page:zoom-in", "Zoom in", [
    chord("Equal", { primary: true }),
    chord("Equal", { primary: true, shift: true }),
    chord("NumpadAdd", { primary: true }),
  ]),
  shortcut("zoom-out", "page:zoom-out", "Zoom out", [
    chord("Minus", { primary: true }),
    chord("NumpadSubtract", { primary: true }),
  ]),
  shortcut("zoom-reset", "page:zoom-reset", "Reset zoom", [
    chord("Digit0", { primary: true }),
    chord("Numpad0", { primary: true }),
  ]),
  shortcut("developer-tools-mac", "developer:open-tools", "Developer tools", [
    chord("KeyI", { primary: true, alt: true }, ["darwin"]),
  ]),
  shortcut("developer-tools-other", "developer:open-tools", "Developer tools", [
    chord("KeyI", { primary: true, shift: true }, ["win32", "linux"]),
  ]),
]);

function normalizedPlatform(platform) {
  return PLATFORM_NAMES.has(platform) ? platform : "linux";
}

function fallbackCode(key) {
  const value = String(key || "");
  if (/^[a-z]$/i.test(value)) return `Key${value.toUpperCase()}`;
  if (/^[0-9]$/.test(value)) return `Digit${value}`;
  return ({
    "[": "BracketLeft",
    "]": "BracketRight",
    "=": "Equal",
    "+": "Equal",
    "-": "Minus",
    Tab: "Tab",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
  })[value] || value;
}

function chordApplies(chordValue, platform) {
  return !chordValue.platforms || chordValue.platforms.includes(platform);
}

function exactChordMatch(chordValue, input, platform) {
  const primaryIsMeta = platform === "darwin";
  const expectedMeta = chordValue.meta || (chordValue.primary && primaryIsMeta);
  const expectedControl = chordValue.control ||
    (chordValue.primary && !primaryIsMeta);
  // Electron has no stable `altGraph` boolean across platforms. On Windows
  // and Linux AltGr is commonly reported as Ctrl+Alt, but its resulting key is
  // a composed character rather than the physical letter named by `code`.
  // Requiring the logical letter for Ctrl+Alt letter chords prevents those
  // composed inputs from triggering workspace/split commands.
  const expectedLetter = /^Key([A-Z])$/.exec(chordValue.code)?.[1] || "";
  const logicalKeyMatches = !expectedLetter ||
    platform === "darwin" ||
    !expectedControl ||
    !chordValue.alt ||
    !input.key ||
    String(input.key).toUpperCase() === expectedLetter;
  return fallbackCode(input.code || input.key) === chordValue.code &&
    logicalKeyMatches &&
    Boolean(input.meta) === expectedMeta &&
    Boolean(input.control) === expectedControl &&
    Boolean(input.alt) === chordValue.alt &&
    Boolean(input.shift) === chordValue.shift;
}

export function shortcutActionForInput(input, platform = "linux") {
  if (
    !input ||
    !["keyDown", "rawKeyDown"].includes(input.type) ||
    input.isAutoRepeat === true ||
    input.isComposing === true ||
    input.altGraph === true
  ) {
    return null;
  }
  const targetPlatform = normalizedPlatform(platform);
  for (const item of BROWSER_SHORTCUTS) {
    if (item.chords.some(candidate =>
      chordApplies(candidate, targetPlatform) &&
      exactChordMatch(candidate, input, targetPlatform)
    )) {
      return item.action;
    }
  }
  return null;
}

function firstChordForAction(action, platform) {
  const targetPlatform = normalizedPlatform(platform);
  for (const item of BROWSER_SHORTCUTS) {
    if (item.action !== action) continue;
    const candidate = item.chords.find(value => chordApplies(value, targetPlatform));
    if (candidate) return candidate;
  }
  return null;
}

function keyLabel(code, platform) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  return ({
    ArrowLeft: platform === "darwin" ? "←" : "Left",
    ArrowRight: platform === "darwin" ? "→" : "Right",
    ArrowUp: platform === "darwin" ? "↑" : "Up",
    ArrowDown: platform === "darwin" ? "↓" : "Down",
    Equal: "+",
    NumpadAdd: "+",
    Minus: "−",
    NumpadSubtract: "−",
    Tab: platform === "darwin" ? "⇥" : "Tab",
  })[code] || code;
}

export function shortcutDisplayForAction(action, platform = "linux") {
  const targetPlatform = normalizedPlatform(platform);
  const value = firstChordForAction(action, targetPlatform);
  if (!value) return "";
  if (targetPlatform === "darwin") {
    return [
      value.control ? "⌃" : "",
      value.alt ? "⌥" : "",
      value.shift ? "⇧" : "",
      value.meta || value.primary ? "⌘" : "",
      keyLabel(value.code, targetPlatform),
    ].join("");
  }
  return [
    value.control || value.primary ? "Ctrl" : "",
    value.meta ? "Meta" : "",
    value.alt ? "Alt" : "",
    value.shift ? "Shift" : "",
    keyLabel(value.code, targetPlatform),
  ].filter(Boolean).join("+");
}

export function menuAcceleratorForAction(action, platform = "linux") {
  const targetPlatform = normalizedPlatform(platform);
  const value = firstChordForAction(action, targetPlatform);
  if (!value) return undefined;
  return [
    value.primary ? "CmdOrCtrl" : "",
    value.control ? "Ctrl" : "",
    value.meta ? "Command" : "",
    value.alt ? "Alt" : "",
    value.shift ? "Shift" : "",
    keyLabel(value.code, targetPlatform).replace("−", "-"),
  ].filter(Boolean).join("+");
}
