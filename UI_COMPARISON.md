# Chroma UI Comparison Evidence

Chroma is a from-scratch Chromium/Electron rewrite. Its design language is
inspired by Arc and its workflow research is informed by Zen Browser, but this
repository does not use Arc or Zen source code, branded assets, or visual
baselines.

This document describes Chroma's **self-regression** evidence. It does not
measure or claim similarity to Arc, Zen, or any other browser.

## Capture contract

The current implementation baseline is Darwin with Electron 43.1.0 at
1280×720 and DPR 1, using the theme declared by each scene.
`scripts/visual-smoke.mjs` captures the shell and
each visible native page target separately, then deterministically composes
them into one image. It fixes the visual font stack to Arial/Helvetica and
disables motion. Geometry is checked alongside PNG pixels.

The report uses a 0.1 pixelmatch threshold, a maximum changed-pixel ratio of
0.25%, and a one-pixel geometry tolerance. Its generated machine-readable result
is `artifacts/visual/report.json`; baseline geometry is stored in
[`test/visual/baselines/darwin-electron43/manifest.json`](test/visual/baselines/darwin-electron43/manifest.json).

## Current Chroma baselines

| Scene | Chroma baseline | Current capture | Generated difference | Current result |
|---|---|---|---|---:|
| Expanded sidebar, dark, one page | [`expanded-dark.png`](test/visual/baselines/darwin-electron43/expanded-dark.png) | `artifacts/visual/expanded-dark.actual.png` | `artifacts/visual/expanded-dark.diff.png` | 0 changed pixels; no geometry differences |
| Expanded sidebar, light, one page | [`expanded-light.png`](test/visual/baselines/darwin-electron43/expanded-light.png) | `artifacts/visual/expanded-light.actual.png` | `artifacts/visual/expanded-light.diff.png` | 0 changed pixels; no geometry differences |
| Sidebar collapsed to zero visible width | [`collapsed-dark-hidden.png`](test/visual/baselines/darwin-electron43/collapsed-dark-hidden.png) | `artifacts/visual/collapsed-dark-hidden.actual.png` | `artifacts/visual/collapsed-dark-hidden.diff.png` | 0 changed pixels; no geometry differences |
| Floating dark sidebar overlay, composed from its independent overlay target | [`overlay-dark.png`](test/visual/baselines/darwin-electron43/overlay-dark.png) | `artifacts/visual/overlay-dark.actual.png` | `artifacts/visual/overlay-dark.diff.png` | 0 changed pixels; no geometry differences |
| Two-pane dark split, 60/40 | [`split-2-dark-60-40.png`](test/visual/baselines/darwin-electron43/split-2-dark-60-40.png) | `artifacts/visual/split-2-dark-60-40.actual.png` | `artifacts/visual/split-2-dark-60-40.diff.png` | 0 changed pixels; no geometry differences |
| Three-pane dark split, 1/2 + 1/4 + 1/4 | [`split-3-dark.png`](test/visual/baselines/darwin-electron43/split-3-dark.png) | `artifacts/visual/split-3-dark.actual.png` | `artifacts/visual/split-3-dark.diff.png` | 0 changed pixels; no geometry differences |
| Four-pane dark split, 2×2 | [`split-4-dark.png`](test/visual/baselines/darwin-electron43/split-4-dark.png) | `artifacts/visual/split-4-dark.actual.png` | `artifacts/visual/split-4-dark.diff.png` | 0 changed pixels; no geometry differences |

The files under `artifacts/visual/` are generated and ignored; rerunning
`npm run visual` recreates them. The implementation baselines and manifest live
under `test/visual/baselines/darwin-electron43/`.

## What `diff = 0` means

For these seven scenes, zero means the current Chroma capture equals the saved
Chroma baseline under the same deterministic software-raster contract. It does
**not** mean:

- 100% visual similarity to Arc or Zen;
- any measured Arc/Zen similarity score;
- pixel-level product parity with another browser;
- validation of native vibrancy, Mica, system shadows, or window-compositor
  chrome;
- validation on Windows, Linux, another Electron major, another DPR, or another
  font/rendering stack.

No licensed, provenance-recorded Arc or Zen reference baseline is currently
checked into this repository. Therefore an external similarity percentage or
external pixel diff cannot be calculated from the available evidence. Screenshots
used during design discussion are not automatically repository baselines.

## Coverage still missing

The current seven-scene baseline does not yet cover system theme,
reduced-transparency mode, menus, history, downloads, command palette,
loading/audio states, folders, every ratio-tree permutation, all active/compact
split-capsule variants, responsive transitions, or platform-native window
chrome. Those states require reviewed Chroma baselines; platform-native
materials require captures on each target operating system.

If an external design reference is added later, record its source, date,
license/permission, exact crop and environment separately. Keep Chroma
self-regression results distinct from qualitative design review, and do not
interpret one as the other.

## Running and updating

```bash
npm run visual
```

Only an intentional review should replace baselines:

```bash
CHROMA_UPDATE_VISUAL_BASELINES=1 npm run visual:update
```

See [`TESTING.md`](TESTING.md) for gate boundaries, [`DESIGN.md`](DESIGN.md) for
the baseplate and split-layout decisions, and
[`docs/PARITY.md`](docs/PARITY.md) for visual work still remaining.
