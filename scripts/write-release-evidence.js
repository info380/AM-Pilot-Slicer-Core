import fs from 'node:fs';

import {
  ENGINE_KEY,
  GMP_SOURCE_SHA256,
  GMP_VERSION,
  PRUSA_SLICER_SOURCE_SHA256,
  PRUSA_SLICER_UPSTREAM_COMMIT,
  PRUSA_SLICER_VERSION,
  WORKER_PROTOCOL_VERSION
} from '../src/constants.js';

const [digest, outputPath] = process.argv.slice(2);
if (!/^sha256:[0-9a-f]{64}$/.test(digest || '') || !outputPath) {
  throw new Error('Usage: write-release-evidence.js sha256:<digest> <output-path>');
}

const releaseBaseUrl = process.env.GITHUB_SERVER_URL
  && process.env.GITHUB_REPOSITORY
  && process.env.GITHUB_REF_NAME
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/releases/download/${encodeURIComponent(process.env.GITHUB_REF_NAME)}`
  : null;
const releaseAssetUrl = filename => releaseBaseUrl ? `${releaseBaseUrl}/${filename}` : null;

const evidence = {
  schema: 'am-pilot-slicer-core-release-evidence',
  version: 1,
  engineKey: ENGINE_KEY,
  semanticVersion: process.env.GITHUB_REF_NAME || 'unversioned',
  imageDigest: digest,
  workerProtocolVersion: WORKER_PROTOCOL_VERSION,
  capabilityRevisionId: 'fdm-prusa-2.9.3-protocol1-r1',
  source: {
    repository: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
      : null,
    revision: process.env.GITHUB_SHA || null,
    prusaSlicerVersion: PRUSA_SLICER_VERSION,
    prusaSlicerUpstreamCommit: PRUSA_SLICER_UPSTREAM_COMMIT,
    prusaSlicerSourceArchiveChecksumSha256: PRUSA_SLICER_SOURCE_SHA256,
    gmpVersion: GMP_VERSION,
    gmpSourceArchiveChecksumSha256: GMP_SOURCE_SHA256
  },
  build: {
    workflowRun: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
    provenance: 'OCI BuildKit provenance and GitHub artifact attestation attached to the digest',
    sbom: 'OCI SPDX SBOM attached to the digest',
    signature: 'Sigstore keyless signature attached to the digest',
    vulnerabilityScan: 'Trivy SARIF uploaded by the release workflow'
  },
  artifacts: {
    checksums: releaseAssetUrl('EVIDENCE_SHA256SUMS'),
    sourceChecksums: releaseAssetUrl('SHA256SUMS'),
    amPilotSource: releaseAssetUrl(`AM-Pilot-Slicer-Core-${process.env.GITHUB_SHA}.tar.gz`),
    prusaSlicerSource: releaseAssetUrl(`PrusaSlicer-${PRUSA_SLICER_UPSTREAM_COMMIT}.tar.gz`),
    gmpSource: releaseAssetUrl(`gmp-${GMP_VERSION}.tar.bz2`),
    binaryChecksum: releaseAssetUrl('prusa-slicer-binary.SHA256'),
    sbom: releaseAssetUrl('sbom.spdx.json'),
    provenance: releaseAssetUrl('provenance.slsa.json'),
    signatureVerification: releaseAssetUrl('signature-verification.json'),
    vulnerabilityScan: releaseAssetUrl('trivy-results.sarif'),
    notices: releaseAssetUrl('THIRD_PARTY_NOTICES.md'),
    sourceOffer: releaseAssetUrl('SOURCE_OFFER.md')
  },
  qualification: {
    status: 'candidate',
    legalReview: 'required outside this repository',
    securityReview: 'required outside this repository',
    regressionCorpus: 'required outside this repository',
    physicalPrint: 'required outside this repository'
  }
};

fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
