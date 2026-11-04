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
- Capability revision: `fdm-prusa-2.9.3-protocol1-r4`
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
6. The worker hashes the G-code, compiles a versioned AM Pilot production
   toolpath artifact in center-origin coordinates, builds the result manifest,
   and streams all three outputs back to the API. The worker never receives tenant IDs, bucket
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

The same immutable image can run that dedicated proxy with
`node src/egress-proxy.js`. It requires all six settings below and has no
defaults or alternate destination:

| Variable | Meaning |
| --- | --- |
| `SLICER_EGRESS_PROXY_ALLOWED_HOST` | Exact API DNS hostname or IP address |
| `SLICER_EGRESS_PROXY_ALLOWED_PORT` | Exact API TCP port |
| `SLICER_EGRESS_PROXY_LISTEN_HOST` | Internal-network listen address |
| `SLICER_EGRESS_PROXY_LISTEN_PORT` | Unprivileged internal proxy port |
| `SLICER_EGRESS_PROXY_IDLE_TIMEOUT_MS` | Bounded tunnel idle timeout |
| `SLICER_EGRESS_PROXY_MAX_CONNECTIONS` | Bounded simultaneous connection count |

The proxy rejects ordinary HTTP forwarding and every CONNECT authority except
the exact configured host and port. Run it as a separate container joined to
both the worker's internal-only network and a controlled egress network; the
worker container must join only the internal network.

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
| `SLICER_MAX_MODEL_BYTES` | 33554432 |
| `SLICER_MAX_TOTAL_MODEL_BYTES` | 134217728 |
| `SLICER_MAX_NORMALIZED_MODEL_BYTES` | 67108864 |
| `SLICER_MAX_TOTAL_NORMALIZED_BYTES` | 134217728 |
| `SLICER_MAX_PLATE_INPUT_BYTES` | 201326592 |
| `SLICER_NORMALIZATION_CACHE_MAX_BYTES` | 0 (disabled) |
| `SLICER_NORMALIZATION_CACHE_MAX_ENTRIES` | 128 |
| `SLICER_NORMALIZATION_CACHE_TTL_MS` | 900000 |
| `SLICER_MAX_GCODE_BYTES` | 67108864 |
| `SLICER_MAX_MANIFEST_BYTES` | 1048576 |
| `SLICER_MAX_TOOLPATH_PREVIEW_BYTES` | 268435456 |

There is no model or object-count cap. Legacy `SLICER_MAX_MODELS_PER_RUN`
and `SLICER_MAX_OBJECTS_PER_PLATE` environment values are ignored. Empty plates
remain invalid; byte budgets, execution limits and release-identity checks remain
enforced. A rejected input on a verified lease is reported as a failed run,
without terminating the worker's polling loop.

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

## Per-object print overrides (v0.4.0)

Capability r4 carries each instance's sparse print overrides into native
3MF object metadata. Settings inherit from the plate unless explicitly overridden.
Source profile metadata is discarded; only pinned object/region keys and typed
values are admitted. Generated volume ranges preserve the complete geometry.
The release gate slices duplicate synthetic cubes with different layer heights
and perimeter/infill settings, and checks their actual extrusion paths separately.
Other instances, transforms and support annotations remain independent.

## Painted mesh recentering correction (v0.3.2)

The native importer centers mesh coordinates using float32 subtraction and
serializes its retained translation with nine significant digits. The support
paint preservation check now compares the exact native local coordinate frame,
instead of reconstructing world coordinates with a non-reversible addition.
Fractional, off-origin STL geometry can therefore retain its paint through
normalization without a false geometry-change rejection. Changed facets, winding,
paint trees and arbitrary transforms still fail closed; no geometric tolerance,
implicit repair or source mutation is introduced.

This release retains capability r3 and the existing resource boundaries. It needs
its own signed immutable image and qualification/reproduction evidence before
activation. Local desktop tests do not qualify a production worker image.

## Support painting candidate (v0.3.1)

The immutable v0.3.0 release is rejected for activation: its generated release
evidence incorrectly advertised capability r2 instead of the worker's r3 support
painting contract. Its tag and assets remain unchanged. The v0.3.1 replacement
uses the worker's canonical capability definition for release evidence and checks
that identity before qualification. It requires its own signed image and complete
qualification evidence; no v0.3.0 result grants v0.3.1 approval.

