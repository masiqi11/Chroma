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

Evidence for these statuses is split between [`../TESTING.md`](../TESTING.md)
and [`../UI_COMPARISON.md`](../UI_COMPARISON.md). Dependency and distribution
notice work is tracked in
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

| Area | Current status | Work remaining |
|---|---:|---|
| baseplate / vertical sidebar | Basic | right-side placement, preferences, accessibility polish, cross-platform native-material calibration |
| compact sidebar overlay | Current | configurable timing, right-edge mode, multi-window coordination, broader visual regression coverage |
| appearance / Space color | Current | automatic OS Reduce Transparency integration, per-window themes, presets, and cross-platform native-material/visual QA |
| navigation / address-search | Basic | provider settings, Chromium Omnibox providers, complete command/action model, certificate/security UI |
| tab lifecycle | Current | discard policy, cross-window moves, crash reporting/telemetry, direct Chromium `TabStripModel` integration if pursued |
| workspaces | Basic | create/switch/delete, drag reorder, and eligible-tab moves are implemented; bookmark/container relationships, keyboard reordering, cross-window propagation, and richer management UI remain |
| Essentials | Basic | reset/unload semantics, richer metadata, workspace/global policy |
| folders | Basic | nesting, search, bulk lifecycle actions, convert-to-workspace behavior |
| live folders | Planned | provider model, background refresh, privacy and rate-limit policy |
| split view | Basic | ratio presets, per-pane desktop/mobile override, complete focus/fullscreen/PiP/capture/permission semantics |
| split capsule | Current | additional accessibility and keyboard reordering; active group mirrors two-to-four-pane geometry and inactive groups compact to one row |
| transient preview pages | Planned | parent lifecycle, overlay WebContents, expand/split conversion, permission behavior |
| media controls | Planned | MediaSession metadata, transport, PiP, and capture indicators |
| downloads | Current | danger/reputation UI, richer filtering/history views, and direct Chromium DownloadManager integration if pursued |
| permissions / site information | Basic | persistent Chromium PermissionManager policy, certificate, site-data, device, and extension panels |
| local history | Current | replace the local JSON service with production Chromium `HistoryService` integration; add profile/sync policy and richer favicon/settings surfaces |
| bookmarks | Basic | local star/unstar, sidebar listing, open/remove, and profile persistence are implemented; folders, richer management, address-bar integration, and import/export remain |
| command palette | Current | a visible shell control, CJK/English ranked search, contextual availability, keyboard navigation, and safe action adapters are wired; a user-configurable shortcut, user-defined commands, and extension actions remain |
| browser shortcuts | Current | one exact-match registry routes shell/page/overlay input and supplies platform menu/palette labels; remapping, shortcut settings/conflict UI, catalog-action alignment, Zen grid/numeric-Space chords, AltGr/platform normalization, private-window behavior, and full native-platform acceptance remain |
| passwords / autofill / WebAuthn | Planned | integrate mature Chromium services and native security UI; do not implement secrets in shell JavaScript |
| Chrome extensions | Planned | direct extension-system host, action popup, MV3 worker, tabs/storage/DNR/native-messaging coverage |
| containers / isolated identities | Planned | storage-partition model that preserves explicitly shared services |
| session restoration | Basic | multi-window restore and reconciliation, dirty-session recovery UX, production Chromium session services |
| state repair / host lifecycle | Current | broader corruption fuzzing, multi-window ownership, and crash-reporting integration |
| startup / memory regression gate | Current | one/eight-tab local-fixture startup and RSS ceilings are automated on macOS/Linux; Windows sampling, GPU/native-material cost, long-session leaks, interaction latency, CPU, and energy remain |
| cloud sync | Planned | identity, service, encryption, conflict model, and explicit synced datatypes |
| page customization / mods | Policy/License | define an original Chroma API and security boundary; Firefox/XUL mods are not portable |
| local unsigned macOS package | Current | explicit runtime allow-list, original Chroma icon, five license resources, and packaged-executable smoke; cross-platform package QA remains |
| updater / signed release distribution | Basic | unsigned macOS ASAR/package smoke exists; hardened runtime, entitlements, notarization, signed updates, installer QA, rollout and rollback remain |
| DRM / proprietary codecs / vendor APIs | Policy/License | Widevine agreement, codec flags, Safe Browsing/geolocation/vendor keys |

## Current interaction acceptance

