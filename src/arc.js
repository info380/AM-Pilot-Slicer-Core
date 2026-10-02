import { WorkerError } from './errors.js';
export const ARC_PREVIEW_TOLERANCE_MM = 0.01;
const fail = () => new WorkerError('Unsupported or inconsistent XY arc evidence.', { code: 'slicer_toolpath_command_unsupported' });
// Preview tessellation only. Printable G-code is never modified. P is the
// number of turns; Bambu's spiral Z hop uses a full-circle XY arc plus linear Z.
export const arcPreviewPoints = ({ start, end, parameters, clockwise }) => {
  if (parameters.has('R') || !parameters.has('I') && !parameters.has('J')) throw fail();
  const i = parameters.get('I') ?? 0, j = parameters.get('J') ?? 0;
  const cx = start.x + i, cy = start.y + j, radius = Math.hypot(i, j);
  if (!Number.isFinite(radius) || radius <= 0 || radius > 10000) throw fail();
  const endRadius = Math.hypot(end.x - cx, end.y - cy);
  if (Math.abs(endRadius - radius) > Math.max(0.05, radius * 0.001)) throw fail();
  const turns = parameters.get('P') ?? 1;
  if (!Number.isInteger(turns) || turns < 1 || turns > 100) throw fail();
  const startAngle = Math.atan2(start.y - cy, start.x - cx), endAngle = Math.atan2(end.y - cy, end.x - cx);
  let sweep = clockwise ? startAngle - endAngle : endAngle - startAngle;
  if (sweep <= 1e-10) sweep += 2 * Math.PI;
  sweep += (turns - 1) * 2 * Math.PI;
  const step = Math.min(Math.PI / 16, 2 * Math.acos(Math.max(-1, 1 - ARC_PREVIEW_TOLERANCE_MM / radius)));
  const count = Math.ceil(sweep / step);
  if (!Number.isSafeInteger(count) || count > 100000) throw fail();
  return Array.from({ length: count }, (_, index) => {
    const fraction = (index + 1) / count, angle = startAngle + (clockwise ? -1 : 1) * sweep * fraction;
    return index === count - 1 ? { ...end } : { ...end, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle),
      z: start.z + (end.z - start.z) * fraction, e: start.e + (end.e - start.e) * fraction };
  });
};
