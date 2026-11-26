import { readdirSync, readFileSync, statSync } from 'node:fs';
import { parse } from 'yaml';

export const app = 'example.thia.vizint';

const fields = 'order activity title intro type frameHeight source sharedScript previewReady previewHash customHost media assets collapseExercises learning learningModule'.split(' ');
const relations = 'topics teaches answers prerequisites practices assesses'.split(' ');
const segment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function target({ kind, name, key, id }) {
  if (kind === 'topic') id = 'name:' + Buffer.from(name.toLowerCase()).toString('hex');
  if (kind === 'fact' || kind === 'skill') {
    if (typeof key !== 'string' || !key.trim()) throw new Error('Missing fact or skill key');
    id = `key:${app}:${key}`;
  }
  return { kind, id };
}

function learning(data, exercise = false) {
  const supported = ['records', ...relations, ...(exercise ? ['id', 'title'] : ['exercises'])];
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
    return [field, value.map(link => ({ ...link, target: target(link.target) }))];
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
      for (const field of ['customHost', 'media', 'collapseExercises']) {
        if (field in data && typeof data[field] !== 'boolean') throw new Error(`Expected a boolean ${field}`);
      }
      if (data.customHost) requirePath('host.mjs');
      if ('assets' in data) {
        if (!segment.test(data.assets) || typeof data.assets !== 'string') throw new Error('Invalid assets directory');
        requirePath(data.assets + '/', true);
      }
      if ('sharedScript' in data) {
        if (typeof data.sharedScript !== 'string' || !/^src\/[\w-]+\.js$/.test(data.sharedScript)) throw new Error('Invalid sharedScript path');
        requirePath(data.sharedScript, false, new URL('../', import.meta.url));
      }
      const { order, activity = slug, learningModule, learning: authored, ...entry } = data;
      if (order !== undefined && !Number.isFinite(order)) throw new Error('Invalid order');
      if (learningModule !== undefined && (learningModule !== 'content.mjs' || authored !== undefined)) {
        throw new Error('Use either learning or learningModule: content.mjs');
      }
      if (learningModule) requirePath(learningModule);
      const content = learningModule
        ? await (await import(new URL(learningModule, folder))).default(app)
        : learning(authored ?? {});
      return { order: order ?? Infinity, entry: { slug, activity, ...entry, learning: content } };
    } catch (error) {
      throw new Error(`${manifest.pathname}: ${error.message}`, { cause: error });
    }
  }));
  return loaded.sort((a, b) => a.order - b.order || a.entry.slug.localeCompare(b.entry.slug))
    .map(({ entry }) => entry);
}

export const entries = await loadCatalog();
