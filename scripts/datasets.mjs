// Datasets: static data published separately from views and addressed by the
// hash of their pack. See doc/datasets.md.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse } from 'yaml';

export const datasetRoot = new URL('../src/datasets/', import.meta.url);
const segment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const pathPart = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const required = ['title', 'kind', 'source', 'license'];
const optional = ['sourceUrl', 'licenseUrl', 'notice'];
const fields = [...required, ...optional, 'meta', 'derive'];
const types = { '.json': 'application/json', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8' };

export const isPackPath = path => typeof path === 'string' && path.split('/').every(part => pathPart.test(part));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function loadDatasets(root = datasetRoot) {
  const found = new Map();
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return found;
  for (const { name: id } of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory())) {
    const manifest = new URL(`${id}/dataset.yml`, root);
    try {
      if (!segment.test(id)) throw new Error('Invalid dataset folder name');
      const data = parse(readFileSync(manifest, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a mapping');
      for (const field of Object.keys(data)) {
        if (!fields.includes(field)) throw new Error(`Unknown dataset field ${field}`);
      }
      for (const field of required) {
        if (typeof data[field] !== 'string' || !data[field].trim()) throw new Error(`Expected a nonempty ${field}`);
      }
      for (const field of optional) {
        if (field in data && (typeof data[field] !== 'string' || !data[field].trim())) throw new Error(`Expected a nonempty ${field}`);
      }
      if (!segment.test(data.kind)) throw new Error('Expected a kebab-case kind');
      if ('meta' in data && (!data.meta || typeof data.meta !== 'object' || Array.isArray(data.meta))) {
        throw new Error('Expected meta to be a mapping');
      }
      if ('derive' in data) {
        if (data.derive !== 'derive.mjs') throw new Error('Expected derive: derive.mjs');
        if (!statSync(new URL(`${id}/derive.mjs`, root), { throwIfNoEntry: false })?.isFile()) throw new Error('Missing derive.mjs');
      } else if (!statSync(new URL(`${id}/files/`, root), { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error('Expected a files directory or derive: derive.mjs');
      }
      found.set(id, { id, ...data, root });
    } catch (error) {
      throw new Error(`${manifest.pathname}: ${error.message}`, { cause: error });
    }
  }
  return found;
}

export const datasets = loadDatasets();

async function readTree(folder, prefix = '') {
  const files = new Map();
  for (const item of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix + item.name;
    if (item.isDirectory()) {
      for (const [child, bytes] of await readTree(new URL(item.name + '/', folder), path + '/')) files.set(child, bytes);
    } else if (item.isFile()) {
      if (!isPackPath(path)) throw new Error(`Unsupported dataset file name ${path}`);
      files.set(path, new Uint8Array(await readFile(new URL(item.name, folder))));
    }
  }
  return files;
}

/** Writes a deterministic pack: sorted entries and the index's own key order. */
export function writePack(header, files) {
  const paths = [...files.keys()].sort();
  const entries = {};
  let offset = 0;
  for (const path of paths) {
    if (!isPackPath(path)) throw new Error(`Unsupported dataset path ${path}`);
    const bytes = files.get(path);
    entries[path] = { offset, length: bytes.length, type: types[extname(path)] ?? 'application/octet-stream', sha256: sha256(bytes) };
    offset += bytes.length;
  }
  const index = Buffer.from(JSON.stringify({ format: 1, ...header, entries }));
  const start = Buffer.alloc(8);
  start.write('VZPK', 0, 'latin1');
  start.writeUInt32LE(index.length, 4);
  return { bytes: Buffer.concat([start, index, ...paths.map(path => files.get(path))]), hash: sha256(index), size: 8 + index.length + offset };
}

export function createDatasetStore(registry = datasets) {
  const files = new Map();
  const packs = new Map();

  function get(id) {
    const dataset = registry.get(id);
    if (!dataset) throw new Error(`Unknown dataset ${id}`);
    return dataset;
  }

  function datasetFiles(id, trail = []) {
    if (trail.includes(id)) throw new Error(`Dataset derivation cycle: ${[...trail, id].join(' → ')}`);
    const dataset = get(id);
    if (!files.has(id)) {
      files.set(id, (async () => {
        if (!dataset.derive) return readTree(new URL(`${id}/files/`, dataset.root));
        const { default: derive } = await import(new URL(`${id}/derive.mjs`, dataset.root));
        const result = await derive({ dataset, files: other => datasetFiles(other, [...trail, id]) });
        if (!(result instanceof Map) || [...result].some(([path, bytes]) => !isPackPath(path) || !(bytes instanceof Uint8Array))) {
          throw new Error(`${id}/derive.mjs must return a Map of paths to Uint8Array`);
        }
        return result;
      })());
    }
    return files.get(id);
  }

  /** One file, without reading the rest of a stored dataset. */
  async function datasetFile(id, path) {
    const dataset = get(id);
    if (dataset.derive) {
      const bytes = (await datasetFiles(id)).get(path);
      if (!bytes) throw new Error(`Dataset ${id} has no ${path}`);
      return bytes;
    }
    if (!isPackPath(path)) throw new Error(`Unsupported dataset path ${path}`);
    return new Uint8Array(await readFile(new URL(`${id}/files/${path}`, dataset.root)));
  }

  function packDataset(id) {
    if (!packs.has(id)) {
      packs.set(id, (async () => {
        const { title, kind, source, sourceUrl, licenseUrl, license, notice, meta } = get(id);
        return writePack({ id, kind, title, source, sourceUrl, license, licenseUrl, notice, meta }, await datasetFiles(id));
      })());
    }
    return packs.get(id);
  }

  /** The build-time view of a dataset that a view's content.mjs receives. */
  function describe(id) {
    const { title, kind, source, sourceUrl, license, licenseUrl, notice, meta = {} } = get(id);
    const text = async path => new TextDecoder().decode(await datasetFile(id, path));
    return {
      id, title, kind, source, sourceUrl, license, licenseUrl, notice, meta,
      bytes: path => datasetFile(id, path), text, json: async path => JSON.parse(await text(path)),
      paths: async () => [...(await datasetFiles(id)).keys()],
    };
  }

  return { get, datasetFiles, datasetFile, packDataset, describe };
}

export const datasetStore = createDatasetStore();
