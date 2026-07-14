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
- The current split model does not yet expose draggable ratios or all
  focused-pane semantics for fullscreen, capture, permissions, and PiP.
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

`layoutRects` computes one to four native rectangles. `BrowserController`
applies those bounds directly to the visible `WebContentsView` instances before
showing them. Page zoom and CSS `zoom` remain unchanged, normally at `1`.

Fit-to-width zoom was rejected because a fixed 1250 px desktop page scaled into
a roughly 586 px pane produces unreadably small text and is not equivalent to
responsive reflow. Arbitrary CSS injection was also rejected because selectors
and layout assumptions are site-specific and can break page behavior.

For three panes, the geometry is intentionally asymmetric: row/grid direction
uses a full-height left half plus stacked right quarters; column direction uses
a full-width top half plus two bottom quarters. Four panes form a 2-by-2 grid.
The active sidebar capsule mirrors that geometry at full capsule height. When a
different tab is active, the split group compacts to a single-row capsule so it
does not consume unnecessary sidebar height.

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
sidebar-overlay timers before native objects are destroyed.

## Verification strategy

- Unit tests cover layout, state repair, navigation normalization, and atomic
  persistence.
- The runtime smoke test launches an isolated Electron profile and exercises
  live navigation, new-tab search, workspace/folder creation, folder drag-in and
  drag-out, left/right tab merging, split reordering and detaching, active and
  compact capsule geometry, zero-width sidebar collapse, the rounded overlay's
  z-order, neutral split frames, responsive native bounds, sandbox isolation,
  tab cleanup, and clean window close.
- A local fixture returns a fixed-width desktop document for a desktop user
  agent and responsive markup for a mobile user agent. The smoke test verifies
  page zoom remains `1`, readable text is preserved, transitions reload only as
  expected, Stop is honored, stale probes cannot override explicit navigation,
  and unsplitting restores desktop mode.

## Change history

- 2026-07-14: Reframed the project as Chroma, an independent
  Chromium/Electron rewrite with Arc-inspired design language and Zen-informed
  workflows; documented active/full-height and inactive/compact split capsules.
- 2026-07-14: Defined the double baseplate, zero-width compact sidebar with a
  non-displacing rounded hover panel, neutral page focus treatment, and animated
  tab merge/reorder/detach gestures.
- 2026-07-13: Documented the runnable Electron host, versioned navigation and
  lifecycle model, pointer-based split interaction, and guarded responsive
  fallback. Rejected fit-to-width scaling after readability testing.
