# Immutable candidate corpus

`run-corpus.mjs` is executed only by the digest-pinned qualification workflow.
It runs inside the already-published Slicer Core image with its network disabled,
root filesystem read-only, Linux capabilities dropped, and CPU, memory, process,
and temporary-storage limits applied by Docker.

The synthetic, non-customer corpus covers STL and 3MF inputs, duplicate objects,
a mixed plate, negative and positive center-origin coordinates, non-uniform scale,
XYZ rotation, supports, material settings, Marlin 2 output, and custom start/end
G-code. The same plate is sliced twice from the same immutable inputs and the
workflow fails unless both G-code checksums match.

The synthetic G-code and JSON report are written with read-only-for-others file
permissions so the separate GitHub runner identity can validate and package the
bind-mounted evidence. They contain no customer or production input.

`run-failure-corpus.mjs` executes in a separate container at the same candidate
digest and with the same hardened resource and network boundaries. It exercises
the published worker's failure contracts for malformed STL and 3MF input,
download checksum mismatch and cleanup, cancellation, lease loss, timeout,
transient-download retry with partial-file cleanup, and G-code and manifest
output limits. The workflow fails unless all nine cases produce their exact
expected result, and packages the JSON report and container inspection as
candidate evidence.

PrusaSlicer places the wall-clock time in the first generated G-code comment.
The worker replaces only that exact timestamp with the conventional reproducible
build epoch `1970-01-01 at 00:00:00 UTC` before hashing or publishing output.
Operational run timestamps remain in AM Pilot's run and manifest evidence; an
unexpected generator header fails closed.

The workflow artifact is candidate evidence, not engine approval. AM Pilot still
requires representative production-worker resource and admission evidence,
destination-restricted worker egress, named legal and security approvals, and a
supervised physical-print qualification before the private engine-promotion
command can succeed.
