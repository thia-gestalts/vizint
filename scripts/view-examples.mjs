// Retrieve a checked-in view as a reference example for local generation.
import { readFile } from 'node:fs/promises';
import { entries } from '../src/catalog.mjs';
import { readActivityScript } from './activity-script.mjs';
import { embedSearch } from './learning-embeddings.mjs';

export const exampleModes = ['none', 'fixed', 'retrieved'];
export const fixedExample = 'squared-errors';
export const exampleLimit = 6000;

const stopwords = new Set(('the and for with that this from into when then than show shows teach use uses using ' +
  'each both two one are its their them how what which where while also make give gives keep visible labeled ' +
  'label input range step numeric value values output display id').split(' '));
const words = text => (text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter(word => word.length > 2 && !stopwords.has(word));

/** Views a generated activity can imitate: engagements without datasets. */
export function exampleCandidates(catalog = entries) {
  return catalog.filter(entry => entry.type === 'engagement' && !Object.keys(entry.datasets ?? {}).length).map(entry => {
    const topics = (entry.learning.records ?? []).filter(record => record.kind === 'topic').map(record => record.name);
    const patterns = entry.patterns ?? [];
    return {
      id: entry.slug, label: entry.title, entry, patterns,
      text: [entry.title, entry.intro, ...topics, 'techniques: ' + patterns.join(', ')].join('\n'),
    };
  });
}

function overlapRanking(items, brief) {
  const query = new Set(words(brief));
  return items.map(item => {
    const vocabulary = words(item.text + ' ' + item.patterns.join(' ').replaceAll('-', ' '));
    const score = [...query].filter(term => vocabulary.some(word => word.startsWith(term) || term.startsWith(word))).length;
    return { item, score };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
    .map(({ item }) => item);
}

/**
 * Rank candidate views for a brief with reciprocal-rank fusion of term overlap
 * and, when the local embedder is available, semantic similarity.
 */
export async function localSearch(items, query) {
  const endpoint = process.env.VIZINT_OLLAMA_URL ?? 'http://localhost:11434';
  let model = process.env.VIZINT_EMBED_MODEL;
  if (!model) {
    const response = await fetch(new URL('/api/tags', endpoint), { signal: AbortSignal.timeout(3000) });
    const names = ((await response.json()).models ?? []).map(item => item.name);
    model = names.find(name => name.startsWith('embeddinggemma')) ?? names.find(name => /embed/i.test(name));
    if (!model) throw new Error('No local embedding model is installed');
  }
  return embedSearch(items, query, { endpoint, model, directory: new URL('../.learning-cache/', import.meta.url) });
}

export async function findExamples(brief, { exclude = [], limit = 1, catalog, search = localSearch } = {}) {
  const items = exampleCandidates(catalog).filter(item => !exclude.includes(item.id));
  if (!items.length) return { mode: 'empty', results: [] };
  const lists = [overlapRanking(items, brief)];
  let mode = 'lexical';
  try {
    const { vectors, queryVector } = await search(items, brief);
    lists.push([...items].sort((a, b) => dot(vectors.get(b.id), queryVector) - dot(vectors.get(a.id), queryVector)));
    mode = 'hybrid';
  } catch (error) {
    mode = `lexical (${error.message})`;
  }
  const scores = new Map();
  for (const list of lists) list.forEach(({ id }, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (61 + index)));
  const results = items.filter(item => scores.has(item.id))
    .sort((a, b) => scores.get(b.id) - scores.get(a.id) || a.id.localeCompare(b.id))
    .slice(0, limit).map(item => ({ slug: item.id, title: item.label, score: scores.get(item.id) }));
  return { mode, results };
}

const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);

/** The reference text injected into the prompt, within the character budget. */
export async function exampleReference(slug, catalog = entries) {
  const entry = catalog.find(item => item.slug === slug);
  if (!entry) throw new Error(`Unknown example view ${slug}`);
  const markup = (await readFile(new URL(`../src/views/${slug}/activity.html`, import.meta.url), 'utf8')).trim();
  const { source } = await readActivityScript(entry);
  const code = source.trim();
  const intro = `Reference activity "${entry.title}" from this site. It passes strict checkJs. ` +
    'Reuse its techniques for DOM lookups, typing and event handling, not its topic.';
  const full = `${intro}\n\`\`\`html\n${markup}\n\`\`\`\n\`\`\`js\n${code}\n\`\`\``;
  if (markup.length + code.length <= exampleLimit) return { text: full, truncated: false };
  if (code.length <= exampleLimit) return { text: `${intro}\n\`\`\`js\n${code}\n\`\`\``, truncated: true };
  return null;
}

/** Resolve an arm's example mode to a reference for one brief. */
export async function selectExample(mode, brief, { exclude = [], catalog, search } = {}) {
  if (mode === 'none') return { mode };
  let slug;
  let retrieval;
  if (mode === 'fixed') {
    slug = exclude.includes(fixedExample) ? undefined : fixedExample;
  } else {
    const found = await findExamples(brief, { exclude, catalog, search });
    retrieval = found.mode;
    slug = found.results[0]?.slug;
  }
  if (!slug) return { mode, retrieval, skipped: 'No eligible example view' };
  const reference = await exampleReference(slug, catalog);
  if (!reference) return { mode, retrieval, slug, skipped: 'Example exceeds the prompt budget' };
  return { mode, retrieval, slug, truncated: reference.truncated, text: reference.text };
}
