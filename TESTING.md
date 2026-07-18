# Chroma Testing

This document separates automated evidence from manual acceptance for the
current Chromium/Electron rewrite. `check`, `window-lifecycle-smoke`,
`session-smoke`, `smoke`, `performance`, and `verify` were rerun on
2026-07-18 after the schema-9 live-folder, split-ratio preset, bookmark
import/export, media-control, extension-popup, nested bookmark-folder,
bookmark drag-and-drop, hardware media-key, HTTP-auth prompt, MediaSession-artwork, site-information, Essential reset/unload, per-tab UA-override, bookmark
address-suggestion, per-container proxy, per-container User-Agent, and bookmark search/rename changes; `visual`,
`visual`, `package-smoke`, and `npm audit` were also rerun on 2026-07-18.
The visual baselines were intentionally reviewed and refreshed for the new
bookmark-search and live-folder rows before a clean comparison pass. Only the
unlocked desktop GUI acceptance session below still reflects 2026-07-16. A
later code, dependency, Electron, operating-system, or baseline change requires
the relevant gates to be rerun.

## Current evidence snapshot

| Gate | Current result | What it establishes |
|---|---:|---|
| `npm run check` | Passed | Syntax checks plus 314 Node tests: 314 passed, 0 failed, 0 skipped |
| `npm run window-lifecycle-smoke` | Passed | Eight concurrent startup URLs, one live window, failed-window cleanup, and queued-URL recovery |
| `npm run session-smoke` | Passed | Four launches against one profile, schema-13 topology restore, and persisted dark/light/system Appearance transitions |
| `npm run smoke` | Passed | The full isolated Electron runtime report completed with every reported capability flag set to `true` |
| `npm run performance` | Passed | Local-fixture startup and one/eight-tab process-tree RSS remained below every configured ceiling |
| `npm run verify` | Passed | The five host gates above passed serially in the order defined by `package.json` |
| `npm run visual` | Passed (2026-07-18) | Seven Darwin/Electron-43 software-raster scenes passed with zero changed pixels and no geometry differences after the reviewed baseline refresh |
| `npm run package-smoke` | Passed (2026-07-18) | The unsigned macOS bundle satisfied its ASAR allow-list, branded-icon and license-resource checks, then started through the real packaged preload bridge |
| `npm audit --ignore-scripts` | Passed (2026-07-18) | npm reported 0 known vulnerabilities for the resolved lockfile snapshot |
| Unlocked desktop GUI acceptance | **Partial** (2026-07-16) | The packaged app launched without a JavaScript-error dialog, completed new-tab search and direct address navigation to Baidu, and passed sidebar collapse, edge reveal, overlay, and restore checks while the live page remained visible |

The current 314-test count comes from `node --test test/*.test.mjs`, up from
245 after adding live-folder, split-ratio preset, bookmark import/export,
media-control, and extension-action-popup coverage.
It is not a claim that 314 user-visible features exist, and it is
not a replacement for the Electron or manual gates. An earlier schema-6/
Appearance checkpoint recorded 125/125; that number is retained here only as
historical evidence and is not the current suite result.

## `npm run verify`

`verify` is the required automated host gate and stops on the first failure:

```text
npm run check
  -> npm run window-lifecycle-smoke
  -> npm run session-smoke
  -> npm run smoke
  -> npm run performance
```

### Static and unit gate