The packaged macOS app has been operated on an unlocked desktop for launch,
new-tab search, direct Baidu navigation, sidebar collapse, edge reveal, overlay,
and docked-sidebar restoration without a JavaScript-error dialog. This is a
partial GUI check; the real-pointer split/folder gestures and cross-platform
release checklist remain open in [`../TESTING.md`](../TESTING.md).

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
  three-pane row/grid topology is one full-height left cell plus two stacked
  right cells; four panes use a 2-by-2 topology. Actual extents follow the
  stored ratios. When another tab is selected, that split group compacts to one
  row.
- Every visible split boundary is draggable. The shell and native page bounds
  preview continuously without mutating durable state; release commits one
  clamped 20–80% ratio, while cancellation restores the saved geometry.
  Arrow keys and Home/End adjust the same divider, and active capsule segments
  mirror the resulting ratio tree.
- Split panes use actual native bounds at zoom `1`, so responsive pages reflow
  rather than being scaled down. Fixed-width pages remain subject to the
  guarded mobile-response fallback and may still require a future manual
  desktop/mobile override.
- Tabs can be dragged into a basic folder and back to the ungrouped area. The
  target folder expands after a successful move.
- Space controls use roving keyboard focus with Arrow/Home/End switching and
  can be reordered by drag/drop. An ordinary ungrouped, unpinned,
  non-Essential, unsplit tab can move to another Space from its context menu.
  Confirmed deletion removes one Space and all of its owned tabs, folders, and
  splits, chooses a deterministic adjacent fallback, and cannot remove the
  final Space.
- When a page renderer exits, only its native pane is hidden; healthy split
  siblings remain visible. The shell shows an accessible Reload/Close card.
  Reload either reuses the surviving `WebContents` or creates a replacement
  while preserving the tab ID, URL, and workspace/folder/split topology.
- Browser chords are matched against an exact shared registry before the page
  receives them. Primary means Command on macOS and Control elsewhere, while
  literal Control remains distinct for Ctrl+Tab on macOS. The registry covers
  navigation, tabs, workspaces, splits, zoom, bookmarks, history, downloads,
  sidebar, and developer tools. Extra modifiers, repeats, composition, and
  key-up events do not fall through to a different action. The command palette
  uses its visible Commands control; `Cmd/Ctrl+Shift+P` is intentionally
  unbound. An exact browser chord is consumed even when its action is currently
  unavailable, and shell/page/overlay paths guard destroyed native views.
  AltGr normalization still needs real Windows/Linux acceptance.
- Appearance offers persisted `System`, `Light`, and `Dark` themes, the active
  Space's six-digit accent color, and a manual Reduce transparency option.
  System follows Electron's native theme. Reduced mode swaps Chroma's glass
  shell surfaces for opaque rounded materials while preserving the floating
  sidebar shape and leaving page content untouched.
- Starring an HTTP(S) page persists a local bookmark and updates the navigation
  action and sidebar. A bookmark can be reopened or removed; unsafe URLs are not
  accepted. Bookmark folders and import/export are outside this slice.
- The profile uses schema version 6. Its bounded history shape was introduced in
  schema 3, terminal download metadata in schema 4, the sanitized split ratio
  tree in schema 5, and Appearance preferences in schema 6. Space colors remain
  on their workspaces. History remains behind a dedicated main-process
  service. The shell panel supports bounded local search, date groups,
  pagination, individual and
  selection deletion, confirmed custom/range/all-time clearing, persistent
  recording/retention/clear-on-exit preferences, and `Cmd+Y` / `Ctrl+H` access.
  Full visit records stay behind the query boundary; credentials and fragments,
  subframes, failed navigations, and unsafe schemes are not recorded.
- Profile load repairs invalid or colliding folder/split IDs and memberships as
  one topology. Split members are co-located in the first pane's folder (or all
  ungrouped), matching the single-capsule renderer contract after restart.
  Entity IDs, tab count, page URLs, and favicons have hard persistence/IPC
  bounds; HTTP(S) credentials and stored fragments are removed while bounded
  runtime page anchors remain functional. Media permission decisions isolate
  microphone and camera scope, and teardown stays deny-all until remote pages
  are gone. A closed stdout/stderr pipe is handled narrowly so logging does
  not crash the main process with `EPIPE`; unrelated stream failures remain
  visible.
- Downloads use a dedicated main-process lifecycle service. Active transfers
  remain memory-only, while at most 100 completed, cancelled, or interrupted
  records are sanitized and persisted. The shell popover exposes pause, resume,
  cancel, open, reveal, remove, and clear-finished controls; controller teardown
  removes the persistent Session listener.

