# Chroma History Panel Specification

This document records the implemented contract for Chroma's local history
service and panel. It describes the current Electron host while keeping the UI
and command boundary portable to a future direct Chromium `HistoryService`
backend.

Chroma is an independent Chromium/Electron rewrite. Arc informs its design
language and Zen Browser informs workflow research; this contract is not a
migration of Zen's Firefox implementation.

## Baseline and scope

Chroma now uses profile state schema version 6. The bounded history object was
introduced in schema version 3 and retains stable visit IDs, a revision,
persistent preferences, and sanitized entries. Schema 4 added terminal download
metadata, schema 5 added split-layout ratio trees, and schema 6 added global
Appearance preferences while retaining Space color on each workspace; none of
those later slices changes this history contract. Full entries stay behind a
dedicated main-process service; ordinary public state exposes only the revision,
count, and normalized preferences.

The current Electron milestone implements:

- a shell-owned, searchable history panel grouped by local date;
- durable, individually addressable top-level visit records;
- deletion of selected visits and confirmed clearing by time range;
- bounded retention, recording controls, and clear-on-exit behavior;
- an allow-listed query/mutation contract that does not broadcast the complete
  history database with ordinary tab state;
- unit and Electron runtime-smoke coverage for persistence, privacy, and UI
  behavior.

It does not clear cookies, cache, passwords, permissions, downloads, bookmarks,
or site storage. Sync, cross-profile history, history import/export, semantic
search, and remote suggestions are separate milestones.

## Persistent model

The current implementation uses the profile's atomic Chroma state store. Any
future shape change must bump `STATE_SCHEMA_VERSION`. The canonical model is:

```js
history: {
  revision: 0,
  entries: [
    {
      id: "uuid",
      url: "https://example.com/path?query=value",
      title: "Example",
      visitedAt: 1784044800000,
      transition: "link"
    }
  ],
  preferences: {
    recordingEnabled: true,
    retentionDays: 90,
    clearOnExit: false
  }
}
```

Field rules:

| Field | Contract |
|---|---|
| `id` | Non-empty, profile-local stable ID; duplicates are regenerated during repair. |
| `url` | Canonical HTTP(S) URL with username, password, and fragment removed. Query parameters are retained. Maximum 8,192 characters. |
| `title` | Last committed title for this visit, trimmed to 500 characters; falls back to URL. |
| `visitedAt` | Finite Unix epoch milliseconds. Future values more than five minutes ahead are clamped to load time. |
| `transition` | One of `typed`, `link`, `form-submit`, `reload`, `redirect`, or `other`; unknown values repair to `other`. |
| `revision` | Non-negative integer incremented once for each committed append, edit, prune, remove, or clear transaction. |
| `recordingEnabled` | Stops future recording when false; it does not silently delete existing records. |
| `retentionDays` | One of `7`, `30`, `90`, `365`, or `0`; `0` means retain until the entry cap is reached. |
| `clearOnExit` | Clears history during orderly shutdown before the final state flush. |

The Electron JSON backend is capped at 10,000 entries even when
`retentionDays` is `0`. Pruning runs after load, after append, and when the
retention preference changes. Entries are ordered oldest-to-newest on disk;
queries return newest-first. The state file remains atomically replaced with
owner-only mode `0600`.

### Migration and repair

The old history array migrates deterministically:

1. Keep only valid HTTP(S) records, preserving their existing order.
2. Canonicalize and sanitize URLs and titles using the rules above.
3. Allocate a fresh ID per surviving record and set `transition: "other"`.
4. Use the existing finite `visitedAt`, otherwise the migration time.
5. Install the default preferences, prune by retention and cap, and set
   `revision` to `1` when any legacy item survives (otherwise `0`).

Malformed new-format entries are repaired independently; one bad entry must
not discard the profile. `stateForDisk` includes the repaired history object,
while `getPublicState()` exposes only `{ historyRevision, historyCount,
historyPreferences }`, not `entries`.

## Recording semantics

The main process is the only writer. Record a visit after a successful,
committed main-frame HTTP(S) navigation. Never record:

- subframe navigation;
- `chroma:`, `file:`, `data:`, `javascript:`, `blob:`, DevTools, extension, or
  external-application URLs;
- failed, aborted, interstitial, or uncommitted navigation;
- private/ephemeral profile activity when that mode is introduced;
- visits while `recordingEnabled` is false.

