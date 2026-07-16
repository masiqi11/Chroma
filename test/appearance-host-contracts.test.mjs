import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const controllerSourcePromise = readFile(
  new URL("../src/main/browser-controller.mjs", import.meta.url),
  "utf8"
);
const mainSourcePromise = readFile(
  new URL("../src/main/main.mjs", import.meta.url),
  "utf8"
);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("the controller applies restored appearance before creating page views", async () => {
  const source = await controllerSourcePromise;
  const initialize = sourceBetween(
    source,
    "async initialize() {",
    "getPublicState() {"
  );

  assert.match(source, /applyAppearance = \(\) => \{\}/);
  assert.match(source, /#applyAppearance/);
  assert.match(initialize, /#applyAppearance\(\{ \.\.\.this\.#state\.settings\.appearance \}\)/);
  assert.ok(
    initialize.indexOf("#applyAppearance") < initialize.indexOf("#createView"),
    "restored appearance must be applied before page views are created"
  );
});

test("the appearance command validates atomically and commits exactly once", async () => {
  const source = await controllerSourcePromise;
  const body = sourceBetween(
    source,
    "setAppearance(payload = {}) {",
    "openDevTools("
  );

  assert.match(source, /case commands\.setAppearance:/);
  assert.match(body, /APPEARANCE_THEME_SET\.has\(theme\)/);
  assert.match(body, /typeof reduceTransparency !== "boolean"/);
  assert.match(body, /workspaceId !== this\.#state\.activeWorkspaceId/);
  assert.match(body, /\^#\[\\da-f\]\{6\}\$\/i\.test\(workspaceColor\)/);
  assert.match(body, /this\.#state\.settings\.appearance = appearance/);
  assert.match(body, /workspace\.color = color/);
  assert.equal((body.match(/this\.#commit\(\)/g) || []).length, 1);

  const finalRejection = body.lastIndexOf("return false;");
  const applyIndex = body.indexOf("this.#applyAppearance");
  const stateMutation = body.indexOf("this.#state.settings.appearance = appearance");
  assert.ok(finalRejection >= 0 && finalRejection < applyIndex);
  assert.ok(applyIndex >= 0 && applyIndex < stateMutation);
});

test("the Electron host applies theme source and keeps window backgrounds current", async () => {
  const source = await mainSourcePromise;
  const refresh = sourceBetween(
    source,
    "function refreshWindowBackgrounds() {",
    "function applyWindowAppearance("
  );
  const apply = sourceBetween(
    source,
    "function applyWindowAppearance(window, appearance) {",
    'nativeTheme.on("updated"'
  );

  assert.match(refresh, /BrowserWindow\.getAllWindows\(\)/);
  assert.match(refresh, /setBackgroundColor\(background\)/);
  assert.match(apply, /nativeTheme\.themeSource = theme/);
  assert.match(apply, /setBackgroundColor\(currentWindowBackground\(\)\)/);
  assert.match(source, /nativeTheme\.on\("updated", refreshWindowBackgrounds\)/);
  assert.match(source, /applyAppearance\(appearance\) \{\s*applyWindowAppearance\(window, appearance\)/);
});
