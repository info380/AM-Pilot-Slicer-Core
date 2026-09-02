export const ENGINE_KEY = 'fdm.am_pilot_prusa_core';
export const WORKER_PROTOCOL_VERSION = 1;
export const RESULT_MANIFEST_SCHEMA = 'am-pilot-slicer-result-manifest';
export const RESULT_MANIFEST_VERSION = 1;
export const INPUT_SNAPSHOT_SCHEMA = 'am-pilot-slicer-input-snapshot';
export const INPUT_SNAPSHOT_VERSION = 1;
export const EFFECTIVE_CONFIG_SCHEMA = 'am-pilot-slicer-effective-config';
export const EFFECTIVE_CONFIG_VERSION = 6;
export const PRUSA_SLICER_VERSION = '2.9.3';
export const PRUSA_SLICER_UPSTREAM_COMMIT = 'f1776c0a6347bb84986d10eac8db1021f5bd8548';
export const PRUSA_SLICER_SOURCE_SHA256 = 'fe6c6696360c688f3ac6744964d5c27d98394da3e3cd00a8b8df7bc3fd4f7055';

export const GCODE_CONTENT_TYPE = 'text/x.gcode';
export const MANIFEST_CONTENT_TYPE = 'application/vnd.am-pilot.slicer-result+json';

export const DEFAULTS = Object.freeze({
  pollIntervalMs: 3_000,
  heartbeatIntervalMs: 20_000,
  requestTimeoutMs: 30_000,
  jobTimeoutMs: 1_200_000,
  maximumModelBytes: 536_870_912,
  maximumGcodeBytes: 536_870_912,
  maximumManifestBytes: 1_048_576,
  maximumObjectsPerPlate: 1_000,
  maximumModelsPerRun: 1_000,
  maximumLogBytes: 262_144,
  engineThreads: 1,
  retryBackoffMaximumMs: 30_000
});
