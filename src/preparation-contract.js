import { compileObjectOverrides } from './object-overrides.js';
import { WorkerError } from './errors.js';
import bambuPrintSettings from '../schemas/bambu-print-settings-2.8.2.61.json' with { type: 'json' };
const normalizeSlicerObjectPrintOverrides = value => { compileObjectOverrides(value); return structuredClone(value); };

// Versioned common preparation contract, independent of the selected engine.
// Region settings must be supported by the selected native engine.
export const FDM_PREPARATION_VERSION = 1;
export const GCODE_SCRIPT_LIMITS = Object.freeze({perScriptCharacters:100000,totalCharacters:500000});
export const FDM_PREPARATION_LIMITS = Object.freeze({ pausePoints: 128, modifiersPerObject: 32, modifiersPerPlate: 256 });
export const FDM_MODIFIER_SHAPES = Object.freeze(['box', 'cylinder', 'sphere']);
export const FDM_MODIFIER_INFILL_PATTERNS = Object.freeze(['rectilinear','alignedrectilinear','grid','triangles','stars','cubic','line','concentric','honeycomb','3dhoneycomb','gyroid','hilbertcurve','archimedeanchords','octagramspiral','adaptivecubic','supportcubic','lightning']);
export const FDM_MODIFIER_BASE_SETTING_KEYS = Object.freeze([
  'perimeters', 'fill_density', 'fill_pattern', 'top_solid_layers', 'bottom_solid_layers',
  'perimeter_speed', 'external_perimeter_speed', 'infill_speed', 'solid_infill_speed', 'top_solid_infill_speed'
]);
export const BAMBU_MODIFIER_SHELL_THICKNESS_KEY = 'ensure_vertical_shell_thickness';
const bambuIroningInsetField = bambuPrintSettings.fields.find(field => field.key === 'ironing_inset');
export const BAMBU_MODIFIER_IRONING_INSET_KEY = bambuIroningInsetField.key;
export const FDM_MODIFIER_SETTING_KEYS = Object.freeze([
  ...FDM_MODIFIER_BASE_SETTING_KEYS, BAMBU_MODIFIER_SHELL_THICKNESS_KEY,
  'top_solid_min_thickness', 'bottom_solid_min_thickness', 'thin_walls', 'overhangs',
  'top_fill_pattern', 'bottom_fill_pattern', 'fill_angle', 'bridge_angle', 'bridge_speed', 'gap_fill_speed',
  'ironing', 'ironing_type', 'ironing_flowrate', 'ironing_spacing', 'ironing_speed', BAMBU_MODIFIER_IRONING_INSET_KEY,
  'fuzzy_skin', 'fuzzy_skin_thickness', 'fuzzy_skin_point_dist',
  'perimeter_extrusion_width', 'external_perimeter_extrusion_width', 'infill_extrusion_width',
  'solid_infill_extrusion_width', 'top_infill_extrusion_width', 'infill_overlap', 'bridge_flow_ratio'
]);
const fail = message => { throw new WorkerError(message, { code: 'slicer_preparation_invalid' }); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const label = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(`Invalid ${name}.`);
  return value.trim();
};
const finite = (value, name, positive = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) fail(`Invalid ${name}.`);
  return value;
};
const vector = (value, name, positive = false) => {
  if (!exact(value, ['x', 'y', 'z']) || Object.keys(value).length !== 3) fail(`Invalid ${name}.`);
  return Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, finite(value[axis], `${name}.${axis}`, positive)]));
};
export const normalizeFdmPausePoints = value => {
  if (!Array.isArray(value) || value.length > FDM_PREPARATION_LIMITS.pausePoints) fail('Too many pause points or invalid pause list.');
  const ids = new Set(), heights = new Set();
  return value.map(entry => {
    if (!exact(entry, ['id', 'zMm', 'message'])) fail('Invalid pause point.');
    const id = label(entry.id, 'pause identity', 240), zMm = finite(entry.zMm, 'pause height', true);
    if (ids.has(id) || heights.has(zMm)) fail('Pause identities and heights must be unique.');
    ids.add(id); heights.add(zMm);
    const message = entry.message === '' ? '' : label(entry.message, 'pause message', 160);
    return { id, zMm, message };
  }).sort((a, b) => a.zMm - b.zMm);
};
export const normalizeFdmCustomGcodePoints = value => {
  if(!Array.isArray(value)||value.length>FDM_PREPARATION_LIMITS.pausePoints)fail('Too many custom G-code points or invalid layer action list.');
  const ids=new Set(),heights=new Set();
  const result=value.map(entry=>{
    if(!exact(entry,['id','zMm','gcode']))fail('Invalid custom G-code point.');
    const id=label(entry.id,'custom G-code identity',240),zMm=finite(entry.zMm,'custom G-code height',true);
    if(ids.has(id)||heights.has(zMm))fail('Custom G-code identities and heights must be unique.');
    ids.add(id);heights.add(zMm);
    if(typeof entry.gcode!=='string'||!entry.gcode.trim()||entry.gcode.length>GCODE_SCRIPT_LIMITS.perScriptCharacters
      ||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(entry.gcode))fail('Custom G-code must contain printer commands within the script size limit.');
    if(/^\s*;\s*AM_PILOT_LAYER_GCODE_(?:BEGIN|END)\b/im.test(entry.gcode))fail('Custom G-code cannot contain reserved layer-action markers.');
    return {id,zMm,gcode:entry.gcode.replace(/\r\n?/g,'\n').trim()};
  }).sort((a,b)=>a.zMm-b.zMm);
  if(JSON.stringify(result).length>GCODE_SCRIPT_LIMITS.totalCharacters)fail('Custom G-code exceeds the plate script size limit.');
  return result;
};

