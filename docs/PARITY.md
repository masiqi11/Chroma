# Chroma Capability Matrix

This document tracks Chroma's own implementation status and next steps. It is
not a Zen migration checklist and does not claim source, binary, API, or
pixel-level parity with Arc, Zen Browser, Firefox, or Chrome.

Arc's design language and Zen Browser's workflows are useful product references,
but every Chroma feature is implemented independently for Chromium/Electron.
No Arc or Zen source code or branded asset is part of this repository.

Status values:

- **Current**: implemented and covered by the runnable host or its tests;
- **Basic**: a usable subset exists, with important behavior still missing;
- **Planned**: not implemented in the current milestone;
- **Policy/License**: requires a product, service, security, or licensing
  decision before implementation or distribution.

| Area | Current status | Work remaining |
|---|---:|---|
| baseplate / vertical sidebar | Basic | right-side placement, preferences, accessibility polish, cross-platform native-material calibration |
| compact sidebar overlay | Current | configurable timing, right-edge mode, multi-window coordination, broader visual regression coverage |
| navigation / address-search | Basic | provider settings, Chromium Omnibox providers, complete command/action model, certificate/security UI |
| tab lifecycle | Current | discard policy, cross-window moves, crash recovery UI, direct Chromium `TabStripModel` integration if pursued |
| workspaces | Basic | gestures, bookmark/container relationships, cross-window propagation, richer management UI |
| Essentials | Basic | reset/unload semantics, richer metadata, workspace/global policy |
| folders | Basic | nesting, search, bulk lifecycle actions, convert-to-workspace behavior |
| live folders | Planned | provider model, background refresh, privacy and rate-limit policy |
| split view | Basic | draggable ratios, per-pane desktop/mobile override, complete focus/fullscreen/PiP/capture/permission semantics |
| split capsule | Current | additional accessibility and keyboard reordering; active group mirrors two-to-four-pane geometry and inactive groups compact to one row |
| transient preview pages | Planned | parent lifecycle, overlay WebContents, expand/split conversion, permission behavior |
| media controls | Planned | MediaSession metadata, transport, PiP, and capture indicators |
| downloads | Basic | durable history, danger/reputation UI, production Chromium DownloadManager integration |
| permissions / site information | Basic | persistent Chromium PermissionManager policy, certificate, site-data, device, and extension panels |
| local history suggestions | Basic | full history UI, deletion/retention controls, Chromium HistoryService integration |
| bookmarks | Planned | model, import/export, sidebar and address-bar integration |
| passwords / autofill / WebAuthn | Planned | integrate mature Chromium services and native security UI; do not implement secrets in shell JavaScript |
| Chrome extensions | Planned | direct extension-system host, action popup, MV3 worker, tabs/storage/DNR/native-messaging coverage |
| containers / isolated identities | Planned | storage-partition model that preserves explicitly shared services |
| session restoration | Basic | multi-window restore and reconciliation, crash-recovery UX, production Chromium session services |
| cloud sync | Planned | identity, service, encryption, conflict model, and explicit synced datatypes |
| page customization / mods | Policy/License | define an original Chroma API and security boundary; Firefox/XUL mods are not portable |
| updater / packaging / signing | Planned | release channels, signed updates, code signing/notarization, rollout and rollback |
| DRM / proprietary codecs / vendor APIs | Policy/License | Widevine agreement, codec flags, Safe Browsing/geolocation/vendor keys |

## Current interaction acceptance

- The expanded sidebar defaults to 228 px. Collapsing it leaves no visible
  rail; entering the invisible left-edge target reveals a rounded 228 px panel
  above the page, and leaving removes the panel completely.
- Collapse/reveal does not hide or translate the page. The live web surface
  receives a wider viewport when the docked sidebar releases its space; the
  floating panel overlays it without displacement.
- The window reads as a shared double-layer baseplate. Single and split web
  surfaces have neutral enclosing frames, and the selected page has no blue
  focus outline.
- The floating sidebar retains its rounded glass panel, while the overlay
  document behind that panel remains transparent. Sidebar menus and drag
  previews stay above native web contents.
- On macOS, inactive traffic lights are muted colored rings. Hover fills only
  the individual red, yellow, or green control.
- Dropping a tab on another tab's left or right half creates a split in matching
  order. Segments can be reordered within a capsule, and dragging a segment
  outside dispatches `split:detach`.
- The active split capsule uses its full height and mirrors real pane geometry:
  three-pane row/grid layout is one full-height left cell plus two stacked right
  cells; four panes are a 2-by-2 grid. When another tab is selected, that split
  group compacts to one row.
- Split panes use actual native bounds at zoom `1`, so responsive pages reflow
  rather than being scaled down. Fixed-width pages remain subject to the
  guarded mobile-response fallback and may still require a future manual
  desktop/mobile override.
- Tabs can be dragged into a basic folder and back to the ungrouped area. The
  target folder expands after a successful move.

Verification combines pure geometry/model tests with the isolated Electron
runtime smoke test. It covers zero-width collapse, overlay width and z-order,
unchanged page visibility, neutral frames, merge/order/detach transitions,
active and compact capsule geometry, folder drag behavior, responsive pane
bounds, navigation rollback, sandbox isolation, and native-view cleanup.

## Future direct Chromium acceptance gate

Before Chroma describes a direct Chromium browser-layer host as production
capable, a dedicated build should demonstrate at least:

1. Chroma WebUI connected through Mojo, with no Electron code in the renderer.
2. One vertical-tab window with two to four simultaneously visible live pages.
3. A persistent Chromium Profile using upstream history, download, permission,
   password, autofill, certificate, and WebAuthn services.
4. Representative MV3 extensions covering content scripts, service workers,
   action popups, `chrome.tabs`, storage, DNR, and native messaging.
5. Defined focused-pane semantics for extension actions, shortcuts,
   `activeTab`, capture, fullscreen, PiP, and permission prompts.
6. A storage-partition proof for one isolated identity without breaking
   intentionally shared bookmarks, history, or extensions.
7. Signed updates, crash reporting, sandbox verification, and third-party
   license/notice generation for every supported platform.

## Visual acceptance

Chroma's own reviewed screenshots, tokens, and interaction specifications are
the acceptance baseline. Arc and Zen may be consulted as high-level design and
workflow references, but Chroma must not copy protected assets or depend on
pixel identity with either product.

For visual regression, capture the same OS, font stack, DPR, theme, window size,
accent color, and fixed page fixture. Validate geometry first, then compare
non-native surfaces with screenshot diff or SSIM. Cover single-page, multi-tab,
collapsed/overlay sidebar, light/dark themes, loading/audio states, Essentials,
folders, two-to-four-pane layouts, active and compact split capsules, and
macOS/Windows/Linux window chrome. Native vibrancy, Mica, and CSD regions require
platform-specific tolerances.
