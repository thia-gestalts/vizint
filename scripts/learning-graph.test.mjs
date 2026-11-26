import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { entries } from '../src/catalog.mjs';
import { buildLearningGraph } from './learning-graph.mjs';
import { activityLearning } from './learning-pages.mjs';

const common = JSON.parse(readFileSync(new URL('../vendor/thia-gestalts/common/v2.json', import.meta.url)));
const view = (catalog, slug) => catalog.find((entry) => entry.slug === slug);

test('learner events use directly addressed topics and exercise assessments', () => {
  const catalog = structuredClone(entries);
  const getTargets = (slug) => view(buildLearningGraph(catalog, common).eventEntries, slug).targets;
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
    assert.throws(() => buildLearningGraph(catalog, common), error);
  }
});

test('questions are indexed and can be answered at exercise scope', () => {
  const catalog = structuredClone(entries);
  const rounding = view(catalog, 'rounding');
  const exercise = rounding.learning.exercises[0];
  exercise.answers = rounding.learning.answers;
  const graph = buildLearningGraph(catalog, common);
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
  const graph = buildLearningGraph(catalog, common);
  const markup = activityLearning(graph.byActivity.get(mse.activity));
  assert.doesNotMatch(markup, />Mean Squared Error</);
  assert.match(markup, />Squared Error</);
  assert.equal(view(graph.eventEntries, 'mse').targets.length, 2);
});
