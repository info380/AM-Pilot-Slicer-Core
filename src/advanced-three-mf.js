import {zipSync,strToU8} from 'fflate';
import {readNormalized3mfXml,CONTENT_TYPES,RELATIONSHIPS} from './three-mf.js';
import {IDENTITY_3MF_TRANSFORM,parse3mfTransform,multiply3mfTransforms,apply3mfTransform,buildPlateObjectTransform,format3mfTransform} from './transform.js';
import {normalizeFdmModifiers,normalizeFdmPausePoints,FDM_PREPARATION_LIMITS} from './preparation-contract.js';
import {modifierGeometry} from './modifier-geometry.js';
import {compileObjectOverrides} from './object-overrides.js';
import {WorkerError} from './errors.js';
const error=message=>{throw new WorkerError(message,{code:'slicer_preparation_geometry_invalid'});};
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const attr=(source,name)=>source.match(new RegExp('\\b'+name+'="([^"]*)"'))?.[1];
const determinant = m => m[0]*(m[4]*m[8]-m[5]*m[7])-m[1]*(m[3]*m[8]-m[5]*m[6])+m[2]*(m[3]*m[7]-m[4]*m[6]);
const transformedVertex = (point, matrix) => {
 const result = apply3mfTransform(point, matrix);
 if (Object.values(result).some(value => !Number.isFinite(value))) error('Transformed geometry exceeds the finite coordinate range.');
 return result;
};
const entry=value=>[strToU8(value),{mtime:new Date('1980-01-01T00:00:00.000Z')}];
const nativeKeys=Object.freeze({"perimeters":"wall_loops","fill_density":"sparse_infill_density","fill_pattern":"sparse_infill_pattern","top_solid_layers":"top_shell_layers","bottom_solid_layers":"bottom_shell_layers","perimeter_speed":"inner_wall_speed","external_perimeter_speed":"outer_wall_speed","infill_speed":"sparse_infill_speed","solid_infill_speed":"internal_solid_infill_speed","top_solid_infill_speed":"top_surface_speed","top_solid_min_thickness":"top_shell_thickness","bottom_solid_min_thickness":"bottom_shell_thickness","thin_walls":"detect_thin_wall","overhangs":"detect_overhang_wall","top_fill_pattern":"top_surface_pattern","bottom_fill_pattern":"bottom_surface_pattern","fill_angle":"infill_direction","bridge_angle":"bridge_angle","bridge_speed":"bridge_speed","gap_fill_speed":"gap_infill_speed","ironing_type":"ironing_type","ironing_flowrate":"ironing_flow","ironing_spacing":"ironing_spacing","ironing_speed":"ironing_speed","fuzzy_skin":"fuzzy_skin","fuzzy_skin_thickness":"fuzzy_skin_thickness","fuzzy_skin_point_dist":"fuzzy_skin_point_distance","perimeter_extrusion_width":"inner_wall_line_width","external_perimeter_extrusion_width":"outer_wall_line_width","infill_extrusion_width":"sparse_infill_line_width","solid_infill_extrusion_width":"internal_solid_infill_line_width","top_infill_extrusion_width":"top_surface_line_width","infill_overlap":"infill_wall_overlap","bridge_flow_ratio":"bridge_flow"});
const patternMap=Object.freeze({monotonic:'monotonic',monotoniclines:'monotonicline',rectilinear:'zig-zag',stars:'tri-hexagon',alignedrectilinear:'alignedrectilinear',grid:'grid',triangles:'triangles',cubic:'cubic',gyroid:'gyroid',honeycomb:'honeycomb','3dhoneycomb':'3dhoneycomb',adaptivecubic:'adaptivecubic',supportcubic:'supportcubic',concentric:'concentric',hilbertcurve:'hilbertcurve',archimedeanchords:'archimedeanchords',octagramspiral:'octagramspiral',lightning:'lightning',line:'line'});
const settingsMetadata=(overrides,bambu,type='volume')=>Object.entries(compileObjectOverrides(overrides)).map(([key,value])=>{
 if(bambu&&key==='ironing'){return value?'':`<metadata key="ironing_type" value="no ironing"/>`;}
 if(typeof value==='boolean')value=value?'1':'0';
 if(bambu){if(!nativeKeys[key])error('Unsupported Bambu region setting.');if(['fill_pattern','top_fill_pattern','bottom_fill_pattern'].includes(key)){if(!Object.hasOwn(patternMap,value))error('Unsupported Bambu region infill pattern.');value=patternMap[value];}key=nativeKeys[key];}
 return `<metadata${bambu?'':` type="${type}"`} key="${xml(key)}" value="${xml(value)}"/>`;
}).join('');

