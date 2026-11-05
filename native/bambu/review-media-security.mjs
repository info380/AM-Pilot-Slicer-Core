import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const hash = b => createHash('sha256').update(b).digest('hex');
export function reviewAdvisories({ feed, policy, evidence }) {
  assert.equal(feed.format, 'NVD_CVE'); assert.equal(feed.version, '2.0');
  assert(Number.isSafeInteger(feed.totalResults) && feed.totalResults >= 0);
  const timestamp = Date.parse(feed.timestamp.endsWith('Z') ? feed.timestamp : feed.timestamp + 'Z');
  assert(Number.isFinite(timestamp) && policy.maximumFeedAgeSeconds > 0 && policy.maximumFutureSkewSeconds >= 0);
  assert(Date.now() - timestamp <= policy.maximumFeedAgeSeconds * 1000, 'Stale native advisory feed');
  assert(timestamp - Date.now() <= policy.maximumFutureSkewSeconds * 1000, 'Native advisory feed timestamp is in the future');
  assert.equal(policy.sourceSha256, evidence.sourceSha256);
  assert.equal(policy.upstreamVersion, evidence.upstreamVersion);
  assert.equal(feed.totalResults, feed.vulnerabilities.length, 'Truncated advisory feed');
  const known = new Map(policy.advisories.map(item => [item.id, item]));
  assert.equal(known.size, policy.advisories.length, 'Duplicate native advisory review');
  const reviewed = [];
  for (const { cve } of feed.vulnerabilities) {
    const severities = Object.values(cve.metrics ?? {}).flat().map(item => item.cvssData?.baseSeverity ?? item.baseSeverity).filter(Boolean);
    assert(severities.length, 'Unscored native dependency advisory: ' + cve.id);
    if (!severities.some(value => ['HIGH', 'CRITICAL'].includes(value))) continue;
    const item = known.get(cve.id); assert(item, 'Unreviewed high/critical native dependency advisory: ' + cve.id);
    const required = { 'disabled-parser': ['parserCount', 0], 'disabled-codec': ['codecCount', 0], 'unshipped-filter': ['avfilter', false], 'unshipped-format': ['avformat', false], 'unshipped-tools': ['programs', false] }[item.reason];
    assert(required, 'Unknown source exclusion'); assert.equal(evidence[required[0]], required[1]);
    reviewed.push({ ...item, status: 'not_affected', justification: 'vulnerable_code_not_present' });
  }
  return { schema: 'am-pilot-headless-ffmpeg-security-evidence', version: 1, generatedAt: new Date().toISOString(), sourceSha256: evidence.sourceSha256, nativeMediaSourceRevision: evidence.sourceRevision, totalAdvisories: feed.totalResults, highCriticalReviewed: reviewed.length, unknownHighCriticalAllowed: false, severityWaivers: false, formalProductionApproval: false, reviewed };
}

