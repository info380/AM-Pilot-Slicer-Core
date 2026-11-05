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
readonly native_revision="$(node -p "require('./native/bambu/runtime-plan.json').nativeSourceRevision")"
readonly native_source="release-evidence/AM-Pilot-Native-Build-${native_revision}.tar.gz"
curl --fail --location --proto '=https' --tlsv1.2 \
  "https://codeload.github.com/info380/AM-Pilot-Slicer-Core/tar.gz/${native_revision}" --output "$native_source"
printf '%s  %s\n' "$(node -p "require('./native/bambu/runtime-plan.json').nativeSourceArchiveSha256")" "$native_source" | sha256sum --check --strict
# Retain the exact compiled artifact permanently, alongside its source and
# provenance, so reproduction does not depend on an expiring workflow artifact.
readonly native_artifact="release-evidence/Bambu-native-build-${native_revision}.tar.gz"
cp "${BAMBU_NATIVE_ARCHIVE_PATH:?The verified native archive is required}" "$native_artifact"
printf '%s  %s\n' "$(node -p "require('./native/bambu/runtime-plan.json').artifactTarSha256")" "$native_artifact" | sha256sum --check --strict
cp native/bambu/runtime/native-build-status.json native/bambu/runtime/native-build-evidence.json \
  native/bambu/runtime/native-runtime-plan.json native/bambu/runtime/native-runtime.SHA256SUMS release-evidence/
readonly media_revision="$(node -p "require('./native/bambu/runtime-plan.json').media.nativeSourceRevision")"
readonly media_source="release-evidence/AM-Pilot-Media-Build-${media_revision}.tar.gz"
curl --fail --location --proto '=https' --tlsv1.2 \
  "https://codeload.github.com/info380/AM-Pilot-Slicer-Core/tar.gz/${media_revision}" --output "$media_source"
printf '%s  %s\n' "$(node -p "require('./native/bambu/runtime-plan.json').media.nativeSourceArchiveSha256")" "$media_source" | sha256sum --check --strict
readonly media_artifact="release-evidence/Bambu-headless-media-${media_revision}.tar.gz"
cp "${BAMBU_MEDIA_ARCHIVE_PATH:?The verified headless media archive is required}" "$media_artifact"
printf '%s  %s\n' "$(node -p "require('./native/bambu/runtime-plan.json').media.artifactTarSha256")" "$media_artifact" | sha256sum --check --strict
cp native/bambu/runtime/native-media-build-evidence.json release-evidence/
readonly ffmpeg_archive="release-evidence/FFmpeg-n$(node -p "require('./native/bambu/media-build-plan.json').versionName").tar.gz"
curl --fail --location --proto '=https' --tlsv1.2 \
  "$(node -p "require('./native/bambu/media-build-plan.json').sourceUrl")" --output "$ffmpeg_archive"
printf '%s  %s\n' "$(node -p "require('./native/bambu/media-build-plan.json').sourceSha256")" "$ffmpeg_archive" | sha256sum --check --strict
(cd release-evidence && sha256sum ./*.tar.gz ./*.tar.bz2 > SHA256SUMS)
node scripts/write-bambu-release-evidence.js
