import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { WorkerError } from './errors.js';
import { serializePrusaConfig } from './config-ini.js';
import {
  format3mfTransform,
  multiply3mfTransforms,
  parse3mfTransform
} from './transform.js';

const MODEL_PATH = '3D/3dmodel.model';
const MAXIMUM_ARCHIVE_ENTRIES = 128;
const FIXED_ZIP_TIME = new Date('1980-01-01T00:00:00.000Z');
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
const RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/${MODEL_PATH}" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

const rootModelPath = entries => {
  const names = Object.keys(entries);
  return names.find(name => name.toLowerCase() === MODEL_PATH.toLowerCase())
    || names.find(name => name.toLowerCase().endsWith('/3dmodel.model'))
    || names.find(name => name.toLowerCase().endsWith('.model'))
    || null;
};

const replaceAttribute = (attributes, name, value) => {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'i');
  const without = attributes.replace(pattern, '');
  return `${without} ${name}="${value}"`;
};

export const applyBuildTransformTo3mfXml = (xml, objectTransform) => {
  const modelMatch = xml.match(/<(?:[A-Za-z_][\w.-]*:)?model\b([^>]*)>/i);
  if (!modelMatch || !/\bunit\s*=\s*["']millimeter["']/i.test(modelMatch[1])) {
    throw new WorkerError('Normalized 3MF must use millimeter units.', { code: 'slicer_source_3mf_invalid' });
  }
  const buildMatch = xml.match(/<(?:[A-Za-z_][\w.-]*:)?build\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?build\s*>/i);
  if (!buildMatch) {
    throw new WorkerError('Normalized 3MF has no build section.', { code: 'slicer_source_3mf_invalid' });
  }
  let itemCount = 0;
  const transformedBuild = buildMatch[0].replace(
    /(<(?:[A-Za-z_][\w.-]*:)?item\b)([^>]*?)(\/?>)/gi,
    (_match, opening, attributes, closing) => {
      if (!/\bobjectid\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attributes)) {
        throw new WorkerError('Normalized 3MF contains a build item without an object ID.', {
          code: 'slicer_source_3mf_invalid'
        });
      }
      const transformMatch = attributes.match(/\btransform\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const sourceTransform = parse3mfTransform(transformMatch?.[1] ?? transformMatch?.[2] ?? '');
      const composed = multiply3mfTransforms(sourceTransform, objectTransform);
      itemCount += 1;
      return `${opening}${replaceAttribute(attributes, 'transform', format3mfTransform(composed))}${closing}`;
    }
  );
  if (!itemCount) {
    throw new WorkerError('Normalized 3MF build contains no items.', { code: 'slicer_source_3mf_invalid' });
  }
  return xml.replace(buildMatch[0], transformedBuild);
};

const deterministicEntry = value => [strToU8(value), { level: 6, mtime: FIXED_ZIP_TIME }];

export const readNormalized3mfXml = ({ source, maximumUncompressedBytes }) => {
  if (!Number.isSafeInteger(maximumUncompressedBytes) || maximumUncompressedBytes <= 0) {
    throw new WorkerError('A bounded normalized 3MF expansion limit is required.', {
      code: 'slicer_source_3mf_limit_invalid'
    });
  }
  let entryCount = 0;
  let totalUncompressedBytes = 0;
  let entries;
  try {
    entries = unzipSync(source, {
      filter: entry => {
        entryCount += 1;
        const originalSize = Number(entry.originalSize);
        totalUncompressedBytes += originalSize;
        if (
          entryCount > MAXIMUM_ARCHIVE_ENTRIES
          || !Number.isSafeInteger(originalSize)
          || originalSize < 0
          || !Number.isSafeInteger(totalUncompressedBytes)
          || totalUncompressedBytes > maximumUncompressedBytes
        ) {
          throw new WorkerError('Normalized 3MF archive exceeds the qualified expansion limits.', {
            code: 'slicer_source_3mf_expansion_limit_exceeded'
          });
        }
        return entry.name.toLowerCase().endsWith('.model');
      }
    });
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError('PrusaSlicer produced an invalid normalized 3MF package.', {
      code: 'slicer_source_3mf_invalid',
      cause: error
    });
  }
  const modelPath = rootModelPath(entries);
  if (!modelPath) {
    throw new WorkerError('Normalized 3MF package is missing its model document.', {
      code: 'slicer_source_3mf_invalid'
    });
  }
  return strFromU8(entries[modelPath]);
};

export const buildTransformed3mf = ({ source, objectTransform, maximumUncompressedBytes, objectOverrides = {} }) => {
  const transformedModel = applyBuildTransformTo3mfXml(readNormalized3mfXml({ source, maximumUncompressedBytes }), objectTransform);
  const escapeXml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const metadata = {};
  if (Object.keys(objectOverrides).length) {
    const settings = serializePrusaConfig(objectOverrides).trimEnd().split('\n').map(line => {
      const separator = line.indexOf(' = ');
      return '<metadata type="object" key="' + escapeXml(line.slice(0, separator)) + '" value="' + escapeXml(line.slice(separator + 3)) + '"/>';
    }).join('\n');
    const resources = [];
    for (const match of transformedModel.matchAll(/<object\s[^>]*\bid="([0-9]+)"[^>]*>([\s\S]*?)<\/object>/g)) {
      let triangles = 0;
      for (const triangle of match[2].matchAll(/<triangle\s/g)) triangles += 1;
      if (triangles) resources.push({ id: match[1], triangles });
    }
    if (!resources.length) throw new WorkerError('Normalized 3MF has no mesh resources.', { code: 'slicer_source_3mf_invalid' });
    metadata['Metadata/Slic3r_PE_model.config'] = deterministicEntry('<?xml version="1.0" encoding="UTF-8"?><config>' + resources.map(({id, triangles}) =>
      '<object id="' + id + '">' + settings + '<volume firstid="0" lastid="' + (triangles - 1) + '"/></object>').join('') + '</config>');
  }
  return zipSync({
    '[Content_Types].xml': deterministicEntry(CONTENT_TYPES),
    '_rels/.rels': deterministicEntry(RELATIONSHIPS),
    [MODEL_PATH]: deterministicEntry(transformedModel),
    ...metadata
  });
};

// Combines normalized, transformed geometry into one plate without arranging it.
// References are rewritten per input; vendor project settings never enter the job.
export const mergePlate3mf = ({ sources, maximumUncompressedBytes }) => {
  if (!Array.isArray(sources) || !sources.length) throw new WorkerError('Plate geometry is missing.', { code: 'slicer_source_3mf_invalid' });
  let nextId = 1, totalBytes = 0;
  const resources = [], build = [];
  for (const source of sources) {
    const xml = readNormalized3mfXml({ source, maximumUncompressedBytes });
    totalBytes += Buffer.byteLength(xml);
    if (totalBytes > maximumUncompressedBytes || /<!DOCTYPE|<!ENTITY|\b(?:p:)?path\s*=/i.test(xml)) {
      throw new WorkerError('Plate geometry exceeds limits or contains external references.', { code: 'slicer_source_3mf_invalid' });
    }
    const resourceBody = xml.match(/<resources\b[^>]*>([\s\S]*?)<\/resources\s*>/i)?.[1];
    const buildBody = xml.match(/<build\b[^>]*>([\s\S]*?)<\/build\s*>/i)?.[1];
    if (!resourceBody || !buildBody) throw new WorkerError('Normalized plate geometry is incomplete.', { code: 'slicer_source_3mf_invalid' });
    const objects = [...resourceBody.matchAll(/<object\b[^>]*\bid="([0-9]+)"[^>]*>[\s\S]*?<\/object\s*>/g)];
    const unhandledResources = objects.reduce((rest, object) => rest.replace(object[0], ''), resourceBody).replace(/<!--[\s\S]*?-->/g, '').trim();
    if (unhandledResources || /\b(?:pid|pindex|p1|p2|p3|requiredextensions)\s*=/.test(xml)) {
      throw new WorkerError('Normalized Bambu input contains unsupported material resources or extensions.', { code: 'slicer_source_3mf_invalid' });
    }
    const ids = new Map();
    for (const object of objects) {
      if (ids.has(object[1])) throw new WorkerError('Duplicate geometry object ID.', { code: 'slicer_source_3mf_invalid' });
      ids.set(object[1], String(nextId++));
    }
    if (!objects.length) throw new WorkerError('Normalized plate has no objects.', { code: 'slicer_source_3mf_invalid' });
    const reference = (_match, id) => {
      if (!ids.has(id)) throw new WorkerError('Missing geometry reference.', { code: 'slicer_source_3mf_invalid' });
      return `objectid="${ids.get(id)}"`;
    };
    for (const object of objects) resources.push(object[0].replace(/(<object\b[^>]*\bid=")[0-9]+"/, (_match, prefix) => `${prefix}${ids.get(object[1])}"`).replace(/\bobjectid="([0-9]+)"/g, reference));
    const items = [...buildBody.matchAll(/<item\b[^>]*\/>/g)];
    if (items.reduce((rest, item) => rest.replace(item[0], ''), buildBody).replace(/<!--[\s\S]*?-->/g, '').trim()) throw new WorkerError('Unsupported plate build elements.', { code: 'slicer_source_3mf_invalid' });
    if (!items.length) throw new WorkerError('Plate contains no placed objects.', { code: 'slicer_source_3mf_invalid' });
    build.push(...items.map(item => item[0].replace(/\bobjectid="([0-9]+)"/g, reference)));
  }
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${resources.join('')}</resources><build>${build.join('')}</build></model>`;
  if (Buffer.byteLength(model) > maximumUncompressedBytes) throw new WorkerError('Assembled plate exceeds its byte limit.', { code: 'slicer_plate_input_size_exceeded' });
  return zipSync({ '[Content_Types].xml': deterministicEntry(CONTENT_TYPES), '_rels/.rels': deterministicEntry(RELATIONSHIPS), [MODEL_PATH]: deterministicEntry(model) });
};