Verification combines pure geometry/model tests with the isolated Electron
runtime smoke test. It covers zero-width collapse, overlay width and z-order,
unchanged page visibility, neutral frames, merge/order/detach transitions,
live divider preview versus one durable ratio commit, active and compact capsule
geometry, folder drag behavior, workspace reorder/delete/tab movement,
shell/page shortcut routing, crashed-pane recovery, responsive pane bounds,
navigation rollback, sandbox isolation, and native-view cleanup.

The implemented history contract is recorded in
[`HISTORY-SPEC.md`](HISTORY-SPEC.md). Runtime smoke reports explicit
`historyPanel`, `historySearch`, `historyDelete`, `historyClearRange`,
`historyPersistence`, and `historyPrivacyPolicy` checks, alongside
`downloadUi`, `downloadLifecycle`, `downloadPersistence`, `splitRatioDrag`,
`splitRatioPersistence`, `appearanceUi`, `appearanceRuntime`,
`appearancePersistence`, command-palette, local-bookmark, and
broken-output-pipe coverage. It also reports `shortcutShellInput`,
`shortcutPageInput`, `shortcutExactModifiers`, `workspaceDeleteUi`,
`workspaceReorderUi`, `workspaceMoveTabUi`, and `crashRecovery`. A separate
four-launch session smoke verifies that
workspaces, tabs, folders, split groups, sidebar state, an external startup URL,
and dark/light/system Appearance settings survive restart boundaries.

Run the current verification gates from the repository root:

```bash
npm run verify
npm run visual
npm run package-smoke
```

`verify` serially runs the fast `check` gate, the concurrent-window lifecycle
smoke, the four-launch session-restoration smoke, the full Electron runtime
smoke, and the local-fixture performance gate. `npm run check` by itself
performs syntax validation and Node unit/source-contract tests only; it does not
launch Electron and therefore does not establish that the browser UI starts or
remains crash-free.

The performance stage gates shell/first-page readiness and one/eight-tab
process-tree RSS against conservative ceilings, then writes
`artifacts/performance/report.json`. It uses software rendering and tiny local
fixtures, so it is not evidence about real-site, GPU, long-session, Windows,
CPU, energy, or cross-browser performance. See
[`PERFORMANCE.md`](PERFORMANCE.md) for the exact method and current result.

`package-smoke` is an independent local macOS bundle gate. It produces an
unsigned `.app`, verifies that its ASAR contains only the declared runtime
boundary, rejects leaked tests/scripts/artifacts/profile state, and starts the
packaged executable far enough to exercise the preload bridge and initial live
browser state without fatal logs. It does not establish code signing,
notarization, Gatekeeper acceptance, or updater readiness. The current report
does verify the original branded Chroma icon and the presence of five directly
readable Chroma, Electron, and Chromium license resources. That minimum payload
is not proof of a complete frozen-artifact SBOM or legal notice review; see
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

`visual` is an independent deterministic renderer gate. It composites the
shell and visible native page targets, then checks geometry and PNG pixels for
seven scenes at 1280×720/DPR 1: expanded dark/light, fully hidden collapse, the
independently captured floating overlay target, 60/40 two-pane, asymmetric
three-pane, and 2×2 four-pane layouts. Current baselines cover Darwin/Electron
43 only and deliberately exclude GPU/native vibrancy, Mica, operating-system
shadows, and cross-platform window chrome.
The exact self-regression evidence is listed in
[`../UI_COMPARISON.md`](../UI_COMPARISON.md); a passing self-regression diff does not measure
similarity to Arc or Zen.

The split-ratio core, download service, command-search core, and Appearance
surface are connected to the browser host. Ratio previews resize real native
views without writing the profile, schema-5 ratio layouts remain persisted in
the current schema-6 profile, downloads attach to the real Electron Session,
and the command palette and Appearance panel remain shell-owned surfaces.

Appearance runtime checks establish validated state changes, Electron
color-scheme propagation, reduced-shell CSS, active-Space accent application,
and disk persistence. They do not establish pixel parity with Arc, native
vibrancy fidelity, automatic OS accessibility-setting synchronization, or
Windows/Linux visual correctness; those require the visual and platform QA
listed below.

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

The current visual comparison boundary and missing external-reference evidence
are recorded in [`../UI_COMPARISON.md`](../UI_COMPARISON.md).
