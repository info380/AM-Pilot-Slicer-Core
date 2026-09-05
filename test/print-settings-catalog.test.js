import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const catalog = JSON.parse(readFileSync(new URL('../schemas/prusa-print-settings-2.9.3.json', import.meta.url)));

test('pinned Print Settings metadata is complete, typed and attributed', () => {
  assert.equal(catalog.upstream.revision, 'f1776c0a6347bb84986d10eac8db1021f5bd8548');
  assert.equal(catalog.upstream.license, 'AGPL-3.0-or-later');
  assert.equal(catalog.fields.length,195);
  assert.equal(new Set(catalog.fields.map(field=>field.key)).size,195);
  for (const field of catalog.fields) {
    assert.ok(field.page && field.group && field.label,field.key);
    assert.ok(Object.hasOwn(field,'defaultValue'),field.key);
    assert.equal(typeof field.upstreamHelp,'string');
    if(field.type==='coEnum')assert.ok(field.options.some(option=>option.value===field.defaultValue),field.key);
  }
});
test('generator refuses unpinned source trees', () => {
  assert.throws(()=>execFileSync(process.execPath,['scripts/extract-print-settings.js','schemas'],{stdio:'pipe'}));
});
