import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { entries, topics } from '../src/catalog.mjs';
import { buildLearningGraph } from './learning-graph.mjs';
import { activityLearning } from './learning-pages.mjs';

const common = JSON.parse(readFileSync(new URL('../vendor/thia-gestalts/common/v2.json', import.meta.url)));
const view = (catalog, slug) => catalog.find((entry) => entry.slug === slug);

test('learner events use directly addressed topics and exercise assessments', () => {
  const catalog = structuredClone(entries);
  const getTargets = (slug) => view(buildLearningGraph(catalog, common, topics).eventEntries, slug).targets;
  assert.deepEqual(getTargets('mse').map(({ name }) => name), ['Mean Squared Error', 'Squared Error']);
  assert.deepEqual(getTargets('rounding').map(({ name }) => name), [
    'Round to the nearest tenth', 'Rounding', 'Decimal Place Value',
  ]);

  const rounding = view(catalog, 'rounding');
  rounding.learning.exercises[0].topics = [rounding.learning.topics[1]];
  assert.deepEqual(getTargets('rounding').map(({ name }) => name), [
    'Round to the nearest tenth', 'Decimal Place Value',
  ]);
});

test('inconsistent author metadata fails before generation', () => {
  const invalid = [
    [({ topics }) => { topics[0].target.id = 'name:00'; }, /Unresolved topics target/],
    [({ topics }) => { topics[0].target.kind = 'skill'; }, /Invalid topics target/],
    [({ answers, teaches }) => { answers[0] = teaches[0]; }, /Invalid answers target/],
    [({ records }) => { records.push(records[0]); }, /Duplicate Gestalt record/],
    [({ topics }) => { topics[0].weight = 1.01; }, /Invalid topics weight/],
    [({ topics }) => { topics[0].weight = NaN; }, /Invalid topics weight/],
  ];
  for (const [modify, error] of invalid) {
    const catalog = structuredClone(entries);
    modify(view(catalog, 'mse').learning);
    assert.throws(() => buildLearningGraph(catalog, common, topics), error);
  }
});

test('questions are indexed and can be answered at exercise scope', () => {
  const catalog = structuredClone(entries);
  const rounding = view(catalog, 'rounding');
  const exercise = rounding.learning.exercises[0];
  exercise.answers = rounding.learning.answers;
  const graph = buildLearningGraph(catalog, common, topics);
  const [question] = rounding.learning.records.filter(({ kind }) => kind === 'question');
  const links = graph.backlinks.get(`question:${question.id}`);
  assert.deepEqual(links.map(({ exercise }) => exercise?.id), [undefined, 'nearest-tenth']);
  assert.match(activityLearning(graph.byActivity.get(rounding.activity), exercise), /Questions answered/);
  assert.ok(!view(graph.eventEntries, 'rounding').targets.includes(question));
});

test('zero-weight links remain in the graph while unrated links still render', () => {
  const catalog = structuredClone(entries);
  const mse = view(catalog, 'mse');
  mse.learning.topics[0].weight = 0;
  delete mse.learning.topics[1].weight;
  const graph = buildLearningGraph(catalog, common, topics);
  const markup = activityLearning(graph.byActivity.get(mse.activity));
  assert.doesNotMatch(markup, />Mean Squared Error</);
  assert.match(markup, />Squared Error</);
  assert.equal(view(graph.eventEntries, 'mse').targets.length, 2);
});

const topicId = (graph, name) => `topic:${[...graph.records.values()].find((record) => record.name === name).id}`;

test('topic links gather views under broader topics across sources', () => {
  const graph = buildLearningGraph(structuredClone(entries), common, topics);
  const mathematics = topicId(graph, 'Mathematics');
  const descendants = graph.topicGraph.descendants(mathematics).map(({ topic }) => topic.name);
  for (const name of ['Statistics', 'Mean Squared Error', 'Rounding', 'Bézier Curves']) assert.ok(descendants.includes(name), name);
  const tones = topicId(graph, 'Vietnamese tones');
  assert.deepEqual(graph.topicGraph.broader(tones).map(({ name }) => name).sort(), ['Phonetics', 'Vietnamese']);
  assert.deepEqual(graph.topicGraph.related(topicId(graph, 'Linear Interpolation')).map(({ name }) => name), ['Bézier Curves']);
});

test('topic link cycles are tolerated', () => {
  const folders = structuredClone(topics);
  const mathematics = folders.find(({ slug }) => slug === 'mathematics');
  const statistics = folders.find(({ slug }) => slug === 'statistics');
  mathematics.links.push({ subject: { kind: 'topic', id: mathematics.record.id }, relation: 'within',
    object: { kind: 'topic', id: statistics.record.id } });
  const graph = buildLearningGraph(structuredClone(entries), common, folders);
  const names = graph.topicGraph.descendants(topicId(graph, 'Mathematics'), 10).map(({ topic }) => topic.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(!names.includes('Mathematics'));
});

test('invalid topic links and mismatched topic ids fail', () => {
  const invalid = [
    [(links) => { links[0].relation = 'broader'; }, /Invalid topic link/],
    [(links) => { links[0].object.id = 'name:00'; }, /Unresolved topic link target/],
    [(links) => { links[0].object = links[0].subject; }, /Self-referential topic link/],
    [(links) => { links.push(structuredClone(links[0])); }, /Duplicate topic link/],
    [(links) => { links.push({ ...structuredClone(links[2]), subject: links[2].object, object: links[2].subject }); },
      /Duplicate topic link/],
    [(links, learning) => { learning.records[0].name = 'Bezier Curves'; }, /does not match its name/],
  ];
  for (const [modify, error] of invalid) {
    const catalog = structuredClone(entries);
    const { learning } = view(catalog, 'bezier');
    modify(learning.topicLinks, learning);
    assert.throws(() => buildLearningGraph(catalog, common, topics), error);
  }
});
