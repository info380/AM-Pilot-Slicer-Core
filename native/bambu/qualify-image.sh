#!/usr/bin/env bash
set -euo pipefail
readonly image="${1:?An exact image or local qualification tag is required}"
readonly output="${2:?An empty output directory is required}"
readonly archive="${3:?The verified native build archive is required}"
test ! -e "$output"
mkdir -p "$output"
chmod 0777 "$output"
readonly root="$(pwd)"
readonly controls="$(mktemp -d)"
base_container=''
cleanup() {
  if [[ -n "$base_container" ]]; then docker rm -f "$base_container" >/dev/null; fi
  rm -rf "$controls"
}
trap cleanup EXIT
value() { node -p "require('./native/bambu/runtime-plan.json')['$1']"; }
verify_sha() { node -e "require('assert/strict').equal(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'),process.argv[2])" "$1" "$2"; }
verify_sha "$archive" "$(value artifactTarSha256)"
mkdir -p "$controls/control/bin" "$controls/stock/bin"
tar -xOf "$archive" ./bin/control > "$controls/control/bin/bambu-studio"
base_container="$(docker create "$(value runtimeBaseImage)")"
docker cp "$base_container:/opt/bambu/bin/bambu-studio" "$controls/stock/bin/bambu-studio"
verify_sha "$controls/control/bin/bambu-studio" "$(value controlBinarySha256)"
verify_sha "$controls/stock/bin/bambu-studio" "$(value stockBinarySha256)"
cp -R native/bambu/runtime/native-lib "$controls/lib"
for label in control stock; do
  # Native CLI resource lookup is relative to the executable. All three builds
  # must use the same installed profiles, including their CLI safety limits.
  ln -s /opt/bambu/resources "$controls/$label/resources"
  cat > "$controls/$label-AppRun" <<EOF
#!/bin/sh
set -eu
export LD_LIBRARY_PATH=/native-controls/lib:/opt/bambu/bin
export LC_ALL=C
exec /native-controls/$label/bin/bambu-studio "\$@"
EOF
done
chmod 0755 "$controls" "$controls/control/bin/bambu-studio" "$controls/stock/bin/bambu-studio" "$controls/control-AppRun" "$controls/stock-AppRun"
docker run --rm --platform linux/amd64 --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --cpus 1 \
  --memory 2g --memory-swap 2g --pids-limit 256 \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --mount type=bind,src="$root",dst=/qualification,readonly \
  --mount type=bind,src="$controls",dst=/native-controls,readonly \
  --mount type=bind,src="$output",dst=/qualification-output \
  "$image" node --input-type=module --eval '
    import fs from "node:fs";
    const { qualify } = await import("/qualification/native/bambu/qualify-prototype.mjs");
    await qualify({control:"/native-controls/control-AppRun",official:"/native-controls/stock-AppRun",candidate:"/opt/bambu/AppRun",resources:"/opt/bambu/resources/profiles/BBL",output:"/qualification-output/cases"});
    fs.writeFileSync("/qualification-output/resources.json",JSON.stringify({cpuMax:fs.readFileSync("/sys/fs/cgroup/cpu.max","utf8").trim(),memoryMax:fs.readFileSync("/sys/fs/cgroup/memory.max","utf8").trim(),memoryPeakBytes:Number(fs.readFileSync("/sys/fs/cgroup/memory.peak","utf8")),memoryEvents:fs.readFileSync("/sys/fs/cgroup/memory.events","utf8").trim()}));
  '
