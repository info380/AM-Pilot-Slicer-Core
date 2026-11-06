# Native feature statistics

`native-statistics.patch` applies to PrusaSlicer commit
`f1776c0a6347bb84986d10eac8db1021f5bd8548`. It emits
`<output.gcode>.am-pilot-statistics.json` after the native processor finalizes
normal-mode times and filament consumption, before its result is moved.
The report contains native enum IDs, seconds, metres and grams. Worker parsing
converts IDs to the production toolpath catalog and metres to millimetres.
Feature time includes native acceleration planning; it is not derived from
preview segment lengths or allocated from total time.

The sidecar does not modify G-code. Its checksum is retained in the immutable
preview. The patch is included in the corresponding-source release archive;
release evidence records its checksum.

## Qualification and release dependency

This change remains a candidate until the patched native runtime is built and
qualified. Before release:

1. Run the existing Prusa native integration and shared-worker fixtures against
   the candidate image. Verify native feature time and consumption, including
   ironing, and compare total time with the G-code summary.
2. Compare stock and patched G-code bytes for the same deterministic fixture
   and settings, after the existing timestamp canonicalization.
3. Build and sign the immutable Prusa native component, and prove stock/patched
   output parity. Make the shared Bambu image include that exact binary; its
   original runtime base predates this exporter. Scan the complete shared image.
   Do not promote a shared image with the older Prusa binary: the worker intentionally rejects a missing native report.
4. Validate the shared API/browser decoder against both engines and deploy
   compatible consumers before activating the new worker image.

The 6 November candidate rebuild also updates the runtime package snapshot to
`20261105T000000Z`: PCRE2 `10.42-1+deb12u2` matches the exact pinned Node image
rather than downgrading it, and libpng `1.6.39-2+deb12u6` is the fixed version
listed by that official security snapshot. GnuTLS stays `3.7.9-2+deb12u7`.
The upstream Prusa source, build snapshot and native dependency versions are
unchanged. Package downgrades are rejected by the release contract. The signed
snapshot package index and image SBOM retain the package integrity evidence.


The existing manual candidate workflow runs `qualify-statistics.sh`. It reuses
its cached native builder, reverses only this exporter patch, rebuilds the stock
binary with the same compiler/dependencies, and compares timestamp-canonicalized
G-code bytes with and without ironing. The worker-process tests also assert
native timing and role consumption. This step is manual-dispatch-only; automatic
PR verification and tag-release runtime budgets are not expanded. No candidate
image is a production engine registration.


The control stage exports only its rebuilt stock executable through a scratch
stage. It reuses the same workflow's native cache, compiles without network,
and avoids loading the complete compiler/dependency filesystem into Docker.
The native exporter constructs its sidecar path from the upstream `const char*`
parameter explicitly as `std::string`.


The shared image copies only `/opt/prusa` from the exact signed native image
in `runtime-plan.json`. Its native stock/patched comparison and worker-process
integration passed. The standalone Debian image failed its runtime scan for
unused `apt`/`libapt-pkg6.0`; that image's operating system and worker are not
shipped. The shared Ubuntu runtime already removes its own package manager.
Its full-image scan remains a mandatory, independent release gate.

`retain-native-component.mjs` verifies the exact successful native build,
signing and stock-comparison steps, source revision, OCI provenance, binary
identity and signed image. It retains the original runtime scan transparently
alongside the native proof and corresponding source. A failure in any native
step is rejected; the standalone runtime cannot be included. The shared build
checks the copied binary checksum and its complete dynamic-link closure.
Existing evidence directories are never replaced. Full native rebuilds also
remove the unused Debian package manager before their own runtime scan.
