#!/usr/bin/env bash
set -euo pipefail
# Preserve the exact normalizer and worker source evidence, then append Bambu.
scripts/build-source-bundle.sh
readonly commit='926a7192574bcb9b3a732e1ec59a46d79cb45466'
readonly checksum='3c0d92559057709a2e500824acb1cfc4b93e0ef0a218c2e404e2ce466b0c7d4b'
readonly archive="release-evidence/BambuStudio-${commit}.tar.gz"
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
  "https://codeload.github.com/bambulab/BambuStudio/tar.gz/${commit}" --output "${archive}"
printf '%s  %s\n' "${checksum}" "${archive}" | sha256sum --check --strict
(cd release-evidence && sha256sum ./*.tar.gz ./*.tar.bz2 > SHA256SUMS)
node scripts/write-bambu-release-evidence.js
