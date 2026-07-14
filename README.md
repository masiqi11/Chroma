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

## Current functionality

- Frameless desktop window with an Arc-inspired baseplate, rounded page
  surfaces, a vertical sidebar, system light/dark appearance, and macOS window
  controls.
- Docked, resizable sidebar that collapses to zero visible width and reappears
  as a non-displacing rounded overlay from the left edge.
- Real Chromium navigation with address/search input, back, forward, reload,
  stop, titles, favicons, popup-to-tab routing, and a Chroma new-tab page.
- Multiple live tabs with selection, pointer reordering, close/reopen, audio
  state, mute, and Essentials.
- Persisted workspaces, basic folders, folder drag-in/drag-out, and local
  navigation history suggestions.
- Two-to-four-pane browsing using live `WebContentsView` instances. Tabs can be
  dragged onto one another to create a split, reordered inside the split
  capsule, and dragged back out to detach. The active capsule mirrors the pane
  geometry; an inactive split group compacts to one row.
- Real viewport resizing at page zoom `1`, plus a guarded mobile-response
  fallback for fixed-width pages in narrow panes. Chroma does not shrink page
  text to simulate responsiveness.
- Downloads, page context menus, permission prompts, session restoration, and
  runtime cleanup checks.
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

```bash
npm run check
npm run smoke
```

`check` runs syntax validation and unit tests for navigation, layout, state
repair, and atomic persistence. `smoke` launches the actual Electron app with an
isolated temporary profile and exercises the bridge, live navigation, tab and
workspace lifecycle, folder drag behavior, split composition/reordering/detach,
capsule geometry, sidebar overlay layering, responsive native bounds, sandbox
isolation, user-agent handling, and `WebContents` cleanup.

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
  names, and split-layout geometry.
- `src/renderer/` implements the Chroma shell and never imports Electron.
- `src/preload/` exposes the narrow `window.chromaBrowser` bridge.
- `src/main/` owns windows, page views, navigation, downloads, permissions,
  persistence, and lifecycle cleanup.
- `scripts/runtime-smoke.mjs` is the end-to-end host conformance test.

This separation leaves room for a future direct Chromium browser-layer host
without treating the Electron prototype as disposable UI code. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`DESIGN.md`](DESIGN.md) for
the detailed boundaries and decisions.

## Known limitations

The current Electron host does not promise Chrome Web Store compatibility or a
complete Chromium browser product surface. Not yet implemented or production
ready:

- Chromium password, autofill, bookmark, WebAuthn, Safe Browsing, certificate,
  and complete permission-management UI;
- full extension-system integration, extension action UI, and tested MV3 API
  coverage;
- nested/live folders, draggable split ratios, complete fullscreen/PiP/capture
  semantics, Glance-style transient pages, media center, container isolation,
  cloud sync, and multi-window state reconciliation;
- updater, packaging, signing/notarization, release channels, crash reporting,
  Widevine, proprietary codecs, and vendor API keys;
- complete accessibility, localization, and cross-platform visual QA.

The adaptive narrow-pane fallback reloads qualifying pages with a mobile user
agent. That can reset unsaved form state, and sites that ignore mobile user
agents may remain fixed-width.

## License and trademarks

Chroma source code is licensed under the
[Apache License 2.0](LICENSE). Third-party dependencies remain under their own
licenses; review and preserve those notices when redistributing source or
binaries. See [`NOTICE.md`](NOTICE.md).

`Chroma` is the name of this independent project. Arc, The Browser Company, Zen
Browser, Firefox, Chromium, Electron, Chrome, macOS, Windows, and Linux are
names or trademarks of their respective owners. References to Arc and Zen
describe design inspiration and interaction research only; they do not imply
ownership, affiliation, endorsement, source reuse, or permission to use their
brand assets.
