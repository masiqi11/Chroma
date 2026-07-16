# Chroma Host Design

This document records design decisions for the current runnable
Chromium/Electron implementation. The wider host and browser-service roadmap is
described in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Product provenance

Chroma uses an Arc-inspired visual language and studies Zen Browser's workflows
as product references. It does not migrate or wrap the Zen Firefox codebase.
The renderer, state model, interaction logic, Electron host, and tests in this
repository are an original rewrite, and no Arc or Zen source code or branded
asset is included.

## Goals

- Keep Chroma's product UI and domain model independent from the Electron host
  and from any future direct Chromium integration.
- Render each visible tab as a real, isolated Chromium page surface.
- Preserve normal web layout semantics in split panes: a page receives the
  pane's actual viewport and its text is not scaled down to fit.
- Make navigation, workspaces, folders, drag splitting, and process cleanup
  deterministic enough for automated runtime verification.
- Keep privileged browser capabilities behind a small, allow-listed bridge.
- Make expanded, compact, and split states feel like one coherent baseplate
  rather than separate toolbars layered around the page.

## Non-goals

- Pixel-for-pixel copying of Arc or Zen is not a goal, and their names, logos,
  fonts, icons, source, and other brand assets are outside this repository.
- Electron does not provide complete Chrome extension or browser-service
  compatibility, so the current host does not claim production-browser parity.
- Chroma does not rewrite arbitrary site CSS to manufacture responsiveness.
- The current split model does not yet expose all focused-pane semantics for
  fullscreen, capture, permissions, and PiP.
- The automatic narrow-pane response mode is not yet a persisted user setting.

## Main design choices

### Native page surfaces instead of webviews in the shell DOM

Each tab owns a sandboxed `WebContentsView`. The shell renderer receives only
serializable state and commands, while page processes have no access to the
shell preload. This is more primitive than integrating directly with
Chromium's `TabStripModel`, but it gives the milestone real Chromium navigation
and process isolation while keeping the Chroma product layer host-neutral.

Alternatives considered:

- `<webview>` elements would simplify DOM layout but weaken the intended host
  boundary and introduce additional embedder lifecycle behavior.
- A direct Chromium browser-layer integration provides a larger production
  surface, but its checkout, build, and maintenance costs are substantially
  higher than this development host.

### Split panes resize the viewport; they do not shrink the page

Introduced in schema 5 and retained by the current schema-6 profile, each split
group is stored as a bounded binary ratio tree: leaves identify the one-to-four
panes, while internal nodes carry a row/column direction and a ratio clamped to
20–80%. `splitLayoutRects` resolves that tree into native rectangles and
divider geometry. `BrowserController` applies those bounds directly to the
visible `WebContentsView` instances before showing them. Page zoom and CSS
`zoom` remain unchanged, normally at `1`.

Fit-to-width zoom was rejected because a fixed 1250 px desktop page scaled into
a roughly 586 px pane produces unreadably small text and is not equivalent to
responsive reflow. Arbitrary CSS injection was also rejected because selectors
and layout assumptions are site-specific and can break page behavior.

For three panes, the topology is intentionally asymmetric: row/grid direction
uses one full-height left branch plus two stacked right branches; column
direction uses one full-width top branch plus two bottom branches. Its default
ratios produce a half plus two quarters. Four panes use a 2-by-2 topology, with
actual extents determined by the stored ratios. The active sidebar capsule
mirrors that geometry at full capsule height. When a different tab is active,
the split group compacts to a single-row capsule so it does not consume
unnecessary sidebar height.

Dragging a pane divider updates the shell frame and capsule immediately and
sends a sanitized, non-durable preview to the owning controller. The controller
keeps preview trees outside profile state while applying their native page
bounds. Pointer release commits one `split:set-ratio` command; cancellation,
lost capture, or window blur discards the preview and restores the persisted
tree. Keyboard arrows and Home/End use the same clamped commit path. Pane swaps
replace leaf assignments without changing the tree's geometry.

### Fixed-width narrow pages use a guarded mobile-response fallback

Responsive sites simply react to their real pane width. For a horizontal/grid
split narrower than 960 px, the host probes the loaded document after a short
settling delay. It changes only that tab to an Android Chromium user agent when
all of the following are true:

