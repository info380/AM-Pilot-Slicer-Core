#!/usr/bin/env bash
set -euo pipefail
readonly work="${1:?An empty download directory is required}"
readonly output="${2:?An empty runtime context is required}"
test ! -e "$work"
test ! -e "$output"
mkdir -p "$work"
value() { node -p "require('./native/bambu/runtime-plan.json')['$1']"; }
readonly repository="$(value repository)"
readonly artifact="$(value artifactId)"
gh api "repos/$repository/actions/artifacts/$artifact" > "$work/artifact.json"
gh api "repos/$repository/actions/runs/$(value buildRunId)" > "$work/run.json"
node native/bambu/materialize-runtime.mjs verify-identity "$work/artifact.json" "$work/run.json"
gh api "repos/$repository/actions/artifacts/$artifact/zip" > "$work/artifact.zip"
node native/bambu/materialize-runtime.mjs from-zip "$work/artifact.zip" "$output" "$work"