export const normalizeFdmModifiers = value => {
  if (!Array.isArray(value) || value.length > FDM_PREPARATION_LIMITS.modifiersPerObject) fail('Too many modifiers or invalid modifier list.');
  const ids = new Set();
  return value.map(entry => {
    if (!exact(entry, ['id', 'name', 'shape', 'sizeMm', 'transform', 'printOverrides']) || !FDM_MODIFIER_SHAPES.includes(entry.shape)) fail('Invalid modifier shape or fields.');
    const id = label(entry.id, 'modifier identity', 240);
    if (ids.has(id)) fail('Modifier identities must be unique.');
    ids.add(id);
    if (!exact(entry.transform, ['positionMm', 'rotationDeg', 'scale']) || Object.keys(entry.transform).length !== 3) fail('Invalid modifier transform.');
    if (!record(entry.printOverrides) || !Object.keys(entry.printOverrides).length || Object.keys(entry.printOverrides).some(key => !FDM_MODIFIER_SETTING_KEYS.includes(key))) fail('Choose at least one supported modifier setting.');
    const { ironing_inset: ironingInset, ...objectOverrides } = entry.printOverrides;
    const printOverrides = normalizeSlicerObjectPrintOverrides(objectOverrides);
    if (Object.hasOwn(entry.printOverrides, BAMBU_MODIFIER_IRONING_INSET_KEY)) {
      const { min, max } = bambuIroningInsetField;
      if (!Number.isFinite(ironingInset) || ironingInset < min || ironingInset > max) fail('Invalid modifier ironing inset.');
      printOverrides.ironing_inset = ironingInset;
    }
    if (printOverrides.ironing === true && !printOverrides.ironing_type) fail('Choose the surfaces to iron inside this modifier.');
    if (printOverrides.ironing_type && printOverrides.ironing !== true) fail('An ironing surface scope requires ironing to be enabled.');
    if (printOverrides.ironing_flowrate != null && printOverrides.ironing_flowrate > 100) fail('Modifier ironing flow must be between 0 and 100%.');
    if (printOverrides.ironing_spacing != null && (printOverrides.ironing_spacing <= 0 || printOverrides.ironing_spacing > 1)) fail('Modifier ironing spacing must be above 0 and no more than 1 mm.');
    if (printOverrides.fill_pattern != null && !FDM_MODIFIER_INFILL_PATTERNS.includes(printOverrides.fill_pattern)) fail('Choose an infill pattern supported by both slicing engines.');
    if (Object.entries(printOverrides).some(([key,value]) => key.endsWith('_speed') && (typeof value !== 'number' || value <= 0))) fail('Modifier speeds must be positive absolute values in mm/s.');
    if (Object.entries(printOverrides).some(([key,value]) => key.endsWith('_extrusion_width') && typeof value !== 'number')) fail('Modifier line widths must use absolute millimetres.');
    if (printOverrides.infill_overlap != null && (typeof printOverrides.infill_overlap !== 'string' || !printOverrides.infill_overlap.endsWith('%'))) fail('Modifier infill overlap must use a percentage.');
    return { id, name: label(entry.name, 'modifier name', 160), shape: entry.shape,
      sizeMm: vector(entry.sizeMm, 'modifier size', true),
      transform: { positionMm: vector(entry.transform.positionMm, 'modifier position'), rotationDeg: vector(entry.transform.rotationDeg, 'modifier rotation'), scale: vector(entry.transform.scale, 'modifier scale', true) },
      printOverrides };
  });
};
export const assertFdmPlatePreparation = plate => {
  if (!record(plate) || !Array.isArray(plate.objects) || !Number.isFinite(plate.geometry?.heightMm) || plate.geometry.heightMm <= 0) fail('A valid plate and build height are required.');
  const pauses = normalizeFdmPausePoints(Object.hasOwn(plate, 'pausePoints') ? plate.pausePoints : []);
  if (pauses.some(pause => pause.zMm > plate.geometry.heightMm)) fail('A pause is above the selected build volume.');
  const custom=normalizeFdmCustomGcodePoints(Object.hasOwn(plate,'customGcodePoints')?plate.customGcodePoints:[]);
  if(new Set([...pauses,...custom].map(point=>point.id)).size!==pauses.length+custom.length)fail('Layer action identities must be unique.');
  if(custom.some(point=>point.zMm>plate.geometry.heightMm))fail('Custom G-code is above the selected build volume.');
  if(custom.length+pauses.length>FDM_PREPARATION_LIMITS.pausePoints)fail('The plate contains too many layer actions.');
  if(custom.some(point=>pauses.some(pause=>pause.zMm===point.zMm)))fail('Choose either Pause or Custom G-code at a layer.');
  const count = plate.objects.reduce((sum, object) => sum + normalizeFdmModifiers(Object.hasOwn(object, 'modifiers') ? object.modifiers : []).length, 0);
  if (count > FDM_PREPARATION_LIMITS.modifiersPerPlate) fail('The plate contains too many modifiers.');
};
export const hasFdmAdvancedPreparation = plate => Boolean(plate.pausePoints?.length || plate.customGcodePoints?.length || plate.objects?.some(object => object.modifiers?.length));