- the page is HTTP(S), visible, and no longer loading;
- it has no viewport meta declaration;
- horizontal overflow is at least 1.28 times the viewport and 160 px wider.

The tab reloads once so a site with a mobile response can return readable
markup. The mode follows the response when the main document commits, but the
transition remains pending until loading stops. Failure or an explicit Stop
before commit rolls back both state and the per-page user agent and suppresses
automatic retries for that unchanged URL/pane signature. If the pane direction
changes mid-load, the inverse reload waits until the current load stops.
Leaving the narrow split restores every tab in the group to the desktop user
agent.

The fallback keeps scale at `1`; it does not use device emulation. Per-tab state
carries an epoch, navigation version, URL, and view identity through each
asynchronous probe. Every value is revalidated after page JavaScript executes,
and pending timers are invalidated on navigation, hiding, tab destruction, and
window teardown. These checks prevent reload loops and destroyed-object access.

The probe uses a constant source string with no URL, title, or page-controlled
interpolation and returns only numbers and booleans. It does not mutate the
document or add a renderer IPC command. Sandboxing, context isolation,
navigation filtering, and the existing permission policy remain unchanged.

Trade-offs and limitations:

- Switching between mobile and desktop responses requires a reload and may
  discard unsaved form state.
- Some sites ignore mobile user agents or depend on User-Agent Client Hints;
  those sites can remain fixed-width.
- No automatic heuristic can classify every wide table or canvas correctly. A
  future release should provide an explicit per-pane override.

### Pointer drag is owned by the shell

Tab sorting, folder movement, and split composition use pointer events rather
than HTML drag and drop. A drag begins only after a movement threshold.
Dropping a tab on the left or right half of another tab creates a split in that
order. Dragging a segment across another segment reorders the group; dragging a
segment outside the capsule invokes `split:detach`. Target geometry and order
are previewed during the gesture, while pointer-cancel, lost-capture, and window
blur paths restore clean state.

Address-bar window dragging uses the same threshold principle so a normal click
still focuses the omnibox. Folder headers and the ungrouped tab area are valid
drop targets, allowing tabs to move into and out of basic folders.

Split dividers use the same shell-owned pointer model, but preview through a
separate allow-listed channel so high-frequency movement never performs a
profile write. The stable divider path identifies the ratio-tree node, and only
the final ratio crosses the durable command boundary.

Workspace controls are a small, self-contained exception: accessible Space
buttons use roving tabindex plus Arrow/Home/End switching, and native drag/drop
to reorder the persisted sequence. The renderer calculates before/after
feedback, but the controller validates both IDs and commits the reorder without
changing active tabs or container topology. Keyboard reordering remains future
work.

Moving a tab across Spaces is explicit rather than an accidental side effect of
drag geometry. The context menu exposes only other Spaces and the controller
accepts only an ordinary ungrouped, unpinned, non-Essential, unsplit tab. If it
was the source Space's final tab, a replacement new tab is created first. At
the global tab cap that final-tab move is rejected rather than creating a 513th
record that persistence would truncate.

Confirmed Space deletion removes its complete tab/folder/split ownership in one
domain-state commit, chooses the next or previous Space deterministically when
the active Space is removed, and destroys the removed native views afterward.
The final Space cannot be deleted.

### Arc-inspired baseplate and compact sidebar

The shell is a double-layer baseplate rather than a toolbar placed beside a
frameless page. A docked 228 px sidebar and each web surface sit inside a shared
material. Web surfaces use neutral inset frames; focus is conveyed through
controls and state, not a persistent blue outline around the selected page.

Collapsing the sidebar reduces its layout width to exactly 0 px. The page keeps
the same live Chromium surface and expands into the released space; it is not
hidden or translated with the sidebar. An invisible left-edge target reveals a
228 px rounded floating panel above the page. The page behind it is not resized,
and leaving the reveal region restores a clean page edge. The panel is a sibling
`WebContentsView`, so its menus and drag previews remain above page contents.

The floating panel retains its rounded glass surface. Only the overlay
document's full rectangular backdrop is transparent; removing the foreground
panel would erase the intended depth and silhouette.

On macOS, inactive traffic lights are rendered as muted colored rings and each
button fills with its own system color on hover. Hovering one button must not
fill the entire group.

### Lifecycle and navigation are versioned

