import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

const defaults = {
  model: process.env.VIZINT_EMBED_MODEL ?? 'embeddinggemma',
  endpoint: process.env.VIZINT_OLLAMA_URL ?? 'http://localhost:11434',
  directory: new URL('../.learning-cache/', import.meta.url),
};
const hash = text => createHash('sha256').update(text).digest('hex');
const valid = (vector, size) => Array.isArray(vector) && vector.length === size && vector.every(Number.isFinite);

export async function embedSearch(items, query, { endpoint, directory, model = defaults.model } = defaults) {
  async function request(path, payload) {
    const response = await fetch(new URL(path, endpoint), {
      ...(payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Ollama ${path} returned HTTP ${response.status}`);
    return response.json();
  }
  async function embed(input) {
    const { embeddings } = await request('/api/embed', { model, input });
    const size = embeddings?.[0]?.length;
    if (!size || embeddings.length !== input.length || !embeddings.every(vector => valid(vector, size))) {
      throw new Error('Invalid embedding response');
    }
    return embeddings;
  }
  async function modelDigest() {
    const { models } = await request('/api/tags');
    const digest = models.find(({ name }) => name === model || name === model + ':latest')?.digest;
    if (!digest) throw new Error(`Ollama model ${model} is unavailable`);
    return digest;
  }

  const digest = await modelDigest();
  const gemma = model.split(':')[0] === 'embeddinggemma';
  const queryText = gemma ? 'task: search result | query: ' + query
    : 'Instruct: Find relevant learning material for the query.\nQuery: ' + query;
  const [queryVector] = await embed([queryText]);
  const cachePath = new URL(hash(digest) + '.json', directory);
  let cached;
  try {
    cached = JSON.parse(await readFile(cachePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const cache = new Map(Object.entries(cached ?? {}).filter(([, vector]) => valid(vector, queryVector.length)));
  const documents = items.map(item => [item.id, gemma ? 'title: ' + item.label + ' | text: ' + item.text : item.text]);
  const missing = [...new Map(documents.map(([, text]) => [hash(text), text]))]
    .filter(([key]) => !cache.has(key));
  for (let offset = 0; offset < missing.length; offset += 32) {
    const batch = missing.slice(offset, offset + 32);
    const vectors = await embed(batch.map(([, text]) => text));
    if (!vectors.every(vector => valid(vector, queryVector.length))) throw new Error('Embedding dimensions changed');
    batch.forEach(([key], index) => cache.set(key, vectors[index]));
  }
  if (await modelDigest() !== digest) throw new Error('Ollama model changed during search');
  if (missing.length) {
    await mkdir(directory, { recursive: true });
    const temporary = new URL(randomUUID() + '.tmp', directory);
    await writeFile(temporary, JSON.stringify(Object.fromEntries(cache)));
    await rename(temporary, cachePath);
  }
  return { queryVector, vectors: new Map(documents.map(([id, text]) => [id, cache.get(hash(text))])) };
}
