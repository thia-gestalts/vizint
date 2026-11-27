// Reader for dataset packs (.vzpk). See doc/datasets.md for the format.
//
//   "VZPK" | u32 LE index length | UTF-8 JSON index | entry bytes
//
// A dataset's hash is the SHA-256 of its index bytes. The index lists the
// SHA-256 of every entry, so the one hash pins the whole dataset. Entries are
// read lazily through a source, one byte range per entry.

import { sha256 } from './sha256.js';

/**
 * @typedef {{ offset: number, length: number, type: string, sha256: string }} PackEntry
 * @typedef {{
 *   format: 1, id: string, kind: string, title: string, source: string, sourceUrl?: string,
 *   license: string, licenseUrl?: string, notice?: string, meta?: Record<string, unknown>,
 *   entries: Record<string, PackEntry>,
 * }} PackIndex
 * @typedef {{ read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> }} PackSource
 * @typedef {'unavailable' | 'no-range' | 'integrity' | 'format' | 'needs-file'} DatasetErrorCode
 */

const header = 8;
/** Bytes read first: the header and, for most packs, the whole index. */
export const indexProbe = 65536;
/** Without byte-range support, a source reads at most this far into a pack. */
export const noRangeLimit = 4 * 1024 * 1024;

export class DatasetError extends Error {
  /** @param {DatasetErrorCode} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'DatasetError';
    this.code = code;
  }
}

/** @param {Uint8Array<ArrayBuffer>} bytes @returns {PackSource} */
export function bytesSource(bytes) {
  return { read: async (offset, length) => bytes.subarray(offset, offset + length) };
}

/** A local file the learner picked, or any other Blob. @param {Blob} blob @returns {PackSource} */
export function blobSource(blob) {
  return { read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) };
}

/**
 * Reads byte ranges over HTTP. A server that ignores Range gets its response
 * streamed only as far as needed, and never past `limit`, so a missing Range
 * feature fails loudly instead of downloading a whole pack.
 * @param {string | URL} url
 * @param {{ limit?: number }} [options]
 * @returns {PackSource}
 */
export function httpSource(url, { limit = noRangeLimit } = {}) {
  return {
    async read(offset, length) {
      const end = offset + length;
      let response;
      try {
        response = await fetch(url, { headers: { Range: `bytes=${offset}-${end - 1}` } });
      } catch {
        throw new DatasetError('unavailable', `Could not reach ${url}`);
      }
      if (response.status === 206) {
        const range = /^bytes (\d+)-/.exec(response.headers.get('Content-Range') ?? '');
        if (range && Number(range[1]) !== offset) throw new DatasetError('format', `Unexpected byte range from ${url}`);
        return new Uint8Array(await response.arrayBuffer()).subarray(0, length);
      }
      if (response.status === 416) return new Uint8Array(0);
      if (!response.ok || !response.body) throw new DatasetError('unavailable', `${url} answered ${response.status}`);
      if (end > limit) {
        await response.body.cancel();
        throw new DatasetError('no-range', `${url} does not support byte ranges`);
      }
      const reader = response.body.getReader();
      const buffer = new Uint8Array(end);
      let filled = 0;
      while (filled < end) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = Math.min(value.length, end - filled);
        buffer.set(value.subarray(0, take), filled);
        filled += take;
      }
      await reader.cancel();
      return buffer.subarray(offset, filled);
    },
  };
}

/**
 * @param {PackSource} source
 * @param {string} [expected] The dataset hash to verify against.
 */
export async function openPack(source, expected) {
  const start = await source.read(0, indexProbe);
  if (start.length < header || String.fromCharCode(...start.subarray(0, 4)) !== 'VZPK') {
    throw new DatasetError('format', 'Not a dataset pack');
  }
  const size = new DataView(start.buffer, start.byteOffset, start.byteLength).getUint32(4, true);
  const indexBytes = start.length >= header + size
    ? start.subarray(header, header + size)
    : await source.read(header, size);
  if (indexBytes.length !== size) throw new DatasetError('format', 'Truncated dataset index');
  const hash = await sha256(indexBytes);
  if (expected !== undefined && hash !== expected) {
    throw new DatasetError('integrity', 'This file is not the expected dataset');
  }
  /** @type {PackIndex} */
  let index;
  try {
    index = JSON.parse(new TextDecoder().decode(indexBytes));
  } catch {
    throw new DatasetError('format', 'Unreadable dataset index');
  }
  if (index?.format !== 1 || !index.entries || typeof index.entries !== 'object') {
    throw new DatasetError('format', 'Unsupported dataset format');
  }
  return new Pack(source, index, header + size, hash);
}

export class Pack {
  #source;
  #base;
  /** @type {Map<string, Promise<Uint8Array<ArrayBuffer>>>} */
  #bytes = new Map();
  /** @type {Map<string, Promise<string>>} */
  #urls = new Map();

  /** @param {PackSource} source @param {PackIndex} index @param {number} base @param {string} hash */
  constructor(source, index, base, hash) {
    this.#source = source;
    this.#base = base;
    this.index = index;
    this.hash = hash;
    /** @type {Record<string, any>} */
    this.meta = index.meta ?? {};
  }

  get id() { return this.index.id; }
  get kind() { return this.index.kind; }
  get title() { return this.index.title; }

  paths() { return Object.keys(this.index.entries); }

  /** @param {string} path */
  has(path) { return Object.hasOwn(this.index.entries, path); }

  /** @param {string} path */
  bytes(path) {
    let pending = this.#bytes.get(path);
    if (!pending) {
      pending = this.#read(path);
      this.#bytes.set(path, pending);
      pending.catch(() => this.#bytes.delete(path));
    }
    return pending;
  }

  /** @param {string} path */
  async #read(path) {
    if (!this.has(path)) throw new DatasetError('format', `The dataset has no ${path}`);
    const entry = this.index.entries[path];
    const bytes = await this.#source.read(this.#base + entry.offset, entry.length);
    if (bytes.length !== entry.length) throw new DatasetError('format', `Truncated ${path}`);
    if (await sha256(bytes) !== entry.sha256) throw new DatasetError('integrity', `${path} is corrupted`);
    return bytes;
  }

  /** @param {string} path */
  async text(path) { return new TextDecoder().decode(await this.bytes(path)); }

  /** @param {string} path @returns {Promise<any>} */
  async json(path) { return JSON.parse(await this.text(path)); }

  /** An object URL for media elements. It lives as long as the page. @param {string} path */
  blobUrl(path) {
    let pending = this.#urls.get(path);
    if (!pending) {
      pending = this.bytes(path).then(bytes => URL.createObjectURL(new Blob([bytes], { type: this.index.entries[path].type })));
      this.#urls.set(path, pending);
      pending.catch(() => this.#urls.delete(path));
    }
    return pending;
  }

  /** Starts reading entries ahead of use. @param {string[]} paths */
  prefetch(paths) {
    for (const path of paths) this.bytes(path).catch(() => {});
  }
}
