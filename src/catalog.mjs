import { readdirSync, readFileSync, statSync } from 'node:fs';
import { parse } from 'yaml';
import { validateLibraries, viewLibraries } from '../scripts/activity-libraries.mjs';
import { datasetStore, datasets } from '../scripts/datasets.mjs';
import { nameId } from './name-id.mjs';

export const app = 'example.thia.vizint';

const fields = 'order activity title intro type frameHeight source sharedScript libraries previewReady previewHash patterns media datasets collapseExercises learning learningModule'.split(' ');
const relations = 'topics teaches answers prerequisites practices assesses'.split(' ');
const segment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function target({ kind, name, key, id }) {
  if (kind === 'topic') id = nameId(name);
  if (kind === 'fact' || kind === 'skill') {
    if (typeof key !== 'string' || !key.trim()) throw new Error('Missing fact or skill key');
    id = `key:${app}:${key}`;
  }
  return { kind, id };
}

function exactFields(value, allowed, what) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected a ${what} mapping`);
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) throw new Error(`Unknown ${what} field ${field}`);
  }
}

function topicLink(link) {
  exactFields(link, ['subject', 'relation', 'object'], 'topic link');
  return { subject: target(link.subject), relation: link.relation, object: target(link.object) };
}

function learning(data, exercise = false) {
  const supported = ['records', ...relations, ...(exercise ? ['id', 'title'] : ['exercises', 'topicLinks'])];
  for (const field of Object.keys(data)) {
    if (!supported.includes(field)) throw new Error(`Unknown learning field ${field}`);
  }
  return Object.fromEntries(Object.entries(data).map(([field, value]) => {
    if (field === 'id' || field === 'title') return [field, value];
    if (field === 'records') return [field, value.map(record => {
      const label = { topic: 'name', skill: 'name', fact: 'statement', question: 'text' }[record.kind];
      return { ...target(record), [label]: record[label] };
    })];
    if (field === 'exercises') return [field, value.map(item => learning(item, true))];
    if (field === 'topicLinks') return [field, value.map(topicLink)];
    return [field, value.map(link => ({ ...link, target: target(link.target) }))];
  }));
}

// A slot names the datasets a view can show; the first option is the default.
function datasetSlots(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a datasets mapping');
  return Object.fromEntries(Object.entries(value).map(([name, slot]) => {
    if (!segment.test(name)) throw new Error(`Invalid dataset slot name ${name}`);
    exactFields(slot, ['kind', 'label', 'options'], 'dataset slot');
    if (typeof slot.label !== 'string' || !slot.label.trim()) throw new Error(`Expected a label for dataset slot ${name}`);
    if (!Array.isArray(slot.options) || !slot.options.length || new Set(slot.options).size !== slot.options.length) {
      throw new Error(`Expected unique options for dataset slot ${name}`);
    }
    for (const id of slot.options) {
      const dataset = datasets.get(id);
      if (!dataset) throw new Error(`Unknown dataset ${id} in slot ${name}`);
      if (dataset.kind !== slot.kind) throw new Error(`Dataset ${id} is a ${dataset.kind}, not a ${slot.kind}`);
    }
    return [name, { kind: slot.kind, label: slot.label, options: slot.options }];
  }));
}

export async function loadCatalog(root = new URL('views/', import.meta.url)) {
  const loaded = await Promise.all(readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(async ({ name: slug }) => {
    const folder = new URL(slug + '/', root);
    const manifest = new URL('view.yml', folder);
    function requirePath(path, directory = false, base = folder) {
      const url = new URL(path, base);
      const info = statSync(url, { throwIfNoEntry: false });
      if (!(directory ? info?.isDirectory() : info?.isFile())) throw new Error(`Missing ${url.pathname}`);
    }
    try {
      if (!segment.test(slug)) throw new Error('Invalid view folder name');
      const data = parse(readFileSync(manifest, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a mapping');
      for (const field of Object.keys(data)) {
        if (!fields.includes(field)) throw new Error(`Unknown manifest field ${field}`);
      }
      for (const field of ['title', 'intro', 'type', 'frameHeight']) {
        if (typeof data[field] !== 'string' || !data[field].trim()) throw new Error(`Expected a nonempty ${field}`);
      }
      if (!['attempt', 'engagement'].includes(data.type)) throw new Error('Invalid activity type');
      for (const file of ['activity.html', 'activity.css', 'activity.js']) requirePath(file);
      for (const field of ['media', 'collapseExercises']) {
        if (field in data && typeof data[field] !== 'boolean') throw new Error(`Expected a boolean ${field}`);
      }
      if ('libraries' in data) validateLibraries(data.libraries, viewLibraries);
      const slots = 'datasets' in data ? datasetSlots(data.datasets) : {};
      if ('patterns' in data && (!Array.isArray(data.patterns) || new Set(data.patterns).size !== data.patterns.length ||
          data.patterns.some(pattern => typeof pattern !== 'string' || !segment.test(pattern)))) {
        throw new Error('Expected patterns to be unique kebab-case strings');
      }
      if ('sharedScript' in data) {
        if (typeof data.sharedScript !== 'string' || !/^src\/[\w-]+\.js$/.test(data.sharedScript)) throw new Error('Invalid sharedScript path');
        requirePath(data.sharedScript, false, new URL('../', import.meta.url));
      }
      const { order, activity = slug, learningModule, learning: authored, datasets: _, ...entry } = data;
      if (order !== undefined && !Number.isFinite(order)) throw new Error('Invalid order');
      if (learningModule !== undefined && (learningModule !== 'content.mjs' || authored !== undefined)) {
        throw new Error('Use either learning or learningModule: content.mjs');
      }
      if (learningModule) requirePath(learningModule);
      const content = learningModule
        ? await (await import(new URL(learningModule, folder))).default(app, {
          datasets: Object.fromEntries(Object.entries(slots).map(([name, slot]) =>
            [name, slot.options.map(id => datasetStore.describe(id))])),
        })
        : learning(authored ?? {});
      for (const exercise of content.exercises ?? []) {
        if (!exercise.dataset) continue;
        exactFields(exercise.dataset, ['slot', 'id'], 'exercise dataset');
        if (!slots[exercise.dataset.slot]?.options.includes(exercise.dataset.id)) {
          throw new Error(`Exercise ${exercise.id} names an undeclared dataset`);
        }
      }
      const preview = statSync(new URL('preview.png', folder), { throwIfNoEntry: false })?.isFile() ?? false;
      return { order: order ?? Infinity, entry: { slug, activity, ...entry, datasets: slots, preview, learning: content } };
    } catch (error) {
      throw new Error(`${manifest.pathname}: ${error.message}`, { cause: error });
    }
  }));
  return loaded.sort((a, b) => a.order - b.order || a.entry.slug.localeCompare(b.entry.slug))
    .map(({ entry }) => entry);
}

export function loadTopics(root = new URL('topics/', import.meta.url)) {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(({ name: slug }) => {
    const manifest = new URL(slug + '/topic.yml', root);
    try {
      if (!segment.test(slug)) throw new Error('Invalid topic folder name');
      const data = parse(readFileSync(manifest, 'utf8'));
      exactFields(data, ['name', 'intro', 'links'], 'topic');
      for (const field of ['name', 'intro']) {
        if (typeof data[field] !== 'string' || !data[field].trim()) throw new Error(`Expected a nonempty ${field}`);
      }
      if ('links' in data && !Array.isArray(data.links)) throw new Error('Expected links to be a list');
      const record = { kind: 'topic', id: nameId(data.name), name: data.name };
      const links = (data.links ?? []).map(link => {
        exactFields(link, ['relation', 'target'], 'topic link');
        return { subject: { kind: record.kind, id: record.id }, relation: link.relation, object: target(link.target) };
      });
      return { slug, record, intro: data.intro, links };
    } catch (error) {
      throw new Error(`${manifest.pathname}: ${error.message}`, { cause: error });
    }
  }).sort((a, b) => a.slug.localeCompare(b.slug));
}

export const entries = await loadCatalog();
export const topics = loadTopics();
