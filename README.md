# Chroma

Chroma is an independent, open-source desktop browser shell built on Chromium
through Electron. It combines an Arc-inspired visual language with workflows
informed by Zen Browser—vertical tabs, workspaces, folders, a compact sidebar,
and multi-pane browsing—while using an original implementation throughout.

Chroma is a complete rewrite for Chromium/Electron. It is **not** a port of the
Zen Firefox codebase, and this repository does not contain Arc or Zen source
code, logos, icons, fonts, or other brand assets. Chroma is not affiliated with
or endorsed by The Browser Company or the Zen Browser project.

> Chroma is an early runnable milestone, not yet a production-ready daily
> browser. The current host provides real Chromium page surfaces and working
> browser interactions, but it does not yet include the complete services and
> hardening expected from a mature browser.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): current Electron boundary and
  possible direct-Chromium host
- [`DESIGN.md`](DESIGN.md): implemented host and interaction decisions
- [`docs/PARITY.md`](docs/PARITY.md): capability status and remaining work
- [`TESTING.md`](TESTING.md): automated evidence, package/visual gates, and the
  outstanding unlocked-GUI acceptance
- [`UI_COMPARISON.md`](UI_COMPARISON.md): Chroma self-regression baselines and
  the limits of comparison with external browsers
- [`docs/HISTORY-SPEC.md`](docs/HISTORY-SPEC.md): local history contract
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md): dependency-license
  snapshot and release obligations

## Current functionality

- Frameless desktop window with an Arc-inspired baseplate, rounded page
  surfaces, a vertical sidebar, and macOS window controls.
- A persisted Appearance surface with `System`, `Light`, and `Dark` themes, an
  accent color for the active Space, and a manual Reduce transparency option.
  System theme follows Electron's native theme; reduced transparency replaces
  Chroma's glass with opaque rounded shell surfaces without modifying websites.
- Docked, resizable sidebar that collapses to zero visible width and reappears
  as a non-displacing rounded overlay from the left edge.
- Real Chromium navigation with address/search input, back, forward, reload,
  stop, titles, favicons, popup-to-tab routing, and a Chroma new-tab page.
- Multiple live tabs with selection, pointer reordering, close/reopen, audio
  state, mute, and Essentials.
- Persisted workspaces, basic folders, and folder drag-in/drag-out. State load
  also repairs invalid folder/split IDs and memberships instead of letting a
  damaged topology break the library.
- Basic local bookmarks: star/unstar the active HTTP(S) page, browse saved
  pages in the sidebar, open them in a tab, remove them, and restore them with
  the profile. Bookmark folders and import/export are not implemented yet.
- A profile-local history service and shell-owned panel with bounded search,
  date grouping, individual/selection deletion, confirmed time-range clearing,
  address suggestions, persistent recording/retention/clear-on-exit
  preferences, and `Cmd+Y` (macOS) / `Ctrl+H` (Windows and Linux) access.
- A shell-owned command palette on `Cmd/Ctrl+Shift+P` with ranked English and
  Chinese search, contextual availability, keyboard navigation, and explicit
  adapters to the allow-listed browser command boundary.
- Two-to-four-pane browsing using live `WebContentsView` instances. Tabs can be
  dragged onto one another to create a split, reordered inside the split
  capsule, and dragged back out to detach. The active capsule mirrors the pane
  geometry; an inactive split group compacts to one row. Pane ratios can be
  adjusted by pointer or keyboard with live page and capsule previews, remain
  clamped to 20–80%, and persist across profile restoration.
- Real viewport resizing at page zoom `1`, plus a guarded mobile-response
  fallback for fixed-width pages in narrow panes. Chroma does not shrink page
  text to simulate responsiveness.
- Real Electron downloads with a live shell popover, pause/resume/cancel,
  open/reveal/remove/clear actions, bounded terminal-history persistence, and
  Session-listener cleanup. Active transfers remain transient; schema 4 added
  sanitized persistence for at most 100 completed, cancelled, or interrupted
  records. Page context menus, permission prompts, session restoration, and
  runtime cleanup checks are also present. The main process
  tolerates a closed stdout or stderr pipe without turning renderer logging
  into an uncaught `EPIPE` crash.
- Sandboxed page contents, context isolation, no Node.js integration in web
  pages, an allow-listed preload bridge, and filtering of unsupported external
  schemes.

The implementation status and remaining work are tracked in
[`docs/PARITY.md`](docs/PARITY.md).

## Run locally

Requirements:

- Node.js 22 or newer
- npm
- macOS is the primary tested desktop platform at this milestone; Windows and
  Linux host paths exist but still need full native-material and interaction QA

From the repository root:

```bash
npm install
npm start
```

The development profile is stored in Electron's platform-specific user-data
directory under the application name `Chroma`. Browser state is persisted in
`browser-state.json` inside that directory.

## Test

The complete gate definitions, current 125-test evidence, and manual acceptance
boundary are recorded in [`TESTING.md`](TESTING.md).

```bash
npm run verify
```

`verify` is the complete serial Electron gate. It runs `check`,
`window-lifecycle-smoke`, `session-smoke`, and `smoke` in that order and stops
at the first failure. `check` alone is intentionally limited to syntax
validation and Node unit/source-contract tests for navigation, layout, state
repair, history and persistence services, command/preload boundaries, and
process-output handling; it does not launch Electron and must not be treated as
proof that the browser UI starts or stays alive.

