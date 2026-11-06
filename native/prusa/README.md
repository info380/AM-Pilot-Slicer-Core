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

1. Run the existing Prusa native integration and qualification corpus against
   the candidate image. Verify native feature time and consumption, including
   ironing, and compare total time with the G-code summary.
2. Compare stock and patched G-code bytes for the same deterministic fixture
   and settings, after the existing timestamp canonicalization.
3. Build, scan, sign and qualify the immutable Prusa image. Make the shared
   Bambu image include that exact qualified Prusa runtime; its currently pinned
   base predates this exporter. Do not promote a shared image with the older
   Prusa binary: the worker intentionally rejects a missing native report.
4. Validate the shared API/browser decoder against both engines and deploy
   compatible consumers before activating the new worker image.

The local native build was blocked on 6 November 2026 by gateway errors from
the pinned Debian snapshot package service. No alternative package versions
or unverified native runtime were substituted.
