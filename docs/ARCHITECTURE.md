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

- `src/shared/`: navigation normalization, schema-13 state and topology repair,
  split ratio trees, Appearance sanitization, command names, exact shortcut
  definitions, and command search. These modules are host-neutral.
- `src/renderer/`: Chroma interface. It calls only
  `window.chromaBrowser` and does not import Electron.
- `src/preload/`: allow-listed IPC adapter. It validates command names and
  copies payloads across the context-isolated boundary.
- `src/main/browser-controller.mjs`: Electron adapter for tabs, workspaces,
  folders, split groups, navigation, permissions, history/download services,
  Appearance, responsive pane handling, shortcut dispatch, crashed-pane
  recovery, and view lifecycle.
- `src/main/feed-service.mjs`: dependency-free RSS/Atom parsing and bounded,
  credential-free feed fetching for live folders.
- `src/main/state-store.mjs`: atomic, schema-versioned development-session
  persistence.
- `scripts/runtime-smoke.mjs`: end-to-end host conformance test.
- `scripts/performance-smoke.mjs`: isolated startup and one/eight-tab
  process-tree RSS regression gate. The lifecycle, session, visual, and package
  smoke scripts cover separate boundaries; see
  [`../TESTING.md`](../TESTING.md).

## Host-owned workspace, recovery, and shortcut transitions

Workspace mutations cross the same allow-listed command bridge as tab and
split operations. Reordering changes only the persisted workspace sequence.
Moving a tab accepts only an ordinary ungrouped, unpinned, non-Essential,
unsplit tab; if it was the source Space's final tab, the controller creates a
replacement before the move. At the global tab cap that replacement-requiring
move is rejected so the live and persisted models cannot diverge. Deleting a
Space rejects the last remaining Space, removes every owned tab/folder/split in
one state commit, selects a deterministic adjacent fallback when necessary,
and then destroys only the removed native views. The renderer owns
gesture/confirmation state, not domain mutation rules.

`render-process-gone` marks the owning tab crashed and removes only that native
view from visible composition. The trusted shell renders the recovery card, so
failed page content cannot cover or impersonate it. Recovery reloads a live
`WebContents`; if Electron has already destroyed it, the controller creates a
new view for the same tab record. Tab ID, URL, workspace, folder, and split
membership therefore remain stable while healthy split siblings stay live.

`src/shared/shortcut-registry.mjs` is the single chord source for shell, floating
sidebar, page hosts, application-menu labels, and command-palette labels. The
controller listens to Electron `before-input-event` on each trusted and page
surface, performs an exact platform-aware modifier match, and invokes the same
host action router. Menu items set `registerAccelerator: false`; their displayed
accelerators come from the registry, but Electron does not register a second
global path that could double-dispatch a focused shell shortcut. The renderer
does not implement a competing browser-keydown chain. An exact browser chord is
consumed even when its action is unavailable, and the input boundary rejects
teardown work and guards native-wrapper races. Shell-owned panels requested
from the floating sidebar retire that overlay before opening in the main shell.

## Current-to-future Chromium mapping

| Host-neutral concept | Electron host today | Possible direct Chromium host |
|---|---|---|
| tab ID and lifecycle | `WebContentsView` map | `TabStripModel` plus stable Chroma metadata |
| page | Electron `webContents` | Chromium `content::WebContents` |
| split pane | native bounds from the persisted ratio tree | multiple BrowserViews/WebContents in a Chroma window view |
| shell bridge | context-isolated IPC preload | Mojo interface plus WebUI `PageHandler` |
| browser shortcuts | shared registry plus host `before-input-event` router | Chromium accelerator/command controller backed by the same Chroma action IDs |
| profile | Electron persistent `session` | Chromium `Profile` / `BrowserContext` |
| container | per-container persistent `session.fromPartition` isolation | `StoragePartitionConfig` with shared profile services |
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
9. Browser shortcuts must use exact modifier matching and one host action
   router; shell and page focus must not create duplicate dispatch paths.
10. A crashed page may hide only its own native pane, and recovery must preserve
   the owning tab's stable domain identity and container topology.
11. Mature browser services should be adapted from Chromium if a direct host is
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
- [`PERFORMANCE.md`](PERFORMANCE.md): performance-gate method, ceilings, and current report
- [`../UI_COMPARISON.md`](../UI_COMPARISON.md): self-regression visual evidence
- [`HISTORY-SPEC.md`](HISTORY-SPEC.md): history-service boundary
