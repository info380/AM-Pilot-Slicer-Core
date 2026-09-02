# Corresponding source offer

For every AM Pilot Slicer Core OCI release, the release workflow publishes:

1. the exact AM Pilot Slicer Core Git source archive;
2. the exact PrusaSlicer upstream source archive used to build the binary;
3. the exact GNU GMP source archive statically linked into PrusaSlicer;
4. SHA-256 checksums for all three archives;
5. an OCI SPDX SBOM and build provenance extracted from the immutable image
   attestations;
6. signature-verification, vulnerability-scan, dependency-notice, binary
   checksum, and evidence-checksum files;
7. a release-evidence JSON document tying those artifacts to the digest.

The source repository, Dockerfile, build workflow, patches (if any), dependency
lockfile, and installation scripts are the preferred form for modifying this
software. No private AM Pilot platform source is required to build or modify
the worker and Prusa-derived executable.

Release artifacts are retained with the applicable release record. If an
artifact is unavailable, open a public repository issue identifying the image
digest. AM Pilot will provide the corresponding source for covered releases in
accordance with GNU AGPLv3.
