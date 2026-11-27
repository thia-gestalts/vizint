import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { DatasetError, blobSource, bytesSource, httpSource, openPack } from '../src/runtime/pack.js';
import { sha256Sync } from '../src/runtime/sha256.js';
import { datasetStore, datasets, writePack } from './datasets.mjs';

const header = { id: 'sample', kind: 'sample', title: 'Sample', source: 'Tests', license: 'CC0' };
const encode = text => new TextEncoder().encode(text);
const big = new Uint8Array(randomBytes(4_000_000));
const sample = () => new Map([
  ['b/notes.txt', encode('second')],
  ['a.json', encode(JSON.stringify({ value: 1 }))],
  ['big.bin', big],
]);
const asBytes = buffer => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);

async function serve(t, bytes, { ranges = true } = {}) {
  const log = { requests: 0, sent: 0 };
  const server = createServer((request, response) => {
    log.requests++;
    const range = ranges && /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    let body = bytes;
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), bytes.length - 1);
      body = bytes.subarray(start, end + 1);
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` });
    }
    // Send in chunks so an aborted read stops the transfer early.
    let offset = 0;
    const next = () => {
      if (offset >= body.length) return response.end();
      const chunk = body.subarray(offset, offset + 16384);
      offset += chunk.length;
      log.sent += chunk.length;
      if (response.write(chunk)) setImmediate(next);
      else response.once('drain', next);
    };
    response.on('close', () => { offset = body.length; });
    next();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/pack.vzpk`, log };
}

test('packs are deterministic and hashed by their index', () => {
  const first = writePack(header, sample());
  const reordered = writePack(header, new Map([...sample()].reverse()));
  assert.equal(first.hash.length, 64);
  assert.equal(first.size, first.bytes.length);
  assert.equal(reordered.hash, first.hash);
  assert.deepEqual(reordered.bytes, first.bytes);
  const again = writePack(header, new Map([['a.json', encode(JSON.stringify({ value: 1 }))]]));
  assert.notEqual(again.hash, first.hash);
  assert.throws(() => writePack(header, new Map([['../escape', encode('x')]])), /Unsupported dataset path/);
});

test('the bundled SHA-256 matches Node for awkward lengths', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 1000, 70_000]) {
    const bytes = new Uint8Array(randomBytes(length));
    assert.equal(sha256Sync(bytes), createHash('sha256').update(bytes).digest('hex'), `length ${length}`);
  }
});

test('a pack reads the same from bytes and from a file', async () => {
  const files = sample();
  const { bytes, hash } = writePack(header, files);
  for (const source of [bytesSource(asBytes(bytes)), blobSource(new Blob([bytes]))]) {
    const pack = await openPack(source, hash);
    assert.equal(pack.hash, hash);
    assert.deepEqual(pack.paths().sort(), [...files.keys()].sort());
    assert.deepEqual(await pack.json('a.json'), { value: 1 });
    assert.equal(await pack.text('b/notes.txt'), 'second');
    assert.deepEqual(await pack.bytes('big.bin'), files.get('big.bin'));
  }
});

test('reading one entry over HTTP transfers only the index and that entry', async t => {
  const { bytes, hash } = writePack(header, sample());
  const { url, log } = await serve(t, asBytes(bytes));
  const pack = await openPack(httpSource(url), hash);
  // One request reads the header and index, plus up to 64 KiB past it.
  const indexBytes = log.sent;
  assert.ok(indexBytes <= 65536, `index probe sent ${indexBytes} bytes`);
  assert.equal(log.requests, 1);
  assert.equal(await pack.text('b/notes.txt'), 'second');
  assert.equal(log.sent - indexBytes, encode('second').length);
  assert.equal(log.requests, 2);
  assert.ok(log.sent < bytes.length / 4, `sent ${log.sent} of ${bytes.length} bytes`);
});

test('without Range support a deep entry fails instead of downloading the pack', async t => {
  const { bytes, hash } = writePack(header, sample());
  const { url, log } = await serve(t, asBytes(bytes), { ranges: false });
  const pack = await openPack(httpSource(url, { limit: 100_000 }), hash);
  assert.deepEqual(await pack.json('a.json'), { value: 1 });
  await assert.rejects(pack.bytes('big.bin'), error => error instanceof DatasetError && error.code === 'no-range');
  assert.ok(log.sent < bytes.length / 10, `sent ${log.sent} of ${bytes.length} bytes`);
});

test('a tampered index or entry is rejected', async () => {
  const { bytes, hash } = writePack(header, sample());
  await assert.rejects(openPack(bytesSource(asBytes(bytes)), 'f'.repeat(64)),
    error => error.code === 'integrity');
  const changedIndex = Buffer.from(bytes);
  changedIndex[20] ^= 1;
  await assert.rejects(openPack(bytesSource(asBytes(changedIndex)), hash), error => error.code === 'integrity');
  const changedEntry = Buffer.from(bytes);
  changedEntry[changedEntry.length - 1] ^= 1;
  const pack = await openPack(bytesSource(asBytes(changedEntry)), hash);
  await assert.rejects(pack.bytes('big.bin'), error => error.code === 'integrity');
  await assert.rejects(openPack(bytesSource(encode('not a pack'))), error => error.code === 'format');
});

test('the Africa map only contains African countries, groups and distractors', async () => {
  const africa = datasetStore.describe('africa-countries');
  const codes = new Set(datasets.get('africa-countries').meta.codes);
  const geometry = await africa.json('map.geo.json');
  assert.deepEqual(new Set(geometry.features.map(feature => feature.properties.code)), codes);
  const countries = await africa.json('countries.json');
  for (const [code, data] of Object.entries(countries)) {
    assert.ok(codes.has(code), code);
    assert.ok(data.distractorChoice.distractors.every(other => codes.has(other)), code);
    if (!data.distractorChoice.distractors.length) assert.equal(data.distractorChoice.enabled, false);
  }
  for (const group of Object.values(await africa.json('groups.json'))) {
    assert.ok(group.countries.every(code => codes.has(code)), group.name);
  }
  const pack = await openPack(bytesSource(asBytes((await datasetStore.packDataset('africa-countries')).bytes)));
  assert.equal(pack.meta.mapName, 'map of Africa');
});