export async function inspectReducedRuntime(root, plan) {
  const evidence = JSON.parse(await fs.readFile(path.join(root, 'native-media-build-evidence.json'), 'utf8'));
  assert.equal(evidence.sourceRevision, plan.media.nativeSourceRevision);
  assert.equal(evidence.sourceSha256, plan.media.sourceSha256);
  assert.deepEqual(evidence.libraries, plan.libraries);
  const verifiedLibraryFiles = [];
  for (const [name, checksum] of Object.entries(plan.libraries)) {
    const bytes = await fs.readFile(path.join(root, 'native-lib', name)); assert.equal(hash(bytes), checksum);
    verifiedLibraryFiles.push({ name, sha256: checksum, sha1: createHash('sha1').update(bytes).digest('hex') });
  }
  for (const key of ['parserCount', 'codecCount', 'bitstreamFilterCount']) assert.equal(evidence[key], 0);
  for (const key of ['programs', 'network', 'avformat', 'avfilter', 'avdevice']) assert.equal(evidence[key], false);
  for (const name of ['parser', 'codec', 'bsf']) {
    const text = await fs.readFile(path.join(root, 'native-media-' + name + '-list.c'), 'utf8'); assert(!/\bff_[A-Za-z0-9_]+/.test(text)); assert.match(text, /NULL/);
  }
  const config = await fs.readFile(path.join(root, 'native-media-config.h'), 'utf8');
  for (const name of ['AVFORMAT', 'AVFILTER', 'AVDEVICE', 'NETWORK', 'AUTODETECT']) assert.match(config, new RegExp('#define CONFIG_' + name + ' 0(?:\\n|$)'));
  const components = await fs.readFile(path.join(root, 'native-media-components.h'), 'utf8');
  assert.match(components, /#define CONFIG_DVBSUB_PARSER 0(?:\n|$)/);
  assert(!/#define CONFIG_\w+_(?:PARSER|DECODER|ENCODER|HWACCEL|BSF) 1\b/.test(components), 'Media processing component enabled');
  const libraries = await fs.readdir(path.join(root, 'native-lib'));
  assert.deepEqual(libraries.sort(), Object.keys(plan.libraries).sort(), 'Unreviewed native library');
  return { ...evidence, verifiedLibraryFiles };
}

export function nativeMediaSbom(evidence, plan, created) {
  const files = evidence.verifiedLibraryFiles, packageId = 'SPDXRef-FFmpeg';
  return {
    spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT',
    name: 'AM Pilot headless FFmpeg runtime', documentNamespace: 'https://am-pilot.com/spdx/headless-ffmpeg/' + plan.media.artifactTarSha256,
    creationInfo: { creators: ['Tool: AM-Pilot-native-runtime-review'], created },
    packages: [{
      name: 'FFmpeg', SPDXID: packageId, versionInfo: evidence.upstreamVersion, downloadLocation: 'NOASSERTION', filesAnalyzed: true,
      packageVerificationCode: { packageVerificationCodeValue: createHash('sha1').update(files.map(file => file.sha1).sort().join('')).digest('hex') },
      licenseConcluded: 'LGPL-2.1-or-later', licenseDeclared: 'LGPL-2.1-or-later', copyrightText: 'NOASSERTION',
      sourceInfo: 'Exact source ' + evidence.sourceSha256 + '; reduced build ' + evidence.sourceRevision + '; all media parsers/codecs/formats/filters/programs/network disabled',
      externalRefs: [
        { referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:generic/ffmpeg@' + evidence.upstreamVersion },
        { referenceCategory: 'SECURITY', referenceType: 'cpe23Type', referenceLocator: 'cpe:2.3:a:ffmpeg:ffmpeg:' + evidence.upstreamVersion + ':*:*:*:*:*:*:*' }
      ]
    }],
    files: files.map((file, index) => ({
      fileName: '/opt/bambu/native-lib/' + file.name, SPDXID: 'SPDXRef-NativeLibrary-' + index,
      checksums: [{ algorithm: 'SHA256', checksumValue: file.sha256 }, { algorithm: 'SHA1', checksumValue: file.sha1 }],
      licenseConcluded: 'LGPL-2.1-or-later', licenseInfoInFiles: ['LGPL-2.1-or-later'], copyrightText: 'NOASSERTION'
    })),
    relationships: [
      { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: packageId },
      ...files.map((_, index) => ({ spdxElementId: packageId, relationshipType: 'CONTAINS', relatedSpdxElement: 'SPDXRef-NativeLibrary-' + index }))
    ]
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, feedPath, output] = process.argv.slice(2);
  assert(root && feedPath && output, 'Explicit reduced runtime, NVD feed and evidence output are required');
  const plan = JSON.parse(await fs.readFile(new URL('runtime-plan.json', import.meta.url), 'utf8'));
  const policy = JSON.parse(await fs.readFile(new URL('media-security-review.json', import.meta.url), 'utf8'));
  const evidence = await inspectReducedRuntime(root, plan);
  const feed = JSON.parse(await fs.readFile(feedPath, 'utf8'));
  const report = reviewAdvisories({ feed, policy, evidence });
  report.advisoryFeedSha256 = hash(await fs.readFile(feedPath));
  report.sourceReviewSha256 = hash(await fs.readFile(new URL('media-security-review.json', import.meta.url)));
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(path.dirname(output), 'native-media.spdx.json'), JSON.stringify(nativeMediaSbom(evidence, plan, report.generatedAt), null, 2) + '\n');
}
