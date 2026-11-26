import assert from 'node:assert/strict';
import { main } from './learning.mjs';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { entries, loadCatalog, topics } from '../src/catalog.mjs';
import { embedSearch } from './learning-embeddings.mjs';
import { buildLearningGraph } from './learning-graph.mjs';
import { createQueryIndex, neighbors, rank } from './learning-query.mjs';

const common = JSON.parse(await readFile(new URL('../vendor/thia-gestalts/common/v2.json', import.meta.url)));
const index = createQueryIndex(entries, buildLearningGraph(entries, common, topics));

async function temporaryDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), 'vizint-learning-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return pathToFileURL(path + '/');
}

test('catalog reports missing manifests and duplicate keys with a path', async t => {
  const root = await temporaryDirectory(t);
  const folder = new URL('example/', root);
  await mkdir(folder);
  await assert.rejects(loadCatalog(root), /example\/view\.yml.*ENOENT/);
  await writeFile(new URL('view.yml', folder), 'title: Example\ntitle: Duplicate\n');
  await assert.rejects(loadCatalog(root), /example\/view\.yml.*unique/);
});

test('rank handles typos and exact IDs and breaks ties consistently', () => {
  const views = [...index.items.values()].filter(item => item.kind === 'view');
  assert.equal(rank(views, 'beizer', 1)[0].id, 'view:bezier-explorer');
  assert.equal(rank(views, 'view:mean-squared-error', 1)[0].path, 'mse/');
  const vectors = new Map(views.map(item => [item.id, [1, 0]]));
  assert.deepEqual(rank(views, 'unmatched', 10, vectors, [1, 0]),
    rank(views.toReversed(), 'unmatched', 10, vectors, [1, 0]));
});

test('neighbors retains prerequisite reasons and exercise anchors', () => {
  const mse = 'view:mean-squared-error';
  const { links } = neighbors(index, mse, { direction: 'out', relation: 'prerequisites' });
  assert.equal(links[0].to.id, 'view:squared-errors');
  assert.match(links[0].reason, /vertical error/);
  const { links: shared } = neighbors(index, mse, { relation: 'sharedTopic' });
  assert.equal(shared[0].derived, true);
  assert.equal(shared[0].via.label, 'Squared Error');
  const exercise = 'exercise:round-to-nearest-tenth/nearest-tenth';
  assert.equal(neighbors(index, exercise).item.path, 'rounding/#exercise-nearest-tenth');
});

test('embedding cache handles reuse, edits, deletions, and model revisions', async t => {
  const directory = await temporaryDirectory(t);
  const options = { endpoint: 'http://localhost:11434', directory, model: 'embeddinggemma' };
  let digest = 'revision-a';
  const embeddedDocuments = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    if (url.pathname === '/api/tags') return Response.json({ models: [{ name: 'embeddinggemma:latest', digest }] });
    const { input } = JSON.parse(request.body);
    embeddedDocuments.push(...input.filter(text => text.startsWith('title:')));
    return Response.json({ embeddings: input.map(() => [1, 0]) });
  });
  const a = { id: 'a', label: 'A', text: 'First' };
  const b = { id: 'b', label: 'B', text: 'Second' };
  await embedSearch([a, b], 'query', options);
  await embedSearch([a, b], 'query', options);
  assert.equal(embeddedDocuments.length, 2);
  const changed = { ...a, text: 'Edited' };
  const { vectors } = await embedSearch([changed], 'query', options);
  assert.deepEqual([...vectors.keys()], ['a']);
  assert.equal(embeddedDocuments.length, 3);
  digest = 'revision-b';
  await embedSearch([changed], 'query', options);
  assert.equal(embeddedDocuments.length, 4);
});

test('CLI falls back to lexical results and applies kind and limit filters', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const diagnostic = t.mock.method(console, 'error', () => {});
  const { mode, results } = await main(['search', 'beizer', '--kind', 'view', '--limit', '1']);
  assert.match(diagnostic.mock.calls[0].arguments[0], /Semantic search unavailable/);
  assert.equal(mode, 'lexical');
  assert.deepEqual(results.map(({ id }) => id), ['view:bezier-explorer']);
});

test('topic links are queryable neighbors', () => {
  const statistics = [...index.items.values()].find(({ kind, label }) => kind === 'topic' && label === 'Statistics');
  assert.ok(statistics.path);
  const { links } = neighbors(index, statistics.id, { relation: 'within' });
  const labels = (direction) => links.filter((link) => link.direction === direction)
    .map(({ from, to }) => (direction === 'in' ? from : to).label).sort();
  assert.deepEqual(labels('in'), ['Mean Squared Error', 'Squared Error']);
  assert.deepEqual(labels('out'), ['Mathematics']);
});
