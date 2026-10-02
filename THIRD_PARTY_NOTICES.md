# Third-party notices

## PrusaSlicer 2.9.3

- Project: <https://github.com/prusa3d/PrusaSlicer>
- Exact source commit: `f1776c0a6347bb84986d10eac8db1021f5bd8548`
- License: GNU Affero General Public License, version 3
- Exact source archive SHA-256:
  `fe6c6696360c688f3ac6744964d5c27d98394da3e3cd00a8b8df7bc3fd4f7055`

PrusaSlicer is based on Slic3r by Alessandro Ranellucci and the RepRap
community. Its dependency build definitions contain the exact upstream URLs,
versions, patches, and checksums used by the pinned build.

## GNU MP 6.2.1

- Project: <https://gmplib.org/>
- Authoritative source: <https://ftp.gnu.org/gnu/gmp/gmp-6.2.1.tar.bz2>
- License: GNU LGPL version 3 or later, or GNU GPL version 2 or later
- Exact source archive SHA-256:
  `eae9326beb4158c386e39a356818031bd28f3124cf915f8c5b1dc4c7a36b4d7c`

The release publishes the exact checksum-locked source archive linked into
the PrusaSlicer binary.

## fflate 0.8.3

- Project: <https://github.com/101arrowz/fflate>
- Registry package: <https://www.npmjs.com/package/fflate/v/0.8.3>
- License: MIT
- Lockfile integrity is recorded in `package-lock.json`.

The complete installed license text is available in
`node_modules/fflate/LICENSE` and is present in the OCI image's package
inventory/SBOM.

## Bambu Studio 02.08.02.61 (Bambu worker variant only)

- Project: <https://github.com/bambulab/BambuStudio>
- Exact source commit: `926a7192574bcb9b3a732e1ec59a46d79cb45466`
- License: GNU Affero General Public License, version 3
- Source archive SHA-256: `3c0d92559057709a2e500824acb1cfc4b93e0ef0a218c2e404e2ce466b0c7d4b`
- Upstream Linux AppImage SHA-256: `69426a59682574591590f51c913d3889baa19252d1c8e9fcae2497eb0ed6bf92`

The Bambu variant redistributes the unmodified upstream Linux executable and
resources. The corresponding source archive includes upstream build scripts,
dependency definitions, patches and license notices. It uses the separate Prusa
runtime above only for source geometry normalization. Network printer plugins
are not installed or used by the worker. Ubuntu package versions are recorded
in its SBOM and resolved from the 20261002T000000Z Ubuntu snapshot.

## Undici 8.10.1

- Project: <https://github.com/nodejs/undici>
- License: MIT
- Exact package and integrity: `package-lock.json`.
