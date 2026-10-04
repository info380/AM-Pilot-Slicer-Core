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

const bambu = JSON.parse(readFileSync(new URL('../schemas/bambu-print-settings-2.8.2.61.json', import.meta.url)));
test('native Bambu Print tab catalog preserves typed source definitions',()=>{
 assert.equal(bambu.fields.length,259);
 assert.equal(new Set(bambu.fields.map(f=>f.key)).size,bambu.fields.length);
 assert.equal(bambu.upstream.revision,'926a7192574bcb9b3a732e1ec59a46d79cb45466');
 for(const field of bambu.fields){
  assert.ok(field.label&&field.page&&field.group&&field.valueType,field.key);
  assert.ok(Object.hasOwn(field,'defaultValue'),field.key);
  if(field.type==='coEnum')assert.ok(field.options.some(o=>o.value===field.defaultValue),field.key);
 }
});
