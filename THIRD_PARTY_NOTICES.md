# Third-party notices

## PrusaSlicer 2.9.3

- Project: <https://github.com/prusa3d/PrusaSlicer>
- Exact source commit: `f1776c0a6347bb84986d10eac8db1021f5bd8548`
- License: GNU Affero General Public License, version 3
- Exact source archive SHA-256:
  `fe6c6696360c688f3ac6744964d5c27d98394da3e3cd00a8b8df7bc3fd4f7055`

PrusaSlicer is based on Slic3r by Alessandro Ranellucci and the RepRap
community. Its dependency build definitions contain the exact upstream URLs,
versions, patches, and checksums used by the pinned build.

AM Pilot's `native/prusa/native-statistics.patch` adds a separate JSON report of
the native processor's normal-mode feature times and filament consumption.
The patch is included in the corresponding-source archive and its checksum is
recorded in release evidence. It does not change generated G-code commands.

## GNU MP 6.2.1

- Project: <https://gmplib.org/>
- Authoritative source: <https://ftp.gnu.org/gnu/gmp/gmp-6.2.1.tar.bz2>
- License: GNU LGPL version 3 or later, or GNU GPL version 2 or later
- Exact source archive SHA-256:
  `eae9326beb4158c386e39a356818031bd28f3124cf915f8c5b1dc4c7a36b4d7c`

The release publishes the exact checksum-locked source archive linked into
the PrusaSlicer binary.

## fflate 0.8.3

- Project: <https://github.com/101arrowz/fflate>
- Registry package: <https://www.npmjs.com/package/fflate/v/0.8.3>
- License: MIT
- Lockfile integrity is recorded in `package-lock.json`.

The complete installed license text is available in
`node_modules/fflate/LICENSE` and is present in the OCI image's package
inventory/SBOM.

## Bambu Studio 02.08.02.61 (Bambu worker variant only)

- Project: <https://github.com/bambulab/BambuStudio>
- Exact source commit: `926a7192574bcb9b3a732e1ec59a46d79cb45466`
- License: GNU Affero General Public License, version 3
- Source archive SHA-256: `3c0d92559057709a2e500824acb1cfc4b93e0ef0a218c2e404e2ce466b0c7d4b`
- Upstream Linux AppImage SHA-256: `69426a59682574591590f51c913d3889baa19252d1c8e9fcae2497eb0ed6bf92`

Earlier Bambu releases redistributed the unmodified upstream Linux executable.
The seam-visibility runtime is source-built from the exact upstream revision
with AM Pilot's slice-local visibility reuse patch. `native/bambu/runtime-plan.json`
pins the compiler workflow, preferred source, patch, binary and library hashes.
The corresponding source archives include the exact native builder source,
upstream build scripts, dependency definitions, patches and license notices.
The installed profile resources are retained from the verified runtime base.
It uses the separate Prusa
runtime above only for source geometry normalization. Network printer plugins
are not installed or used by the worker. Ubuntu package versions are recorded
in its SBOM and resolved from the snapshot identified in release-evidence.json.

## FFmpeg 7.0.2 (source-built Bambu runtime)

- Project: <https://github.com/FFmpeg/FFmpeg>
- Source tag: `n7.0.2`.
- Source archive SHA-256: `5eb46d18d664a0ccadf7b0adee03bd3b7fa72893d667f36c69e202a807e6d533`.
- Libraries: `libavcodec.so.61`, `libavutil.so.59`, `libswscale.so.8`.
- License: GNU LGPL version 2.1 or later, as reported by these build artifacts.

The exact library hashes are pinned in the native runtime plan. The official
Bambu dependency recipe is retained in `deps/FFMPEG/FFMPEG.cmake` in the upstream
source archive. The dependency build's configuration is embedded in the libraries.
The worker uses a reduced source-built closure with all codecs, parsers, bitstream
filters, media formats, media filters, programs and network support disabled.
These components are outside the headless FDM worker contract. This build does
not enable GPL or nonfree components. The exact FFmpeg source
archive is also published permanently with the release.

## Undici 8.12.3

- Project: <https://github.com/nodejs/undici>
- License: MIT
- Exact package and integrity: `package-lock.json`.

The headless Bambu image excludes the upstream desktop `resources/web` UI assets.
Those browser components are not used by native slicing. The installed profile
resources remain unchanged; the native executable carries the documented
visibility patch. The complete upstream source is still supplied.
