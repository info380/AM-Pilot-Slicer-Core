# Native seam-visibility prototype

This is a diagnostic candidate, not an admitted production runtime. It leaves
the worker, printer settings, source geometry, modifiers and seam choices intact.
See [corresponding source and notices](SOURCE.md) for the exact source-built
control and modified candidate, separately from existing OCI release offers.

The patch reuses immutable occlusion and identical painted seam-region data only
when Bambu has already established a native shared-object relation and the
centered transforms and every volume matrix are finite and exactly equal.
Bambu's volume-transform equality is approximate, so it is explicitly narrowed
before cache eligibility. Candidate collection,
visibility assignment, overhang checks, alignment and final seam selection still
run for every object. One cache entry lives inside one `SeamPlacer::init` call;
replacement, exceptions and cancellation release it. It does not persist between
objects' groups or slices. Unrelated or differently transformed objects calculate
their own visibility through the unchanged native algorithm.

`visibility-cache-test.cpp` exercises noncopyable self-referential data, exact
transform eligibility, independent objects, group replacement, cancellation,
failed construction and release between slices. Run it with C++17 and address/
undefined-behavior sanitizers, with assertions enabled.

The manual `seam-prototype` profile in the native CPU measurement workflow builds
an unmodified control and candidate using the same Ubuntu 22.04 compiler,
dependencies and Release configuration. It uses an official Bambu dependency
artifact whose dependency and build-definition trees match the pinned upstream
revision. Both archive checksums and producer revision are verified. The vendor
wx-config contains an absolute prefix; the explicit prefix in the plan preserves
that vendor requirement. There is no alternative dependency or compiler path on
failure. No recurring build or automatic native build is introduced.
The manual compiler job uses the public runner's four CPUs and verifies its
memory allocation. This compiler allocation is separate from the unchanged
one-CPU production worker. A failed build's sealed diagnostic artifact remains
marked failed; it cannot count as native qualification.

The build artifact includes source/patch identities, compiler and package
versions, CMake configuration, runtime dependencies and both binary checksums.
Private customer geometry must not be uploaded to this public workflow. Real
TapOut validation and one-CPU timings belong in the existing private worker
environment, with no printer commands or paid plan upgrade.

A successful build is not seam or toolpath qualification. Compare the control
and candidate with unchanged settings, modifiers, painted facets, transforms,
seam modes and layer events. Account separately for Bambu's existing floating-
shell variation. Verify placement, seams and feature geometry rather than relying
only on total filament/time or executable-command hashes. Production activation
would require the normal reviewed native-runtime, source-offer, signature, scan,
capability and deployment qualification process.

`qualify-prototype.mjs` runs fourteen public synthetic cases against the official
binary, the matched unmodified control and the candidate. Its preflight mode
only verifies that the unchanged binary exercises the intended fixtures; it
does not mark equivalence as passed. Fixtures include all seam modes, changed
transforms/settings/regions, independent objects, seam enforcers/blockers and
negative volumes. Two cases retain native layer sharing for approximately equal
volume transforms while rejecting exact visibility reuse. Painted facets must alter seams, and every positive modifier
must produce native ironing. These fixtures explicitly disable floating-shell
variation; no saved customer recipe is edited.

`toolpath-comparison.mjs` compares exact deposited line segments, directed native
arc parameters and per-contour outer-wall starts. It follows coordinate/extrusion
modes and resets, and rejects unsupported arc planes/center modes. Reordering is
separated from geometry and seam changes. Layer heights and extrusion amounts
remain part of the comparison.
The synthetic cases additionally require identical executable command sequences,
including feeds, acceleration and travel; only comments and M73 display progress
are excluded. Real-plate command checksums are recorded separately because its
unchanged floating-shell feature already varies between native executions.

`benchmark-worker.mjs` accepts a private input packet in the existing worker.
It verifies the packet's runtime-source/binary identities, one-CPU/two-GB limits,
nice priority and single-CPU native affinity. It aborts when other Bambu/Prusa
native work appears, limits each invocation to one minute and the diagnostic to
six minutes, and cleans its temporary slice files. One official run and three
alternating control/candidate pairs use the unchanged prepared plate and all
native settings. The private input packet supplies explicit expectations derived
from the frozen reference: object and layer counts, native setting count,
visibility calculations/reuse and ironing moves per part. Missing expectations
fail closed. It checks embedded MD5, the authoritative pause/custom-code verifiers,
each part's ironing, seam starts and deposited features.
The only permitted feature variation is the previously documented native
floating-shell branch. A frozen feature-wide envelope must come exclusively from
repeated unmodified controls with the same input, all native settings and bound
executable identities. Continuous-segment distance bounds, extrusion and length
deltas must remain within that envelope. The input packet supplies these limits
and their evidence reference. The `collectUnmodifiedBaseline` mode admits no
candidate binary and records the control observations separately.

Two earlier comparison gates rejected repeats: one rejected a candidate for an
extrusion difference then reproduced by unchanged controls; a per-layer gate
subsequently rejected an unchanged control on another layer. The final gate uses
the control-only feature envelope and retains both failures in the private
evidence. It keeps exact checks for seams, modifiers and all other deposited
features. This measures existing native nondeterminism; it neither fixes that
behavior nor establishes physical print quality or byte identity.
Do not upload its private input packet or
customer archives to this repository or its workflows.

Before production activation:

1. Complete the balanced, matched-recipe benchmark on the unchanged one-CPU
   worker and verify its actual resource limits, output checks and cleanup.
2. Qualify a worker image with the corresponding source, notices, SBOM,
   provenance, signatures, vulnerability scan and required runtime admission.
3. Verify a complete Slice attempt, preview, every instance's modifiers and
   layer events at the exact deployed revision before any printer operation.

This diagnostic milestone changes no API or Admin code and needs neither
deployment. The optimization is not enabled in production by merging these tools.

## Signed runtime packaging

`runtime-plan.json` selects the exact measured native artifact. `fetch-runtime.sh`
requires its successful repository/workflow/source identity and ZIP checksum;
`materialize-runtime.mjs` additionally verifies the tar, preferred build inputs,
binary, dependencies and build status before creating a new image context. Existing
contexts are rejected. `AppRun` selects this binary explicitly with its reviewed
library closure; the runtime never selects the previous executable on failure.

The release workflow tests the packaged image against the stock and source-built
controls with identical installed profile resources. It retains 42 synthetic native
executions and one-CPU/two-GB resource evidence, then publishes the complete native
build and source archives permanently. Future materialization can use the retained
tar with its exact plan through the explicit `from-tar` command; no automatic
artifact-source substitution is performed when a workflow artifact expires.

The signed image still needs exact-digest API engine registration and a verified
worker rollout before it is active. Native packaging changes require a worker
redeploy; no API or Admin redeploy is required when the protocol and capabilities
remain unchanged. Keep the production worker on its current one-CPU plan.