// Flatten only the already normalized geometry graph. Never import source profile,
// script or project metadata. Instance transforms and support-paint attributes stay.
const flattenSource=(source,parentTransform,limit)=>{
 const text=readNormalized3mfXml({source,maximumUncompressedBytes:limit});
 if(/<!DOCTYPE|<!ENTITY|\b(?:p:)?path\s*=/i.test(text))error('External or entity geometry is unsupported.');
 const resources=text.match(/<resources\b[^>]*>([\s\S]*?)<\/resources>/)?.[1];
 const build=text.match(/<build\b[^>]*>([\s\S]*?)<\/build>/)?.[1];
 if(!resources||!build)error('Normalized geometry has no resources or build.');
 if (/\b(?:pid|pindex|p1|p2|p3|requiredextensions)\s*=/.test(text)) error('Normalized geometry contains unsupported material resources or extensions.');
 const objects=new Map();
 let remainder=resources;
 for(const match of resources.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)){const id=attr(match[1],'id');if(!id||objects.has(id))error('Invalid geometry identity.');objects.set(id,match[2]);remainder=remainder.replace(match[0],'');}
 if (remainder.replace(/<!--[\s\S]*?-->/g,'').trim()) error('Normalized geometry contains unsupported resources.');
 const vertices=[],triangles=[];
 const append=(id,matrix,path=[])=>{
  if(path.includes(id)||path.length>=32||!objects.has(id))error('Invalid or recursive geometry graph.');
  if(matrix.some(value=>!Number.isFinite(value)) || !Number.isFinite(determinant(matrix)) || determinant(matrix)===0)error('Invalid composed geometry transform.');
  const mirrored=determinant(matrix)<0;
  const body=objects.get(id),mesh=body.match(/<mesh>([\s\S]*?)<\/mesh>/)?.[1];
  if(mesh){
   const offset=vertices.length,local=[];
   for(const v of mesh.matchAll(/<vertex\b([^>]*)\/>/g)){const point=Object.fromEntries(['x','y','z'].map(axis=>[axis,Number(attr(v[1],axis))]));if(Object.values(point).some(v=>!Number.isFinite(v)))error('Invalid mesh vertex.');local.push(point);vertices.push(transformedVertex(point,matrix));}
   for(const t of mesh.matchAll(/<triangle\b([^>]*)\/>/g)){const indices=['v1','v2','v3'].map(key=>Number(attr(t[1],key)));if(indices.some(i=>!Number.isSafeInteger(i)||i<0||i>=local.length))error('Invalid mesh triangle.');const attributes=t[1].replace(/\s*v[123]="[^"]*"/g,'');if(mirrored)[indices[1],indices[2]]=[indices[2],indices[1]];triangles.push({indices:indices.map(i=>i+offset),attributes});}
   if((vertices.length*48+triangles.length*64)>limit*2)error('Expanded geometry exceeds its budget.');
  }else{
   const components=[...body.matchAll(/<component\b([^>]*)\/>/g)];if(!components.length)error('Geometry object has no mesh or components.');
   for(const c of components)append(attr(c[1],'objectid'),multiply3mfTransforms(parse3mfTransform(attr(c[1],'transform')||''),matrix),[...path,id]);
  }
 };
 const items=[...build.matchAll(/<item\b([^>]*)\/>/g)];if(!items.length)error('Normalized geometry has no build items.');
 for(const item of items)append(attr(item[1],'objectid'),multiply3mfTransforms(parse3mfTransform(attr(item[1],'transform')||''),parentTransform));
 if(!vertices.length||!triangles.length)error('Printable geometry is empty.');
 return {vertices,triangles};
};
const paintAttributes=(attributes,painted)=>attributes
 .replace(/\s*(?:slic3rpe:)?paint_supports="[^"]*"/g,'')
 .replace(/\s*slic3rpe:custom_supports="([^"]*)"/g,(_match,data)=>painted?` paint_supports="${data}"`:'');
