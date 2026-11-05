import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolpaths, compareToolpaths } from './toolpath-comparison.mjs';

const prefix = 'G90\nM83\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\nG1 Z.2\n';
const wall = (x, reverse = false) => `G1 X${x} Y0\n; FEATURE: Outer wall\n${reverse ? `G1 X${x} Y1 E.1\nG1 X${x + 1} Y1 E.1\nG1 X${x + 1} Y0 E.1\nG1 X${x} Y0 E.1` : `G1 X${x + 1} Y0 E.1\nG1 X${x + 1} Y1 E.1\nG1 X${x} Y1 E.1\nG1 X${x} Y0 E.1`}\n`;

test('ordering changes preserve deposited geometry and per-contour seam starts', () => {
  const a = summarizeToolpaths(prefix + wall(0) + wall(10));
  const b = summarizeToolpaths(prefix + wall(10) + wall(0));
  assert.deepEqual(compareToolpaths(a, b), { layersMatch: true, seamsMatch: true, changedFeatureLayers: [] });
});

test('reversing a closed wall preserves segments but changes its seam direction', () => {
  const result = compareToolpaths(summarizeToolpaths(prefix + wall(0)), summarizeToolpaths(prefix + wall(0, true)));
  assert.deepEqual(result, { layersMatch: true, seamsMatch: false, changedFeatureLayers: [] });
});

test('deposited movement modes and extrusion resets produce the same evidence', () => {
  const absolute = prefix + wall(0);
  const relative = prefix + 'G1 X0 Y0\nM82\nG92 E5\n; FEATURE: Outer wall\nG91\nG1 X1 E5.1\nG1 Y1 E5.2\nG1 X-1 E5.3\nG1 Y-1 E5.4\n';
  assert.deepEqual(compareToolpaths(summarizeToolpaths(absolute), summarizeToolpaths(relative)), { layersMatch: true, seamsMatch: true, changedFeatureLayers: [] });
});

test('changed modifiers, positions and extrusion amounts cannot pass geometry comparison', () => {
  const a = summarizeToolpaths(prefix + wall(0));
  for (const candidate of [prefix + wall(1), (prefix + wall(0)).replace('E.1', 'E.2'), (prefix + wall(0)).replace('Z_HEIGHT: 0.2', 'Z_HEIGHT: 0.3')]) {
    const result = compareToolpaths(a, summarizeToolpaths(candidate));
    assert(!result.layersMatch || result.changedFeatureLayers.length > 0);
  }
});

test('native arcs retain their direction and center without approximation', () => {
  const arc = (prefix + wall(0)).replace('G1 X1 Y0 E.1', 'G2 X1 Y0 I.5 J0 E.1');
  const a = summarizeToolpaths(arc);
  assert.deepEqual(compareToolpaths(a, summarizeToolpaths(arc)), { layersMatch: true, seamsMatch: true, changedFeatureLayers: [] });
  for (const change of [arc.replace('I.5', 'I.4'), arc.replace('G2', 'G3')]) assert(compareToolpaths(a, summarizeToolpaths(change)).changedFeatureLayers.length);
  const circle = arc.replace('G2 X1 Y0 I.5 J0 E.1', 'G2 X0 Y0 I.5 J0 E.1');
  assert(compareToolpaths(summarizeToolpaths(circle), summarizeToolpaths(circle.replace('I.5', 'I.4'))).changedFeatureLayers.length);
  assert.throws(() => summarizeToolpaths('G90.1\n' + arc), /Unsupported arc/);
  assert.deepEqual(summarizeToolpaths(prefix + wall(0)), summarizeToolpaths((prefix + wall(0)).replace('G1 X0 Y0', 'G2 X0 Y0 I0 J0')));
});

test('malformed native coordinates fail closed', () => {
  for (const value of ['NaN', 'Infinity', '1e3']) assert.throws(() => summarizeToolpaths((prefix + wall(0)).replace('X1 Y0 E.1', `X${value} Y0 E.1`)), /Unsupported native movement/);
  assert.throws(() => summarizeToolpaths((prefix + wall(0)).replace('X1 Y0 E.1', 'X1 X2 Y0 E.1')), /Duplicate native/);
  assert.throws(() => summarizeToolpaths((prefix + wall(0)).replace('G1 X1 Y0 E.1', 'G2 X1 Y0 E.1')), /lacks center/);
});
