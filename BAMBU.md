# Bambu engine integration

This adapter uses Bambu Studio 02.08.02.61, upstream release commit
`926a7192574bcb9b3a732e1ec59a46d79cb45466`. It produces Bambu `.gcode.3mf`
archives and extracts the exact contained G-code for AM Pilot preview evidence.
The Prusa adapter remains a separate engine identity.

Initial scope: A1 and A2L, one physical nozzle, single-filament external spool,
one plate per run. Printer, process and filament settings must be fully resolved,
compatible and bound into the immutable effective configuration. No network-based
profile updates, desktop post-processing, profile host credentials, AMS,
per-object overrides are admitted by the initial capability.

The engine is not yet registered or deployed in AM Pilot production. The platform
must validate and retain the additional `printArchive` completion artifact before
registering `fdm.am_pilot_bambu_core` / `fdm-bambu-2.8.2.61-protocol1-r1`.
Native availability must not be inferred from the existing external-file template.

## Output contract

`outputs.gcode` remains textual G-code and feeds the existing preview.
`outputs.printArchive` adds checksum, size and 3MF content type for the printable
archive. The slice-evidence digest includes both artifacts. The API must inspect
the archive, match the model/nozzle/material and verify its contained G-code
checksum against `outputs.gcode`. A Bambu job must never publish raw `.gcode`
as the production file.

The Bambu preview interprets manufacturer layer/feature markers and XY arc/helix
travel, with a maximum 0.01 mm chord error recorded in the preview header. It shows
slicer-generated model toolpaths; firmware-conditional and custom start/end blocks
are excluded explicitly. This is preview tessellation only: printable bytes are
unchanged. The single-nozzle dialect does not interpret Bambu's virtual T commands
as additional physical extruders.

PrusaSlicer remains the existing bounded source-geometry normalizer. Normalized
objects are transformed and combined into one 3MF without automatic arrangement
or orientation. Input presets and scripts in uploaded model files are discarded.

## Validation

The optional native test uses only synthetic geometry. It never connects to a
printer, uploads a job, heats a machine or starts a print:

```sh
BAMBU_STUDIO_INTEGRATION_CMD=/path/to/BambuStudio \
BAMBU_STUDIO_INTEGRATION_RESOURCES=/path/to/resources/profiles/BBL \
node --test test/bambu-engine.test.js
```

The Linux integration workflow checks the upstream AppImage SHA-256 before using
it. This test dependency is not a production worker image or deployment approval.
A production image still needs immutable source/release evidence, runtime
isolation, resource limits, signature/SBOM/scan evidence and registration.

## Native painting and performance (capability r5)

`fdm-bambu-2.8.2.61-protocol1-r5` adds source-bound STL support painting.
The immutable paint contract remains `am-pilot-support-paint` version 1.
The worker validates source SHA-256, source facet count and subdivision budgets,
normalizes an ephemeral Prusa annotated package, verifies the exact facet/paint
round trip, and translates its support attributes to the pinned Bambu native
`paint_supports` encoding. Whole facets and four-midpoint subdivisions support
Enforce, Block and Erase. Imported 3MF paint is not an authoritative annotation.
Painted Bambu runs require explicit `enable_support=1`; no setting is enabled
implicitly. Object overrides remain unsupported. Modifiers and pauses remain
available through their existing versioned contracts.

Linked instances with identical frozen source, paint and region evidence share
native mesh resources. Every placement retains its own Bambu object settings
record and build transform, including independent rotations and nonuniform
scales. Different definitions or settings are not merged. Per-source expansion,
aggregate plate, modifier and normalized-byte limits remain enforced. Validated
painted normalization is cached only within one leased run and removed with its
workspace.

`SLICER_ENGINE_CPU_AFFINITY=threads` explicitly opts Bambu subprocesses into
Linux CPU affinity using `SLICER_ENGINE_THREADS`. Startup requires Linux and
`/usr/bin/taskset`; invalid CPU sets or insufficient permitted CPUs fail closed.
The default is `none` for compatibility. No environment secrets are forwarded to
native subprocesses. Affinity changes scheduling, not the recipe, geometry,
thread budget, job concurrency, service size or printing commands.

Worker logs record download, preparation, slicing/validation, preview/manifest
and publication durations under `slicer_run_stage_completed`, and include all
phase timings in `slicer_run_completed`. Logs contain run identity and timing,
not source geometry, model names, credentials or configuration contents.

The manual synthetic benchmark is `qualification/run-performance.mjs`. Supply
`SLICER_BENCHMARK_OUTPUT_DIR` (an empty absolute directory), the three native
integration paths documented above, and optionally
`SLICER_TEST_CPU_AFFINITY=threads` on Linux and `SLICER_BENCHMARK_REGION=1`.
It generates its own 16,384-facet torus and measures one and ten linked parts;
no customer geometry, network service or printer is used. Linux resource
measurements require the cgroup v2 files used by the release container.