`npm run check` syntax-checks the main entry, controller, process-output guard,
and preload before running the Node test suite. The current 314 tests cover the
state schema and repair rules, navigation and fixed search-provider policy,
history, downloads, command search, page zoom, startup-policy core, split ratio
trees, folder and pinned/Essential invariants (including Essential saved-page
capture/reset/clearing and unload-revive), bookmark-folder topology repair
(including nested-parent cycle breaking and depth capping) and controller
commands (nested create/move/delete with descendant and depth guards), Netscape bookmark HTML serialization/parsing and
import/export commands (folder reuse, duplicate skip, unsafe-link drop), container sanitization/partition isolation/deletion/proxy policy (rule normalization, per-partition `setProxy` application, launch reapply, and delete-time reset)/user-agent policy (printable-ASCII normalization, live-member re-identification with per-tab override precedence, and new-view inheritance)/
reopen-in-container commands, per-origin site-data clearing scoped to the
tab's own partition, per-tab UA-mode overrides (pin/no-op/auto semantics,
discarded-tab refusal, close-time cleanup), extension-service registry/install/remove/
reload/boot-replay behavior, extension action-popup lifecycle (toggle,
Escape close, link-to-tab routing, root-escape rejection) and action-icon
embedding bounds (raster-only, in-root, size-capped), live-folder feed parsing/fetch bounds and
rate-limited refresh commands, split-ratio preset application/bounds,
media playback/PiP command contracts (user-gesture scripts, null collapse,
discarded/crashed-tab refusal) and now-playing tracking (media-tab registry,
MediaSession metadata and artwork-validation reads, closed-tab pruning,
hardware media-key
registration/release and recency-ordered targeting), HTTP-auth challenge
queuing (FIFO surfacing, credential pass-through bounds, double-answer and
teardown cancellation), manual tab unloading with view destruction and
selection restore, Glance preview lifecycle (open/close/promote, unsafe-URL
rejection, auto-close on tab switch), renderer/preload contracts,
workspace deletion/reorder/tab-movement invariants, exact shared shortcut
routing (including unavailable actions, overlay focus, and destroyed views),
renderer-crash recovery, the 512-tab Space-movement guard, security boundaries,
lifecycle cleanup, performance-report lifecycle/diagnostics, Appearance, and
atomic persistence.

Some of these are pure-core or source-contract tests; passing this stage alone
does not prove that Electron can create a window or host a page.

### Window lifecycle smoke

The lifecycle smoke starts real Electron processes against isolated profiles.
Its passing report records:

```json
{
  "concurrentUrls": 8,
  "singleWindow": true,
  "failedCreationCleanup": true,
  "queuedUrlsSurviveFailure": true
}
```

This specifically protects the second-instance queue, single-window ownership,
and recovery after an injected creation failure.

### Session smoke

The session smoke launches Chroma four times with one temporary profile. It
verifies schema-8 workspace, tab, folder, split, and sidebar restoration; that
an external startup URL creates a tab without replacing restored topology; and
that dark, light, then system themes survive restarts with native color-scheme
propagation. It also restores the Reduce transparency value and Space colors.
The final state contained two restored folders and one restored split group at
schema 8.
The current folder-specific report records
`restoredEmptyFolder`, `restoredFolderMembership`,
`removedFolderStayedDeleted`, and
`folderDeletePreservedTabAndSplitTopology` as `true`; folder deletion preserves
the contained tab and its split topology while the removed container stays
deleted after restart.

### Runtime smoke

