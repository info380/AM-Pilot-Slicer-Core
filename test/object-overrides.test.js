import test from 'node:test';
import assert from 'node:assert/strict';
import { compileObjectOverrides } from '../src/object-overrides.js';

test('object overrides serialize native types without accepting global configuration', () => {
  assert.deepEqual(compileObjectOverrides({ perimeters: 4, fill_density: 40, layer_height: 0.1, support_material: true, extrusion_width: '120%' }),
    { perimeters: 4, fill_density: '40%', layer_height: 0.1, support_material: true, extrusion_width: '120%' });
  for (const value of [{post_process:'command'}, {temperature:250}, {perimeters:'4\nM112'}, {perimeters:-1},
    {fill_pattern:'invented'}, {support_material:1}, {perimeters:Infinity}, {perimeters:2.5}, {extrusion_width:'12%\nM112'}]) {
    assert.throws(() => compileObjectOverrides(value), error => error.code === 'slicer_object_override_invalid');
  }
});
