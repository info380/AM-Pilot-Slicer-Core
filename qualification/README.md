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

The workflow artifact is candidate evidence, not engine approval. AM Pilot still
requires durable regression evidence, destination-restricted worker egress, named
legal and security approvals, and a supervised physical-print qualification before
the private engine-promotion command can succeed.
