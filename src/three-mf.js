import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { WorkerError } from './errors.js';
import {
  format3mfTransform,
  multiply3mfTransforms,
  parse3mfTransform
} from './transform.js';

const MODEL_PATH = '3D/3dmodel.model';
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

export const buildTransformed3mf = ({ source, objectTransform }) => {
  let entries;
  try {
    entries = unzipSync(source);
  } catch (error) {
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
  const transformedModel = applyBuildTransformTo3mfXml(strFromU8(entries[modelPath]), objectTransform);
  return zipSync({
    '[Content_Types].xml': deterministicEntry(CONTENT_TYPES),
    '_rels/.rels': deterministicEntry(RELATIONSHIPS),
    [MODEL_PATH]: deterministicEntry(transformedModel)
  });
};
