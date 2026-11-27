import { identity, recordLabel } from './learning-graph.mjs';
import { recordPath, viewPath } from './learning-pages.mjs';

export const kinds = ['view', 'exercise', 'topic', 'fact', 'skill', 'question'];
export const relations = ['topics', 'teaches', 'answers', 'practices', 'assesses', 'prerequisites', 'sharedTopic', 'within', 'related'];
const viewId = entry => 'view:' + entry.activity;
const exerciseId = (entry, exercise) => `exercise:${entry.activity}/${exercise.id}`;

export function createQueryIndex(entries, graph) {
  const items = new Map();
  const edges = [];
  for (const entry of entries) {
    const links = graph.byActivity.get(entry.activity);
    const context = (exercise, relations) => [...new Set(links
      .filter(link => link.exercise === exercise && relations.includes(link.relation))
      .map(link => recordLabel(link.resolved)))];
    const id = viewId(entry);
    items.set(id, { id, kind: 'view', label: entry.title, aliases: [entry.activity, entry.slug],
      path: viewPath(entry), text: [entry.title, entry.intro, ...context(undefined, ['topics'])].join('\n') });
    for (const exercise of entry.learning.exercises ?? []) {
      const id = exerciseId(entry, exercise);
      const hasAnchor = (entry.type === 'attempt' && entry.learning.exercises.length === 1) ||
        links.some(link => link.exercise === exercise && link.weight !== 0);
      items.set(id, { id, kind: 'exercise', label: exercise.title,
        path: viewPath(entry, hasAnchor ? exercise : undefined),
        text: [exercise.title, entry.title, ...context(exercise, ['practices', 'assesses'])].join('\n') });
    }
    for (const { exercise, relation, target, weight, reason } of links) {
      edges.push({ from: exercise ? exerciseId(entry, exercise) : id, to: identity(target),
        relation, exercise: exercise?.id, weight, reason });
    }
  }
  for (const [id, record] of graph.records) {
    const links = graph.backlinks.get(id);
    const topics = new Set();
    for (const { entry, exercise } of links ?? []) {
      for (const link of graph.byActivity.get(entry.activity)) {
        if (link.relation === 'topics' && (!link.exercise || link.exercise === exercise) && link.weight !== 0) {
          topics.add(recordLabel(link.resolved));
        }
      }
    }
    const label = recordLabel(record);
    const intro = graph.topicFolders.get(id)?.intro;
    const hasPage = links || graph.topicFolders.has(id)
      || graph.topicLinks.some(({ subject, object }) => identity(subject) === id || identity(object) === id);
    items.set(id, { id, kind: record.kind, label, path: hasPage ? recordPath(record) : undefined,
      text: [label, ...(intro ? [intro] : []), ...topics].join('\n') });
  }
  for (const { subject, relation, object, source } of graph.topicLinks) {
    edges.push({ from: identity(subject), to: identity(object), relation, source });
  }
  return { items, edges };
}

const publicItem = ({ text, aliases, ...item }) => item;

export function neighbors({ items, edges }, id, { direction = 'both', relation } = {}) {
  if (!items.has(id)) throw new Error(`Unknown learning item ${id}`);
  const links = [];
  if (relation !== 'sharedTopic') {
    for (const edge of edges) {
      if (relation && edge.relation !== relation) continue;
      if (edge.to === id && direction !== 'out') links.push({ ...edge, direction: 'in' });
      if (edge.from === id && direction !== 'in') links.push({ ...edge, direction: 'out' });
    }
  }
  if ((!relation || relation === 'sharedTopic') && items.get(id).kind === 'view') {
    const topics = edges.filter(edge => edge.from === id && edge.relation === 'topics' && edge.weight !== 0);
    for (const { to: topic } of topics) {
      for (const edge of edges) {
        if (edge.from !== id && items.get(edge.from).kind === 'view' && edge.to === topic &&
            edge.relation === 'topics' && edge.weight !== 0) {
          links.push({ from: id, to: edge.from, relation: 'sharedTopic', direction: 'both', derived: true,
            via: publicItem(items.get(topic)) });
        }
      }
    }
  }
  return { item: publicItem(items.get(id)), links: links.map(link => ({
    ...link, from: publicItem(items.get(link.from)), to: publicItem(items.get(link.to)),
  })) };
}

const normalize = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
const tokens = text => normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];

function withinOneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length > b.length) return withinOneEdit(b, a);
  let offset = 0;
  while (offset < a.length && a[offset] === b[offset]) offset++;
  if (a.length !== b.length) return a.slice(offset) === b.slice(offset + 1);
  return a.slice(offset + 1) === b.slice(offset + 1) ||
    (a[offset] === b[offset + 1] && a[offset + 1] === b[offset] && a.slice(offset + 2) === b.slice(offset + 2));
}

function lexicalScore(item, query, terms, raw) {
  const names = [item.label, ...(item.aliases ?? [])].map(normalize);
  if (item.id === raw || names.includes(query)) return Infinity;
  if (names.some(name => name.includes(query))) return 4;
  const nameWords = names.flatMap(tokens);
  if (terms.length && terms.every(term => nameWords.some(word =>
    word.startsWith(term) || (term.length >= 4 && withinOneEdit(term, word))))) return 3;
  const words = tokens(item.text);
  if (terms.length && terms.every(term => words.some(word => word.startsWith(term)))) return 2;
  if (terms.length && terms.every(term => words.some(word =>
    word.startsWith(term) || (term.length >= 4 && withinOneEdit(term, word))))) return 1;
  return 0;
}

const compareId = (a, b) => a.id.localeCompare(b.id, 'en');

export function rank(items, query, limit, vectors, queryVector) {
  const text = normalize(query);
  const terms = tokens(text);
  const scores = new Map();
  const lexical = items.map(item => ({ ...item, score: lexicalScore(item, text, terms, query.trim()) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || compareId(a, b));
  const exact = new Set(lexical.filter(item => item.score === Infinity).map(item => item.id));
  const lists = [lexical];
  if (queryVector) {
    lists.push(items.map(item => ({ ...item, score: vectors.get(item.id)
      .reduce((sum, value, index) => sum + value * queryVector[index], 0) }))
      .sort((a, b) => b.score - a.score || compareId(a, b)));
  }
  for (const list of lists) {
    list.forEach(({ id }, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + index + 1)));
  }
  return items.filter(({ id }) => scores.has(id)).sort((a, b) =>
    Number(exact.has(b.id)) - Number(exact.has(a.id)) || scores.get(b.id) - scores.get(a.id) || compareId(a, b))
    .slice(0, limit).map(publicItem);
}