Initial navigation waits for the sandboxed blank document to become ready.
Every explicit navigation increments a per-tab version; stale startup or
delayed operations are ignored. Closing a tab detaches its native view, stops
in-flight work, and waits for `WebContents` destruction before completing.
Window shutdown drains the command queue and cancels adaptive-layout and
sidebar-overlay timers before native objects are destroyed. Main-process stdout
and stderr have narrow guards for `EPIPE` and `ERR_STREAM_DESTROYED`, so a test
harness or launcher closing its output pipe cannot turn a later renderer log
message into an uncaught exception. Other stream errors remain fatal instead of
being silently hidden.

### Crashed page recovery preserves the browser model

A page renderer failure is not treated as a tab or split deletion.
`render-process-gone` marks the tab crashed, cancels its adaptive work, and
hides only that pane's native view. In a split, healthy siblings remain live and
visible. The trusted shell draws an accessible Reload/Close recovery card above
the failed surface.

Reload clears the crash state and reuses a surviving `WebContents`. If Electron
has already destroyed it, the controller removes the stale view and creates a
new one for the same tab record. Both paths preserve the tab ID, URL, workspace,
folder, split membership, and ratio tree. Unknown or healthy tabs reject the
recovery command. This is renderer recovery, not production crash reporting or
dirty multi-window session restoration; those remain separate work.

### Persisted library topology is repaired as one graph

Folders and split groups reference workspace-owned tabs, so sanitizing each
array independently can preserve duplicate membership, cross-workspace links,
or colliding entity IDs. Schema load therefore runs a shared topology repair
after workspaces and tabs are normalized. Folder and split IDs share one
namespace; member order is stable; the first surviving owner keeps a duplicate
reference; invalid workspace links and split groups with fewer than two valid
tabs are removed. This makes a malformed profile recoverable without changing
a valid profile's ordering or active selection.

The schema-5 split slice additionally sanitizes each ratio tree against the
group's repaired membership. A valid tree retains its topology, pane order, and
clamped ratios. A missing, malformed, cyclic, over-deep, duplicate, or stale
tree falls back to the canonical two-to-four-pane topology, so invalid layout
data cannot resurrect removed tabs or escape the pane limit. Schema 6 preserves
that repair contract while adding Appearance preferences.

### Local bookmarks are deliberately a basic profile service

The current bookmark slice stores sanitized, de-duplicated HTTP(S) records in
the versioned profile model. The shell can star or unstar the active page and
renders persisted bookmarks in the sidebar with open and remove actions. This
is a usable local workflow, but it is not yet a full bookmark manager: folders,
import/export, richer metadata, and address-bar integration remain separate
work.

### History is profile data behind a query boundary

The bounded history object was introduced in schema 3 and remains present in
the current schema-6 profile, but complete entries are not ordinary shell state
broadcast after every navigation. The main-process history service owns
recording, retention, search, deletion,
preference changes, and persistence. The renderer receives bounded, validated
query results plus a revision/count/preferences summary. This keeps private
profile data out of unrelated renderer updates and allows a future
direct-Chromium host to replace the JSON implementation with Chromium
`HistoryService` without changing the product UI contract.

The shell-owned history panel is a browser surface, not page content. Opening
it preserves the current tab, uses the existing chrome-modal/native-view
coordination so websites cannot cover its controls, and closing it restores
the same page and focus. It supports keyboard access, date grouping, bounded
search, pagination, exact/selection deletion, and confirmed time-range or
all-time clearing. Recording, retention, and clear-on-exit preferences persist
behind the same service boundary. Internal `chroma:` pages, subframes, unsafe
schemes, credentials, and fragments are not recorded. Default retention,
migration, command, and privacy rules are defined in
[`docs/HISTORY-SPEC.md`](docs/HISTORY-SPEC.md).

### One shortcut registry owns browser chords

`src/shared/shortcut-registry.mjs` declares immutable action/chord records,
platform display labels, and application-menu accelerator labels. Primary maps
to Command on macOS and Control on Windows/Linux; literal Control remains a
separate modifier so Ctrl+Tab keeps its browser meaning on macOS. Matching is
exact: an extra Shift or Alt cannot trigger a less-specific command, and repeat,
composition, and key-up input are ignored. Electron's real Windows/Linux AltGr
normalization still requires platform acceptance and must not be inferred from
synthetic `altGraph` input alone.

