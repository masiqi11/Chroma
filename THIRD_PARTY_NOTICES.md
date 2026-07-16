# Chroma Third-Party Notices

Chroma's original source code is licensed under the Apache License, Version 2.0;
see [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md). That project license does
not replace, relicense, or waive the terms that apply to third-party software.

This file is a reviewable snapshot of the dependency metadata resolved on
2026-07-16. It is not yet the complete release NOTICE or a legal opinion. The
current packaged macOS build is an unsigned local smoke artifact, not a public
distribution.

## Direct npm dependencies

All current npm entries are declared as development dependencies. The packaged
ASAR allow-list contains Chroma's runtime source and `package.json`, not npm's
`node_modules`; Electron itself supplies the application runtime. The readable
release-license resources are copied separately under
`Contents/Resources/licenses/`, outside ASAR.

| Package | Resolved version | Declared license | Current role |
|---|---:|---|---|
| `@electron/asar` | 3.4.1 | MIT | ASAR inspection used by package verification |
| `electron` | 43.1.0 | MIT | Local Chromium/Electron runtime and development launcher |
| `electron-builder` | 26.15.3 | MIT | Local unsigned macOS packaging |
| `pixelmatch` | 7.1.0 | ISC | Visual-regression comparison only |
| `pngjs` | 7.0.0 | MIT | Visual PNG reading/writing only |

The versions and SPDX expressions above come from `package-lock.json`. The
corresponding installed license texts are available at:

```text
node_modules/@electron/asar/LICENSE.md
node_modules/electron/LICENSE
node_modules/electron-builder/LICENSE
node_modules/pixelmatch/LICENSE
node_modules/pngjs/LICENSE
```

## Lockfile inventory

The current lockfile contains 286 `node_modules/` package records and every
record has a license expression. This is a metadata count, not a substitute for
shipping required license texts or copyright notices.

| Declared expression | Package records |
|---|---:|
| MIT | 214 |
| ISC | 37 |
| BSD-3-Clause | 9 |
| BlueOak-1.0.0 | 8 |
| Apache-2.0 | 6 |
| BSD-2-Clause | 6 |
| 0BSD | 1 |
| Python-2.0 | 1 |
| WTFPL | 1 |
| `(MIT OR CC0-1.0)` | 1 |
| `(WTFPL OR MIT)` | 1 |
| `WTFPL OR ISC` | 1 |

Optional and platform-specific packages in the lockfile are included in these
counts even when they are not installed or shipped for a particular artifact.
Conversely, a lockfile license field alone does not enumerate every notice,
exception, asset license, or runtime component bundled inside Electron.

## Electron and Chromium

The Electron npm package declares MIT and includes Electron's license at
`node_modules/electron/dist/LICENSE`. The downloaded Electron distribution also
contains the generated Chromium/open-source credits file
`node_modules/electron/dist/LICENSES.chromium.html`. That credits file is the
primary generated inventory shipped with the exact local Electron distribution
and is much broader than the npm dependency graph.

| Runtime component | Version in the inspected Electron binary | Notice source |
|---|---:|---|
| Electron | 43.1.0 | `node_modules/electron/LICENSE` |
| Chromium | 150.0.7871.47 | `LICENSES.chromium.html` |
| Node.js | 24.18.0 | `LICENSES.chromium.html` |
| V8 | 15.0.245.13-electron.0 | `LICENSES.chromium.html` |

The local Chromium credits file is 19,956,019 bytes and contains 773 generated
component entries. It must be kept intact rather than replaced by the npm
license-expression summary above.

Electron's npm installer directly resolves the following build-time packages;
they were not present in the inspected Chroma ASAR:

| Package | Resolved version | Declared license | Local evidence |
|---|---:|---|---|
| `@electron-internal/extract-zip` | 1.0.4 | BSD-2-Clause | SPDX package metadata only; the installed package has no license file |
| `@electron/get` | 5.0.0 | MIT | `node_modules/@electron/get/LICENSE` |
| `@types/node` | 24.13.3 | MIT | `node_modules/@types/node/LICENSE` |

A public Chroma binary must preserve all notices required by Electron,
Chromium, and their bundled components. The current local package smoke verifies
startup, the ASAR boundary, and this minimum directly readable resource set in
`dist/mac-arm64/Chroma.app/Contents/Resources/licenses/`:

```text
Chroma-LICENSE.txt
Chroma-NOTICE.md
THIRD_PARTY_NOTICES.md
Electron-LICENSE.txt
LICENSES.chromium.html
```

All five were present in the inspected artifact. This resolves the earlier
missing-notice packaging defect, but it does not by itself establish that the
set is legally complete for a public release. A frozen-artifact SBOM, asset and
binary inventory, and legal review have not yet been completed.

## Projects and marks that are not dependencies

Arc and Zen Browser are design-language and workflow references only. This
repository does not include their source code or branded assets, and they are
not npm dependencies. Their names and the names of Electron, Chromium, Chrome,
Firefox, macOS, Windows, and Linux remain trademarks of their respective
owners. See [`NOTICE.md`](NOTICE.md) for the project notice.

## Required before public distribution

Before publishing a source or binary release:

1. Generate a complete SPDX or CycloneDX SBOM from the exact packaged artifact,
   including hashes, optional/platform dependencies, native frameworks, and
   Electron/Chromium components.
2. Generate a release NOTICE containing every required copyright attribution,
   license text, exception, and source-offer obligation; do not rely only on
   this summary or `package-lock.json`.
3. Preserve and reverify the currently packaged Chroma license/notice, this
   inventory, Electron license, and matching `LICENSES.chromium.html` in an
   accessible distribution location, subject to a release/legal review.
4. Review fonts, icons, favicons, codecs, media/DRM modules, vendor keys,
   generated assets, and installer resources separately from npm packages.
5. Rerun dependency vulnerability and license-policy scans after the lockfile
   and final artifact are frozen.

`npm audit --ignore-scripts` currently reports zero known vulnerabilities for
the lockfile snapshot. That result is time-sensitive and is neither a license
audit nor proof that an unsigned artifact is safe or release-ready.
