import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { compareWeights, exerciseAnchor, identity, recordLabel } from './learning-graph.mjs';

export function escapeHTML(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

const kindLabels = { view: 'View', topic: 'Topic', skill: 'Skill', fact: 'Fact', question: 'Question' };
const relations = [
  ['topics', 'Topics', 'Covered in'],
  ['teaches', 'What this teaches', 'Taught in'],
  ['answers', 'Questions answered', 'Answered in'],
  ['practices', 'What you practice', 'Practiced in'],
  ['assesses', 'What this checks', 'Assessed in'],
  ['practicesAndAssesses', 'What you practice and answer', 'Practiced and assessed in'],
  ['prerequisites', 'Helpful background', 'Helpful background for'],
];

function recordPath({ kind, id }) {
  return `learn/${kind}/${createHash('sha256').update(id).digest('hex')}/`;
}

function viewPath(entry, exercise) {
  return `${entry.slug}/${exercise ? '#' + exerciseAnchor(exercise) : ''}`;
}

const linkTo = (path, label) => `<a class="link link-hover link-primary" href="${path}">${escapeHTML(label)}</a>`;
const reasonText = (reason) => reason ? `<p class="text-sm text-base-content/75">${escapeHTML(reason)}</p>` : '';

function section(title, items, level = 2) {
  return items.length ? `
    <section class="mt-6">
      <h${level} class="text-lg font-semibold">${title}</h${level}>
      <ul class="mt-2 space-y-2">${items.map((item) => `<li>${item}</li>`).join('')}</ul>
    </section>` : '';
}

function visible(links, relation) {
  return links.filter((link) => link.relation === relation && link.weight !== 0).sort(compareWeights);
}

function combinePracticeAndAssessment(links) {
  const sameTarget = (a, b) => a.exercise === b.exercise && identity(a.target) === identity(b.target);
  const assessed = visible(links, 'assesses');
  const practiced = visible(links, 'practices');
  return [
    ...links.filter(({ relation }) => relation !== 'assesses' && relation !== 'practices'),
    ...practiced.filter((link) => !assessed.some((other) => sameTarget(link, other))),
    ...assessed.map((link) => practiced.some((other) => sameTarget(link, other))
      ? { ...link, relation: 'practicesAndAssesses' } : link),
  ];
}

export function activityLearning(links, exercise) {
  const scoped = combinePracticeAndAssessment(links.filter((link) => link.exercise === exercise));
  return relations.map(([relation, label]) => {
    const items = visible(scoped, relation).map(({ target, resolved, reason }) => {
      const isView = target.kind === 'view';
      const path = isView ? viewPath(resolved) : recordPath(resolved);
      return linkTo('../' + path, isView ? resolved.title : recordLabel(resolved)) + reasonText(reason);
    });
    return section(label, items, exercise ? 3 : 2);
  }).join('');
}

function overviewSections(links, prefix) {
  const displayLinks = combinePracticeAndAssessment(links);
  return relations.map(([relation, , label]) => {
    const groups = new Map();
    for (const link of visible(displayLinks, relation)) {
      const key = link.entry.activity;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(link);
    }
    const items = [...groups.values()].map((group) => {
      const { entry } = group[0];
      const view = group.find((link) => !link.exercise);
      const exercises = group.filter((link) => link.exercise);
      const exerciseItems = exercises.map(({ exercise, reason }) =>
        `<li>${linkTo(prefix + viewPath(entry, exercise), exercise.title)}${reasonText(reason)}</li>`);
      return linkTo(prefix + viewPath(entry), entry.title) + reasonText(view?.reason)
        + (exercises.length ? `<ul class="mt-1 ml-4 space-y-1">${exerciseItems.join('')}</ul>` : '');
    });
    return section(label, items);
  }).join('');
}

export async function writeLearningPages({ output, page, entries, graph }) {
  const searchItems = entries.map((entry) => ({
    kind: 'view', label: entry.title, path: viewPath(entry),
  }));
  const searchPath = new URL('learn/', output);
  await mkdir(searchPath);
  await writeFile(new URL('index.html', searchPath), page('Find learning material | Vizint', '../', `
    <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">Find learning material</h1>
    <form id="learning-search" role="search" class="mt-6 flex flex-wrap items-end gap-3">
      <label class="grid min-w-0 flex-1 gap-1 font-medium">
        Search
        <input class="input w-full" type="search" name="q" placeholder="Search by name or statement">
      </label>
      <label class="grid gap-1 font-medium">
        Type
        <select class="select w-auto" name="kind">
          <option value="">All types</option>
          ${Object.entries(kindLabels).map(([kind, label]) => `<option value="${kind}">${label}s</option>`).join('')}
        </select>
      </label>
      <button class="btn btn-primary" type="submit">Search</button>
    </form>
    <p id="search-status" class="mt-4 text-sm" role="status"></p>
    <p id="search-browse" class="mt-2">${linkTo('../', 'Browse all activities')}</p>
    <noscript><p class="mt-2">Enable JavaScript to search.</p></noscript>
    <ul id="search-results" class="mt-3 space-y-2"></ul>`, '<script type="module" src="../search.mjs"></script>'));

  const prefix = '../../../';
  for (const [key, record] of graph.records) {
    const links = graph.backlinks.get(key);
    if (!links) continue;
    const label = recordLabel(record);
    const path = recordPath(record);
    const directory = new URL(path, output);
    await mkdir(directory, { recursive: true });
    await writeFile(new URL('index.html', directory), page(`${label} | Vizint`, prefix, `
      ${linkTo(prefix + 'learn/', 'Find learning material')}
      <p class="mt-5 text-sm font-medium text-base-content/75">${kindLabels[record.kind]}</p>
      <h1 class="mt-2 text-3xl leading-tight font-semibold tracking-tight sm:text-5xl">${escapeHTML(label)}</h1>
      ${overviewSections(links, prefix)}`));
    searchItems.push({ kind: record.kind, label, path });
  }

  await writeFile(new URL('search-index.json', searchPath), JSON.stringify(searchItems));
}