The runtime smoke starts the actual Electron host with deterministic local page
fixtures. Its report covers the bridge, navigation, command palette, bookmarks
and bookmark folders (create/rename/delete, move-in/move-out, delete-ungroups,
remove-cleans-membership, rename with trim/cap/blank rejection, sidebar search filtering titles and URLs into a flat cross-folder result list with Escape-to-clear), bookmark export to a parseable Netscape HTML file
and import that recreates a nested folder tree while skipping an
already-saved URL, with folder move-to-top and self-parent rejection
verified live, pointer drag-and-drop filing a bookmark into a folder (with
drop-target highlight asserted mid-drag) and nesting a folder into another, live folders (created from a local RSS fixture,
feed-title adoption, item rendering and open-as-tab, immediate re-refresh
rejected by the rate limit, persisted items on disk, rename and delete
reflected in the sidebar), containers (create/rename/delete through the
bridge, per-container partition isolation proven by same-origin localStorage
staying invisible across partitions, reopen-in-container replacing a live tab
under the container partition, container tab indicator UI, tab closure
and persistence on delete), unpacked-extension install/remove with a real
MV3 content script observed executing and then no longer executing, its
action popup opened and closed as a real chrome-extension:// target with a
data-URI icon button rendered in the sidebar toolbar, manual
tab unloading with dimmed sidebar state and live-view restoration on
selection, a Glance preview loading as a real page target without a tab
record and promoting into the active tab, media playback toggled on a real
captureStream video with MediaSession title/artist/artwork surfaced through the
now-playing query and popover thumbnail, with clean null reporting on
media-free pages,
a never-visited imported bookmark surfacing as the star-tagged first
suggestion under the search row for a title query (a URL absent from
history, so the row can only come from the bookmark store),
a container-pinned SOCKS proxy routing container traffic into a local TCP
probe and releasing it when the rule is cleared (with the invalid-scheme
rejection and containers-menu badge asserted alongside),
a container-pinned User-Agent surfacing verbatim in a page that titles
itself from navigator.userAgent, persisting to disk, and reverting to the
default identity when cleared,
Request-mobile-site pinning a mobile identity through the real tab menu
(fixture titles prove the UA change and the return to automatic), the
Essentials context menu resetting a navigated-away Essential to its
saved page and unloading it with a dimmed grid item and live revival on
selection, the site-information popover reporting an unencrypted fixture and its
confirmed clear-site-data wiping localStorage (proven by the reloaded
page's title), an HTTP Basic 401 challenge answered through the real shell dialog (title
proves the Authorization header arrived) and a cancelled challenge showing
the server's error page, history, downloads, tab/workspace/folder lifecycle, split insertion/reorder/
detach and live ratios plus preset application with out-of-bounds rejection,
native page bounds, adaptive narrow panes, sidebar
collapse/overlay, traffic lights, sandboxing, permission boundaries, output-pipe
failure handling, view destruction, and clean window close. It now sends real
DevTools key events to both shell and page targets, proving that a valid
Primary+T creates exactly one tab, Primary+D reaches the active page command,
and an extra Shift does not leak into close-tab matching. It also verifies that
Primary+Shift+P stays unconsumed by the command palette.

The workspace lifecycle path moves an eligible tab through the real context
menu, reorders Space controls through drag/drop, confirms deletion with an
accurate closing-tab count, and verifies the removed workspace's tabs, folders,
split groups, native views, and persisted records are gone. The crash path uses
Electron's renderer-crash API through a smoke-only diagnostic boundary, asserts
that only the failed native pane is hidden, operates
the accessible Reload action, and verifies the same tab/URL returns without a
managed-view leak. Folder and pinned-tab flags additionally cover the empty
folder drop zone, bounded rename, explicit drag-in and drag-out, persistence,
Pinned and Essential host/UI guards, delete-without-closing-tab integrity,
popover/native layering, pinned persistence/reopen, and zero fatal startup
diagnostics. Every boolean in the current report was `true`.

This remains automation driven through Electron's debugging protocol. It does
not prove that a human can complete every gesture on an unlocked desktop.

### Performance smoke

The final `verify` stage launches a fresh Electron process against tiny local
fixtures and records process-launch shell readiness, first-page readiness, and
settled process-tree RSS with one and eight loaded tabs. RSS uses the median of five
samples after a one-second settling interval; process counts and peaks are
diagnostic. The current Darwin arm64 report (2026-07-17) records 570.9 ms
shell-ready, 770.3 ms first-local-page-ready, 719.7 MiB one-tab RSS, 1,319.5
MiB eight-tab RSS, and a 599.8 MiB delta. These are below the configured
20/25-second and 900/1,800/1,100-MiB ceilings.

The gate uses software rendering and `ps` process-tree sampling, and its local
fixture deliberately excludes real network and complex-site cost. It is a
regression alarm, not a production benchmark or cross-browser comparison. The
method, thresholds, complete samples, and interpretation limits are in
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md); the machine-readable result is
`artifacts/performance/report.json`. Report schema 1 overwrites stale success at
startup and finishes with an explicit passed/failed status, environment and Git
metadata, fatal-log matches, cleanup errors, and bounded failure diagnostics.

## Independent visual gate

Run:

```bash
npm run visual
```