Capability `fdm-prusa-2.9.3-protocol1-r3` admits version-1 source-bound support
annotations on STL objects. The API snapshot retains the original STL SHA-256,
facet count, and sparse native support trees. Only none/enforce/block and
four-midpoint subdivision are accepted: 16 levels, 262,144 total nodes,
2 MiB annotation text per object, and 1,000,000 source facets. Existing model,
object, memory, CPU, archive-expansion and tenant limits are not widened.

The worker builds an ephemeral native painted 3MF, normalizes it, verifies that
facet coordinates, vertex order and paint survived, then uses the existing plate
transform and slicing path. Changed/duplicate/degenerate facets fail closed;
there is no implicit repair or source overwrite. Imported 3MF painting, seam
painting, fuzzy-skin painting and geometry splitting are not part of this release.

`test/support-paint.test.js` covers hostile input, source binding, native 3MF
roundtrip, partial enforcers and blockers. Set `PRUSA_SLICER_INTEGRATION_CMD` to
run its native test locally. The qualification workflow runs that test without
skips on the **exact signed image digest**, with the existing production resource
boundaries. A passing local desktop test is not image qualification or permission
to promote production printing. Support settings remain explicit: enforcers
require support generation; disabling automatic supports yields painted-only
supports, while blockers affect automatically generated supports.

## License

AM Pilot Slicer Core is licensed under the GNU Affero General Public License,
version 3. PrusaSlicer is also AGPLv3 and includes work derived from Slic3r.
See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Shared Prusa and Bambu worker

The combined image built by `Dockerfile.bambu` can serve both engine queues on
one deployment. `SLICER_ENGINE_KEYS=fdm.am_pilot_prusa_core,fdm.am_pilot_bambu_core`
is explicit; do not also set the legacy `SLICER_ENGINE_KEY`. Single-engine images
and deployments can continue using the legacy setting. Both binaries are verified
before claiming work. Each claim, lease and output keeps its own engine identity,
capability and immutable image digest. Register the combined digest separately
for each engine in AM Pilot before admitting new work to it.

There is one execution slot for the whole process. Polling alternates engine
queues after each completed job, so a busy queue cannot monopolize the worker.
An empty queue does not add a poll delay before checking the other queue. Both
queues share the existing control credential, stable worker ID and workspace
cleanup. There is no engine substitution, quality reduction or automatic plan
upgrade. Drain active runs before replacing a deployed digest.

The combined release runs native tests for both engines sequentially under
512 MiB memory (including swap), 0.5 CPU and one engine thread. Passing the small
acceptance fixtures does not establish capacity for every production model.

### Native Print settings and Ironing candidate

The versioned Bambu Print-tab catalog contains 259 source fields from
BambuStudio `926a7192574bcb9b3a732e1ec59a46d79cb45466` (02.08.02.61).
Regenerate it with `node scripts/extract-bambu-print-settings.js /path/to/BambuStudio/src`.
The importer verifies both source file checksums before emitting metadata. The
catalog records compile-time conditions rather than claiming those controls are
present in the released binary. Firmware, credentials and shell execution are
not accepted as arbitrary process settings.

Prusa capability `fdm-prusa-2.9.3-protocol1-r5` and Bambu capability
`fdm-bambu-2.8.2.61-protocol1-r2` add explicit Ironing and Support ironing preview
features, preserving all previous feature IDs. Native integration tests require
actual Ironing extrusion and preview records, not only a saved configuration key.
This candidate does not authorize a worker release or deployment; release and
qualification remain separate gates.

## Planned pauses and modifier regions (0.5.0)

The immutable plate snapshot accepts `pausePoints` and per-object `modifiers`
under the version 1 preparation contract in `src/preparation-contract.js`.
They require Prusa capability `fdm-prusa-2.9.3-protocol1-r6` or Bambu capability
`fdm-bambu-2.8.2.61-protocol1-r3`. Older capabilities cannot consume these fields.

