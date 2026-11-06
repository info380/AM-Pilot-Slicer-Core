import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WorkerError } from './errors.js';

// Native role identities from the qualified engine revisions. UI colours are
// owned by AM Pilot shared/src/slicer/native-toolpath-presentation.js.
// Bambu 926a719: BaseRenderer.cpp / ExtrusionEntity.cpp.
// Prusa f1776c0: libvgcode/ViewerImpl.cpp / ExtrusionRole.cpp.
const PRUSA = [
  [0,'Unknown'],[1,'Perimeter'],[2,'External perimeter'],
  [3,'Overhang perimeter'],[4,'Internal infill'],[5,'Solid infill'],
  [6,'Top solid infill'],[14,'Ironing'],[7,'Bridge infill'],
  [11,'Gap fill'],[10,'Skirt / brim'],[8,'Support material'],
  [9,'Support material interface'],[12,'Wipe tower'],[13,'Custom']
];
const BAMBU = [
  [0,'Undefined'],[1,'Inner wall'],[2,'Outer wall'],
  [3,'Overhang wall'],[4,'Sparse infill'],[5,'Internal solid infill'],[16,'Floating vertical shell'],
  [6,'Top surface'],[18,'Bottom surface'],[14,'Ironing'],
  [7,'Bridge'],[11,'Gap infill'],[10,'Skirt'],[19,'Brim'],
  [8,'Support'],[9,'Support interface'],[17,'Support transition'],
  [15,'Support ironing'],[12,'Prime tower'],[13,'Custom'],[20,'Flush']
];
export const nativeFeatureCatalog = (features, bambu) => {
  const native = new Map((bambu ? BAMBU : PRUSA).map(([id,displayName]) => [id,{displayName}]));
  return features.map(entry => ({...entry,...native.get(entry.id)}));
};
const fail = message => { throw new WorkerError(message, {code:'slicer_native_statistics_invalid'}); };
const number = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12) fail(`Invalid native ${name}.`);
  return value;
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export const parseNativeStatistics = (report, bambu) => {
  if (!object(report)) fail('Native statistics report is invalid.');
  if (bambu) {
    if (report.return_code !== 0 || !Array.isArray(report.sliced_plates) || report.sliced_plates.length !== 1) fail('Native Bambu plate statistics are invalid.');
    const plate = report.sliced_plates[0];
    if (!object(plate) || plate.id !== 1 || !object(plate.feature_type_times) || Object.keys(plate.feature_type_times).length > 64) fail('Native Bambu feature statistics are invalid.');
    const roles = new Map(BAMBU.map(([id,label]) => [label,id]));
    const rows = [];
    for (const [label,value] of Object.entries(plate.feature_type_times)) {
      const timeSeconds = number(value,'feature time');
      // erNone includes non-extrusion moves. Native Bambu's GUI displays
      // moves_times[Travel] separately, never a second Undefined travel row.
      if (label === 'Undefined') continue;
      const featureId = roles.get(label);
      if (featureId == null && label !== 'Travel') fail(`Unrecognised native Bambu role: ${label.slice(0,120)}.`);
      rows.push({...(label === 'Travel' ? {moveKey:'travel'} : {featureId}),timeSeconds});
    }
    const totalTimeSeconds = number(plate.total_predication,'total time');
    const modelTimeSeconds = number(plate.main_predication,'model time');
    if (modelTimeSeconds > totalTimeSeconds || totalTimeSeconds <= 0) fail('Native Bambu time totals are invalid.');
    return {schemaVersion:1,timeBasis:'native-normal-mode',filamentBasis:'gcode-model-extrusion',totalTimeSeconds,modelTimeSeconds,rows};
  }
  if (report.schemaVersion !== 1 || report.engine !== 'PrusaSlicer-2.9.3' || !Array.isArray(report.roles) || report.roles.length > PRUSA.length || !Array.isArray(report.moves) || report.moves.length > 12) fail('Native Prusa statistics are invalid.');
  const seen = new Set();
  const rows = report.roles.map(row => {
    if (!Array.isArray(row) || row.length !== 4 || !Number.isSafeInteger(row[0]) || !PRUSA[row[0]] || seen.has(row[0])) fail('Native Prusa role is invalid.');
    seen.add(row[0]);
    return {featureId:PRUSA[row[0]][0],timeSeconds:number(row[1],'feature time'),filamentLengthMm:number(row[2],'feature filament length')*1000,filamentMassG:number(row[3],'feature filament mass')};
  });
  // Native enum values from GCodeProcessor.hpp. Preserve unreported movement
  // times as unavailable; do not redistribute the print total among features.
  const moves = new Map([[1,'retraction'],[2,'unretraction'],[8,'travel'],[9,'wipe']]);
  const seenMoves = new Set();
  for (const row of report.moves) {
    if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < 0 || row[0] > 10 || seenMoves.has(row[0])) fail('Native Prusa move is invalid.');
    seenMoves.add(row[0]);
    const timeSeconds = number(row[1],'movement time');
    if (moves.has(row[0])) rows.push({moveKey:moves.get(row[0]),timeSeconds});
  }
  const totalTimeSeconds = number(report.totalTimeSeconds,'total time');
  if (totalTimeSeconds <= 0) fail('Native Prusa total time is empty.');
  return {schemaVersion:1,timeBasis:'native-normal-mode',filamentBasis:'native-role-consumption',totalTimeSeconds,rows};
};

export const readNativeStatistics = async (filePath, bambu) => {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.size < 2 || stat.size > 256*1024) fail('Native statistics report exceeds its limit.');
  const bytes = await fs.readFile(filePath);
  let report;
  try { report = JSON.parse(bytes); } catch { fail('Native statistics report is not JSON.'); }
  return {...parseNativeStatistics(report,bambu),reportChecksumSha256:createHash('sha256').update(bytes).digest('hex')};
};
