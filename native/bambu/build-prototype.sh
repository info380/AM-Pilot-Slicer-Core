#!/usr/bin/env bash
set -euo pipefail

readonly task_root="$(cd "$(dirname "$0")/../.." && pwd)"
readonly work="${1:?An empty build working directory is required}"
readonly output="${2:?An empty artifact output directory is required}"
test "$(uname -s)" = Linux
test ! -e "$work"
test ! -e "$output"
mkdir -p "$work" "$output/bin" "$output/lib"
readonly plan="$task_root/native/bambu/prototype-plan.json"
value() { node -e 'process.stdout.write(String(require(process.argv[1])[process.argv[2]]))' "$plan" "$1"; }
readonly revision="$(value upstreamCommit)"
readonly vendor_root="$(value vendorBuildPrefix)"
readonly artifact_id="$(value vendorDependencyArtifactId)"
readonly jobs="$(value buildJobs)"
cp "$plan" "$task_root/native/bambu/seam-visibility-reuse.patch" "$output/"
seal_artifact() {
  local status=$?
  trap - EXIT
  node --input-type=module - "$output" "$status" <<'JS'
import fs from 'node:fs';import crypto from 'node:crypto';import path from 'node:path';
const root=process.argv[2],code=Number(process.argv[3]);
const files=['bin/control','bin/candidate'].filter(p=>fs.existsSync(path.join(root,p)));
fs.writeFileSync(path.join(root,'build-status.json'),JSON.stringify({schema:'am-pilot-native-prototype-build-status',version:1,status:code===0?'complete':'failed',exitCode:code,sourceRevision:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,productionActivation:false,binaries:Object.fromEntries(files.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')]))},null,2)+'\n');
JS
  # Preserve executable bits and failed-build diagnostics. A partial artifact
  # remains explicitly failed and cannot count as native qualification.
  tar --create --gzip --file "$work/native-prototype.tar.gz" --directory "$output" .
  mv "$work/native-prototype.tar.gz" "$output/"
  (cd "$output" && sha256sum native-prototype.tar.gz > native-prototype.tar.gz.sha256)
  exit "$status"
}
trap seal_artifact EXIT
node --input-type=module - "$plan" "$output/build-host.json" <<'JS'
import fs from 'node:fs';import os from 'node:os';import assert from 'node:assert/strict';
const p=JSON.parse(fs.readFileSync(process.argv[2])),host={platform:process.platform,arch:process.arch,cpus:os.cpus().length,memoryBytes:os.totalmem()};
fs.writeFileSync(process.argv[3],JSON.stringify(host,null,2)+'\n');
assert.equal(host.arch,'x64');assert.equal(host.cpus,p.buildExpectedCpus);assert(host.memoryBytes>=p.buildMinimumMemoryBytes);
JS
test ! -e "$vendor_root"
mkdir -p "$vendor_root"

# Vendor wx-config embeds this original build prefix. Preserve it explicitly;
# changing it or silently substituting another dependency archive is not allowed.
gh api "repos/bambulab/BambuStudio/actions/artifacts/$artifact_id" > "$work/vendor-artifact.json"
node --input-type=module - "$plan" "$work/vendor-artifact.json" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const p=JSON.parse(fs.readFileSync(process.argv[2])),a=JSON.parse(fs.readFileSync(process.argv[3]));
assert.equal(a.id,p.vendorDependencyArtifactId);assert.equal(a.expired,false);
assert.equal(a.digest,'sha256:'+p.vendorDependencyArtifactSha256);
assert.equal(a.workflow_run.id,p.vendorDependencyRunId);
assert.equal(a.workflow_run.head_repository_id,p.vendorRepositoryId);
assert.equal(a.workflow_run.head_sha,p.vendorDependencyRevision);
JS
for commit in "$revision" "$(value vendorDependencyRevision)"; do
  gh api "repos/bambulab/BambuStudio/git/trees/$commit" > "$work/tree-$commit.json"
done
node --input-type=module - "$plan" "$work" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const p=JSON.parse(fs.readFileSync(process.argv[2])),root=process.argv[3];
const trees=[p.upstreamCommit,p.vendorDependencyRevision].map(c=>JSON.parse(fs.readFileSync(root+'/tree-'+c+'.json')).tree);
for(const name of ['deps','linux.d','BuildLinux.sh','CMakeLists.txt','.github'])
 assert.equal(trees[0].find(e=>e.path===name)?.sha,trees[1].find(e=>e.path===name)?.sha,'Vendor build source changed: '+name);
assert.equal(trees[0].find(e=>e.path==='deps').sha,p.matchingDependencyTree);
JS
gh api "repos/bambulab/BambuStudio/actions/artifacts/$artifact_id/zip" > "$work/vendor-dependencies.zip"
printf '%s  %s\n' "$(value vendorDependencyArtifactSha256)" "$work/vendor-dependencies.zip" | sha256sum --check --strict
python3 - "$work/vendor-dependencies.zip" "$work/vendor-dependencies.tar.gz" <<'PY'
import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert len(archive.namelist()) == 1
    with open(sys.argv[2], 'wb') as output: output.write(archive.read(archive.namelist()[0]))
PY
printf '%s  %s\n' "$(value vendorDependencyArchiveSha256)" "$work/vendor-dependencies.tar.gz" | sha256sum --check --strict
curl --fail --location --proto '=https' --tlsv1.2 "https://codeload.github.com/bambulab/BambuStudio/tar.gz/$revision" --output "$work/upstream.tar.gz"
printf '%s  %s\n' "$(value upstreamSourceSha256)" "$work/upstream.tar.gz" | sha256sum --check --strict
tar --extract --gzip --file "$work/upstream.tar.gz" --directory "$vendor_root" --strip-components=1 --no-same-owner
mkdir -p "$vendor_root/deps/build"
tar --extract --gzip --file "$work/vendor-dependencies.tar.gz" --directory "$vendor_root/deps/build" --no-same-owner

cmake -S "$vendor_root" -B "$vendor_root/build" -G Ninja \
  -DCMAKE_PREFIX_PATH="$vendor_root/deps/build/destdir/usr/local" \
  -DSLIC3R_STATIC=1 -DSLIC3R_GTK=3 -DBBL_RELEASE_TO_PUBLIC=1 \
  -DBBL_INTERNAL_TESTING=0 -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  > "$output/configure.log" 2>&1
cmake --build "$vendor_root/build" --target BambuStudio --parallel "$jobs" > "$output/control-build.log" 2>&1
cp "$vendor_root/build/src/bambu-studio" "$output/bin/control"
(cd "$vendor_root" && git apply --check "$task_root/native/bambu/seam-visibility-reuse.patch")
(cd "$vendor_root" && git apply "$task_root/native/bambu/seam-visibility-reuse.patch")
cmp "$task_root/native/bambu/SeamVisibilityReuse.hpp" "$vendor_root/src/libslic3r/GCode/SeamVisibilityReuse.hpp"
cmake --build "$vendor_root/build" --target BambuStudio --parallel "$jobs" > "$output/candidate-build.log" 2>&1
cp "$vendor_root/build/src/bambu-studio" "$output/bin/candidate"
ldd "$output/bin/control" > "$output/control-ldd.txt"
ldd "$output/bin/candidate" > "$output/candidate-ldd.txt"
! grep -F 'not found' "$output/control-ldd.txt" "$output/candidate-ldd.txt"

# Keep only dependencies resolved from the verified vendor prefix. System ABI
# dependencies are recorded, not replaced by arbitrary libraries on the worker.
python3 - "$vendor_root" "$output" <<'PY'
import pathlib,re,sys,shutil
prefix=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2])
for line in (out/'candidate-ldd.txt').read_text().splitlines():
    match=re.search(r'=> (\S+) \(',line)
    if match:
        p=pathlib.Path(match[1])
        if p.resolve().is_relative_to(prefix): shutil.copy2(p,out/'lib'/p.name)
PY
mkdir -p "$output/resources"
rsync -a --exclude web/ "$vendor_root/resources/" "$output/resources/"
c++ -std=c++17 -Wall -Wextra -Werror -UNDEBUG -fsanitize=address,undefined \
  "$task_root/native/bambu/visibility-cache-test.cpp" -o "$work/cache-test"
"$work/cache-test" > "$output/cache-test.txt" 2>&1
export LD_LIBRARY_PATH="$output/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
(cd "$work" && "$output/bin/control" --help > "$output/control-help.txt")
(cd "$work" && "$output/bin/candidate" --help > "$output/candidate-help.txt")
grep -F 'BambuStudio-02.08.02.61:' "$output/control-help.txt" "$output/candidate-help.txt"
cp "$plan" "$work/vendor-artifact.json" "$task_root/native/bambu/seam-visibility-reuse.patch" "$output/"
cp "$vendor_root/build/CMakeCache.txt" "$output/"
dpkg-query -W > "$output/build-packages.txt"
node --input-type=module - "$output" <<'JS'
import fs from 'node:fs';import crypto from 'node:crypto';import path from 'node:path';import child from 'node:child_process';
const root=process.argv[2],hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const files=['bin/control','bin/candidate','seam-visibility-reuse.patch','CMakeCache.txt','vendor-artifact.json'];
fs.writeFileSync(path.join(root,'build-evidence.json'),JSON.stringify({schema:'am-pilot-bambu-native-prototype-build',version:1,sourceRevision:process.env.GITHUB_SHA,repository:process.env.GITHUB_REPOSITORY,runId:process.env.GITHUB_RUN_ID,compiler:child.execFileSync('c++',['--version'],{encoding:'utf8'}).split('\n')[0],files:Object.fromEntries(files.map(p=>[p,hash(path.join(root,p))])),productionActivation:false},null,2)+'\n');
JS
(cd "$output" && sha256sum bin/control bin/candidate seam-visibility-reuse.patch build-evidence.json > SHA256SUMS)
