# Security policy

Do not include customer models, G-code, credentials, private AM Pilot API
responses, or tenant data in public issues.

Report vulnerabilities privately through GitHub's **Report a vulnerability**
security-advisory flow for this repository. Include the affected immutable
image digest and a minimal reproduction that contains no customer data.

The worker intentionally has:

- one dedicated API bearer credential and no user/session credential;
- no object-storage credential or tenant identifier;
- exact engine/protocol/image admission;
- checksum-verified inputs and outputs;
- a fixed no-shell process invocation;
- disabled PrusaSlicer post-processing;
- bounded requests, files, logs, objects, time, and concurrency;
- non-root execution and a fresh per-run temporary directory;
- redacted structured logs containing run IDs and stable failure codes only.

The initial hosted worker also requires a deployment-level outbound policy
that permits only the AM Pilot API origin and required DNS/TLS infrastructure.
Application-layer URL validation is defense in depth, not a replacement for
that network policy.
