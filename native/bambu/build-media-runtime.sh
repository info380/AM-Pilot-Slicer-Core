#!/usr/bin/env bash
set -euo pipefail
readonly root="$(pwd)"
readonly work="${1:?An empty work directory is required}"
readonly output="${2:?An empty output directory is required}"
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test ! -e "$work"
test ! -e "$output"
mkdir -p "$work" "$output/lib"
readonly plan="$root/native/bambu/media-build-plan.json"
value() { node -e 'process.stdout.write(String(require(process.argv[1])[process.argv[2]]))' "$plan" "$1"; }
curl --fail --location --proto '=https' --tlsv1.2 "$(value sourceUrl)" --output "$work/source.tar.gz"
printf '%s  %s\n' "$(value sourceSha256)" "$work/source.tar.gz" | sha256sum --check --strict
mkdir "$work/source"
tar -xzf "$work/source.tar.gz" -C "$work/source" --strip-components=1 --no-same-owner
mapfile -t configure < <(node -e 'for(const value of require(process.argv[1]).configure)console.log(value)' "$plan")
cd "$work/source"
./configure --prefix="$work/install" "${configure[@]}" > "$output/configure.log" 2>&1
make -j"$(value buildJobs)" > "$output/build.log" 2>&1
make install >> "$output/build.log" 2>&1
cp config.h config_components.h libavcodec/parser_list.c libavcodec/codec_list.c libavcodec/bsf_list.c "$output/"
cp "$plan" "$output/"
node --input-type=module - "$output" "$work/install/lib" <<'JS'
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import crypto from 'node:crypto';import child from 'node:child_process';
const out=process.argv[2],lib=process.argv[3],plan=JSON.parse(fs.readFileSync(path.join(out,'media-build-plan.json')));
for(const name of ['parser_list.c','codec_list.c','bsf_list.c']){
 const text=fs.readFileSync(path.join(out,name),'utf8');
 assert(!/\bff_[A-Za-z0-9_]+/.test(text),'Unused native media components must not be registered');
 assert.match(text,/NULL/);
}
const config=fs.readFileSync(path.join(out,'config.h'),'utf8');
for(const name of ['AVFORMAT','AVFILTER','AVDEVICE','NETWORK','AUTODETECT'])assert.match(config,new RegExp('#define CONFIG_'+name+' 0(?:\\n|$)'));
const hashes={};for(const name of plan.libraries){const bytes=fs.readFileSync(path.join(lib,name));fs.writeFileSync(path.join(out,'lib',name),bytes,{mode:0o755});hashes[name]=crypto.createHash('sha256').update(bytes).digest('hex');}
fs.writeFileSync(path.join(out,'media-build-evidence.json'),JSON.stringify({schema:'am-pilot-headless-bambu-media-build-evidence',version:1,sourceRevision:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,repository:process.env.GITHUB_REPOSITORY,compiler:child.execFileSync('cc',['--version'],{encoding:'utf8'}).split('\n')[0],upstreamVersion:plan.versionName,sourceSha256:plan.sourceSha256,libraries:hashes,parserCount:0,codecCount:0,bitstreamFilterCount:0,programs:false,network:false,avformat:false,avfilter:false,avdevice:false,configure:plan.configure},null,2)+'\n');
JS
(cd "$output" && sha256sum lib/* config.h config_components.h parser_list.c codec_list.c bsf_list.c media-build-plan.json media-build-evidence.json > SHA256SUMS)
tar -czf "$work/media-runtime.tar.gz" -C "$output" .
mv "$work/media-runtime.tar.gz" "$output/"
(cd "$output" && sha256sum media-runtime.tar.gz > media-runtime.tar.gz.sha256)
