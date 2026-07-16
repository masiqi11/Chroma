# Chroma Performance Gate

Chroma has a repeatable startup and memory-regression smoke for the current
Electron host. It is a conservative CI/developer gate, not a product benchmark
or a comparison with Arc, Zen Browser, Firefox, Chrome, or another browser.

Run it from the repository root:

```bash
npm run performance
```

`npm run verify` runs the same gate after the static/unit, window-lifecycle,
session-restoration, and full runtime smokes. Every run writes its current
machine-readable state to `artifacts/performance/report.json`; startup first
overwrites any stale success before measurement begins.

## Measurement contract

The harness starts the real Electron application with a fresh temporary
profile, the same headless-smoke switches used by the other automated host
gates, and hardware acceleration disabled. It serves deterministic `no-store`
HTML fixtures from a loopback HTTP server so DNS, WAN latency, third-party
scripts, and cache state do not dominate the result.

The measured milestones are:

1. **Shell ready**: the shell DevTools target exists, the preload bridge and
   application root are available, and the host reports one live managed page
   view.
2. **First local page ready**: the first tab has committed the fixture URL and
   title, stopped loading, has visible non-zero native bounds, and its fixture
   readiness marker is observable in the page target.
3. **One-tab RSS**: after one second of settling, the harness samples the
   Electron root process and all descendants five times at 200 ms intervals.
4. **Eight-tab RSS**: after eight fixture tabs are loaded with one managed view
   per tab, it repeats the same settled sampling and records the delta from the
   one-tab median.

RSS is collected from `ps -axo pid=,ppid=,rss=` and summed across the complete
process tree. Each gate uses the median of five samples; peaks and process
counts are retained for diagnosis. Chromium may legitimately consolidate the
same-origin fixtures, so process count is diagnostic rather than a tab-to-
renderer assertion. The host's managed-view count remains the ownership check.
The run also fails if output contains known fatal main/renderer diagnostics.

The report uses `schemaVersion: 1`. It transitions from `starting` to `running`
and finishes as `passed` or `failed`. Common metadata includes timestamps, Git
commit/dirty state when available, platform, architecture, OS release, Node,
Electron, Chromium, execution mode, thresholds, fatal-log matches, and cleanup
errors. Successful reports add measurements and samples. Failed reports retain
a serialized error and the final bounded output tail, so an older
`passed: true` artifact cannot survive a failed or interrupted measurement
start unnoticed.

## Regression ceilings

These values are broad failure ceilings for the current local-smoke
environment, not performance goals:

| Metric | Maximum |
|---|---:|
| Shell ready | 20,000 ms |
| First local page ready from process launch | 25,000 ms |
| One loaded tab, settled process-tree RSS | 900 MiB |
| Eight loaded tabs, settled process-tree RSS | 1,800 MiB |
| Eight-tab minus one-tab RSS | 1,100 MiB |

Threshold changes require a reviewed reason and a new report. Do not increase a
ceiling merely to make a regression pass.

## Current recorded result

The checked `schemaVersion: 1` report was captured on 2026-07-16 on Darwin arm64
(OS release 27.0.0, Node 25.9.0) with Electron 43.1.0 / Chromium
150.0.7871.47. It records Git commit
`c112407c59f71191868a6f7f0c866d009aca02bb` with a dirty working tree:

| Metric | Result | Ceiling |
|---|---:|---:|
| Shell ready | 857.2 ms | 20,000 ms |
| First local page ready | 1,208.0 ms | 25,000 ms |
| First page after shell ready | 350.8 ms | diagnostic only |
| One-tab median RSS | 725.5 MiB | 900 MiB |
| One-tab peak RSS | 725.5 MiB | diagnostic only |
| Eight-tab median RSS | 1,369.9 MiB | 1,800 MiB |
| Eight-tab peak RSS | 1,370.1 MiB | diagnostic only |
| Eight-tab RSS delta | 644.4 MiB | 1,100 MiB |

The five one-tab samples ranged from 725.1 to 725.5 MiB across six processes;
the five eight-tab samples ranged from 1,369.9 to 1,370.1 MiB across thirteen
processes. All configured ceilings passed, with no fatal-log matches or cleanup
errors.

## Interpretation limits

- The RSS sampler currently requires `ps`, so this gate supports macOS and
  Linux; it fails explicitly on Windows rather than reporting a misleading
  value.
- Hardware acceleration is disabled. The result does not characterize GPU
  memory, native vibrancy/Mica cost, compositor behavior, or an unlocked
  production desktop.
- The fixtures are tiny local pages. The gate excludes real network, media,
  extension, download, history-volume, complex-site, and long-running-session
  costs.
- RSS is an operating-system process-tree snapshot, not a heap profile. It
  cannot identify JavaScript, DOM, Blink, image, GPU, or native allocations.
- Process-start and memory results vary with hardware, OS load, filesystem cache,
  Electron/Chromium updates, and instrumentation. Compare trends on equivalent
  environments; do not treat one run as a universal product claim.
- A fresh profile does not flush the operating system's filesystem or binary
  cache, so this is not a controlled cold-disk startup benchmark.
- The harness does not measure interaction latency, scrolling smoothness, CPU,
  energy, tab-discard effectiveness, warm start, or leak growth over hours.

Use the full runtime smoke for behavior and cleanup invariants, the visual gate
for deterministic shell geometry/pixels, and platform profiling tools for
production performance work. Those boundaries are documented in
[`../TESTING.md`](../TESTING.md).
