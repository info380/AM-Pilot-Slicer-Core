// SPDX-License-Identifier: AGPL-3.0-or-later
// Import protocol metadata from the exact engine source; never execute upstream code.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = process.argv[2];
if (!root) throw new Error('Usage: node scripts/extract-bambu-print-settings.js <BambuStudio src>');
const hashes = {
  'libslic3r/PrintConfig.cpp': 'd4e96aaca40b0698de720537ba0d2af46efbb576e183507c763c0654e394e99c',
  'slic3r/GUI/Tab.cpp': 'f65f2680f364ccfe7ee74da9a7b43b64878c3c486b0d54fda9134ac670c83bf9'
};
const sources = Object.fromEntries(Object.entries(hashes).map(([file, hash]) => {
  const bytes = readFileSync(`${root}/${file}`);
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Unpinned source: ${file}`);
  return [file, bytes.toString('utf8')];
}));
const config = sources['libslic3r/PrintConfig.cpp'];
const tab = sources['slic3r/GUI/Tab.cpp'].split('void TabPrint::build()')[1].split('void TabPrint::reload_config()')[0];
const strings = value => [...value.matchAll(/"(?:\\.|[^"\\])*"/g)].map(m => JSON.parse(m[0]));
const property = (block, key) => strings(block.match(new RegExp(`def->${key}\\s*=\\s*([^;]+);`))?.[1] || '').join('');
const definitions = new Map([...config.matchAll(/def\s*=\s*this->add\("([^"]+)",\s*(\w+)\);([\s\S]*?)(?=\n[^\n]*?def\s*=\s*this->add\(|$)/g)].map(m => [m[1], { type:m[2], block:m[3] }]));
const fields = new Map(), invalid = [];
let page='', group='', conditional=[];
for (const line of tab.split('\n')) {
  if (line.trim().startsWith('//')) continue;
  if (/^\s*#if/.test(line)) conditional.push(line.trim());
  if (/^\s*#endif/.test(line)) conditional.pop();
  if (conditional.includes('#if 0')) continue;
  page = line.match(/add_options_page\(L\("([^"]+)"/)?.[1] || page;
  group = line.match(/new_optgroup\(L\("([^"]+)"/)?.[1] || group;
  const key = line.match(/(?:append_single_option_line|get_option)\("([^"]+)"/)?.[1];
  if (!key || fields.has(key)) continue;
  const definition = definitions.get(key);
  if (!definition) {invalid.push({key,error:'missing definition'});continue;}
  const {type,block} = definition;
  const field={key,page,group,label:property(block,'full_label')||property(block,'label'),type,unit:property(block,'sidetext'),upstreamHelp:property(block,'tooltip'),ratioOver:property(block,'ratio_over'),mode:block.match(/def->mode\s*=\s*(\w+)/)?.[1]||''};
  if (conditional.length) field.compileConditions=[...conditional];
  for (const bound of ['min','max']) {
    const value=block.match(new RegExp(`def->${bound}\\s*=\\s*([-+0-9.e]+)\\s*;`));
    if(value)field[bound]=Number(value[1]);
  }
  const d=block.match(/set_default_value\(new ConfigOption\w+(?:<([^>]+)>)?\s*[({]([^;]*?)[)}]\);/);
  let value=d?.[2].trim();
  const scalar = type.replace('FloatsOrPercents','FloatOrPercent').replace(/(Floats|Ints|Bools|Percents)$/,m=>m.slice(0,-1));
  field.valueType=scalar;
  if (type==='coEnum') {
    const values=[...block.matchAll(/enum_values\.(?:push_back|emplace_back)\("([^"]+)"\)/g)].map(m=>m[1]);
    const labels=[...block.matchAll(/enum_labels\.(?:push_back|emplace_back)\((?:L\()?"([^"]+)"/g)].map(m=>m[1]);
    field.options=values.map((value,i)=>({value,label:labels[i]||value}));
    const shared=block.match(/def->enum_values\s*=\s*(\w+)->enum_values/);
    if(shared){
      const sourceKey=config.match(new RegExp(`${shared[1]}\\s*=\\s*def\\s*=\\s*this->add\\("([^"\\n]+)"`))?.[1];
      if(!sourceKey||!fields.get(sourceKey)?.options)throw new Error(`Unresolved enum source: ${key}`);
      field.options=fields.get(sourceKey).options;
    }
    const enumMap=config.match(new RegExp(`s_keys_map_${d?.[1]}\\s*=?\\s*\\{([\\s\\S]*?)\\};`))?.[1]||'';
    const symbol=value?.split('::').pop();
    field.defaultValue=[...enumMap.matchAll(/\{\s*"([^"]+)",([^\n]+)\}/g)].find(m=>new RegExp(`\\b${symbol}\\b`).test(m[2]))?.[1];
  } else if (scalar==='coFloatOrPercent') {
    value=value?.replace(/^FloatOrPercent\(/,'').replace(/\)$/,'');
    const [n,pct]=value?.split(',').map(v=>v.trim())||[];
    field.defaultValue=pct==='true'||pct==='1'?`${Number(n)}%`:Number(n);
  } else if(scalar==='coBool') field.defaultValue=value==='true'||value==='1';
  else if(['coFloat','coInt','coPercent'].includes(scalar)) field.defaultValue=Number(value?.replace(/f$/,''));
  else if(type==='coString') field.defaultValue=strings(value||'').join('');
  else if(type==='coStrings')field.defaultValue=strings(value||'');
  if(!d || field.defaultValue===undefined || typeof field.defaultValue==='number'&&!Number.isFinite(field.defaultValue) || !field.label || type==='coEnum'&&!field.options.some(o=>o.value===field.defaultValue))invalid.push({key,type,value,default:field.defaultValue,options:field.options});
  fields.set(key,field);
}
if(invalid.length)throw new Error(JSON.stringify({count:fields.size,invalid},null,2));
process.stdout.write(JSON.stringify({schema:'am-pilot-bambu-print-settings-catalog',version:1,upstream:{project:'BambuStudio',version:'02.08.02.61',revision:'926a7192574bcb9b3a732e1ec59a46d79cb45466',license:'AGPL-3.0-or-later',files:hashes},fields:[...fields.values()]},null,2)+'\n');
