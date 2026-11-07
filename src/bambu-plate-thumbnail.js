import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { strFromU8, strToU8, unzipSync, zipSync, zlibSync } from 'fflate';
import { WorkerError } from './errors.js';

const plateImage = 'Metadata/plate_1.png';
const smallPlateImage = 'Metadata/plate_1_small.png';
const modelSettings = 'Metadata/model_settings.config';
const size = 512;
const smallSize = 128;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
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

const project = (x, y, z) => ({
  x: (x - y) / Math.SQRT2,
  y: (x + y) / (2 * Math.SQRT2) - z * Math.sqrt(3) / 2,
  depth: (x + y) * Math.sqrt(3) / (2 * Math.SQRT2) + z / 2
});

async function renderPlate({ recordPath, bounds, stride, includeMove, filamentColor, signal }) {
  const corners = [];
  for (const x of [bounds.minimum.x, bounds.maximum.x])
    for (const y of [bounds.minimum.y, bounds.maximum.y])
      for (const z of [bounds.minimum.z, bounds.maximum.z]) corners.push(project(x, y, z));
  const left = Math.min(...corners.map(point => point.x));
  const right = Math.max(...corners.map(point => point.x));
  const top = Math.min(...corners.map(point => point.y));
  const bottom = Math.max(...corners.map(point => point.y));
  const extent = Math.max(right - left, bottom - top);
  if (!Number.isFinite(extent) || extent <= 0 || !/^#[0-9A-F]{6}$/.test(filamentColor)) throw invalid('The print preview lacks valid geometry or filament color.');
  const scale = (size - 48) / extent;
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const rgb = Buffer.from(filamentColor.slice(1), 'hex');
  const pixels = new Uint8Array(size * size * 4);
  const depths = new Float32Array(size * size).fill(-Infinity);
  const stamp = (x, y, depth, color) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const index = y * size + x;
    if (depth < depths[index]) return;
    depths[index] = depth;
    pixels.set(color, 4 * index);
  };
  const drawMove = (record, at) => {
    if (!includeMove(record.readUInt8(at + 52), record.readUInt8(at + 53))) return;
    const from = project(record.readFloatLE(at), record.readFloatLE(at + 4), record.readFloatLE(at + 8));
    const to = project(record.readFloatLE(at + 12), record.readFloatLE(at + 16), record.readFloatLE(at + 20));
    const x0 = (from.x - centerX) * scale + size / 2;
    const y0 = (from.y - centerY) * scale + size / 2;
    const dx = (to.x - from.x) * scale;
    const dy = (to.y - from.y) * scale;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
    if (!Number.isSafeInteger(steps) || steps > size) throw invalid('The print preview contains an out-of-bounds move.');
    const radius = Math.max(0, Math.min(4, Math.round(record.readFloatLE(at + 24) * scale / 2)));
    const z = Math.max(record.readFloatLE(at + 8), record.readFloatLE(at + 20));
    const heightFraction = bounds.maximum.z > bounds.minimum.z ? (z - bounds.minimum.z) / (bounds.maximum.z - bounds.minimum.z) : 1;
    const shade = 0.63 + 0.37 * Math.min(1, Math.max(0, heightFraction));
    const color = [Math.round(rgb[0] * shade), Math.round(rgb[1] * shade), Math.round(rgb[2] * shade), 255];
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const x = Math.round(x0 + dx * t);
      const y = Math.round(y0 + dy * t);
      const depth = from.depth + (to.depth - from.depth) * t;
      for (let oy = -radius; oy <= radius; oy++)
        for (let ox = -radius; ox <= radius; ox++)
          if (ox * ox + oy * oy <= radius * radius) stamp(x + ox, y + oy, depth, color);
    }
  };
  let remainder = Buffer.alloc(0);
  for await (const chunk of createReadStream(recordPath, { signal })) {
    const records = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    const aligned = records.length - records.length % stride;
    for (let at = 0; at < aligned; at += stride) drawMove(records, at);
    remainder = records.subarray(aligned);
  }
  if (remainder.length || !depths.some(Number.isFinite)) throw invalid('The print preview contains no complete model extrusion records.');
  const reduced = new Uint8Array(smallSize * smallSize * 4);
  const factor = size / smallSize;
  for (let y = 0; y < smallSize; y++) for (let x = 0; x < smallSize; x++) {
    let r = 0, g = 0, b = 0, count = 0;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const source = ((y * factor + dy) * size + x * factor + dx) * 4;
      if (!pixels[source + 3]) continue;
      r += pixels[source]; g += pixels[source + 1]; b += pixels[source + 2]; count++;
    }
    if (count) reduced.set([r / count, g / count, b / count, count * 255 / (factor * factor)], (y * smallSize + x) * 4);
  }
  return { [plateImage]: encodePng(pixels, size), [smallPlateImage]: encodePng(reduced, smallSize) };
}