The visual harness is deliberately outside `verify`. It composes the trusted
shell capture with the visible `WebContentsView` captures, compares exact
geometry, and runs `pixelmatch` at 1280×720, DPR 1, using each scene's declared
dark or light theme. The current
Darwin/Electron-43 report covers `expanded-dark`, `expanded-light`,
`collapsed-dark-hidden`, `overlay-dark`, `split-2-dark-60-40`,
`split-3-dark`, and `split-4-dark`. All seven passed with no geometry
differences; the largest raster difference was 57 pixels (`0.0062%`), well
below the `0.25%` ceiling. See
[`UI_COMPARISON.md`](UI_COMPARISON.md) for the exact baseline, actual, diff, and
manifest paths.

The maximum accepted diff ratio is 0.25%, with a pixel threshold of 0.1 and a
one-pixel geometry tolerance. GPU acceleration is disabled, so this gate does
not cover native vibrancy, Mica, operating-system shadows, compositor chrome,
or other platforms. Baselines can be replaced only deliberately:

```bash
CHROMA_UPDATE_VISUAL_BASELINES=1 npm run visual:update
```

Review the generated images and geometry manifest before accepting an update.

## Independent package gate

Run:

```bash
npm run package-smoke
```

This rebuilds the local directory target, checks the bundle identifier and ASAR
runtime allow-list, rejects leaked development/user-state roots, launches the
packaged executable with a temporary profile, and calls
`window.chromaBrowser.getState()` through the packaged preload. The current
generated report is `artifacts/package/package-smoke.json`.

The passing report identifies `dist/mac-arm64/Chroma.app`, records 32 ASAR
entries and all 27 required entries, and confirms the current runtime allow-list
(including the extension, feed, bookmark-I/O, and shortcut modules), an available preload bridge,
one initial tab, Electron 43.1.0, and no fatal startup output. It also confirms
that the packaged original `build/icon.icns` is branded and has SHA-256
`986ff64959f96141dfd562ec2d2c8ffdc2fac51a054d3304f4991eb2aef41907`,
and that all five declared resources are present: `Chroma-LICENSE.txt`,
`Chroma-NOTICE.md`, `THIRD_PARTY_NOTICES.md`, `Electron-LICENSE.txt`, and
`LICENSES.chromium.html`.

The artifact remains arm64, unsigned, and unnotarized. This gate does not
establish Developer ID signing, hardened runtime, entitlements, notarization,
Gatekeeper acceptance, installer quality, updates, release-channel readiness,
a frozen-artifact SBOM, or legal completeness of the notice set. Those release
boundaries are documented in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Desktop acceptance and remaining manual work

On 2026-07-16 the unlocked macOS desktop was operated through Computer Use
against `dist/mac-arm64/Chroma.app`. The packaged app opened without a
JavaScript-error dialog. A query entered on Chroma's new-tab page produced live
Google results, and the shell address bar then navigated directly to
`https://www.baidu.com`; the Baidu title, URL, and page content all loaded in
the embedded Chromium surface. Collapsing the docked sidebar left the Baidu
page visible at the expanded viewport, the left-edge control revealed the
rounded non-displacing overlay, and the overlay control restored the docked
sidebar.

This is concrete packaged-GUI evidence, but it is not a claim of complete
human acceptance. A future release candidate still needs recorded real-pointer
and keyboard coverage for:

- tab sorting, folder drag-in/drag-out, split creation, split reorder/detach,
  and divider dragging;
- context-menu layering and per-control traffic-light hover behavior;
- visible native keyboard/menu behavior and native theme/material behavior
  (the shared shortcut router itself is covered by unit tests and CDP input);
- the corresponding Windows/Linux builds and signed/notarized macOS artifact.

Those remaining gestures are not declared passed by the headless/runtime smoke
or by the partial desktop session above. Rerun `npm run verify`, the visual
gate, and the packaged-GUI checklist on the exact artifact being accepted.

## Related documents

- [`README.md`](README.md): setup and current product scope
- [`DESIGN.md`](DESIGN.md): host and interaction decisions
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): Electron/direct-Chromium boundary
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md): startup/RSS method and current report
- [`docs/PARITY.md`](docs/PARITY.md): capability status and remaining work
- [`UI_COMPARISON.md`](UI_COMPARISON.md): current self-regression visual evidence
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md): dependency-license snapshot