The controller attaches the same Electron `before-input-event` router to the
shell, floating sidebar, and every page host. The shared action path covers
address focus, tab create/reopen/close/cycle, reload/hard reload, back/forward,
bookmarks, history, downloads, sidebar, workspace cycle, split create/remove,
page zoom, and developer tools. Application-menu accelerators are labels from
the same registry but use `registerAccelerator: false`, avoiding a second
dispatch path while the shell is focused. The renderer consumes the registry
for command-palette labels and does not maintain a competing browser-keydown
table.

Once an exact browser chord matches, the host consumes it even when its action
is currently unavailable—for example Back with no page history or Ctrl+Tab
with one tab—so browser-owned input does not leak into website JavaScript. The
entry point rejects commands during teardown, catches native-wrapper races, and
uses guarded `WebContents` access. History and Downloads invoked while the
floating sidebar is focused first retire that overlay before showing the main
shell surface.

### The command palette is shell-owned and explicitly adapted

`src/shared/command-search.mjs` owns the immutable catalog, Unicode/CJK
normalization, contextual enablement, and deterministic ranking. The trusted
shell renders the glass command surface and maps every result through an
explicit action adapter. It never forwards arbitrary catalog strings to the
preload bridge. The palette opens from the visible Commands control. It has no
default chord in the registry; in particular, `Cmd/Ctrl+Shift+P` is left
unconsumed for the Zen/Firefox private-window convention rather than being
repurposed. Private-window behavior itself is not implemented in this
milestone.

### Downloads separate native lifetime from durable metadata

`src/main/download-service.mjs` owns native `DownloadItem` listeners and the
pause/resume/cancel/open/reveal/remove lifecycle. The controller exposes only
cloned snapshots through the existing allow-listed state and command boundary.
Active transfers never enter the profile file. The download slice was
introduced in schema 4 and remains unchanged through schema 6: it persists at
most 100 completed, cancelled, or interrupted records, accepts only absolute
save paths, and strips URL credentials and fragments. Closing a controller
removes its persistent Session listener, flushes terminal metadata, and
detaches every native-item listener before the state store closes.

### Appearance is persisted shell state, not page styling

Schema 6 adds `settings.appearance` with two sanitized fields: `theme` is one
of `system`, `light`, or `dark`, and `reduceTransparency` is a boolean. Invalid
or older profile values fall back to `system` and `false`. Space color continues
to live on each workspace; the Appearance form saves the current workspace's
strict six-digit hex color together with the global appearance settings in one
validated controller command.

The main process applies the restored theme before page views are created.
Electron `nativeTheme` supplies system following and propagates the selected
light/dark color scheme to Chromium, while the host updates the native window
background. The trusted renderer derives its tokens, accent, and form state
from the same public state. Reduce transparency disables Chroma shell backdrop
filters and substitutes opaque rounded baseplate, popover, modal, and floating
sidebar materials. It deliberately leaves page `WebContentsView` content and
site CSS untouched, and it does not remove the rounded floating-sidebar
silhouette.

This is an application preference, not automatic mirroring of the macOS Reduce
Transparency accessibility setting. Electron's theme source is process-wide,
so independent per-window themes remain future multi-window work. Runtime smoke
validates the Appearance form, native color-scheme propagation, reduced-shell
styling, active-Space accent, and profile-file persistence; it does not certify
pixel identity, native vibrancy, or Windows/Linux material rendering.

### Performance is gated with deterministic local fixtures

`scripts/performance-smoke.mjs` launches the real Electron host with a new
temporary profile and loopback `no-store` pages. It gates process-launch shell
readiness, first-local-page readiness, settled one-tab process-tree RSS,
settled eight-tab RSS, and their delta. RSS is the median of five `ps` samples
after a one-second settle, with peaks and descendant-process counts retained
for diagnosis. The host's managed-view count, not Chromium's same-origin
process count, is the tab ownership invariant.

This is deliberately a regression ceiling rather than a marketing benchmark.
The smoke configuration disables hardware acceleration, local fixtures exclude
network and complex-site cost, and the `ps` sampler currently supports macOS
and Linux only. GPU/native-material cost, Windows, CPU, energy, interaction
latency, tab discard, and long-session leak profiling remain outside the gate.
The exact thresholds, current measurements, and interpretation limits are in
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

### Local packaging has an explicit, independently tested boundary

