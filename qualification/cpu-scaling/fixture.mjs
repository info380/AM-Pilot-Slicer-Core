import assert from 'node:assert/strict';
import { sha256 } from './contract.mjs';
export const torusStl = ({ nu=128, nv=64, major=9, heightScale=1 }) => {
  const point=(u,v)=>{const a=u/nu*Math.PI*2,b=v/nv*Math.PI*2;return [(major+3*Math.cos(b))*Math.cos(a),(major+3*Math.cos(b))*Math.sin(a),(3+3*Math.sin(b))*heightScale];};
  const bytes=Buffer.alloc(84+nu*nv*2*50); bytes.writeUInt32LE(nu*nv*2,80); let face=0;
  for(let u=0;u<nu;u++)for(let v=0;v<nv;v++){
    const a=point(u,v),b=point(u+1,v),c=point(u+1,v+1),d=point(u,v+1);
    for(const triangle of [[a,b,c],[a,c,d]]){triangle.flat().forEach((x,j)=>bytes.writeFloatLE(x,84+face*50+12+j*4));face++;}
  }
  return bytes;
};
export const buildFixture = name => {
  assert(['linked-ten','unique-ten','single-dense'].includes(name));
  const unique=name==='unique-ten', dense=name==='single-dense', count=dense?1:10;
  const sources=Array.from({length:unique?10:1},(_,i)=>torusStl(dense?{nu:256,nv:256,heightScale:2}:{major:9+i*0.02}));
  const models=sources.map((bytes,i)=>({modelId:`source-${i}`,projectFileId:`file-${i}`,sourceFormat:'stl',checksumSha256:sha256(bytes),sizeBytes:bytes.length}));
  const inputSnapshot={schema:'am-pilot-slicer-input-snapshot',version:1,models,plate:{geometry:{heightMm:256},objects:Array.from({length:count},(_,i)=>({
    id:`object-${i}`,definitionId:unique?`definition-${i}`:'linked',name:'Synthetic torus',fileId:`file-${unique?i:0}`,placement:{status:'placed'},printOverrides:{},
    transform:{positionMm:{x:dense?0:(i%5)*35-70,y:dense?0:Math.floor(i/5)*35-20,z:0},rotationDeg:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},
    modifiers:[{id:'region',name:'Lower density',shape:'box',sizeMm:{x:30,y:30,z:3},transform:{positionMm:{x:0,y:0,z:1.5},rotationDeg:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},printOverrides:{fill_density:30}}]
  }))}};
  return {sources,inputSnapshot};
};
export const prusaRecipe = Object.freeze({printer_technology:'FFF',gcode_flavor:'marlin2',bed_shape:'0x0,256x0,256x256,0x256',max_print_height:256,
 nozzle_diameter:0.4,filament_diameter:1.75,filament_density:1.24,extrusion_multiplier:1,layer_height:0.2,first_layer_height:0.2,
 perimeters:2,top_solid_layers:3,bottom_solid_layers:3,fill_density:'15%',fill_pattern:'grid',support_material:false,
 ironing:false,first_layer_temperature:210,temperature:205,first_layer_bed_temperature:60,bed_temperature:60,
 start_gcode:'G28\nG90\nM82',end_gcode:'M104 S0\nM140 S0',start_filament_gcode:'',end_filament_gcode:''});
