import fs from 'node:fs/promises';
import path from 'node:path';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {runProcess} from './process.js';
import {WorkerError} from './errors.js';

const axes=['x','y','z','e'];
const motionKeys=new Set([...axes.map(axis=>`machine_max_speed_${axis}`),...[...axes,'extruding','retracting','travel'].map(axis=>`machine_max_acceleration_${axis}`),...axes.map(axis=>`machine_max_jerk_${axis}`)]);
const scriptKeys=new Set(['machine_start_gcode','machine_end_gcode','layer_change_gcode','machine_pause_gcode','change_filament_gcode','time_lapse_gcode','wrapping_detection_gcode']);
const fail=message=>{throw new WorkerError(message,{code:'slicer_machine_override_invalid'});};
export const reviewedBambuMachineOverrides=(ownership,machine)=>{
  const result={motion:ownership?.motionOverrides??{},scripts:ownership?.gcodeOverrides??{}};
  for(const [kind,values] of Object.entries(result)){
    if(!values||typeof values!=='object'||Array.isArray(values))fail('Machine overrides must be explicit objects.');
    for(const [key,value] of Object.entries(values)){
      if(kind==='motion'){
        if(!motionKeys.has(key)||typeof value!=='number'||!Number.isFinite(value)||value<0||(!key.includes('jerk')&&value===0)
          ||!Array.isArray(machine[key])||Number(machine[key][0])!==value)fail('Reviewed machine motion overrides do not match the resolved preset.');
      }else if(!scriptKeys.has(key)||typeof value!=='string'||value.length>100000||value.includes('\0')||machine[key]!==value)fail('Reviewed machine scripts do not match the resolved preset.');
    }
  }
  if(JSON.stringify(result.scripts).length>500000)fail('Machine scripts exceed the configuration byte limit.');
  return result;
};
export const assertBambuMachineOverrideResult=(ownership,machine,settings)=>{
  const overrides=reviewedBambuMachineOverrides(ownership,machine);
  for(const [key,value] of Object.entries(overrides.motion))if(!Array.isArray(settings[key])||Number(settings[key][0])!==value)fail(`The native engine changed the reviewed machine limit ${key}. No print file was accepted.`);
  for(const [key,value] of Object.entries(overrides.scripts))if(settings[key]!==value)fail(`The native engine changed the reviewed machine script ${key}. No print file was accepted.`);
};

export const readBoundedBambuProject=(input,limit)=>{
  if(!Number.isSafeInteger(limit)||limit<=0||input.length>limit)fail('An explicit native project byte limit is required.');
  let entries=0,expanded=0;const seen=new Set();
  let files;try{files=unzipSync(input,{filter:entry=>{
    if(++entries>4096||seen.has(entry.name.toLowerCase())||entry.name.startsWith('/')||entry.name.includes('\\')||entry.name.split('/').includes('..')
      ||!Number.isSafeInteger(entry.originalSize)||entry.originalSize<0||(expanded+=entry.originalSize)>limit)fail('The generated native project has invalid archive entries.');
    seen.add(entry.name.toLowerCase());return true;
  }});}catch(error){if(error instanceof WorkerError)throw error;fail('The generated native project is not a valid bounded archive.');}
  if(!files['3D/3dmodel.model']?.length)fail('The native project has no model geometry.');
  return {files,expanded};
};

export const rewriteReviewedBambuProject=(input,presets,limit)=>{
  const {files,expanded}=readBoundedBambuProject(input,limit);
  const bytes=files['Metadata/project_settings.config'];if(!bytes||bytes.length>2*1024*1024)fail('The native project has no bounded settings evidence.');
  let original;try{original=JSON.parse(strFromU8(bytes));}catch{fail('The native project has invalid settings evidence.');}
  if(original.printer_model!==presets.machine.printer_model||original.nozzle_diameter?.length!==1||Number(original.nozzle_diameter[0])!==Number(presets.machine.nozzle_diameter?.[0]))fail('The generated native project changed the reviewed printer identity.');
  const settings={...original,...presets.machine,...presets.process,...presets.filament,printer_settings_id:presets.machine.name,print_settings_id:presets.process.name,filament_settings_id:[presets.filament.name]};
  for(const key of ['type','name','from'])delete settings[key];
  files['Metadata/project_settings.config']=strToU8(JSON.stringify(settings));
  if(files['Metadata/project_settings.config'].length>2*1024*1024 || expanded-bytes.length+files['Metadata/project_settings.config'].length>limit)fail('Reviewed settings exceed the native project byte limit.');
  applyBambuHandoffMetadata(files,presets);
  if(Object.values(files).reduce((sum,value)=>sum+value.length,0)>limit)fail('Native handoff metadata exceeds the expanded plate budget.');
  const output=zipSync(files);if(output.length>limit)fail('The reviewed native project exceeds its byte limit.');return output;
};


