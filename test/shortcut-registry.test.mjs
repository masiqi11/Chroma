import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BROWSER_SHORTCUTS,
  menuAcceleratorForAction,
  shortcutActionForInput,
  shortcutDisplayForAction,
} from "../src/shared/shortcut-registry.mjs";

function input({
  code,
  key = "",
  meta = false,
  control = false,
  alt = false,
  shift = false,
  type = "keyDown",
  isAutoRepeat = false,
  isComposing = false,
  altGraph = false,
}) {
  return { code, key, meta, control, alt, shift, type, isAutoRepeat, isComposing, altGraph };
}

test("registry ids and platform chords resolve to one action", () => {
  assert.equal(
    new Set(BROWSER_SHORTCUTS.map(item => item.id)).size,
    BROWSER_SHORTCUTS.length
  );
  for (const platform of ["darwin", "win32", "linux"]) {
    const resolved = new Map();
    for (const item of BROWSER_SHORTCUTS) {
      for (const chord of item.chords) {
        if (chord.platforms && !chord.platforms.includes(platform)) continue;
        const primaryIsMeta = platform === "darwin";
        const event = input({
          code: chord.code,
          meta: chord.meta || (chord.primary && primaryIsMeta),
          control: chord.control || (chord.primary && !primaryIsMeta),
          alt: chord.alt,
          shift: chord.shift,
        });
        const signature = JSON.stringify(event);
        const action = shortcutActionForInput(event, platform);
        assert.equal(action, item.action);
        assert.equal(resolved.has(signature), false, `${platform} duplicate ${signature}`);
        resolved.set(signature, action);
      }
    }
  }
});

test("primary maps to Command on macOS and Control elsewhere", () => {
  assert.equal(
    shortcutActionForInput(input({ code: "KeyL", meta: true }), "darwin"),
    "address:focus"
  );
  assert.equal(
    shortcutActionForInput(input({ code: "KeyL", control: true }), "darwin"),
    null
  );
  assert.equal(
    shortcutActionForInput(input({ code: "KeyL", control: true }), "win32"),
    "address:focus"
  );
});

test("matching is exact and never lets extra modifiers fall through", () => {
  assert.equal(
    shortcutActionForInput(
      input({ code: "KeyW", meta: true, shift: true }),
      "darwin"
    ),
    null
  );
  assert.equal(
    shortcutActionForInput(
      input({ code: "KeyR", meta: true, shift: true }),
      "darwin"
    ),
    "navigation:reload-ignore-cache"
  );
  assert.equal(
    shortcutActionForInput(
      input({ code: "KeyL", meta: true, alt: true }),
      "darwin"
    ),
    null
  );
  assert.equal(
    shortcutActionForInput(
      input({ code: "KeyP", meta: true, shift: true }),
      "darwin"
    ),
    null,
    "the Firefox/Zen private-window shortcut must not open Chroma's palette"
  );
});

test("literal Control remains distinct from Primary on macOS", () => {
  assert.equal(
    shortcutActionForInput(input({ code: "Tab", control: true }), "darwin"),
    "tab:next"
  );
  assert.equal(
    shortcutActionForInput(input({ code: "Tab", meta: true }), "darwin"),
    null
  );
});

test("downloads follows the platform-specific Zen shortcut", () => {
  assert.equal(
    shortcutActionForInput(
      input({ code: "KeyJ", meta: true, shift: true }),
      "darwin"
    ),
    "downloads:open"
  );
  assert.equal(
    shortcutActionForInput(input({ code: "KeyJ", meta: true }), "darwin"),
    null
  );
  for (const platform of ["win32", "linux"]) {
    assert.equal(
      shortcutActionForInput(input({ code: "KeyJ", control: true }), platform),
      "downloads:open"
    );
    assert.equal(
      shortcutActionForInput(
        input({ code: "KeyJ", control: true, shift: true }),
        platform
      ),
      null
    );
  }
  assert.equal(shortcutDisplayForAction("downloads:open", "darwin"), "⇧⌘J");
  assert.equal(shortcutDisplayForAction("downloads:open", "win32"), "Ctrl+J");
  assert.equal(shortcutDisplayForAction("downloads:open", "linux"), "Ctrl+J");
  assert.equal(
    menuAcceleratorForAction("downloads:open", "darwin"),
    "CmdOrCtrl+Shift+J"
  );
  assert.equal(
    menuAcceleratorForAction("downloads:open", "win32"),
    "CmdOrCtrl+J"
  );
});

