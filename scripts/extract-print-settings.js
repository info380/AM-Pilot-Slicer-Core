import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
// SPDX-License-Identifier: AGPL-3.0-or-later
// Generator for the pinned PrusaSlicer Print tab metadata; stdout is JSON.
const src = process.argv[2];
if (!src) throw new Error('Usage: node scripts/extract-print-settings.js <PrusaSlicer src directory>');
const checksums = {
  "libslic3r/PrintConfig.cpp": "59c38a3b10d45eb26b19130e4bb80142712a587c6fa18b572aade07b3e1455e8",
  "slic3r/GUI/Tab.cpp": "ab7ee3b10bfb9919dc5b085ee952745d83ca4b9ad37f42a499ab15aea0476492"
};
for (const [path, expected] of Object.entries(checksums)) {
  if (createHash('sha256').update(readFileSync(src+'/'+path)).digest('hex') !== expected) throw new Error('Unpinned upstream source: '+path);
}
const config = readFileSync(`${src}/libslic3r/PrintConfig.cpp`, 'utf8');
const tab = readFileSync(`${src}/slic3r/GUI/Tab.cpp`, 'utf8').split('void TabPrint::build()')[1].split('void TabPrint::update_description_lines()')[0];
const strings = text => [...text.matchAll(/"(?:\\.|[^"\\])*"/g)].map(m => JSON.parse(m[0]));
const property = (block, key) => {
  const match = block.match(new RegExp(`def->${key}\\s*=\\s*([^;]+);`));
  return match ? strings(match[1]).join('') : '';
};
const definitions = new Map();
for (const match of config.matchAll(/def\s*=\s*this->add\("([^"]+)",\s*(\w+)\);([\s\S]*?)(?=\n[^\n]*?def\s*=\s*this->add\(|$)/g)) {
  if (!definitions.has(match[1])) definitions.set(match[1], { type: match[2], block: match[3] });
}
let page = '', group = '';
const entries = new Map();
const invalid = [];
for (const line of tab.split('\n')) {
  if (line.trim().startsWith('//')) continue;
  const p = line.match(/add_options_page\(L\("([^"]+)"/); if (p) page = p[1];
  const g = line.match(/new_optgroup\(L\("([^"]+)"/); if (g) group = g[1];
  const key = line.match(/(?:append_single_option_line\(|get_option\(|create_line_with_widget\(optgroup.get\(\),\s*)"([^"]+)"/)?.[1];
  if (!key || entries.has(key)) continue;
  const definition = definitions.get(key);
  if (!definition) { invalid.push({ key, error: 'missing definition' }); continue; }
  const { type, block } = definition;
  const field = { key, page, group, label: property(block, 'full_label') || property(block, 'label'), type, unit: property(block, 'sidetext') };
  for (const bound of ['min', 'max']) {
    const value = block.match(new RegExp(`def->${bound}\\s*=\\s*([-+0-9.e]+)\\s*;`));
    if (value) field[bound] = Number(value[1]);
  }
  const d = block.match(/set_default_value\(new ConfigOption\w+(?:<([^>]+)>)?\s*[({]([^;]*?)[)}]\);/);
  if (d) {
    const value = d[2].trim();
    if (type === 'coFloatOrPercent') { const [n, pct] = value.split(',').map(s => s.trim()); field.defaultValue = pct === 'true' ? `${Number(n)}%` : Number(n); }
    else if (type === 'coBool') field.defaultValue = value === 'true';
    else if (['coFloat', 'coInt', 'coPercent'].includes(type)) field.defaultValue = Number(value.replace(/f$/, ''));
    else if (type === 'coString') field.defaultValue = strings(value).join('');
    else if (type === 'coEnum') {
      const enumBlock = block.match(/set_enum<[^>]+>\(\{([\s\S]*?)\}\);/)?.[1];
      field.options = enumBlock ? [...enumBlock.matchAll(/\{\s*"([^"]+)",\s*(?:L\()?"([^"]+)"/g)].map(m => ({ value: m[1], label: m[2] })) : [];
      const enumMap = config.match(new RegExp(`s_keys_map_${d[1]}\\s*=?\\s*\\{([\\s\\S]*?)\\};`))?.[1] || '';
      const symbol = value.split('::').pop();
      field.defaultValue = [...enumMap.matchAll(/\{\s*"([^"]+)",([^\n]+)\}/g)].find(m => m[2].includes(symbol))?.[1];
    }
  }
  if (['coStrings', 'coFloats', 'coInts', 'coBools'].includes(type)) {
    const values = block.match(/set_default_value\(new ConfigOption\w+\s*\{([^;]*?)\}\);/);
    if (values) field.defaultValue = type === 'coStrings' ? strings(values[1]) : values[1].trim() ? values[1].split(',').map(Number) : [];
    else if (d && !d[2].trim()) field.defaultValue = [];
  }
  if (key === 'bottom_fill_pattern') field.options = entries.get('top_fill_pattern').options;
  field.ratioOver = property(block, 'ratio_over');
  field.mode = block.match(/def->mode\s*=\s*(\w+)/)?.[1] || '';
  if (field.defaultValue === undefined || (typeof field.defaultValue === 'number' && !Number.isFinite(field.defaultValue))) invalid.push({ key, type, default: d?.[2] });
  field.upstreamHelp = property(block, 'tooltip');
  if (key.startsWith('overhang_speed_')) field.upstreamHelp = strings(config.match(/auto overhang_speed_setting_description = L\(([\s\S]*?)\);/)[1]).join('');
  entries.set(key, field);
}
if (invalid.length || entries.size !== 195) throw new Error(JSON.stringify({count:entries.size, invalid}));
const metadata = { ...{"schema":"am-pilot-prusa-print-settings-catalog","version":1,"upstream":{"project":"PrusaSlicer","version":"2.9.3","revision":"f1776c0a6347bb84986d10eac8db1021f5bd8548","license":"AGPL-3.0-or-later","files":["src/libslic3r/PrintConfig.cpp","src/slic3r/GUI/Tab.cpp"]}}, fields: [...entries.values()] };
process.stdout.write(JSON.stringify(metadata, null, 2)+'\n');