const meshXml=({vertices,triangles},bambu=false,painted=false)=>`<mesh><vertices>${vertices.map(p=>`<vertex x="${p.x}" y="${p.y}" z="${p.z}"/>`).join('')}</vertices><triangles>${triangles.map(t=>{const ids=t.indices||t;return `<triangle v1="${ids[0]}" v2="${ids[1]}" v3="${ids[2]}"${bambu?paintAttributes(t.attributes||'',painted):t.attributes||''}/>`;}).join('')}</triangles></mesh>`;

export const buildAdvancedPlate3mf=({sources,pausePoints=[],bambu=false,pauseGcode,maximumUncompressedBytes,maximumSourceUncompressedBytes})=>{
 if(!Array.isArray(sources)||!sources.length||!Number.isSafeInteger(maximumUncompressedBytes)||maximumUncompressedBytes<=0||!Number.isSafeInteger(maximumSourceUncompressedBytes)||maximumSourceUncompressedBytes<=0)error('Explicit preparation sources and limits are required.');
 const pauses=normalizeFdmPausePoints(pausePoints);
 if(pauses.length&&(typeof pauseGcode!=='string'||!pauseGcode.trim()))error('The selected printer has no configured pause command.');
 let nextId=1,totalModifiers=0;const resources=[],items=[],metadata=[],instances=[];
 const linked = new Map();
 for(const {source,object,objectTransform} of sources){
  const modifiers=normalizeFdmModifiers(object.modifiers||[]);
  // Only explicit linked instances may share a native model. Verify all frozen
  // source and region evidence too; a definition ID alone is not authority.
  const variant = JSON.stringify({modifiers,overrides:object.printOverrides||{},paint:object.supportPaint||null});
  const previous = bambu && object.definitionId ? linked.get(object.definitionId) : null;
  if (objectTransform.length !== 12 || objectTransform.some(value=>!Number.isFinite(value)) || !Number.isFinite(determinant(objectTransform)) || determinant(objectTransform)===0) error('Invalid composed geometry transform.');
  const baseTransform = bambu ? IDENTITY_3MF_TRANSFORM : objectTransform;
  const base = previous?.source === source && previous.variant === variant ? previous.base : flattenSource(source,baseTransform,maximumSourceUncompressedBytes);
  // Preserve the finite-world-coordinate guard even though the native engine
  // now receives local meshes plus instance matrices.
  if (bambu) for (const vertex of base.vertices) transformedVertex(vertex,objectTransform);
  totalModifiers+=modifiers.length;if(totalModifiers>FDM_PREPARATION_LIMITS.modifiersPerPlate)error('Too many modifier volumes.');
  const volumes=[{geometry:base,modifier:false,name:object.name,settings:{}}];
  for(const modifier of modifiers){
   const matrix=multiply3mfTransforms(buildPlateObjectTransform({transform:modifier.transform,coordinateMapping:{projectOrigin:'center',engineBedOrigin:'center',translationMm:{x:0,y:0,z:0}}}),baseTransform);
   const geometry=modifierGeometry(modifier);geometry.vertices=geometry.vertices.map(v=>transformedVertex(v,matrix));
   volumes.push({geometry,modifier:true,name:modifier.name,settings:modifier.printOverrides});
  }
  const id=nextId++;
  if(bambu){
   // Keep a native object record per placement. The pinned CLI splits some
   // repeated build instances before applying region metadata, so sharing the
   // meshes (not the object metadata) preserves modifier and paint semantics.
   const reuse=previous?.source===source && previous.variant===variant;
   const parts=reuse?previous.parts:volumes.map(volume=>({id:nextId++,volume}));
   if(!reuse)for(const part of parts)resources.push(`<object id="${part.id}" type="model">${meshXml(part.volume.geometry,true,Boolean(object.supportPaint?.data))}</object>`);
   resources.push(`<object id="${id}" type="model"><components>${parts.map(part=>`<component objectid="${part.id}"/>`).join('')}</components></object>`);
   metadata.push(`<object id="${id}"><metadata key="name" value="${xml(object.name)}"/>${settingsMetadata(object.printOverrides||{},true,'object')}${parts.map(({id,volume})=>`<part id="${id}" subtype="${volume.modifier?'modifier_part':'normal_part'}"><metadata key="name" value="${xml(volume.name)}"/>${settingsMetadata(volume.settings,true)}</part>`).join('')}</object>`);
   instances.push(`<model_instance><metadata key="object_id" value="${id}"/><metadata key="instance_id" value="0"/></model_instance>`);
   if (object.definitionId && !previous) linked.set(object.definitionId,{source,variant,id,base,parts});
  }else{
   const combined={vertices:[],triangles:[]},ranges=[];
   for(const volume of volumes){const offset=combined.vertices.length,first=combined.triangles.length;for(const vertex of volume.geometry.vertices)combined.vertices.push(vertex);for(const t of volume.geometry.triangles)combined.triangles.push({indices:(t.indices||t).map(i=>i+offset),attributes:t.attributes||''});ranges.push(`<volume firstid="${first}" lastid="${combined.triangles.length-1}"><metadata type="volume" key="name" value="${xml(volume.name)}"/>${volume.modifier?'<metadata type="volume" key="modifier" value="1"/>':''}${settingsMetadata(volume.settings,false)}</volume>`);}
   resources.push(`<object id="${id}" type="model">${meshXml(combined)}</object>`);
   metadata.push(`<object id="${id}">${settingsMetadata(object.printOverrides||{},false,'object')}${ranges.join('')}</object>`);
  }
  items.push(`<item objectid="${id}"${bambu?` transform="${format3mfTransform(objectTransform)}"`:""}/>`);
 }
 const model=`<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06"><metadata name="slic3rpe:Version3mf">1</metadata>${bambu?'<metadata name="BambuStudio:3mfVersion">1</metadata><metadata name="BambuStudio:FdmSupportsPaintingVersion">0</metadata>':'<metadata name="slic3rpe:FdmSupportsPaintingVersion">1</metadata>'}<resources>${resources.join('')}</resources><build>${items.join('')}</build></model>`;
 const config=`<?xml version="1.0" encoding="UTF-8"?><config>${metadata.join('')}${bambu?`<plate><metadata key="plater_id" value="1"/>${instances.join('')}</plate>`:''}</config>`;
 const files={'[Content_Types].xml':entry(CONTENT_TYPES),'_rels/.rels':entry(RELATIONSHIPS),'3D/3dmodel.model':entry(model),[bambu?'Metadata/model_settings.config':'Metadata/Slic3r_PE_model.config']:entry(config)};
 if(pauses.length){
  const events=pauses.map(p=>bambu?`<layer top_z="${p.zMm}" type="1" extruder="1" color="" extra="${xml(p.message)}" gcode="${xml(pauseGcode)}"/>`:`<code print_z="${p.zMm}" type="1" extruder="1" color="" extra="${xml(p.message)}" gcode="${xml(pauseGcode)}"/>`).join('');
  files[bambu?'Metadata/custom_gcode_per_layer.xml':'Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml']=entry(bambu?`<custom_gcodes_per_layer><plate><plate_info id="1"/>${events}<mode value="SingleExtruder"/></plate></custom_gcodes_per_layer>`:`<custom_gcodes_per_print_z>${events}<mode value="SingleExtruder"/></custom_gcodes_per_print_z>`);
 }
 if(Object.values(files).reduce((sum,[bytes])=>sum+bytes.length,0)>maximumUncompressedBytes)error('Prepared geometry exceeds the plate input budget.');
 return zipSync(files);
};