test("Zen split shortcuts map V to side by side and H to top and bottom", () => {
  for (const [platform, primary] of [
    ["darwin", { meta: true }],
    ["win32", { control: true }],
    ["linux", { control: true }],
  ]) {
    assert.equal(
      shortcutActionForInput(
        input({ code: "KeyV", alt: true, ...primary }),
        platform
      ),
      "split:row"
    );
    assert.equal(
      shortcutActionForInput(
        input({ code: "KeyH", alt: true, ...primary }),
        platform
      ),
      "split:column"
    );
  }
  assert.equal(shortcutDisplayForAction("split:row", "darwin"), "⌥⌘V");
  assert.equal(shortcutDisplayForAction("split:column", "darwin"), "⌥⌘H");
  assert.equal(shortcutDisplayForAction("split:row", "win32"), "Ctrl+Alt+V");
  assert.equal(shortcutDisplayForAction("split:column", "linux"), "Ctrl+Alt+H");
});

test("repeat, composition, composed AltGr input, and non-keydown input are ignored", () => {
  const candidate = { code: "KeyT", control: true };
  assert.equal(shortcutActionForInput(input({ ...candidate, isAutoRepeat: true })), null);
  assert.equal(shortcutActionForInput(input({ ...candidate, isComposing: true })), null);
  assert.equal(shortcutActionForInput(input({ ...candidate, altGraph: true })), null);
  assert.equal(
    shortcutActionForInput(
      input({ code: "KeyH", key: "ħ", control: true, alt: true }),
      "linux"
    ),
    null
  );
  assert.equal(
    shortcutActionForInput(
      input({ code: "KeyH", key: "h", control: true, alt: true }),
      "linux"
    ),
    "split:column"
  );
  assert.equal(shortcutActionForInput(input({ ...candidate, type: "keyUp" })), null);
});

test("labels and menu accelerators use the active platform", () => {
  assert.equal(shortcutDisplayForAction("sidebar:toggle", "darwin"), "⌘S");
  assert.equal(shortcutDisplayForAction("history:open", "darwin"), "⌘Y");
  assert.equal(shortcutDisplayForAction("history:open", "win32"), "Ctrl+H");
  assert.equal(shortcutDisplayForAction("tab:next", "darwin"), "⌃⇥");
  assert.equal(
    menuAcceleratorForAction("sidebar:toggle", "darwin"),
    "CmdOrCtrl+S"
  );
  assert.equal(shortcutDisplayForAction("command-palette:open", "darwin"), "");
});

test("menu, page, shell, and palette consume the shared registry", async () => {
  const [main, controller, renderer] = await Promise.all([
    readFile(new URL("../src/main/main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/main/browser-controller.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/shell.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(main, /menuAcceleratorForAction/);
  assert.match(main, /registerAccelerator:\s*false/);
  assert.doesNotMatch(main, /CmdOrCtrl\+Shift\+S/);
  assert.match(controller, /shortcutActionForInput/);
  assert.match(controller, /#wireShellShortcuts\(this\.#window\.webContents\)/);
  assert.match(controller, /this\.#handleShortcutInput\(event, input, tab\.id\)/);
  assert.match(renderer, /shortcutDisplayForAction/);
  assert.doesNotMatch(renderer, /event\.shiftKey && !event\.altKey && key === "p"/);
});