`electron-builder.yml` packages only `package.json` and the runtime-owned
`src/main`, `src/preload`, `src/renderer`, and `src/shared` trees into ASAR.
Repository tests, smoke harnesses, generated artifacts, documentation, and
local `browser-state.json` data remain outside that allow-list. The package
smoke test reads the produced ASAR, asserts every required host/preload/shell/
shared-service entry, rejects development and user-state roots, and then starts
the packaged executable against an isolated temporary profile. A successful
DevTools connection and `window.chromaBrowser.getState()` call prove that the
packaged main entry, renderer document, preload bridge, and browser controller
cross their real bundle boundaries without fatal startup output.

The checked-in macOS target is deliberately local and unsigned:
`CSC_IDENTITY_AUTO_DISCOVERY=false`, `identity: null`, hardened runtime off,
and notarization off. It creates directory, DMG, and ZIP targets whose names
include `unsigned`. The macOS target configures the original checked-in
`build/icon.icns`; package smoke verifies the bundled `icon.icns` against its
source SHA-256 and requires `branded: true`. A production build must still use
a separate reviewed override that enables Developer ID signing, hardened
runtime, entitlements, notarization, update metadata, and release provenance;
passing the local package smoke is not evidence that those distribution
controls exist.

`extraResources` keeps five license resources directly readable outside ASAR:
Chroma's license and notice, `THIRD_PARTY_NOTICES.md`, Electron's license, and
the matching Chromium-generated credits file. Package smoke requires all five.
This is a concrete improvement over a bare startup artifact, but it is not a
frozen-artifact SBOM or a legal determination that every shipped component,
asset, exception, and attribution has been covered.

Packaging startup evidence is documented in [`TESTING.md`](TESTING.md); the
dependency-license snapshot and public-release notice work are tracked in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Verification strategy

Commands, current results, the partial packaged-GUI acceptance, and the
remaining real-pointer/keyboard checklist are recorded in
[`TESTING.md`](TESTING.md). Exact visual baseline and diff paths are listed in
[`UI_COMPARISON.md`](UI_COMPARISON.md).

- `npm run check` is the fast static/unit gate. It covers ratio-tree geometry,
  schema-6 state repair and migration, Appearance sanitization and command/host
  contracts, history and download service operations,
  bookmark sanitization, topology repair, command search/ranking, navigation
  normalization, workspace lifecycle, exact shortcut matching, crashed-tab
  recovery, bridge command contracts, process-output guards, and atomic
  persistence. It does not launch Electron and is not evidence that the browser
  window or page host runs successfully.
- The runtime smoke test launches an isolated Electron profile and exercises
  live navigation, new-tab search, command-palette CJK search/execution,
  bookmark star/open/remove/persistence, live download
  pause/resume/cancel/UI/terminal persistence, the
  history panel/search/deletion/range clearing/preferences/privacy contract,
  Appearance UI, native-theme propagation, reduced-transparency behavior and
  disk persistence, workspace/folder creation, workspace reorder/delete/tab
  movement, folder drag-in and drag-out, left/right tab merging, split
  reordering and detaching, live divider preview, durable ratio persistence,
  active and compact capsule geometry, exact shell/page shortcut input,
  renderer-crash recovery, zero-width sidebar collapse, the rounded overlay's
  z-order, neutral split frames, responsive native bounds, sandbox isolation, a
  deliberately closed output pipe, tab cleanup, and clean window close.
- A local fixture returns a fixed-width desktop document for a desktop user
  agent and responsive markup for a mobile user agent. The smoke test verifies
  page zoom remains `1`, readable text is preserved, transitions reload only as
  expected, Stop is honored, stale probes cannot override explicit navigation,
  and unsplitting restores desktop mode.
- `npm run session-smoke` performs four launches against one isolated profile.
  It verifies workspace/tab/folder/split/sidebar restoration, proves that an
  external startup URL creates one additional active tab without replacing the
  restored topology, and restores persisted dark, light, then system
  Appearance states with native color-scheme propagation.
- `npm run window-lifecycle-smoke` exercises concurrent second-instance URLs,
  single-window ownership, failed-window cleanup, and FIFO recovery of queued
  URLs after an injected creation failure.
- `npm run verify` is the complete release gate. It serially runs `check`,
  `window-lifecycle-smoke`, `session-smoke`, the full runtime `smoke`, and
  `performance`, and stops at the first failure.