A single navigation version produces at most one record. Redirect chains
record only the final committed URL and mark the transition `redirect` when
known. A main-frame same-document navigation may record a new canonical URL
when the path or query changes; a fragment-only change does not. Reload is a
new visit with transition `reload`, but duplicate Electron events for the same
navigation version are suppressed.

Keep the created history ID and navigation version with the tab's transient
runtime metadata. A later title event may update only that exact record when
the tab, URL, and navigation version still match. A delayed title from another
page must never rename a previous or newer visit.

## Privacy and retention policy

- Defaults are recording on, 90-day retention, and clear-on-exit off.
- URL credentials and fragments are always stripped. Query strings are kept
  because they often identify the visited resource; the settings copy must
  explicitly warn that queries can contain sensitive values.
- Search executes locally in the main process. Queries, matches, cleared URLs,
  and titles are never written to console output, telemetry, crash annotations,
  or network requests.
- History is profile-global and is not copied between workspaces. Workspace and
  tab identifiers are deliberately not persisted in visit records.
- Deletion is durable after the state-store flush completes. Deleted entries
  disappear from both the panel and address suggestions immediately.
- `clearOnExit` applies only to an orderly exit. Crash recovery must run normal
  retention pruning on next load and must not claim a crash-time guarantee.
- A future direct Chromium backend must preserve these product defaults while
  using Chromium's profile database and deletion APIs.

## Command contract

The current allow-listed `commands` set exposes the following names. Payloads
are cloned by the preload, validated again in the main process, and handled
through the controller's serialized command queue.

### `history:query`

Payload:

```js
{
  query: "example",             // optional, trimmed, maximum 200 chars
  range: "all",                 // all | last-hour | last-day | last-week |
                                // last-four-weeks | custom
  from: 1784044800000,           // required only for custom, inclusive
  to: 1784131200000,             // required only for custom, exclusive
  cursor: "opaque-token",       // optional
  limit: 50                      // 1..100, default 50
}
```

Result:

```js
{
  items: [{ id, url, title, visitedAt, transition }],
  nextCursor: "opaque-token-or-null",
  hasMore: false,
  revision: 12
}
```

Matching is case-insensitive over title and URL after whitespace is collapsed.
Tokens use AND semantics. Results sort by `visitedAt` descending, then `id`
descending. The opaque cursor binds the last sort key, normalized query/range,
and history revision. A stale or mismatched cursor returns the structured error
code `HISTORY_CURSOR_STALE`; the renderer restarts from page one.

### `history:suggest`

Payload is `{ query, limit }`, with `query` capped at 200 characters and
`limit` at 10. It returns unique canonical URLs, newest match first, as
`{ items: [{ url, title, visitedAt }], revision }`. Empty query is allowed.
This replaces renderer-side scanning of the complete history array.

### `history:remove`

Payload is `{ ids: string[] }`. Accept 1 to 200 unique IDs. The operation is
idempotent and returns `{ removedCount, revision }`. Invalid shapes are
rejected without mutation; unknown valid IDs simply contribute zero removals.

### `history:clear`

Payload is `{ range, from?, to? }` using the same range semantics as query.
It returns `{ removedCount, revision }`. `range: "all"` is valid only after the
renderer has shown and accepted an explicit confirmation. The main process
still validates the request but does not trust a renderer-provided
`confirmed` boolean as an authorization boundary.

### `history:set-preferences`

Payload may contain any subset of `{ recordingEnabled, retentionDays,
clearOnExit }`. Unknown keys and unsupported values are rejected. It returns
the normalized preferences and `{ prunedCount, revision }`. A retention change
and its pruning are one transaction.

Mutation commands publish one ordinary state update containing only the new
summary. Query/suggest do not publish state. Renderer callers treat controller
shutdown as a normal cancellation and never retry mutation automatically.

## Panel UI and interaction

The history panel is rendered by the trusted shell and coordinated as chrome
modal content, so page `WebContentsView` instances cannot cover it. Opening the
panel does not navigate, close, resize, or replace the active tab. Closing it
returns to the same active page and restores focus sensibly.

Entry points:

- a History item in the sidebar/library surface;
- macOS `Cmd+Y`; Windows/Linux `Ctrl+H`.

A native application-menu entry and a full preference editor are future shell
polish; the current preference contract is available through the validated
service/bridge and its state summary.

Layout and behavior:

- Header: `History`, search field, recording-state indicator, and `Clear…`.
- Body: newest-first rows grouped by local calendar labels (`Today`,
  `Yesterday`, then localized dates). Each row shows favicon fallback, title,
  origin/path, local time, checkbox, and a remove action.
