import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { WorkerError } from './errors.js';
import { BAMBU_PLATE_IMAGE, BAMBU_SMALL_PLATE_IMAGE } from './bambu-thumbnail-renderer.js';

const modelSettings = 'Metadata/model_settings.config';
const invalid = message => new WorkerError(message, { code: 'slicer_bambu_thumbnail_invalid' });

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
  const plate = images?.[BAMBU_PLATE_IMAGE];
  const small = images?.[BAMBU_SMALL_PLATE_IMAGE];
  if (!Buffer.isBuffer(plate) || !plate.length || !Buffer.isBuffer(small) || !small.length) throw invalid('Both native plate cover images are required.');
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
    .replace('</plate>', `  <metadata key="thumbnail_file" value="${BAMBU_PLATE_IMAGE}"/>\n  </plate>`);
  const overlay = { [modelSettings]: strToU8(settings.replace(plates[0][0], updatedPlate)), [BAMBU_PLATE_IMAGE]: plate, [BAMBU_SMALL_PLATE_IMAGE]: small };
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

export async function finalizeBambuArchiveThumbnail({ archivePath, archiveArtifact, images, maximumArchiveBytes, maximumExpandedBytes, signal }) {
  const bytes = await fs.readFile(archivePath, { signal });
  if (bytes.length !== archiveArtifact.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== archiveArtifact.checksumSha256) {
    throw invalid('The native archive changed after validation.');
  }
  const output = addBambuPlateImages(bytes, images, maximumArchiveBytes, maximumExpandedBytes);
  await fs.writeFile(archivePath, output, { mode: 0o600, signal });
  return Object.freeze({ ...archiveArtifact, checksumSha256: createHash('sha256').update(output).digest('hex'), sizeBytes: output.length });
}