- `npm run performance` launches a separate isolated profile against local
  fixtures, gates shell/first-page readiness and one/eight-tab process-tree RSS,
  rejects known fatal output, and writes
  `artifacts/performance/report.json`. It is a software-rendered macOS/Linux
  regression gate, not a real-site, Windows, GPU, CPU, energy, or long-session
  benchmark.
- `npm run package-smoke` is the separate local bundle gate. It rebuilds the
  unsigned directory target, verifies the ASAR boundary and bundle metadata,
  launches the packaged executable, and fails on missing bridge state or known
  fatal startup diagnostics. It intentionally does not claim signing,
  notarization, installer, updater, or Gatekeeper acceptance.
- `npm run visual` is the deterministic renderer gate. It layers the shell and
  visible `WebContentsView` captures, then compares geometry and PNG pixels for
  seven expanded, collapsed, overlay, light/dark, and two-to-four-pane scenes.
  Current baselines are
  Darwin/Electron-43 software-raster references; native compositor materials
  and other platforms need separate baselines and acceptance.

## Change history

- 2026-07-16: Added host-validated Space deletion/reordering/eligible-tab
  movement, shell-owned crashed-pane recovery that preserves tab topology, and
  one exact platform-aware shortcut registry for shell/page/overlay input,
  menu labels, and command labels. Added a deterministic startup/RSS gate to
  `verify` with a checked machine-readable performance report.

- 2026-07-16: Hardened page-state and permission boundaries with bounded
  IDs/tabs/URLs/favicons, credential-free durable URLs, redacted navigation
  failures, microphone/camera scope separation, and fail-closed teardown.

- 2026-07-16: Added an explicit electron-builder runtime allow-list and a
  reproducible unsigned macOS package smoke that inspects ASAR contents and
  launches the packaged executable through the preload bridge. Added an
  original Chroma icon plus directly readable Chroma, Electron, and Chromium
  notice resources; release signing, notarization, updater metadata, SBOM, and
  legal review remain separate work.

- 2026-07-16: Bumped profile persistence to schema 6, added validated
  system/light/dark Appearance preferences, active-Space color editing, and a
  reduced-transparency shell mode, and covered runtime and disk propagation
  without styling page content.

- 2026-07-16: Connected the split ratio tree to native page bounds and the
  full-height active capsule, added shell-local and main-process live previews,
  committed one clamped ratio on pointer/keyboard completion, persisted layouts
  in schema 5, and covered preview-versus-durable behavior in Electron smoke.

- 2026-07-16: Connected the tested download service to Electron's persistent
  Session, added real lifecycle controls and a shell-owned downloads popover,
  bumped profile state to schema 4 for bounded terminal metadata, and covered
  the complete flow in runtime smoke. Detached command errors and Session
  listeners now close cleanly with their window controller.

- 2026-07-16: Connected the tested command-search core to a shell-owned,
  keyboard-accessible glass command palette and added page-focused opening,
  explicit action adapters, accessibility fallbacks, and Electron smoke
  coverage. Split groups now remain in one folder container both at runtime
  and after persisted-state repair.

- 2026-07-16: Implemented schema-3 history behind a dedicated main-process
  service and trusted panel, including search, deletion, confirmed range clear,
  preferences, shortcuts, privacy filtering, and runtime smoke coverage.
- 2026-07-16: Added basic persisted local bookmarks, shared folder/split
  topology repair, narrow broken-output-pipe protection, and a four-launch
  session-restoration smoke test.
- 2026-07-16: Defined the complete history panel boundary, persistent visit
  schema, privacy/retention policy, query and deletion contracts, and runtime
  acceptance criteria in `docs/HISTORY-SPEC.md`.
- 2026-07-14: Reframed the project as Chroma, an independent
  Chromium/Electron rewrite with Arc-inspired design language and Zen-informed
  workflows; documented active/full-height and inactive/compact split capsules.
- 2026-07-14: Defined the double baseplate, zero-width compact sidebar with a
  non-displacing rounded hover panel, neutral page focus treatment, and animated
  tab merge/reorder/detach gestures.
- 2026-07-13: Documented the runnable Electron host, versioned navigation and
  lifecycle model, pointer-based split interaction, and guarded responsive
  fallback. Rejected fit-to-width scaling after readability testing.
