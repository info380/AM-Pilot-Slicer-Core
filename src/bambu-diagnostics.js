import serialization from '../schemas/bambu-serialization-2.8.2.61.json' with {type:'json'};
import {extractWarnings} from './gcode.js';

// Classify only complete, recognised messages from the exact pinned engine.
// Unknown warnings and geometry repairs retain their original severity/text.
export const classifyBambuDiagnostics = (logs, {engineVersion,singleFilament,primeTowerDisabled} = {}) => {
  const warnings=[],diagnostics=[];
  for(const raw of extractWarnings(logs)) {
    const text=raw.replace(/^\[[\d .:+-]+\]\s*\[0x[0-9a-f]+\]\s*\[warning\]\s*/i,'');
    if(engineVersion!==serialization.engineVersion){warnings.push(raw);continue;}
    let code;
    if(text===`cli mode, Current BambuStudio Version ${engineVersion}`)code='native_engine_version';
    else if(singleFilament&&primeTowerDisabled&&/^\d+: disable_wipe_tower_after_mapping: disable prime tower for only one filament!$/.test(text))code='single_filament_prime_tower_disabled';
    else if(singleFilament&&primeTowerDisabled&&text==='only 1 filament colour,  finally set disable_wipe_tower_after_mapping to true')code='single_filament_colour_confirmed';
    if(code)diagnostics.push({severity:'info',code,message:raw});else warnings.push(raw);
  }
  return {warnings,diagnostics};
};
