import { setImmediate as yieldToWorker } from 'node:timers/promises';
import { zlibSync } from 'fflate';
import { WorkerError } from './errors.js';
import { apply3mfTransform } from './transform.js';

export const BAMBU_PLATE_IMAGE = 'Metadata/plate_1.png';
export const BAMBU_SMALL_PLATE_IMAGE = 'Metadata/plate_1_small.png';
const imageSize = 512;
const smallImageSize = 128;
const rasterSize = imageSize * 2;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// A fixed orthographic studio view keeps every plate framed the same way.
// Depth increases toward the camera; the key light comes from the upper left.
const elevation = 60 * Math.PI / 180;
const sinElevation = Math.sin(elevation);
const cosElevation = Math.cos(elevation);
const light = [-0.48, -0.65, 0.59];
const invalid = message => new WorkerError(message, { code: 'slicer_bambu_thumbnail_invalid' });

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value;
});
const pngChunk = (type, data) => {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 'ascii');
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (let index = 4; index < chunk.length - 4; index++) crc = (crc >>> 8) ^ crcTable[(crc ^ chunk[index]) & 255];
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
};
const encodePng = (pixels, width) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(width, 4);
  header[8] = 8;
  header[9] = 6; // RGBA, straight alpha.
  const stride = 4 * width + 1;
  const scanlines = Buffer.alloc(width * stride);
  for (let y = 0; y < width; y++) scanlines.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  return Buffer.concat([pngSignature, pngChunk('IHDR', header), pngChunk('IDAT', zlibSync(scanlines)), pngChunk('IEND', Buffer.alloc(0))]);
};

const project = (x, y, z) => {
  const across = (x - y) / Math.SQRT2;
  const diagonal = (x + y) / Math.SQRT2;
  return [across, diagonal * sinElevation - z * cosElevation, diagonal * cosElevation + z * sinElevation];
};

// Compact meshes are retained only until the plate image is rendered. Repeated
// native instances share one mesh and apply the same transforms used by slicing.
export function createBambuThumbnailScene() {
  const meshes = new WeakMap();
  const instances = [];
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  return {
    addInstance(geometry, transform) {
      let mesh = meshes.get(geometry);
      if (!mesh) {
        const vertices = new Float64Array(geometry.vertices.length * 3);
        const indices = new Uint32Array(geometry.triangles.length * 3);
        geometry.vertices.forEach(({ x, y, z }, index) => {
          vertices[3 * index] = x;
          vertices[3 * index + 1] = y;
          vertices[3 * index + 2] = z;
        });
        geometry.triangles.forEach(({ indices: triangle }, index) => indices.set(triangle, index * 3));
        mesh = { vertices, indices };
        meshes.set(geometry, mesh);
      }
      instances.push({ mesh, transform });
      visitProjectedVertices(mesh.vertices, transform, (_offset, x, y) => {
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x);
        bounds[3] = Math.max(bounds[3], y);
      });
    },
    async render({ filamentColor, signal }) {
      const [left, top, right, bottom] = bounds;
      const extent = Math.max(right - left, bottom - top);
      if (!Number.isFinite(extent) || extent <= 0 || !/^#[0-9a-f]{6}$/i.test(filamentColor)) {
        throw invalid('The plate thumbnail needs valid model geometry and a filament color.');
      }
      const scale = rasterSize * 0.88 / extent;
      const centerX = (left + right) / 2;
      const centerY = (top + bottom) / 2;
      const pixels = new Uint8Array(rasterSize * rasterSize * 4);
      const depth = new Float64Array(rasterSize * rasterSize).fill(-Infinity);
      const rgb = Buffer.from(filamentColor.slice(1), 'hex');
      let effort = 0;
      for (const { mesh, transform } of instances) {
        const screen = new Float64Array(mesh.vertices.length);
        visitProjectedVertices(mesh.vertices, transform, (offset, x, y, z) => {
          screen[offset] = (x - centerX) * scale + rasterSize / 2;
          screen[offset + 1] = (y - centerY) * scale + rasterSize / 2;
          screen[offset + 2] = z * scale;
        });
        for (let i = 0; i < mesh.indices.length; i += 3) {
          effort += 1 + rasterizeTriangle(screen, mesh.indices, i, rgb, pixels, depth);
          // Bound the synchronous work between lease heartbeats even on plates
          // with dense geometry or many overlapping screen-space triangles.
          if (effort >= rasterSize * rasterSize) {
            await yieldToWorker(undefined, { signal });
            effort = 0;
          }
        }
      }
      instances.length = 0;
      signal?.throwIfAborted();
      if (!pixels.some((value, index) => index % 4 === 3 && value)) {
        throw invalid('The plate thumbnail contains no visible model surfaces.');
      }
      shadeCreases(pixels, depth);
      return {
        [BAMBU_PLATE_IMAGE]: encodePng(downsample(pixels, imageSize), imageSize),
        [BAMBU_SMALL_PLATE_IMAGE]: encodePng(downsample(pixels, smallImageSize), smallImageSize)
      };
    }
  };
}

