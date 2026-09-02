#!/usr/bin/env bash
set -euo pipefail

readonly upstream_commit='f1776c0a6347bb84986d10eac8db1021f5bd8548'
readonly upstream_sha256='fe6c6696360c688f3ac6744964d5c27d98394da3e3cd00a8b8df7bc3fd4f7055'
readonly gmp_version='6.2.1'
readonly gmp_sha256='eae9326beb4158c386e39a356818031bd28f3124cf915f8c5b1dc4c7a36b4d7c'
readonly evidence_dir='release-evidence'
readonly upstream_archive="${evidence_dir}/PrusaSlicer-${upstream_commit}.tar.gz"
readonly gmp_archive="${evidence_dir}/gmp-${gmp_version}.tar.bz2"

mkdir -p "${evidence_dir}"
curl --fail --location --proto '=https' --tlsv1.2 \
  "https://codeload.github.com/prusa3d/PrusaSlicer/tar.gz/${upstream_commit}" \
  --output "${upstream_archive}"
readonly actual_upstream_sha256="$(sha256sum "${upstream_archive}" | awk '{print $1}')"
if [[ "${actual_upstream_sha256}" != "${upstream_sha256}" ]]; then
  echo 'Pinned PrusaSlicer source checksum verification failed.' >&2
  exit 1
fi

curl --fail --location --retry 5 --retry-all-errors --retry-delay 2 \
  --proto '=https' --tlsv1.2 \
  "https://ftp.gnu.org/gnu/gmp/gmp-${gmp_version}.tar.bz2" \
  --output "${gmp_archive}"
readonly actual_gmp_sha256="$(sha256sum "${gmp_archive}" | awk '{print $1}')"
if [[ "${actual_gmp_sha256}" != "${gmp_sha256}" ]]; then
  echo 'Pinned GNU GMP source checksum verification failed.' >&2
  exit 1
fi

git archive --format=tar --prefix=AM-Pilot-Slicer-Core/ HEAD \
  | gzip -n -9 > "${evidence_dir}/AM-Pilot-Slicer-Core-${GITHUB_SHA}.tar.gz"

(
  cd "${evidence_dir}"
  sha256sum ./*.tar.gz ./*.tar.bz2 > SHA256SUMS
)

node scripts/write-release-evidence.js \
  "${RELEASE_DIGEST:?RELEASE_DIGEST is required}" \
  "${evidence_dir}/release-evidence.json"
