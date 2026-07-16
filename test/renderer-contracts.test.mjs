import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shellSourcePromise = readFile(
  new URL("../src/renderer/shell.mjs", import.meta.url),
  "utf8"
);
const stylesSourcePromise = readFile(
  new URL("../src/renderer/styles.css", import.meta.url),
  "utf8"
);
const indexSourcePromise = readFile(
  new URL("../src/renderer/index.html", import.meta.url),
  "utf8"
);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function cssBlock(source, selector) {
  const startIndex = source.indexOf(`${selector} {`);
  assert.notEqual(startIndex, -1, `missing CSS selector: ${selector}`);
  const bodyStart = source.indexOf("{", startIndex) + 1;
  const bodyEnd = source.indexOf("}", bodyStart);
  assert.notEqual(bodyEnd, -1, `unterminated CSS selector: ${selector}`);
  return source.slice(bodyStart, bodyEnd);
}

test("tab sequences build split capsules only from their own container", async () => {
  const source = await shellSourcePromise;
  const body = sourceBetween(
    source,
    "function renderTabSequence(tabs, renderedSplitGroups)",
    "function renderTabs()"
  );

  assert.match(body, /new Map\(tabs\.map\(/);
  assert.match(body, /new Set\(tabsById\.keys\(\)\)/);
  assert.match(body, /group\.tabIds\.every\(id => availableIds\.has\(id\)\)/);
  assert.doesNotMatch(body, /tabsForWorkspace\(/);
  assert.doesNotMatch(body, /state\.tabs\.find\(/);
});

test("ordinary pinned tabs render in an isolated neutral two-column grid", async () => {
  const [index, shell, styles] = await Promise.all([
    indexSourcePromise,
    shellSourcePromise,
    stylesSourcePromise,
  ]);
  const pinnedBody = sourceBetween(
    shell,
    "function pinnedTabMarkup(tab)",
    "function bookmarkFavicon(bookmark)"
  );
  const tabsBody = sourceBetween(
    shell,
    "function renderTabs()",
    "function renderWorkspaces()"
  );
  const grid = cssBlock(styles, ".pinned-grid");
  const active = cssBlock(styles, ".pinned-tab.is-active");
  const ordinaryActive = cssBlock(styles, ".tab-item.is-active");
  const essentialActive = cssBlock(styles, ".essential-item.is-active");

  assert.match(
    index,
    /id="pinned-section" class="pinned-section" aria-label="Pinned tabs" hidden[\s\S]*id="pinned-grid" class="pinned-grid" role="tablist"/
  );
  assert.ok(index.indexOf('id="essentials-section"') < index.indexOf('id="pinned-section"'));
  assert.ok(index.indexOf('id="pinned-section"') < index.indexOf('id="tabs-list"'));
  assert.match(pinnedBody, /tab\.pinned && !tab\.essential/);
  assert.match(pinnedBody, /pinnedSection\.hidden = pinnedTabs\.length === 0/);
  assert.match(pinnedBody, /class="pinned-tab\$\{active \? " is-active" : ""\}"/);
  assert.match(pinnedBody, /class="pinned-tab-main"[^>]+data-action="select-tab"[^>]+role="tab"[^>]+aria-selected="\$\{active\}"[^>]+aria-label=[^>]+title=/);
  assert.match(pinnedBody, /class="pinned-tab-close"[^>]+data-action="close-tab"[^>]+aria-label=/);
  assert.match(tabsBody, /filter\(tab => !tab\.essential && !tab\.pinned\)/);
  assert.match(shell, /data-action="context-pin"/);
  assert.match(shell, /commands\.togglePin, \{ id: contextTabId \}/);
  assert.match(shell, /closest\("\.tab-row, \.pinned-tab"\)/);
  assert.match(grid, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.pinned-section\[hidden\][\s\S]*display:\s*none/);
  assert.match(active, /background:\s*rgba\(255, 255, 255, \.115\)/);
  assert.doesNotMatch(active, /accent|blue|#(?:00f|0000ff|3d45ff)/i);
  assert.doesNotMatch(ordinaryActive, /accent|blue|#(?:00f|0000ff|3d45ff)/i);
  assert.doesNotMatch(essentialActive, /accent|blue|#(?:00f|0000ff|3d45ff)/i);
});

test("folders keep an accessible empty drop surface and title menu", async () => {
  const [shell, styles] = await Promise.all([
    shellSourcePromise,
    stylesSourcePromise,
  ]);
  const renderBody = sourceBetween(
    shell,
    "function renderTabs()",
    "function renderWorkspaces()"
  );

  assert.doesNotMatch(renderBody, /if \(!childTabs\.length\) return ""/);
  assert.match(renderBody, /class="folder\$\{folder\.expanded \? " is-expanded" : ""\}\$\{childTabs\.length \? "" : " is-empty"\}"/);
  assert.match(renderBody, /class="folder-header"[^>]+aria-expanded="\$\{Boolean\(folder\.expanded\)\}"[^>]+aria-controls="\$\{folderTabsId\}"[^>]+aria-label=/);
  assert.match(renderBody, /class="folder-menu-button"[^>]+data-action="folder-menu"[^>]+aria-haspopup="menu"[^>]+aria-expanded="false"/);
  assert.match(renderBody, /class="folder-tabs" data-drop-zone="folder" data-folder-id=/);
  assert.match(renderBody, /class=\"folder-empty-drop\"[^>]+>Drop tabs here</);
  assert.match(renderBody, /class="folder-count" aria-hidden="true">\$\{childTabs\.length\}/);

  const emptyTabs = cssBlock(styles, ".folder.is-empty.is-expanded .folder-tabs");
  const emptyDrop = cssBlock(styles, ".folder-empty-drop");
  assert.match(emptyTabs, /min-height:\s*36px/);
  assert.match(emptyDrop, /height:\s*30px/);
  assert.match(emptyDrop, /border:\s*1px dashed/);
  assert.match(styles, /\.folder:not\(\.is-expanded\) \.folder-tabs\s*\{\s*display:\s*none/);
  assert.match(styles, /\.folder-header:focus-visible/);
  assert.match(styles, /\.folder-menu-button:focus-visible/);
});

test("folder actions rename safely and confirm container-only deletion", async () => {
  const [index, shell, styles] = await Promise.all([
    indexSourcePromise,
    shellSourcePromise,
    stylesSourcePromise,
  ]);
  const menuBody = sourceBetween(
    shell,
    "function showFolderMenu(folderId, anchor = null, point = null)",
    "function showTabMenu(tabId, x, y)"
  );
  const promptBody = sourceBetween(
    shell,
    "function requestText(",
    'window.addEventListener("beforeunload"'
  );
  const actionBody = sourceBetween(
    shell,
    "async function handleAction(action, element)",
    'document.addEventListener("click"'
  );

  assert.match(index, /id="text-prompt-description" class="text-prompt-description" hidden/);
  assert.match(menuBody, /role", "menu"/);
  assert.match(menuBody, /role="menuitem" data-action="folder-menu-toggle"/);
  assert.match(menuBody, /data-action="folder-rename"/);
  assert.match(menuBody, /data-action="folder-delete"/);
  assert.match(menuBody, /event\.key === "ArrowDown"/);
  assert.match(menuBody, /event\.key === "Escape"/);
  assert.match(promptBody, /Math\.max\(1, Math\.min\(80, maxLength\)\)/);
  assert.match(promptBody, /textPromptInput\.value\.trim\(\)\.slice\(0, boundedMaxLength\)/);
  assert.match(promptBody, /function requestConfirmation/);
  assert.match(promptBody, /textPrompt\.setAttribute\("aria-describedby", "text-prompt-description"\)/);
  assert.match(actionBody, /commands\.createFolder, \{ name, tabIds: \[\] \}/);
  assert.match(actionBody, /commands\.renameFolder/);
  assert.match(actionBody, /name:\s*name\.trim\(\)\.slice\(0, 80\)/);
  assert.match(actionBody, /Deleting “\$\{folder\.name\}” only removes the folder/);
  assert.match(actionBody, /will stay open and return to the ungrouped tab list/);
  assert.match(actionBody, /commands\.deleteFolder/);
  assert.match(styles, /\.folder-popover\s*\{/);
  assert.match(styles, /\.folder-popover \.menu-item\.danger/);
  assert.match(styles, /\.text-prompt-description\s*\{/);
  assert.match(styles, /\.text-prompt \.prompt-button\.danger\s*\{/);
});

test("folder dragging sends an explicit destination and excludes library tabs", async () => {
  const [shell, styles] = await Promise.all([
    shellSourcePromise,
    stylesSourcePromise,
  ]);
  const tabMenuBody = sourceBetween(
    shell,
    "function showTabMenu(tabId, x, y)",
    "function renderAddressSuggestions()"
  );
  const pointerDownBody = sourceBetween(
    shell,
    'document.addEventListener("pointerdown", event => {\n  const row',
    'document.addEventListener("pointermove", event => {\n  const session = tabPointerDrag'
  );
  const pointerMoveBody = sourceBetween(
    shell,
    'document.addEventListener("pointermove", event => {\n  const session = tabPointerDrag',
    'document.addEventListener("pointerup", event => {\n  if (splitDividerDrag'
  );
  const pointerUpBody = sourceBetween(
    shell,
    'document.addEventListener("pointerup", event => {\n  const session = tabPointerDrag',
    'document.addEventListener("pointercancel"'
  );

  assert.match(tabMenuBody, /const movable = !tab\.essential && !tab\.pinned/);
  assert.match(tabMenuBody, /const folderAction = movable/);
  assert.match(tabMenuBody, /const splitActions = movable/);
  assert.match(pointerDownBody, /!tab\.essential && !tab\.pinned/);
  assert.match(pointerMoveBody, /const targetFolderId = hitFolder\?\.dataset\.folderId \|\| null/);
  assert.match(pointerMoveBody, /dragTargetFolderId = targetFolderId/);
  assert.match(pointerMoveBody, /\?\.tabIds\.filter\(id => id !== session\.sourceId\)[\s\S]*\.at\(-1\) \|\| null/);
  assert.match(pointerMoveBody, /row\.closest\("\.folder"\)\?\.dataset\.folderId \|\| null/);
  assert.match(pointerUpBody, /const pointerFolderId = dragTargetFolderId/);
  assert.ok((pointerUpBody.match(/folderId: pointerFolderId/g) || []).length >= 4);

  const popoverLayer = cssBlock(styles, ".popover-layer");
  const dragChip = cssBlock(styles, ".tab-drag-chip");
  const content = cssBlock(styles, ".content-shell");
  const dragSidebar = cssBlock(styles, "body.is-tab-dragging .sidebar");
  const layerOf = block => Number(/z-index:\s*(\d+)/.exec(block)?.[1]);
  assert.ok(layerOf(popoverLayer) > layerOf(content));
  assert.ok(layerOf(dragChip) > layerOf(content));
  assert.ok(layerOf(dragSidebar) > layerOf(content));
  assert.match(shell, /api\.setChromeModalOpen\(true\)/);
  assert.match(pointerMoveBody, /api\.setTabDragActive\(true\)/);
});

test("overlay tab dragging gives the sidebar priority over the page preview", async () => {
  const source = await shellSourcePromise;
  const dragBody = sourceBetween(
    source,
    'document.addEventListener("pointermove", event => {',
    'document.addEventListener("pointerup", event => {'
  );
  const sidebarIndex = dragBody.indexOf("const sidebarBounds");
  const viewportIndex = dragBody.indexOf("const overViewport");

  assert.ok(sidebarIndex >= 0 && sidebarIndex < viewportIndex);
  assert.match(dragBody, /const overSidebar\s*=/);
  assert.match(dragBody, /!overSidebar\s*&&/);
  assert.match(
    dragBody,
    /\(!isSidebarOverlay \|\| event\.clientX > sidebarBounds\.right\)/
  );
});

test("column split capsules preserve two-row geometry at both density levels", async () => {
  const styles = await stylesSourcePromise;
  const compact = cssBlock(
    styles,
    '.split-tab-group[data-count="2"][data-direction="column"]'
  );
  const current = cssBlock(
    styles,
    '.split-tab-group.is-current[data-count="2"][data-direction="column"]'
  );

  assert.match(compact, /height:\s*36px/);
  assert.match(compact, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(compact, /grid-template-rows:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(current, /height:\s*69px/);
});

test("the overlay sidebar stays above the full-window drag preview", async () => {
  const styles = await stylesSourcePromise;
  const sidebar = cssBlock(
    styles,
    ".is-sidebar-overlay-document body.is-tab-dragging .app.is-sidebar-overlay .sidebar"
  );
  const preview = cssBlock(
    styles,
    ".is-sidebar-overlay-document body.is-tab-dragging .app.is-sidebar-overlay .content-shell"
  );
  const sidebarLayer = Number(/z-index:\s*(\d+)/.exec(sidebar)?.[1]);
  const previewLayer = Number(/z-index:\s*(\d+)/.exec(preview)?.[1]);

  assert.ok(Number.isFinite(sidebarLayer));
  assert.ok(Number.isFinite(previewLayer));
  assert.ok(sidebarLayer > previewLayer);
});

test("the command palette is a searchable keyboard-accessible modal", async () => {
  const [index, shell] = await Promise.all([
    indexSourcePromise,
    shellSourcePromise,
  ]);

  assert.match(index, /id="command-palette"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(index, /id="command-palette-input"[^>]+aria-controls="command-palette-results"/);
  assert.match(index, /id="command-palette-results"[^>]+role="listbox"/);
  assert.match(shell, /DEFAULT_BROWSER_COMMANDS/);
  assert.match(shell, /searchCommands\(commandPaletteInput\.value/);
  assert.match(shell, /event\.shiftKey && !event\.altKey && key === "p"/);
  assert.match(shell, /case "address:focus"/);
  assert.match(shell, /case "history:open"/);
  assert.match(shell, /case "downloads:open"/);
});

test("the command palette glass surface preserves focus and contrast fallbacks", async () => {
  const styles = await stylesSourcePromise;
  const surface = cssBlock(styles, ".command-palette-surface");
  const focus = cssBlock(styles, ".command-palette-item:focus-visible");

  assert.match(surface, /-webkit-backdrop-filter:\s*blur\(/);
  assert.match(surface, /backdrop-filter:\s*blur\(/);
  assert.match(surface, /border-radius:\s*19px/);
  assert.match(focus, /outline:\s*2px solid var\(--chroma-accent\)/);
  assert.match(styles, /@media \(prefers-contrast: more\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("the downloads popover exposes real lifecycle controls", async () => {
  const [shell, styles] = await Promise.all([
    shellSourcePromise,
    stylesSourcePromise,
  ]);
  const body = sourceBetween(
    shell,
    "function showDownloads(anchor)",
    "function formatDownloadBytes(value)"
  );

  for (const action of [
    "download-pause",
    "download-resume",
    "download-cancel",
    "download-open",
    "download-reveal",
    "download-remove",
    "download-clear-finished",
  ]) {
    assert.match(body, new RegExp(action));
  }
  assert.match(body, /download\.terminal/);
  assert.match(body, /role="progressbar"/);
  assert.match(styles, /\.downloads-popover\s*\{/);
  assert.match(styles, /\.download-actions button\s*\{/);
});

test("appearance settings expose an accessible strict four-field editor", async () => {
  const [index, shell, styles] = await Promise.all([
    indexSourcePromise,
    shellSourcePromise,
    stylesSourcePromise,
  ]);
  const appearanceBody = sourceBetween(
    shell,
    "function showAppearance(anchor)",
    "function showDownloads(anchor)"
  );
  const renderBody = sourceBetween(
    shell,
    "function render()",
    "function renderEssentials()"
  );

  assert.match(
    index,
    /id="appearance-button"[^>]+data-action="appearance"[^>]+aria-label="Open appearance settings"[^>]+aria-haspopup="dialog"[^>]+aria-controls="appearance-popover"[^>]+aria-expanded="false"/
  );
  assert.match(appearanceBody, /popover\.id = "appearance-popover"/);
  assert.match(appearanceBody, /role", "dialog"/);
  assert.match(appearanceBody, /aria-modal", "true"/);
  assert.match(appearanceBody, /APPEARANCE_THEMES\.map/);
  assert.match(appearanceBody, /type="radio" name="theme"/);
  assert.match(appearanceBody, /type="color"/);
  assert.match(appearanceBody, /name="reduceTransparency" type="checkbox"/);
  assert.match(appearanceBody, /class="appearance-save" type="submit">Save/);
  assert.match(
    appearanceBody,
    /commands\.setAppearance,\s*\{\s*theme,\s*reduceTransparency,\s*workspaceId,\s*workspaceColor,\s*\}/s
  );
  assert.match(renderBody, /document\.documentElement\.dataset\.theme = appearance\.theme/);
  assert.match(renderBody, /appElement\.dataset\.reduceTransparency = String\(reduceTransparency\)/);
  assert.match(renderBody, /appElement\.classList\.toggle\("reduced-transparency", reduceTransparency\)/);

  const popover = cssBlock(styles, ".appearance-popover");
  const opaquePopover = cssBlock(styles, ".app.reduced-transparency .appearance-popover");
  const opaqueOverlay = cssBlock(
    styles,
    ".app.reduced-transparency.is-sidebar-overlay .sidebar"
  );
  assert.match(popover, /border-radius:\s*18px/);
  assert.match(popover, /-webkit-backdrop-filter:\s*blur\(/);
  assert.match(popover, /backdrop-filter:\s*blur\(/);
  assert.match(opaquePopover, /background:\s*linear-gradient/);
  assert.match(opaqueOverlay, /border-radius:\s*15px/);
  assert.match(opaqueOverlay, /-webkit-backdrop-filter:\s*none/);
  assert.match(opaqueOverlay, /backdrop-filter:\s*none/);
  assert.doesNotMatch(opaqueOverlay, /display:\s*none/);
  assert.match(styles, /\.appearance-theme-option input:focus-visible \+ span/);
  assert.match(
    styles,
    /@media \(prefers-contrast: more\)[\s\S]*\.appearance-popover\s*\{[^}]*background:\s*Canvas[^}]*backdrop-filter:\s*none/
  );
});

test("split dividers preview live geometry and commit one durable ratio", async () => {
  const [index, shell, styles] = await Promise.all([
    indexSourcePromise,
    shellSourcePromise,
    stylesSourcePromise,
  ]);
  const renderBody = sourceBetween(
    shell,
    "function renderPaneFrames(viewportRect)",
    "function sidebarOverlayBounds()"
  );
  const dragBody = sourceBetween(
    shell,
    "function splitPathFromElement(element)",
    'document.addEventListener("pointerdown", event => {\n  const row'
  );
  const capsulePreviewBody = sourceBetween(
    shell,
    "function renderSplitDividerPreview(session = splitDividerDrag)",
    "function restoreSplitDividerPreview(session)"
  );

  assert.match(renderBody, /splitLayoutRects\(/);
  assert.match(renderBody, /class="pane-frame\$\{active\}" aria-hidden="true"/);
  assert.match(renderBody, /class="pane-divider"/);
  assert.match(renderBody, /role="separator"/);
  assert.match(renderBody, /focusedDividerKey/);
  assert.match(renderBody, /replacement\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(dragBody, /api\.previewSplitRatio/);
  assert.match(dragBody, /commands\.setSplitRatio/);
  assert.match(dragBody, /updateSplitCapsuleGeometry\(session\.groupId, session\.previewLayout\)/);
  assert.match(dragBody, /const committed = await runCommand/);
  assert.match(dragBody, /if \(committed !== true\)/);
  assert.match(dragBody, /paneFrameLayer\.setPointerCapture\(event\.pointerId\)/);
  assert.match(dragBody, /Math\.min\(\.8, Math\.max\(\.2/);
  assert.match(dragBody, /divider\.dataset\.splitRatio = String\(ratio\)/);
  assert.match(dragBody, /divider\.setAttribute\("aria-valuenow"/);
  assert.match(shell, /if \(splitDividerDrag\) \{\s*event\.preventDefault\(\);\s*cancelSplitDividerDrag\(\)/);
  assert.match(capsulePreviewBody, /updateSplitCapsuleGeometry/);
  assert.doesNotMatch(capsulePreviewBody, /renderTabs|replaceTrustedMarkup/);
  assert.match(styles, /\.pane-divider\s*\{/);
  assert.match(styles, /\.split-tab-group\.has-ratio-layout\s*\{/);

  const frameLayer = /<div id="pane-frame-layer"[^>]*>/.exec(index)?.[0] || "";
  assert.ok(frameLayer);
  assert.doesNotMatch(frameLayer, /aria-hidden/);
});

test("ratio split capsules preserve their tree geometry when compact", async () => {
  const styles = await stylesSourcePromise;
  const group = cssBlock(styles, ".split-tab-group.has-ratio-layout");
  const row = cssBlock(styles, ".split-tab-group.has-ratio-layout > .tab-row");

  assert.match(group, /display:\s*block/);
  assert.match(group, /height:\s*36px/);
  assert.match(group, /overflow:\s*hidden/);
  assert.match(row, /position:\s*absolute/);
  assert.match(row, /left:\s*var\(--pane-x/);
  assert.match(row, /top:\s*var\(--pane-y/);
  assert.match(row, /width:\s*var\(--pane-width/);
  assert.match(row, /height:\s*var\(--pane-height/);
  assert.match(
    styles,
    /\.split-tab-group\.is-current:is\(\[data-count="3"\], \[data-count="4"\]\)\s*\{[^}]*height:\s*69px/s
  );
  assert.match(
    styles,
    /\.split-tab-group:not\(\.has-ratio-layout\)\[data-count="3"\]\[data-root-direction="column"\]/
  );
});