A pause is `{id, zMm, message}`. Its height is measured from the build plate;
the native engine pauses before the first printed layer at or above that height.
The printer profile must supply its native pause script (`pause_print_gcode` for
Prusa/Klipper, `machine_pause_gcode` for Bambu). No generic pause command or custom
G-code from a note is substituted. The worker verifies actual native pause events
before publishing output. Missing events, heights above the printed model, and
multiple events that cannot be represented at a layer fail closed. A saved pause
is not a live printer command; an operator resumes the printer after the task.

Each modifier has an ID, name, `shape` (`box`, `cylinder`, or `sphere`), positive
`sizeMm` XYZ dimensions, a part-local XYZ `transform`, and `printOverrides`.
A cylinder's axis is local Z; sphere dimensions allow an ellipsoid. Parent part
transforms also transform its modifier volumes. Modifiers are native non-printable
regions. Later overlapping modifiers take precedence; editing retains order.
Region settings cover wall count, infill density/pattern, top/bottom solid layers,
and the five common wall/infill/surface speeds. Speeds are positive absolute mm/s.
Hardware settings, scripts, and unsupported engine-specific settings are rejected.
Limits are 128 pauses, 32 modifiers per object, and 256 modifiers per plate.

Only normalized source geometry, transforms, and supported paint attributes enter
the assembled native 3MF. Original profiles and scripts are not imported.
Prusa receives one assembled plate without CLI merge (which discards layer events).
Bambu receives native modifier parts and `--load-custom-gcodes` layer events so
externally supplied presets do not discard pauses. G-code is never text-patched.

`test/advanced-three-mf.test.js` runs closed-volume, geometry, pause verification,
and real-engine tests for every shape, regional infill, and overlap precedence.
Set both existing native integration command variables for both engines, or
`FDM_ADVANCED_ENGINE=prusa|bambu` for an explicitly single-engine qualification.
The release container runs both engines with zero skipped native tests.

### Runtime security patch (0.5.1)

Failed candidate `bambu-v0.2.0` is retained unchanged. Its release scan identified
CVE-2026-111497 in the old system Brotli package. The shared runtime now uses the
2026-11-01 Ubuntu snapshot with `libbrotli1=1.1.0-2ubuntu0.1`, and the official
Node 22.23.4 image pinned by digest. The runtime copies Node from this patched
stage rather than inheriting an older binary from the geometry image. This also
covers Node's bundled Brotli fix. Native engine binaries and capability IDs stay
unchanged; both engine fixtures and the immutable-image scan must pass again.

### Remaining base-package patch (0.5.2)

The next scan confirmed the Brotli fix and identified the one remaining finding,
CVE-2026-85091 in base-image `zlib1g`. Pin Ubuntu's fixed
`1:1.3.dfsg-3.1ubuntu2.3` from the same signed snapshot. Candidate
`bambu-v0.2.1` remains unchanged. Scan severity and reporting remain unchanged.

### Expanded modifier regions (0.5.3 / Bambu 0.2.3)

Prusa r7 and Bambu r4 add native regional ironing, surface patterns, line widths,
bridge/gap speeds, shell thickness, and fuzzy skin. The common contract accepts
only settings declared by both pinned PrintRegionConfig classes. Support
generation remains object-scoped; local enforce/block uses support painting.
Ironing uses one explicit surface scope; disabled ironing maps to the native off
value. Boolean metadata is serialized as 0/1. Speed values are absolute mm/s,
line widths are absolute mm, and infill overlap is a percentage. Old advanced
preparation capabilities retain their original scope.

### Reviewed Bambu machine configurations

Capability `fdm-bambu-2.8.2.61-protocol1-r6` binds explicit motion and G-code overrides to their resolved machine preset. For these jobs only, the pinned Bambu engine first generates an unsliced native project. The worker writes the reviewed settings into that engine-generated project, preserving its geometry, native metadata and generator identity. The final slice loads the same printer rather than entering the CLI's cross-printer conversion path. Installed engine resources and their conversion limits stay unchanged.

