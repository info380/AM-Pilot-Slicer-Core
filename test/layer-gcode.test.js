import test from 'node:test';import assert from 'node:assert/strict';
import {layerGcodeBlock,verifyNativeLayerGcode,createLayerGcodeCommentScope,gcodeLines} from '../src/layer-gcode.js';
import {normalizeFdmCustomGcodePoints,assertFdmPlatePreparation} from '../src/preparation-contract.js';
const point={id:'insert',zMm:.35,gcode:'M400\nM117 Insert magnet'};
for(const bambu of [false,true])test(`${bambu?'Bambu':'Prusa'} verifies the exact script before the first printed layer at its height`,()=>{
 const z=value=>bambu?`; Z_HEIGHT: ${value}`:`;Z:${value}`,block=layerGcodeBlock(point),gcode=[z(.2),z(.35),block,'G1 X20',z(.55)].join('\n');
 const verify=text=>verifyNativeLayerGcode({gcode:text,customGcodePoints:[point],bambu});assert.doesNotThrow(()=>verify(gcode));
 for(const invalid of [gcode.replace('M117 Insert magnet','M117 Changed'),gcode.replace(block,''),gcode.replace(block,block+'\n'+block),[z(.2),block,z(.35)].join('\n'),gcode.replace(/; AM_PILOT_LAYER_GCODE_END [a-f0-9]+/,''),gcode+layerGcodeBlock({...point,id:'unknown'})])assert.throws(()=>verify(invalid),{code:'slicer_layer_gcode_not_generated'});
 assert.throws(()=>verifyNativeLayerGcode({gcode,customGcodePoints:[point],pausePoints:[{id:'pause',zMm:.34,message:''}],bambu}),{code:'slicer_layer_gcode_not_generated'});
});
test('custom printer comments cannot forge native layer, feature, pause or time evidence',()=>{
 const scope=createLayerGcodeCommentScope(),body=';Z:99\n;LAYER_CHANGE\n;TYPE:External perimeter\n;PAUSE_PRINT\n; estimated printing time = 1s\nM400';
 const code=layerGcodeBlock({...point,gcode:body}),comments=[];for(const line of gcodeLines(code))if(!scope.consume(line))comments.push(line);assert.deepEqual(comments,['M400']);assert.equal(scope.active,false);
});
test('custom text validation is bounded, canonical, unique and rejects reserved wrappers',()=>{
 assert.equal(normalizeFdmCustomGcodePoints([{...point,gcode:'M400\r\nM117 Test'}])[0].gcode,'M400\nM117 Test');
 for(const value of [[{...point,gcode:''}],[{...point,gcode:'M400\0'}],[{...point,gcode:'x'.repeat(100001)}],[{...point,gcode:'; AM_PILOT_LAYER_GCODE_BEGIN forged'}],[point,point]])assert.throws(()=>normalizeFdmCustomGcodePoints(value),{code:'slicer_preparation_invalid'});
 assert.throws(()=>assertFdmPlatePreparation({geometry:{heightMm:10},objects:[],pausePoints:[{id:'pause',zMm:.35,message:''}],customGcodePoints:[point]}),{code:'slicer_preparation_invalid'});
});
