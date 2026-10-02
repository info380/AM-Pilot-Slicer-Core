# Bambu engine integration

This adapter uses Bambu Studio 02.08.02.61, upstream release commit
`926a7192574bcb9b3a732e1ec59a46d79cb45466`. It produces Bambu `.gcode.3mf`
archives and extracts the exact contained G-code for AM Pilot preview evidence.
The Prusa adapter remains a separate engine identity.

Initial scope: A1 and A2L, one physical nozzle, single-filament external spool,
one plate per run. Printer, process and filament settings must be fully resolved,
compatible and bound into the immutable effective configuration. No network-based
profile updates, desktop post-processing, profile host credentials, AMS,
per-object overrides or painted supports are admitted by this capability.

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
