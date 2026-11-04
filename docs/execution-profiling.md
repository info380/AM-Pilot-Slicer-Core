# Worker execution profile

The `slicer_engine_profile` log event splits the existing `slicingAndValidation` worker stage without changing the worker protocol, native invocation, output bytes, checksums, recipe, affinity or resource allocation. One event is emitted when engine validation succeeds, or with partial phase evidence when it fails. Later publication failures do not emit a duplicate engine event.

Durations use a monotonic clock. Successful phases appear in `completedPhases`; `failedPhase` identifies an attempted phase that threw. Missing phases were not reached. The event contains only run identity, engine key, outcome, fixed internal phase names and numeric durations. It never includes commands, paths, stdout, errors, leases, credentials or settings.

- `presetPreparation`: validation/serialization and local preset writes.
- `machineProjectPreparation` (Bambu): native export and bounded rewrite required for reviewed machine overrides. It is separate from the slicing subprocess and is near zero when no override preparation is required.
- `slicingProgress` and `validationProgress`: awaited API progress requests, outside native execution and validation.
- `affinitySetup`: resolving the explicit native CPU invocation.
- `nativeSubprocess`: spawn initiation through the child close event, including CLI startup, load/preparation, native slicing, export and captured-stdio closure. It is wall time, not CPU time or pure algorithm time. On timeout/cancellation it measures until the existing rejection, which can precede child close; unsuccessful attempts must not be treated as completed subprocess samples.
- `archiveValidation` (Bambu): bounded archive read/inspection and extraction of the exact G-code bytes.
- `headerCanonicalization` (Prusa): the existing generator timestamp canonicalization.
- `gcodeInspection`: existing textual/hash and metrics inspection.
- `layerEventValidation`: worker read and authoritative custom-G-code/pause checks.

The phases are sequential and non-overlapping. Their sum excludes small adapter bookkeeping and diagnostic logging outside the measured operations. Heartbeats may overlap native work and are not added to the phase totals. The existing outer stage timer remains the authoritative whole-stage wall time.

Validate production by (1) checking the exact signed image and registered engine identity, (2) slicing an unchanged fixture and correlating engine/worker/API events, and (3) verifying archive/G-code/preview identities, layer events, modifiers and cancellation before selecting a performance change. No printer command is necessary. This change requires a worker-image rollout and matching engine registrations; API and Admin code redeployments are not required.