The Electron stages cover different runtime boundaries.
`window-lifecycle-smoke` verifies concurrent startup URLs, single-window
ownership, failed-window cleanup, and queued-URL recovery. `session-smoke`
launches Chroma four times against the same isolated profile to verify restored
workspaces, tabs, folders, split groups, sidebar state, startup-URL handling,
and persisted `dark → light → system` Appearance transitions. `smoke` launches
the actual app with an isolated temporary profile
and exercises the bridge, live navigation, local bookmarks, the complete local
history flow, command-palette search/execution, tab/workspace/folder behavior,
split composition/reordering/detach, live split-divider preview and durable
ratio commit, capsule geometry, Appearance UI/runtime/disk persistence, sidebar
overlay layering, responsive native bounds, sandbox isolation, user-agent
handling, broken output pipes, and `WebContents` cleanup. These runtime checks
verify state, native-theme propagation, and shell behavior; they are not a
pixel-parity or cross-platform native-material certification.

The deterministic renderer visual gate is separate from `verify`:

```bash
npm run visual
```

It composes the shell with visible native page views and compares pixels and
geometry at 1280×720/DPR 1. The seven current scenes cover expanded dark/light,
fully hidden collapse, the independently captured floating overlay target, a
dark 60/40 split, an asymmetric three-pane split, and a 2×2 four-pane split.
The checked-in baselines currently cover Darwin with Electron 43 only; native
vibrancy, Mica, system shadows, and other platforms remain outside this
software-raster gate. Baselines can be rewritten only with
`CHROMA_UPDATE_VISUAL_BASELINES=1 npm run visual:update`.
Exact baseline, capture, diff, and manifest paths are listed in
[`UI_COMPARISON.md`](UI_COMPARISON.md); a zero Chroma self-diff is not an Arc or
Zen similarity score.

## Local unsigned macOS packaging

The reproducible local package gate builds the real application bundle and
then starts that packaged executable with an isolated temporary profile:

```bash
npm run package-smoke
```

`package:dir` builds `dist/mac-arm64/Chroma.app` (or the matching host
architecture) without running the package checks. `package-smoke` rebuilds the
directory target, verifies the bundle identifier and the explicit ASAR file
allow-list, rejects leaked tests/scripts/artifacts/profile state, launches the
packaged executable, and proves that the preload bridge reaches live browser
state without fatal startup output. Its machine-readable result is written to
`artifacts/package/package-smoke.json`.

`npm run package:mac` creates local DMG and ZIP artifacts. All three package
scripts disable certificate auto-discovery, and `electron-builder.yml`
explicitly sets `identity: null`; these outputs are **unsigned, unnotarized,
and not release-ready**. The current bundle also deliberately uses Electron's
default icon because no original Chroma application icon has been supplied.
Production distribution still requires an original icon plus a separate
Developer ID signing, hardened-runtime, entitlements, notarization, update,
release-channel configuration, and a complete third-party notice payload. The
current `.app` contains no project/Electron/Chromium license-notice files; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Architecture

Chroma keeps browser-independent product state separate from its current
Electron host:

```text
Renderer shell and interaction state
              |
      allow-listed command bridge
              |
       Electron browser host
              |
  sandboxed Chromium WebContentsView pages
```

- `src/shared/` contains navigation rules, the versioned state schema, command
  names and search ranking, the split ratio tree and geometry, appearance
  sanitization, and persisted-library topology repair. The current profile is
  schema 6: bounded history entered in schema 3, terminal download metadata in
  schema 4, durable split ratio trees in schema 5, and persisted Appearance
  preferences in schema 6. Space colors remain properties of their respective
  workspaces.
- `src/renderer/` implements the Chroma shell and never imports Electron.
- `src/preload/` exposes the narrow `window.chromaBrowser` bridge.
- `src/main/` owns windows, page views, navigation, history, downloads,
  permissions, persistence, process-output guards, and lifecycle cleanup.
- `scripts/runtime-smoke.mjs` is the end-to-end host conformance test.
- `scripts/session-smoke.mjs` is the four-launch restoration and Appearance
  conformance test.
- `scripts/window-lifecycle-smoke.mjs` is the concurrent-window and failed-start
  recovery conformance test.

This separation leaves room for a future direct Chromium browser-layer host
without treating the Electron prototype as disposable UI code. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`DESIGN.md`](DESIGN.md) for
the detailed boundaries and decisions.

## Known limitations

The current Electron host does not promise Chrome Web Store compatibility or a
complete Chromium browser product surface. Not yet implemented or production
ready:

- Chromium password, autofill, WebAuthn, Safe Browsing, certificate, and
  complete permission-management UI;
- full extension-system integration, extension action UI, and tested MV3 API
  coverage;
- bookmark folders and import/export; a production Chromium `HistoryService`
  backend; nested/live tab folders; split-ratio presets and complete
  focused-pane/fullscreen/PiP/capture semantics; Glance-style transient pages;
  media center; container isolation; cloud sync; and multi-window state
  reconciliation;
- production release packaging, updater, signing/notarization, release
  channels, crash reporting, Widevine, proprietary codecs, and vendor API
  keys; the checked-in macOS package configuration is an unsigned local smoke
  boundary only;
- complete accessibility, localization, and cross-platform visual QA.

The adaptive narrow-pane fallback reloads qualifying pages with a mobile user
agent. That can reset unsaved form state, and sites that ignore mobile user
agents may remain fixed-width.

## License and trademarks

Chroma source code is licensed under the
[Apache License 2.0](LICENSE). Third-party dependencies remain under their own
licenses; review and preserve those notices when redistributing source or
binaries. See [`NOTICE.md`](NOTICE.md) and the current dependency inventory in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

`Chroma` is the name of this independent project. Arc, The Browser Company, Zen
Browser, Firefox, Chromium, Electron, Chrome, macOS, Windows, and Linux are
names or trademarks of their respective owners. References to Arc and Zen
describe design inspiration and interaction research only; they do not imply
ownership, affiliation, endorsement, source reuse, or permission to use their
brand assets.
