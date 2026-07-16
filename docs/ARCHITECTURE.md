# Chroma Architecture

## Decision

Chroma is an independent Chromium browser project. The current application uses
Electron as its executable Chromium host and keeps Chroma's interface, state
model, command protocol, and layout engine separate from host-specific APIs.

Arc informs parts of the visual language and Zen Browser informs some workflow
research, but neither project is a codebase dependency. Chroma is a from-scratch
rewrite: it does not migrate Firefox/Zen modules, include Arc or Zen source, or
bundle their branded assets.

Electron, CEF, and QtWebEngine can embed Chromium, but none provides the entire
Chrome browser product surface. In particular, the current Electron host cannot
promise arbitrary Chrome Web Store compatibility or complete profile,
password/autofill, session, and extension UI integration. A future direct
Chromium browser-layer host is therefore an architectural path, not something
the current milestone pretends Electron already provides.

## Layers

```text
Chroma HTML UI, tokens, and interaction state
                     |
           typed command/event bridge
                     |
        +------------+-----------------+
        |                              |
Electron host (current)      Direct Chromium host (future)
        |                              |
WebContentsView             TabStripModel / BrowserView / WebContents
        +------------+-----------------+
                     |
 Workspace / Folder / Essential / Split domain model
                     |
 History / Download / Permission / Password / Autofill / Extension services
```

The renderer sees only serializable state and allow-listed commands. It never
receives Electron or Node.js objects. Web pages run in separate sandboxed
`WebContents` instances and cannot access the shell bridge.

## Current module boundaries

- `src/shared/`: navigation normalization, schema-6 state and topology repair,
  split ratio trees, Appearance sanitization, command names, and command
  search. These modules are host-neutral.
- `src/renderer/`: Chroma interface. It calls only
  `window.chromaBrowser` and does not import Electron.
- `src/preload/`: allow-listed IPC adapter. It validates command names and
  copies payloads across the context-isolated boundary.
- `src/main/browser-controller.mjs`: Electron adapter for tabs, workspaces,
  folders, split groups, navigation, permissions, history/download services,
  Appearance, responsive pane handling, and view lifecycle.
- `src/main/state-store.mjs`: atomic, schema-versioned development-session
  persistence.
- `scripts/runtime-smoke.mjs`: end-to-end host conformance test. The lifecycle,
  session, visual, and package smoke scripts cover separate boundaries; see
  [`../TESTING.md`](../TESTING.md).

## Current-to-future Chromium mapping

| Host-neutral concept | Electron host today | Possible direct Chromium host |
|---|---|---|
| tab ID and lifecycle | `WebContentsView` map | `TabStripModel` plus stable Chroma metadata |
| page | Electron `webContents` | Chromium `content::WebContents` |
| split pane | native bounds from the persisted ratio tree | multiple BrowserViews/WebContents in a Chroma window view |
| shell bridge | context-isolated IPC preload | Mojo interface plus WebUI `PageHandler` |
| profile | Electron persistent `session` | Chromium `Profile` / `BrowserContext` |
| container | not implemented | `StoragePartitionConfig` with shared profile services |
| history/download/permission | local state and Electron session | Chromium browser services |
| extensions | intentionally not promised | Chromium `ExtensionSystem` and integrated action UI |
| session | versioned JSON development store | `SessionService` / `TabRestoreService` plus Chroma metadata |
| sync | not implemented | a Chroma identity/service and explicit sync model |

## Invariants

1. UI code must not import Electron, Chromium C++, or browser-service globals.
2. Every UI command is allow-listed in the shared protocol and validated again
   in the host.
3. Arbitrary page URLs never load in the shell renderer.
4. Closing a tab must destroy its page `WebContents`; removing it from UI state
   is not sufficient.
5. Split view has at most four leaves. One focused leaf is the conventional
   active tab while all leaves remain live and visible.
6. Page bounds represent actual pane viewports at zoom `1`; the shell must not
   reduce text scale to make a page appear responsive.
7. Persisted state is schema-versioned, sanitized on load, written atomically,
   and contains no transient renderer flags.
8. Asynchronous probes and overlay timers must revalidate window, view, URL, and
   navigation identity before touching native objects.
9. Mature browser services should be adapted from Chromium if a direct host is
   built, not reimplemented inside the renderer.

## Possible direct Chromium source layout

If Chroma moves from the Electron development host to a maintained Chromium
browser-layer integration, product code should remain concentrated under a
dedicated namespace and upstream patches should be minimized:

```text
//chroma/ui                 WebUI, tokens, components, fixtures
//chroma/common/mojom       typed browser/UI protocol
//chroma/browser            windows, tabs, split, transient pages, actions
//chroma/components         workspaces, folders, Essentials, session, sync
//chroma/platform           macOS vibrancy, Windows Mica, Linux CSD
```

This is a roadmap boundary, not a claim that the current repository already
contains a Chromium source checkout.

## Security and production work still required

Before a production release, Chroma needs a browser threat model, Safe Browsing
and vendor-service decisions, certificate and site-information UI, persistent
per-origin permission storage, download reputation, password-store and autofill
integration, WebAuthn/device permission UX, extension threat boundaries,
signed updates, release-channel infrastructure, sandbox verification on every
platform, crash reporting, and fuzz/integration coverage for the bridge and
session parser.

Public distribution also requires a full third-party license and trademark
review. Apache-2.0 covers Chroma's original source; it does not grant rights to
Arc, Zen, Chromium, Electron, or operating-system trademarks and assets.
The current dependency snapshot and release-notice work are recorded in
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Related evidence and status

- [`../README.md`](../README.md): runnable milestone and setup
- [`../DESIGN.md`](../DESIGN.md): current host design decisions
- [`PARITY.md`](PARITY.md): implemented capabilities and remaining work
- [`../TESTING.md`](../TESTING.md): automated gates and blocked manual GUI acceptance
- [`../UI_COMPARISON.md`](../UI_COMPARISON.md): self-regression visual evidence
- [`HISTORY-SPEC.md`](HISTORY-SPEC.md): history-service boundary