- Footer/action bar: appears while selection is non-empty and reports the exact
  count with `Delete` and `Cancel selection` actions.
- Search starts after a 150 ms debounce; Enter runs immediately. Paging loads
  the next 50 results near the list end without changing scroll position.
- Clicking a row opens its URL in a new tab through existing `tab:create` and
  leaves the current tab intact. Keyboard activation behaves identically.
- `Clear…` opens an in-shell dialog for last hour, last 24 hours, last 7 days,
  last 4 weeks, all time, or a custom interval. The dialog states that only
  browsing history is affected. All-time clearing requires a second explicit
  confirmation action.
- Escape clears selection, then search, then closes the dialog/panel in that
  order. Focus is trapped only while the clear dialog is open.

Use semantic list/checkbox/button markup, visible keyboard focus, announced
result counts, and a live status message after deletion. Titles and URLs must
be inserted as text, never trusted HTML.

### Renderer state machine

The panel has explicit `closed`, `loading`, `ready`, `loading-more`, `mutating`,
`empty`, and `error` states. Keep `queryToken`, `revision`, `nextCursor`,
`selection`, and `items` as transient renderer state.

- A newer query token discards every older response.
- Changing query or range clears selection and pagination.
- Mutation controls are disabled while a mutation is in flight.
- On success, remove affected rows, announce the result, and refetch page one
  if revision changed or the current page became empty.
- On failure, retain the visible rows and selection, show a retryable inline
  error, and never claim deletion succeeded.
- `HISTORY_CURSOR_STALE` silently restarts the current query from page one.
- Opening with zero records renders an empty state; zero search matches render
  a distinct no-results state with a clear-search action.

## Implemented components

1. **Model and migration:** `src/shared/model.mjs` owns the history
   object, legacy migration, sanitization, retention, cap, revision, and public
   summary projection.
2. **Main service:** `src/main/history-service.mjs` owns recording,
   delayed-title/version safety, query, suggestions, removal, range clearing,
   preference updates, pruning, and cursor validation.
3. **Bridge:** five allow-listed history commands cross the preload boundary;
   address suggestions use `history:suggest`, and full entries are absent from
   broadcast state.
4. **Panel:** the trusted shell provides search, date grouping, pagination,
   selection, individual removal, the range-clear dialog, accessibility states,
   shortcuts, and native-view coordination.
5. **Verification:** model/service/preload unit tests and the isolated Electron
   runtime smoke cover the current contract. The four-launch session smoke
   independently covers general profile and Appearance restoration.

## Current verification coverage

Unit/model tests prove:

- legacy migration, malformed-record repair, ID uniqueness, safe URL
  canonicalization, credential/fragment stripping, title limits, and ordering;
- 7/30/90/365-day and unlimited retention, the 10,000-entry cap, future-time
  clamping, revision increments, and atomic clear/preference transactions;
- query tokenization, deterministic pagination, stale cursor rejection,
  time-range boundaries, unique suggestions, and idempotent removal;
- main-frame-only recording, navigation-version deduplication, redirect/reload
  transitions, and stale-title rejection;
- `getPublicState()` and state-change messages contain no history entries.

The isolated Electron runtime smoke currently:

1. Navigates through distinct fixture URLs and verifies committed titles,
   newest-first querying, disk persistence, and public-state redaction.
2. Opens History from the platform shortcut, preserves the active tab, hides
   native page surfaces behind the chrome-modal panel, and verifies date-group
   rendering.
3. Searches by title and URL, clears the query, deletes a visit, and verifies
   that the deleted record also disappears from address suggestions.
4. Clears a custom range, requires the second all-time confirmation, and proves
   tab state remains intact.
5. Disables and resumes recording through persistent preferences, and verifies
   fragment-only navigation does not create another visit.
6. Exercises privacy filtering and persistence while keeping full visit entries
   out of normal renderer state.
7. Closes the panel and verifies the original page and native bounds are
   restored without a main-process exception.

The smoke report exposes passing booleans named `historyPanel`, `historySearch`,
`historyDelete`, `historyClearRange`, `historyPersistence`, and
`historyPrivacyPolicy`. `npm run session-smoke` adds a separate four-launch check
for persisted browser topology, startup URL handling, and schema-6 Appearance
transitions. Run the complete host gate with:

```bash
npm run verify
```

The current results and manual acceptance boundary are recorded in
[`../TESTING.md`](../TESTING.md).

A future Chromium `HistoryService` backend must rerun this same product-level
contract and add database migration, crash recovery, multi-profile, and sync
coverage appropriate to that host.
