#!/usr/bin/env bash
# Manual native qualification only; no printer, API or production queue access.
set -euo pipefail
readonly image="${1:?Pass the immutable candidate image}"
readonly output="${2:?Pass the evidence directory}"
readonly run_key="${GITHUB_RUN_ID:?Run through the manual candidate workflow}"
[[ "$image" =~ ^ghcr\.io/info380/am-pilot-slicer-core@sha256:[a-f0-9]{64}$ ]]
[[ "$run_key" =~ ^[0-9]+$ ]]
test "$(git rev-parse HEAD)" = "${GITHUB_SHA:?}"
mkdir -p "$output"
readonly builder="am-pilot-prusa-statistics-builder:${run_key}"
readonly stock_container="am-pilot-prusa-statistics-stock-${run_key}"
readonly stock_binary="$(realpath "$output")/prusa-slicer-stock"
cleanup() {
  docker rm -f "$stock_container" >/dev/null 2>&1 || true
  docker image rm "$builder" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Reuse this same workflow's cached dependency/native build. Reverse only the
# reviewed exporter patch, then rebuild against exactly the same dependencies.
docker buildx build --platform linux/amd64 --target prusa-build --load --tag "$builder" .
docker run --name "$stock_container" --network none --cpus 2 --memory 4g --pids-limit 256 \
  --entrypoint /bin/sh "$builder" -ec '
    cd /src
    git apply --reverse --check /tmp/native-statistics.patch
    git apply --reverse /tmp/native-statistics.patch
    cmake --build build --parallel 2
    test -x build/src/prusa-slicer
  '
docker cp "$stock_container:/src/build/src/prusa-slicer" "$stock_binary"
chmod a+rx "$stock_binary"
sha256sum "$stock_binary" > "$output/prusa-stock-binary.SHA256"
sha256sum native/prusa/native-statistics.patch > "$output/prusa-statistics-patch.SHA256"
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --cpus 1 --memory 1g --pids-limit 256 --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --mount "type=bind,src=$(pwd)/test,dst=/worker/test,readonly" \
  --mount "type=bind,src=${stock_binary},dst=/stock-prusa-slicer,readonly" \
  --env PRUSA_SLICER_INTEGRATION_CMD=/opt/prusa/bin/prusa-slicer \
  --env PRUSA_STOCK_INTEGRATION_CMD=/stock-prusa-slicer \
  "$image" node --test test/prusa-integration.test.js \
  | tee "$output/native-statistics-parity.txt"
grep -F '# fail 0' "$output/native-statistics-parity.txt"
grep -F '# skipped 0' "$output/native-statistics-parity.txt"
rm "$stock_binary"