The intermediate archive has explicit compressed, expanded, entry-count and settings limits. Both native processes retain the same timeout, cancellation and CPU-affinity controls. The accepted output must retain each reviewed normal-mode limit and script; an engine reduction or replacement fails closed before publication. Separate silent-mode and per-axis limits remain explicit. Jobs with no machine overrides retain their existing preparation path.

## Preview compilation batching

Preview compilation consumes bounded batches from the UTF-8 input stream and
awaits disk writes only when a record chunk is full. CR, LF, split CRLF, empty
lines and unterminated final lines retain the original line numbering. Backpressure
and stream cancellation remain active. Record layout, chunk hashes, output limits,
Bambu firmware-block handling, arcs, support features and result evidence are
unchanged; this does not simplify G-code or alter native slicing settings.

### Per-layer Custom G-code

The shared preparation contract accepts `customGcodePoints` alongside pauses. Each point stores an ID, actual printed height in millimetres, and printer G-code text. The native Bambu Custom event and Prusa custom-code event insert it before the first layer at or above that height. Saved text is bounded by the existing machine-script limits. The output verifier checks an exact, unique block at the actual native layer and rejects collisions after layer-height changes. User comments in these blocks do not supply layer, feature, pause or time metadata. No host-side post-processing command is run. Capability revisions are Bambu r7 and Prusa r8; older requests remain governed by exact worker identity.

Worker-code releases use the immutable signed native runtime from `bambu-v0.3.3` (source `8b5ee15b80c55aaa63db1c96a3ef2c7e8fa3ee5c`, digest `sha256:3545ba6ac6accb118628c3e83e82d25400e525d80dda9e1de35fe8e353840385`). Its full native build recipe is in the permanent corresponding-source archive. The new image replaces worker source, schemas and dependencies, verifies inherited security-fixed package versions and both native binaries, and records runtime provenance. Container isolation, scanning, signatures, source publication and native tests still run for every release. A native-runtime upgrade requires a new reviewed base digest and its matching build/source evidence.


## Tenant-separated normalized geometry reuse

Optional process-local reuse avoids repeating Prusa's source-to-3MF conversion.
Enable it only after the authenticated API health response advertises
`sourceNormalizationCacheVersion: 1`. Each leased claim must supply
`sourceCacheScope: { version: 1, tenantNamespaceSha256: "<64 lowercase hex>" }`,
derived by the API from the leased database tenant. The worker never accepts a
caller-selected namespace. An enabled cache refuses an incompatible API before
claiming work; a malformed claim fails that run closed.

Source downloads and their authorization, immutable size and SHA-256 checks
still happen on every run. Entries are keyed by API-issued tenant namespace,
source format/size/SHA-256, paint evidence, and verified normalizer/image identity.
Paint round-trip checks and all expanded-source, aggregate-source and plate byte
limits still run on hits. Placement, modifiers, print settings, native slicing,
G-code and result validation are rebuilt every time. No native slicedata cache,
G-code cache or disk cache is used.

The cache is disabled by default. `SLICER_NORMALIZATION_CACHE_MAX_BYTES` explicitly
sets retained compressed bytes, bounded by the existing aggregate normalized
source budget. Entry count is bounded to 1–1024, expiry to 60–3600 seconds. Entries
expire after insertion (hits do not extend retention), use LRU eviction, and are
cleared/zeroed on expiry, eviction and orderly shutdown. A single cache is shared
by both engines in the existing one-job loop; restart loses all entries. Owned
buffer copies and checksums prevent mutation from contaminating another run.
Oversized entries take the ordinary cold conversion path without being retained.

For the initial 512 MiB worker, the proposed opt-in is 32 MiB, 128 entries and
15 minutes; retain constrained native qualification and measure actual memory
before promotion. `slicer_normalization_cache` logs only run ID and aggregate
hits/misses/evictions/entry/byte counts, with no source or tenant namespace.
Deploy the API namespace contract before enabling this worker configuration.
No Admin, database schema or printer communication change is required.

## Native CPU and thread measurements

The manual-only [CPU/thread diagnostic](docs/cpu-thread-measurements.md) measures
an exact signed image without changing runtime code or production configuration.
It separates CPU quota from each engine's execution policy and retains output,
CPU, memory and observed-thread evidence. No automatic benchmark or deployment
is added.
