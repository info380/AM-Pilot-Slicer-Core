# Native seam-visibility prototype

This is a diagnostic candidate, not an admitted production runtime. It leaves
the worker, printer settings, source geometry, modifiers and seam choices intact.

The patch reuses immutable occlusion and identical painted seam-region data only
when Bambu has already established a native shared-object relation and the
centered transforms are finite and exactly equal. Candidate collection,
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

`qualify-prototype.mjs` runs twelve public synthetic cases against the official
binary, the matched unmodified control and the candidate. Its preflight mode
only verifies that the unchanged binary exercises the intended fixtures; it
does not mark equivalence as passed. Fixtures include all seam modes, changed
transforms/settings/regions, independent objects, seam enforcers/blockers and
negative volumes. Painted facets must alter seams, and every positive modifier
must produce native ironing. These fixtures explicitly disable floating-shell
variation; no saved customer recipe is edited.

`toolpath-comparison.mjs` compares exact deposited line segments, directed native
arc parameters and per-contour outer-wall starts. It follows coordinate/extrusion
modes and resets, and rejects unsupported arc planes/center modes. Reordering is
separated from geometry and seam changes. Layer heights and extrusion amounts
remain part of the comparison.

`benchmark-worker.mjs` accepts a private input packet in the existing worker.
It verifies the packet's runtime-source/binary identities, one-CPU/two-GB limits,
nice priority and single-CPU native affinity. It aborts when other Bambu/Prusa
native work appears, limits each invocation to one minute and the diagnostic to
six minutes, and cleans its temporary slice files. One official run and three
alternating control/candidate pairs use the unchanged prepared plate and all
575 native settings. It checks embedded MD5, the authoritative pause/custom-code
verifiers, 90 layers, each part's ironing, seam starts and deposited features.
The only permitted feature variation is the previously documented native
floating-shell branch. Continuous-segment distance bounds, extrusion and length
deltas must stay within explicit limits from the retained reference study; the
input packet supplies those limits and its evidence reference. This is recorded
explicitly rather than treated as byte identity or physical qualification.
Do not upload its private input packet or
customer archives to this repository or its workflows.