function visitProjectedVertices(vertices, transform, visit) {
  for (let offset = 0; offset < vertices.length; offset += 3) {
    const point = apply3mfTransform({ x: vertices[offset], y: vertices[offset + 1], z: vertices[offset + 2] }, transform);
    visit(offset, ...project(point.x, point.y, point.z));
  }
}

function rasterizeTriangle(points, indices, index, rgb, pixels, depth) {
  const a = indices[index] * 3, b = indices[index + 1] * 3, c = indices[index + 2] * 3;
  const ax = points[a], ay = points[a + 1], az = points[a + 2];
  const ux = points[b] - ax, uy = points[b + 1] - ay, uz = points[b + 2] - az;
  const vx = points[c] - ax, vy = points[c + 1] - ay, vz = points[c + 2] - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, area = ux * vy - uy * vx;
  if (!area) return 0;
  const left = Math.max(0, Math.ceil(Math.min(ax, points[b], points[c]) - 0.5));
  const right = Math.min(rasterSize - 1, Math.floor(Math.max(ax, points[b], points[c]) - 0.5));
  const top = Math.max(0, Math.ceil(Math.min(ay, points[b + 1], points[c + 1]) - 0.5));
  const bottom = Math.min(rasterSize - 1, Math.floor(Math.max(ay, points[b + 1], points[c + 1]) - 0.5));
  if (right < left || bottom < top) return 0;
  const diffuse = Math.max(0, Math.sign(area) * (nx * light[0] + ny * light[1] + area * light[2]) / Math.hypot(nx, ny, area));
  // A small neutral studio fill keeps near-black filaments legible as well.
  const shade = 0.46 + 0.44 * diffuse;
  const fill = 9 + 32 * diffuse;
  const red = Math.round(rgb[0] * shade + fill * (1 - rgb[0] / 255));
  const green = Math.round(rgb[1] * shade + fill * (1 - rgb[1] / 255));
  const blue = Math.round(rgb[2] * shade + fill * (1 - rgb[2] / 255));
  for (let y = top; y <= bottom; y++) {
    const dy = y + 0.5 - ay;
    for (let x = left; x <= right; x++) {
      const dx = x + 0.5 - ax;
      const u = (dx * vy - dy * vx) / area;
      const v = (ux * dy - uy * dx) / area;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const z = az + u * uz + v * vz;
      const pixel = y * rasterSize + x;
      if (z <= depth[pixel]) continue;
      depth[pixel] = z;
      pixels[4 * pixel] = red;
      pixels[4 * pixel + 1] = green;
      pixels[4 * pixel + 2] = blue;
      pixels[4 * pixel + 3] = 255;
    }
  }
  return (right - left + 1) * (bottom - top + 1);
}

// The average of opposite depth samples cancels the gradient of flat faces.
// Darken inward steps to keep shallow engravings visible after downsampling.
function shadeCreases(pixels, depth) {
  const offset = rasterSize / (2 * smallImageSize);
  for (let y = offset; y < rasterSize - offset; y++) for (let x = offset; x < rasterSize - offset; x++) {
    const i = y * rasterSize + x;
    const center = depth[i];
    if (!Number.isFinite(center)) continue;
    const horizontal = (depth[i - offset] + depth[i + offset]) / 2 - center;
    const vertical = (depth[i - offset * rasterSize] + depth[i + offset * rasterSize]) / 2 - center;
    const crease = Math.max(horizontal, vertical) / offset;
    if (crease <= 0.06) continue;
    const contrast = 1 - 0.32 * Math.min(1, crease);
    const pixel = 4 * i;
    pixels[pixel] *= contrast;
    pixels[pixel + 1] *= contrast;
    pixels[pixel + 2] *= contrast;
  }
}

function downsample(source, width) {
  const target = new Uint8Array(width * width * 4);
  const factor = rasterSize / width;
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    let red = 0, green = 0, blue = 0, covered = 0;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const from = ((y * factor + dy) * rasterSize + x * factor + dx) * 4;
      if (!source[from + 3]) continue;
      red += source[from];
      green += source[from + 1];
      blue += source[from + 2];
      covered++;
    }
    if (covered) {
      const to = 4 * (y * width + x);
      target[to] = Math.round(red / covered);
      target[to + 1] = Math.round(green / covered);
      target[to + 2] = Math.round(blue / covered);
      target[to + 3] = Math.round(255 * covered / (factor * factor));
    }
  }
  return target;
}
