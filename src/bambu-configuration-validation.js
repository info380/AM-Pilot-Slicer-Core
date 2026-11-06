import serialization from '../schemas/bambu-serialization-2.8.2.61.json' with { type: 'json' };
import { WorkerError } from './errors.js';

const excluded = new Set([...serialization.metadataFields, ...serialization.retiredVendorFields]);
const variants = new Set(serialization.scalarVariantFields);
const nullable = new Set(serialization.nullableOmittedFields);
const percents = new Set(serialization.percentFields);
const percentValue = value => Array.isArray(value) ? value.map(percentValue) : typeof value==='string' && numeric.test(value.replace(/%$/,'')) ? value.replace(/%$/,'') : value;
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const fail = key => { throw new WorkerError(`The native engine changed the reviewed setting ${key}. No print file was accepted.`, {code:'slicer_bambu_settings_mismatch'}); };
const equivalent = (expected, actual) => {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length===actual.length && expected.every((value,index)=>equivalent(value,actual[index]));
  if (expected && typeof expected==='object') return actual && typeof actual==='object' && !Array.isArray(actual)
    && Object.keys(expected).length===Object.keys(actual).length && Object.entries(expected).every(([key,value])=>Object.hasOwn(actual,key)&&equivalent(value,actual[key]));
  if (typeof expected==='number' || typeof expected==='string' && numeric.test(expected)) {
    return (typeof actual==='number'||typeof actual==='string'&&numeric.test(actual)) && Number.isFinite(Number(actual)) && Number(actual)===Number(expected);
  }
  return expected===actual;
};
const legacyWallSequence = value => ({'inner wall/outer wall/infill':'inner wall/outer wall','infill/inner wall/outer wall':'inner wall/outer wall',
  'outer wall/inner wall/infill':'outer wall/inner wall','infill/outer wall/inner wall':'outer wall/inner wall','inner-outer-inner wall/infill':'inner-outer-inner wall'}[value] || value);

export const expectedBambuRuntimeSettings = presets => {
  const expected={...presets.machine,...presets.process,...presets.filament,
    printer_settings_id:presets.machine.name,print_settings_id:presets.process.name,filament_settings_id:[presets.filament.name]};
  if(Object.hasOwn(expected,'wall_infill_order')) {
    if(!Object.hasOwn(expected,'wall_sequence')) expected.wall_sequence=legacyWallSequence(expected.wall_infill_order);
    delete expected.wall_infill_order;
  }
  for(const key of excluded) delete expected[key];
  if(typeof expected.best_object_pos==='string') expected.best_object_pos=expected.best_object_pos.split('x').join(',');
  // This qualified invocation is one external spool and does not enable the
  // CLI timelapse mode. Record its deterministic single-filament tower policy.
  if(presets.filament.filament_type?.length===1 && expected.enable_prime_tower!=null) expected.enable_prime_tower='0';
  return expected;
};
export const verifyBambuRuntimeSettings = (presets, actual) => {
  if(!actual||typeof actual!=='object'||Array.isArray(actual)) fail('project_settings');
  const expected=expectedBambuRuntimeSettings(presets);
  for(const [key,value] of Object.entries(expected)) {
    // Pinned optional filament overrides serialize an explicit unset vector by
    // omitting it; any actual value must still equal the requested unset vector.
    if(nullable.has(key)&&Array.isArray(value)&&value.length===1&&value[0]==='nil'&&!Object.hasOwn(actual,key))continue;
    if(!Object.hasOwn(actual,key)) fail(key);
    const serialized=variants.has(key)&&!Array.isArray(value)?[value]:value;
    if(!equivalent(percents.has(key)?percentValue(serialized):serialized,percents.has(key)?percentValue(actual[key]):actual[key])) fail(key);
  }
  return Object.freeze({schema:serialization.schema,version:serialization.version,verifiedFields:Object.keys(expected).length});
};
