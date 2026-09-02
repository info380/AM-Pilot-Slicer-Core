# Production qualification

An OCI image is a candidate until the private AM Pilot engine-promotion gate
records all evidence below against its exact digest.

1. Verify the Sigstore signature and GitHub build attestation.
2. Verify the OCI SPDX SBOM and notices.
3. Rebuild from the corresponding-source bundle and compare the PrusaSlicer
   binary checksum. If byte-for-byte reproduction is not achieved, document
   and approve every measured variance before promotion.
4. Pass the vulnerability policy with no unapproved high or critical finding.
5. Verify non-root execution, read-only image layers, per-run temporary
   isolation, and an API-origin-only outbound network policy.
6. Run the canonical corpus across STL and 3MF, duplicate models, mixed-model
   plates, non-uniform scale, XYZ rotation, negative and positive center-origin
   coordinates, supports, material overrides, cancellation, retry, timeout,
   maximum accepted input, malformed archives, checksum mismatch, and G-code
   output limits.
7. Compare G-code checksum, layer count, time, filament, bounding box, machine
   dialect, start/end G-code, and configuration evidence with the approved
   reference for every deterministic fixture.
8. Measure peak RSS, CPU time, temporary disk, input size, and output size on
   the actual EUR 7 worker class. Approve explicit budgets or upgrade the
   worker before promotion.
9. Complete at least one supervised physical print on a qualified machine and
   reconcile the result through Production File, Build, Job Card, Fleet,
   material consumption, QC, and fulfillment evidence as applicable.
10. Obtain named legal/source-compliance and security approvals. Only then run
    the private AM Pilot promotion command for the exact digest.

Qualification never edits an existing approved release. Any code, base image,
dependency, configuration contract, capability, or upstream change produces a
new immutable candidate.
