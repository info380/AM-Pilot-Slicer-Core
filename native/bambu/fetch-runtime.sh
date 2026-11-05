#!/usr/bin/env bash
set -euo pipefail
readonly work="${1:?An empty download directory is required}"
readonly output="${2:?An empty runtime context is required}"
test ! -e "$work"
test ! -e "$output"
mkdir -p "$work"
value() { node -e 'let p=require("./native/bambu/runtime-plan.json");if(process.argv[1]==="media")p=p.media;process.stdout.write(String(p[process.argv[2]]))' "$1" "$2"; }
for kind in native media; do
  mkdir "$work/$kind"
  repository="$(value "$kind" repository)"
  artifact="$(value "$kind" artifactId)"
  gh api "repos/$repository/actions/artifacts/$artifact" > "$work/$kind/artifact.json"
  gh api "repos/$repository/actions/runs/$(value "$kind" buildRunId)" > "$work/$kind/run.json"
  node --input-type=module - "$kind" "$work/$kind" <<'JS'
import fs from 'node:fs';import {loadPlan,verifyBuildIdentity} from './native/bambu/materialize-runtime.mjs';
const p=await loadPlan(),root=process.argv[3];verifyBuildIdentity(process.argv[2]==='media'?p.media:p,JSON.parse(fs.readFileSync(root+'/artifact.json')),JSON.parse(fs.readFileSync(root+'/run.json')));
JS
  gh api "repos/$repository/actions/artifacts/$artifact/zip" > "$work/$kind/artifact.zip"
done
node native/bambu/materialize-runtime.mjs from-zip "$work/native/artifact.zip" "$output" "$work"
