import {gcodeLines,createLayerGcodeCommentScope} from './layer-gcode.js';
import { normalizeFdmPausePoints } from './preparation-contract.js';
import { WorkerError } from './errors.js';
// Same comparison tolerance as the pinned native CustomGCode contract.
const LAYER_HEIGHT_EPSILON_MM = 0.0011;
export const verifyNativePauseEvents = ({ gcode, pausePoints, bambu }) => {
  const requested = normalizeFdmPausePoints(pausePoints);
  if (!requested.length) return;
  const layers = [], events = [];
  let zMm = null;const scope=createLayerGcodeCommentScope();
  for (const line of gcodeLines(gcode)) {
    if(scope.consume(line)||scope.active)continue;
    const height = line.match(bambu ? /^; Z_HEIGHT: ([\d.]+)$/ : /^;Z:([\d.]+)$/);
    if (height) { zMm = Number(height[1]); layers.push(zMm); }
    if ((bambu ? /^;\s*PAUSE_PRINTING\s*$/ : /^;\s*PAUSE_PRINT\s*$/).test(line)) events.push(zMm);
  }
  const expected = requested.map(pause => layers.find(z => z + LAYER_HEIGHT_EPSILON_MM >= pause.zMm));
  if (expected.some(z => z == null) || events.length !== expected.length
    || events.some((z, index) => z == null || Math.abs(z - expected[index]) > LAYER_HEIGHT_EPSILON_MM))
    throw new WorkerError('A planned pause could not be placed on the printed layers. Review its height and re-slice.', { code: 'slicer_pause_not_generated' });
};
