import { WorkerError } from './errors.js';

export const IDENTITY_3MF_TRANSFORM = Object.freeze([
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
  0, 0, 0
]);

const finite = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new WorkerError(`${label} must be finite.`, { code: 'slicer_object_transform_invalid' });
  }
  return number;
};

const vector = (value, label, { positive = false } = {}) => {
  const result = {
    x: finite(value?.x, `${label}.x`),
    y: finite(value?.y, `${label}.y`),
    z: finite(value?.z, `${label}.z`)
  };
  if (positive && Object.values(result).some(number => number <= 0)) {
    throw new WorkerError(`${label} values must be positive.`, { code: 'slicer_object_transform_invalid' });
  }
  return result;
};

export const parse3mfTransform = value => {
  if (!String(value || '').trim()) return [...IDENTITY_3MF_TRANSFORM];
  const numbers = String(value).trim().split(/[\s,]+/).map(Number);
  if (numbers.length !== 12 || numbers.some(number => !Number.isFinite(number))) {
    throw new WorkerError('A source 3MF build transform is invalid.', { code: 'slicer_source_3mf_invalid' });
  }
  return numbers;
};

// 3MF stores a row-vector affine matrix. Multiplication order here means:
// apply `left`, then apply `right`.
export const multiply3mfTransforms = (left, right) => [
  left[0] * right[0] + left[1] * right[3] + left[2] * right[6],
  left[0] * right[1] + left[1] * right[4] + left[2] * right[7],
  left[0] * right[2] + left[1] * right[5] + left[2] * right[8],
  left[3] * right[0] + left[4] * right[3] + left[5] * right[6],
  left[3] * right[1] + left[4] * right[4] + left[5] * right[7],
  left[3] * right[2] + left[4] * right[5] + left[5] * right[8],
  left[6] * right[0] + left[7] * right[3] + left[8] * right[6],
  left[6] * right[1] + left[7] * right[4] + left[8] * right[7],
  left[6] * right[2] + left[7] * right[5] + left[8] * right[8],
  left[9] * right[0] + left[10] * right[3] + left[11] * right[6] + right[9],
  left[9] * right[1] + left[10] * right[4] + left[11] * right[7] + right[10],
  left[9] * right[2] + left[10] * right[5] + left[11] * right[8] + right[11]
];

export const buildPlateObjectTransform = ({ transform, coordinateMapping }) => {
  const position = vector(transform?.positionMm, 'transform.positionMm');
  const rotation = vector(transform?.rotationDeg, 'transform.rotationDeg');
  const scale = vector(transform?.scale, 'transform.scale', { positive: true });
  const translation = vector(coordinateMapping?.translationMm, 'coordinateMapping.translationMm');
  if (coordinateMapping?.projectOrigin !== 'center') {
    throw new WorkerError('Only the center-origin AM Pilot project coordinate contract is supported.', {
      code: 'slicer_coordinate_mapping_unsupported'
    });
  }
  if (!['front_left', 'center'].includes(coordinateMapping?.engineBedOrigin)) {
    throw new WorkerError('The effective engine bed origin is unsupported.', {
      code: 'slicer_coordinate_mapping_unsupported'
    });
  }

  const x = rotation.x * Math.PI / 180;
  const y = rotation.y * Math.PI / 180;
  const z = rotation.z * Math.PI / 180;
  const a = Math.cos(x);
  const b = Math.sin(x);
  const c = Math.cos(y);
  const d = Math.sin(y);
  const e = Math.cos(z);
  const f = Math.sin(z);

  // Matches THREE.Euler's default XYZ order used by the AM Pilot Slicer viewport.
  const l00 = c * e * scale.x;
  const l01 = -c * f * scale.y;
  const l02 = d * scale.z;
  const l10 = (a * f + b * e * d) * scale.x;
  const l11 = (a * e - b * f * d) * scale.y;
  const l12 = -b * c * scale.z;
  const l20 = (b * f - a * e * d) * scale.x;
  const l21 = (b * e + a * f * d) * scale.y;
  const l22 = a * c * scale.z;

  return [
    l00, l10, l20,
    l01, l11, l21,
    l02, l12, l22,
    position.x + translation.x,
    position.y + translation.y,
    position.z + translation.z
  ];
};

export const format3mfTransform = transform => transform
  .map(value => {
    const normalized = Math.abs(value) < 1e-12 ? 0 : Number(value.toFixed(12));
    return String(normalized);
  })
  .join(' ');

export const apply3mfTransform = (point, transform) => ({
  x: point.x * transform[0] + point.y * transform[3] + point.z * transform[6] + transform[9],
  y: point.x * transform[1] + point.y * transform[4] + point.z * transform[7] + transform[10],
  z: point.x * transform[2] + point.y * transform[5] + point.z * transform[8] + transform[11]
});
