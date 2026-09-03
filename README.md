# AM Pilot Slicer Core

AM Pilot Slicer Core is the open-source execution worker for AM Pilot's
FDM Slicer. It runs a pinned, headless PrusaSlicer build and implements the
versioned AM Pilot Slicer worker protocol.

This repository is deliberately narrow. It contains the engine adapter,
container build, protocol client, geometry handoff, tests, and supply-chain
release workflow. Tenant authorization, Slicer projects, Job Cards, Builds,
Fleet reconciliation, machine control, commercial data, and object-storage
credentials remain in the private AM Pilot platform.

## Release identity

- Engine key: `fdm.am_pilot_prusa_core`
- Worker protocol: `1`
- Capability revision: `fdm-prusa-2.9.3-protocol1-r1`
- PrusaSlicer: `2.9.3`
- Upstream commit: `f1776c0a6347bb84986d10eac8db1021f5bd8548`
- Upstream source archive SHA-256:
  `fe6c6696360c688f3ac6744964d5c27d98394da3e3cd00a8b8df7bc3fd4f7055`

The OCI image is not trusted by tag. AM Pilot admits only a promoted
`sha256:` digest whose protocol, capability revision, source evidence,
signature, provenance, SBOM, security review, regression corpus, and physical
print qualification all match.

## Execution flow

1. The worker authenticates to the private AM Pilot API with a dedicated
   bearer credential and deployment identity.
2. It claims only runs pinned to its exact engine key, protocol, and image
   digest.
3. It downloads source models through lease-scoped API routes and verifies
   size and SHA-256 before use.
4. Every STL or 3MF is normalized by the pinned PrusaSlicer binary. Source 3MF
   metadata is removed, and AM Pilot's per-object XYZ scale, XYZ rotation,
   position, and center-to-bed coordinate mapping are written into a minimal
   geometry-only 3MF package.
5. PrusaSlicer slices the complete plate with auto-arrangement disabled and
   the canonical effective configuration. Post-processing is forcibly empty.
6. The worker hashes the G-code, builds the versioned result manifest, and
   streams both back to the API. The worker never receives tenant IDs, bucket
   credentials, or storage keys.
7. The API validates and stores immutable evidence and reconciles it into the
   existing Production File, Build, Job Card, and Fleet workflows.

The worker is stateless and processes one run at a time. A fresh `0700`
temporary directory is deleted after every completion or failure.

## Required runtime configuration

| Variable | Purpose |
| --- | --- |
| `AM_PILOT_API_BASE_URL` | HTTPS origin of the AM Pilot API |
| `SLICER_WORKER_CONTROL_TOKEN` | Dedicated secret, at least 32 bytes |
| `SLICER_WORKER_ID` | Stable deployment instance identity |
| `SLICER_IMAGE_DIGEST` | Exact deployed OCI digest (`sha256:...`) |
| `SLICER_EGRESS_PROXY_URL` | Dedicated HTTP(S) CONNECT proxy origin used for every API request |
| `SLICER_EGRESS_PROXY_REQUIRED` | Set to `true` on production workers so startup fails unless the proxy is configured |

The image supplies `PRUSA_SLICER_CMD=/opt/prusa/bin/prusa-slicer` and
`SLICER_WORK_ROOT=/tmp/am-pilot-slicer-worker`. Both may be overridden, but
startup fails unless the binary and dedicated absolute work directory are
valid.

For a production deployment, place the worker on an internal-only container
network and expose only a separately administered CONNECT proxy that permits
`api.am-pilot.com:443`. Set both egress-proxy variables above. The worker also
rejects any request whose origin differs from `AM_PILOT_API_BASE_URL`; the
network boundary remains authoritative if the worker process is compromised.

## Explicit runtime defaults

These defaults target the initial low-volume, approximately EUR 7/month
single-worker deployment. They are guardrails, not claims that 512 MB is
enough for every customer model.

| Variable | Default |
| --- | ---: |
| `SLICER_POLL_INTERVAL_MS` | 3000 |
| `SLICER_HEARTBEAT_INTERVAL_MS` | 20000 |
| `SLICER_REQUEST_TIMEOUT_MS` | 30000 |
| `SLICER_JOB_TIMEOUT_MS` | 1200000 |
| `SLICER_ENGINE_THREADS` | 1 |
| `SLICER_MAX_MODEL_BYTES` | 536870912 |
| `SLICER_MAX_GCODE_BYTES` | 536870912 |
| `SLICER_MAX_MANIFEST_BYTES` | 1048576 |
| `SLICER_MAX_MODELS_PER_RUN` | 1000 |
| `SLICER_MAX_OBJECTS_PER_PLATE` | 1000 |

Production promotion must record measured memory, CPU time, temporary storage,
and output sizes from the qualification corpus. If the EUR 7 worker exceeds a
qualified budget, AM Pilot fails the run closed; it does not silently simplify
the model, change the profile, or move work to an unapproved engine.

## Local validation

```sh
npm ci --ignore-scripts
npm run check
```

An installed PrusaSlicer can run the placement and real-slice integration
probe:

```sh
PRUSA_SLICER_INTEGRATION_CMD=/absolute/path/to/prusa-slicer npm test
```

The production image is Linux/amd64 because that is the qualified initial
worker target. Building PrusaSlicer requires at least 8 GB RAM; the final
worker runtime is intentionally much smaller.

## Release and source

Tags and manual release runs build the image in GitHub Actions, attach BuildKit
provenance and an SPDX SBOM, sign the immutable digest with Sigstore, scan it
with Trivy, and publish corresponding-source archives as permanent release
assets as well as short-lived workflow artifacts.
See [SOURCE_OFFER.md](SOURCE_OFFER.md) and
[docs/qualification.md](docs/qualification.md).

## License

AM Pilot Slicer Core is licensed under the GNU Affero General Public License,
version 3. PrusaSlicer is also AGPLv3 and includes work derived from Slic3r.
See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
