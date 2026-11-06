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
readonly stock_binary="$(realpath "$output")/prusa-slicer-stock"
trap 'rm -f "$stock_binary"' EXIT
# Reuse this workflow's native build cache and export only the stock executable.
# Its control stage has no network and reverses only the reviewed exporter.
docker buildx build --platform linux/amd64 --target prusa-statistics-control \
  --output "type=local,dest=${output}" .
test -x "$stock_binary"
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
