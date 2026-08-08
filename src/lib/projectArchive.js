import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { mediaBytes, mediaPackagePath, sha256Hex } from './mediaHash.js';
import { normalizeMediaRegistry } from './mediaRegistry.js';

export const PROJECT_PACKAGE_FORMAT = 'paintty-project';
export const PROJECT_PACKAGE_VERSION = 1;

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function blobEntry(source, hash) {
  if (!source) return null;
  if (typeof source === 'function') return source(hash);
  if (source instanceof Map) return source.get(hash);
  return source[hash] || null;
}

function manifestAsset(asset) {
  return {
    assetId: asset.assetId,
    hash: asset.hash,
    path: asset.path,
    kind: asset.kind,
    size: asset.size,
    mime: asset.mime,
  };
}

function sameManifestAsset(first, second) {
  return JSON.stringify(manifestAsset(first)) === JSON.stringify(manifestAsset(second));
}

export async function encodeProjectArchive({
  document,
  mediaRegistry,
  mediaBlobs,
  blobsByHash,
}, output = 'blob') {
  const project = typeof document === 'string' ? JSON.parse(document) : document;
  const projectRegistry = normalizeMediaRegistry(project?.media, 'Project media registry');
  const registry = mediaRegistry
    ? normalizeMediaRegistry(mediaRegistry, 'Project media registry snapshot')
    : projectRegistry;
  if (JSON.stringify(registry) !== JSON.stringify(projectRegistry)) {
    throw new Error('Project media registry snapshot does not match the document.');
  }
  const supplied = blobsByHash || mediaBlobs;
  const entries = Object.create(null);
  const unique = new Map();
  for (const asset of registry.assets) {
    const previous = unique.get(asset.hash);
    if (previous && previous.path !== asset.path) {
      throw new Error(`Media hash ${asset.hash} has conflicting package paths.`);
    }
    unique.set(asset.hash, asset);
  }
  for (const asset of unique.values()) {
    const blob = await blobEntry(supplied, asset.hash);
    if (!blob) throw new Error(`Project media is missing bytes for ${asset.sourceName}.`);
    const data = await mediaBytes(blob.blob || blob);
    if (data.byteLength !== asset.size) {
      throw new Error(`Project media size mismatch for ${asset.sourceName}.`);
    }
    const hash = await sha256Hex(data);
    if (hash !== asset.hash) throw new Error(`Project media hash mismatch for ${asset.sourceName}.`);
    entries[asset.path] = [data, { level: 0, mtime: new Date(1980, 0, 1) }];
  }
  const manifest = {
    format: PROJECT_PACKAGE_FORMAT,
    version: PROJECT_PACKAGE_VERSION,
    document: project,
    assets: registry.assets.map(manifestAsset),
  };
  entries['project.json'] = [strToU8(`${JSON.stringify(manifest, null, 2)}\n`), {
    level: 6,
    mtime: new Date(1980, 0, 1),
  }];
  const archive = zipSync(entries);
  if (output === 'uint8array') return archive;
  if (output !== 'blob') throw new TypeError("Project archive output must be 'blob' or 'uint8array'.");
  return new Blob([archive], { type: 'application/zip' });
}

export async function decodeProjectArchive(value) {
  const input = asBytes(value);
  if (!input) throw new TypeError('Paintty package must be binary data.');
  const entries = unzipSync(input);
  const projectEntry = entries['project.json'];
  if (!projectEntry) throw new Error('Paintty package is missing project.json.');
  const manifest = JSON.parse(strFromU8(projectEntry));
  if (manifest?.format !== PROJECT_PACKAGE_FORMAT || manifest.version !== PROJECT_PACKAGE_VERSION) {
    throw new Error('Unsupported Paintty project package.');
  }
  const registry = normalizeMediaRegistry(manifest.document?.media, 'Project media registry');
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== registry.assets.length) {
    throw new Error('Paintty package media manifest does not match the project registry.');
  }
  const declaredById = new Map();
  for (const asset of manifest.assets) {
    const fields = asset && typeof asset === 'object' ? Object.keys(asset) : [];
    if (!asset || typeof asset !== 'object' || fields.length !== 6 ||
        fields.some((field) => !['assetId', 'hash', 'path', 'kind', 'size', 'mime'].includes(field)) ||
        declaredById.has(asset.assetId)) {
      throw new Error('Paintty package contains duplicate or malformed media metadata.');
    }
    declaredById.set(asset.assetId, asset);
  }
  for (const asset of registry.assets) {
    const declared = declaredById.get(asset.assetId);
    if (!declared || !sameManifestAsset(declared, asset)) {
      throw new Error(`Paintty package media metadata does not match ${asset.assetId}.`);
    }
  }

  const mediaBlobs = new Map();
  const unique = new Map();
  for (const asset of registry.assets) unique.set(asset.hash, asset);
  for (const [hash, asset] of unique) {
    const expectedPath = mediaPackagePath(hash);
    if (asset.path !== expectedPath) throw new Error(`Unsafe media asset path: ${asset.path}`);
    const data = entries[expectedPath];
    if (!data) throw new Error(`Paintty package is missing ${expectedPath}.`);
    if (data.byteLength !== asset.size) throw new Error(`Paintty package media size mismatch: ${asset.sourceName}.`);
    const actualHash = await sha256Hex(data);
    if (actualHash !== hash) throw new Error(`Paintty package media hash mismatch: ${asset.sourceName}.`);
    mediaBlobs.set(hash, new Blob([data], { type: asset.mime || 'application/octet-stream' }));
  }
  return { document: manifest.document, mediaBlobs, manifest };
}