// The pinned native exporter writes a single-disk ZIP32. Preserve its compressed
// entries and only replace the model-settings entry and the two cover images.
function archiveEntries(bytes) {
  const end = bytes.length - 22;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt32LE(end + 4) !== 0
    || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10) || bytes.readUInt16LE(end + 20) !== 0) {
    throw invalid('The native archive directory is unsupported.');
  }
  const count = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  if (!count || count > 4096 || start + bytes.readUInt32LE(end + 12) !== end) throw invalid('The native archive directory is invalid.');
  const entries = [];
  const names = new Set();
  let at = start;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50 || bytes.readUInt16LE(at + 34) !== 0) throw invalid('The native archive entry is invalid.');
    const nameSize = bytes.readUInt16LE(at + 28);
    const next = at + 46 + nameSize + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    if (!nameSize || next > end) throw invalid('The native archive entry exceeds its directory.');
    const name = bytes.toString('utf8', at + 46, at + 46 + nameSize);
    const offset = bytes.readUInt32LE(at + 42);
    if (names.has(name.toLowerCase()) || offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50) throw invalid('The native archive entry identity is invalid.');
    names.add(name.toLowerCase());
    entries.push({ name, offset, directory: bytes.subarray(at, next) });
    at = next;
  }
  if (at !== end) throw invalid('The native archive directory contains unexpected data.');
  entries.sort((a, b) => a.offset - b.offset);
  if (entries[0].offset !== 0 || entries.some((entry, index) => index > 0 && entry.offset === entries[index - 1].offset)) throw invalid('The native archive offsets are invalid.');
  return entries.map((entry, index) => ({ ...entry, body: bytes.subarray(entry.offset, entries[index + 1]?.offset ?? start) }));
}

export function addBambuPlateImages(bytes, images, maximumArchiveBytes, maximumExpandedBytes) {
  const retained = archiveEntries(bytes);
  const files = unzipSync(bytes, { filter: entry => {
    if (entry.name !== modelSettings) return false;
    if (entry.originalSize > 2 * 1024 * 1024) throw invalid('The native model settings exceed their metadata limit.');
    return true;
  } });
  const settings = files[modelSettings] && strFromU8(files[modelSettings]);
  const plates = settings && [...settings.matchAll(/<plate>([\s\S]*?)<\/plate>/g)];
  if (plates?.length !== 1 || !plates[0][1].includes('key="gcode_file" value="Metadata/plate_1.gcode"')) throw invalid('The native archive has no unambiguous plate image target.');
  const updatedPlate = plates[0][0].replace(/\s*<metadata key="thumbnail_file" value="[^"]*"\/>/g, '')
    .replace('</plate>', '  <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>\n  </plate>');
  const overlay = { [modelSettings]: strToU8(settings.replace(plates[0][0], updatedPlate)), ...images };
  const additions = archiveEntries(Buffer.from(zipSync(overlay, { mtime: new Date('1980-01-01T00:00:00Z') })));
  const replacementNames = new Set(Object.keys(overlay).map(name => name.toLowerCase()));
  const entries = retained.filter(entry => !replacementNames.has(entry.name.toLowerCase())).concat(additions);
  const expanded = entries.reduce((total, entry) => total + entry.directory.readUInt32LE(24), 0);
  if (expanded > maximumExpandedBytes) throw invalid('The archive with its plate preview exceeds the expansion limit.');
  if (entries.length > 4096) throw invalid('The archive has too many entries after adding its preview.');
  const bodies = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const entry of entries) {
    const central = Buffer.from(entry.directory);
    central.writeUInt32LE(offset, 42);
    directory.push(central);
    bodies.push(entry.body);
    offset += entry.body.length;
    directorySize += central.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  const length = offset + directorySize + end.length;
  if (length > maximumArchiveBytes) throw invalid('The archive with its plate preview exceeds the byte limit.');
  return Buffer.concat([...bodies, ...directory, end], length);
}

export async function finalizeBambuArchiveThumbnail({ archivePath, archiveArtifact, recordPath, bounds, stride, includeMove, filamentColor, maximumArchiveBytes, maximumExpandedBytes, signal }) {
  const images = await renderPlate({ recordPath, bounds, stride, includeMove, filamentColor, signal });
  const bytes = await fs.readFile(archivePath, { signal });
  if (bytes.length !== archiveArtifact.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== archiveArtifact.checksumSha256) {
    throw invalid('The native archive changed after validation.');
  }
  const output = addBambuPlateImages(bytes, images, maximumArchiveBytes, maximumExpandedBytes);
  await fs.writeFile(archivePath, output, { mode: 0o600, signal });
  return Object.freeze({ ...archiveArtifact, checksumSha256: createHash('sha256').update(output).digest('hex'), sizeBytes: output.length });
}