// Native metadata is derived from the same immutable, fully resolved settings.
// Logical nozzle IDs are zero based; Bambu's XML physical extruder IDs are one based.
export const applyBambuHandoffMetadata=(files,presets)=>{
  const diameter=presets.machine.nozzle_diameter;
  const volume=presets.machine.nozzle_volume_type;
  if(!Array.isArray(diameter)||diameter.length!==1||!Number.isFinite(Number(diameter[0]))||Number(diameter[0])<=0
    ||!Array.isArray(volume)||volume.length!==1||!['Standard','High Flow','TPU High Flow','E3D High Flow'].includes(volume[0]))
    fail('The reviewed hardware must declare one explicit nozzle diameter and volume type.');
  const color=presets.filament.filament_colour;
  if(!Array.isArray(color)||color.length!==1||typeof color[0]!=='string'||!/^#[0-9a-f]{6}$/i.test(color[0]))
    fail('The native handoff requires the explicit reviewed filament colour.');
  const settingsName='Metadata/project_settings.config';
  let settings={};
  if(files[settingsName]){
    if(files[settingsName].length>2*1024*1024)fail('The native project settings exceed the metadata budget.');
    try{settings=JSON.parse(strFromU8(files[settingsName]));}catch{fail('The native project settings are invalid.');}
    if(!settings||typeof settings!=='object'||Array.isArray(settings))fail('The native project settings must be an object.');
  }
  settings.filament_colour=[color[0].toUpperCase()];
  files[settingsName]=strToU8(JSON.stringify(settings));
  if(files[settingsName].length>2*1024*1024)fail('The native project settings exceed the metadata budget.');
  const name='Metadata/model_settings.config';
  let xml=files[name]?strFromU8(files[name]):'<?xml version="1.0" encoding="UTF-8"?><config><plate><metadata key="plater_id" value="1"/></plate></config>';
  if(xml.length>2*1024*1024||/<!DOCTYPE|<!ENTITY|<plate\s*\/>/i.test(xml)||[...xml.matchAll(/<plate(?:\s[^>]*)?>/g)].length!==1
    ||[...xml.matchAll(/<\/plate>/g)].length!==1)fail('The native metadata must describe one bounded plate.');
  const nozzle=`<nozzle id="0" extruder_id="1" nozzle_diameter="${Number(diameter[0])}" volume_type="${volume[0]}"/>`;
  const present=[...xml.matchAll(/<nozzle\b[^>]*\/>/g)];
  if(present.length>1||[...xml.matchAll(/<nozzle\b/g)].length!==present.length)fail('The native project contains unexpected nozzle metadata.');
  if(present.length){
    const attribute=key=>present[0][0].match(new RegExp('\\b'+key+'="([^"]*)"'))?.[1];
    if(attribute('id')!=='0'||attribute('extruder_id')!=='1'||Number(attribute('nozzle_diameter'))!==Number(diameter[0])||attribute('volume_type')!==volume[0])
      fail('The native nozzle metadata differs from the reviewed hardware.');
    xml=xml.replace(present[0][0],nozzle);
  }else xml=xml.replace('</plate>',nozzle+'</plate>');
  files[name]=strToU8(xml);
  if(files[name].length>2*1024*1024)fail('The native nozzle metadata exceeds the metadata budget.');
};
export const bambuHandoffArguments=(paths,presets)=>['--uptodate','--uptodate-settings',`${paths.machine};${paths.process}`, '--filament-colour',presets.filament.filament_colour[0]];

// Bambu's CLI applies cross-printer conversion caps when a geometry-only input
// acquires a new printer preset. A native project with that same printer keeps
// its reviewed settings. Let the pinned engine create the native project itself;
// never spoof its generator marker or edit the installed CLI resource limits.
export async function prepareBambuMachineProject({ownership,presets,paths,sourcePath,workDir,config,signal,cpuAffinityCount}){
  reviewedBambuMachineOverrides(ownership,presets.machine);
  if(!Number.isSafeInteger(config?.maximumPlateInputBytes)||config.maximumPlateInputBytes<=0)fail('An explicit native project byte limit is required.');
  const limit=config.maximumPlateInputBytes;
  if(!Number.isSafeInteger(limit)||limit<=0)fail('An explicit native project byte limit is required.');
  const generatedPath=path.join(workDir,'native-machine-project.3mf');
  await runProcess({command:config.bambuStudioCommand,args:['--debug','2','--datadir',path.join(workDir,'bambu-project-data'),'--arrange','0','--orient','0','--skip-useless-pick',
    '--load-settings',`${paths.machine};${paths.process}`,...bambuHandoffArguments(paths,presets),'--load-filaments',paths.filament,
    '--export-3mf',path.basename(generatedPath),'--outputdir',workDir,sourcePath],cwd:workDir,timeoutMs:config.jobTimeoutMs,maximumLogBytes:config.maximumLogBytes,signal,cpuAffinityCount});
  const info=await fs.lstat(generatedPath);if(!info.isFile()||info.size>limit)fail('The native machine project exceeds its byte limit.');
  const output=rewriteReviewedBambuProject(await fs.readFile(generatedPath),presets,limit);
  const filename=path.join(workDir,'reviewed-machine-project.3mf');await fs.writeFile(filename,output,{mode:0o600});return filename;
}
