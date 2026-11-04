import {createHash} from 'node:crypto';
import {normalizeFdmCustomGcodePoints,normalizeFdmPausePoints} from './preparation-contract.js';
import {WorkerError} from './errors.js';
const BEGIN=/^; AM_PILOT_LAYER_GCODE_BEGIN ([a-f0-9]{64})$/;
const END=/^; AM_PILOT_LAYER_GCODE_END ([a-f0-9]{64})$/;
const EPSILON_MM=0.0011;
const identity=point=>createHash('sha256').update(JSON.stringify(point)).digest('hex');
export const layerGcodeBlock=point=>{const [value]=normalizeFdmCustomGcodePoints([point]),id=identity(value);return `; AM_PILOT_LAYER_GCODE_BEGIN ${id}\n${value.gcode}\n; AM_PILOT_LAYER_GCODE_END ${id}`;};
export function* gcodeLines(text){let start=0;for(let end;(end=text.indexOf('\n',start))>=0;start=end+1)yield text.slice(start,text[end-1]==='\r'?end-1:end);if(start<text.length)yield text.slice(start).replace(/\r$/,'');}
// User comments are not native layer/feature/metric evidence. Actual commands
// inside the verified block still pass through the normal toolpath parser.
export const createLayerGcodeCommentScope=()=>{let active=false;return {get active(){return active;},consume(line){if(BEGIN.test(line)){active=true;return true;}if(END.test(line)){active=false;return true;}return active&&/^\s*;/.test(line);}};};
export const verifyNativeLayerGcode=({gcode,customGcodePoints,pausePoints=[],bambu})=>{
 const requested=normalizeFdmCustomGcodePoints(customGcodePoints),pauses=normalizeFdmPausePoints(pausePoints);
 if(!requested.length)return;
 const fail=()=>{throw new WorkerError('Custom G-code could not be verified before its printed layer. Review the commands and height, then re-slice.',{code:'slicer_layer_gcode_not_generated'});};
 const expected=new Map(requested.map(point=>[identity(point),point])),events=new Map(),layers=[];let active=null,zMm=null,body=[];
 for(const line of gcodeLines(gcode)){
  const begin=BEGIN.exec(line),end=END.exec(line);
  if(begin){if(active||!expected.has(begin[1])||events.has(begin[1]))fail();active=begin[1];body=[];events.set(active,{zMm});continue;}
  if(end){if(!active||end[1]!==active||body.join('\n')!==expected.get(active).gcode)fail();active=null;continue;}
  if(active){body.push(line);continue;}
  const height=line.match(bambu?/^; Z_HEIGHT: ([\d.]+)$/:/^;Z:([\d.]+)$/);if(height){zMm=Number(height[1]);layers.push(zMm);}
 }
 if(active||events.size!==expected.size)fail();
 const target=point=>layers.find(z=>z+EPSILON_MM>=point.zMm),targets=[...requested,...pauses].map(target);
 if(targets.some(z=>z==null)||new Set(targets).size!==targets.length)fail();
 for(const [id,point] of expected){const event=events.get(id);if(!event||event.zMm==null||Math.abs(event.zMm-target(point))>EPSILON_MM)fail();}
};
