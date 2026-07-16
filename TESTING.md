# Chroma Testing

This document separates automated evidence from manual acceptance for the
current Chromium/Electron rewrite. It records the evidence available on
2026-07-16; a later code, dependency, Electron, operating-system, or baseline
change requires the relevant gates to be rerun.

## Current evidence snapshot

| Gate | Current result | What it establishes |
|---|---:|---|
| `npm run check` | Passed | Syntax checks plus 125 Node tests: 125 passed, 0 failed, 0 skipped |
| `npm run window-lifecycle-smoke` | Passed | Eight concurrent startup URLs, one live window, failed-window cleanup, and queued-URL recovery |
| `npm run session-smoke` | Passed | Four launches against one profile, schema-6 topology restore, and persisted dark/light/system Appearance transitions |
| `npm run smoke` | Passed | The full isolated Electron runtime report completed with every reported capability flag set to `true` |
| `npm run verify` | Passed | The four gates above passed serially in the order defined by `package.json` |
| `npm run visual` | Passed | Seven Darwin/Electron-43 software-raster scenes matched Chroma's own baselines with zero pixel and geometry differences |
| `npm run package-smoke` | Passed | The unsigned macOS bundle satisfied its ASAR allow-list and started through the real packaged preload bridge |
| `npm audit --ignore-scripts` | Passed | npm reported 0 known vulnerabilities for the resolved lockfile snapshot |
| Unlocked, human-operated GUI acceptance | **Not completed** | The available Mac was locked and automatic unlock failed, so the real desktop interaction flow has not yet been accepted |

The 125-test count comes from `node --test test/*.test.mjs`. It is not a claim
that 125 user-visible features exist, and it is not a replacement for the
Electron or manual gates.

## `npm run verify`

`verify` is the required automated host gate and stops on the first failure:

```text
npm run check
  -> npm run window-lifecycle-smoke
  -> npm run session-smoke
  -> npm run smoke
```

### Static and unit gate

`npm run check` syntax-checks the main entry, controller, process-output guard,
and preload before running the Node test suite. The current 125 tests cover the
state schema and repair rules, navigation, history, downloads, command search,
split ratio trees, renderer/preload contracts, security boundaries, lifecycle
cleanup, Appearance, and atomic persistence. Passing this stage alone does not
prove that Electron can create a window or host a page.

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
verifies schema-6 workspace, tab, folder, split, and sidebar restoration; that
an external startup URL creates a tab without replacing restored topology; and
that dark, light, then system themes survive restarts with native color-scheme
propagation. It also restores the Reduce transparency value and Space colors.

### Runtime smoke

The runtime smoke starts the actual Electron host with deterministic local page
fixtures. Its report covers the bridge, navigation, command palette, bookmarks,
history, downloads, tab/workspace/folder lifecycle, split insertion/reorder/
detach and live ratios, native page bounds, adaptive narrow panes, sidebar
collapse/overlay, traffic lights, sandboxing, permission boundaries, output-pipe
failure handling, view destruction, and clean window close. Every boolean in the
current report was `true`.

This remains automation driven through Electron's debugging protocol. It does
not prove that a human can complete every gesture on an unlocked desktop.

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
`split-3-dark`, and `split-4-dark`. All seven have `diffPixels: 0`,
`diffRatio: 0`, and no geometry differences. See
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

The passing artifact is arm64, unsigned, unnotarized, and uses Electron's
default icon. This gate does not establish Developer ID signing, hardened
runtime, entitlements, notarization, Gatekeeper acceptance, installer quality,
updates, release-channel readiness, or third-party-notice completeness. The
inspected `.app` currently contains no project/Electron/Chromium license-notice
files, which is a public-release blocker documented in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Manual acceptance still required

The available macOS desktop was locked, and the automation layer reported that
automatic unlock could not unlock it. Consequently, the current milestone has
not received final human GUI acceptance for at least:

- launching the desktop window without a JavaScript error dialog;
- opening a public page such as Baidu and using the address/search flow;
- pointer tab sorting, folder moves, split creation, split reorder/detach, and
  real divider dragging;
- sidebar collapse, edge reveal, context-menu layering, and traffic-light hover;
- keyboard shortcuts and visible native theme/material behavior.

These items are **blocked on an unlocked desktop**, not declared passed by the
headless/runtime smoke. After unlock, rerun `npm run verify`, then perform and
record the manual flow on the build being accepted.

## Related documents

- [`README.md`](README.md): setup and current product scope
- [`DESIGN.md`](DESIGN.md): host and interaction decisions
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): Electron/direct-Chromium boundary
- [`docs/PARITY.md`](docs/PARITY.md): capability status and remaining work
- [`UI_COMPARISON.md`](UI_COMPARISON.md): current self-regression visual evidence
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md): dependency-license snapshot
