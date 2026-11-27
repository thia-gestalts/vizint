import { app, entries } from '../catalog.mjs';
import { readRecords, saveObservation } from '../storage.mjs';
import { activityFor, nextExercise, replay } from './scheduler.mjs';

const mount = document.querySelector('#activity');
const entry = entries.find(item => item.slug === mount.dataset.entry);
const frame = document.querySelector('#activity-template').content.firstElementChild.cloneNode();
const retry = document.querySelector('#retry');
const status = document.querySelector('#save-status');
const topic = entry.targets.find(record => record.kind === 'topic');
const facts = new Map(entry.targets.filter(record => record.kind === 'fact')
  .map(record => [record.id.split('/').at(-1).toUpperCase(), record]));
const send = message => frame.contentWindow.postMessage(message, '*');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let geometry, countries, groups, names, exercise, lastCountry, question, pending;
let groupIndex = 0;
let busy = false;
let recovery;

async function run(work, error) {
  if (busy) return;
  busy = true;
  retry.hidden = true;
  status.textContent = '';
  recovery = undefined;
  try {
    await work();
  } catch {
    recovery = () => run(work, error);
    status.textContent = error;
    retry.hidden = false;
    if (!pending) send({ type: 'status', text: error });
  } finally {
    busy = false;
  }
}
retry.onclick = () => recovery?.();

function present() {
  const { type, zoom, panIndex, countries: sequence } = exercise;
  const country = sequence ? sequence[groupIndex] : exercise.country;
  const distractors = sequence?.filter(code => code !== country);
  const distractor = distractors
    ? distractors[Math.floor(Math.random() * distractors.length)]
    : exercise.distractor;
  const options = distractor ? (Math.random() < 0.5 ? [country, distractor] : [distractor, country]) : undefined;
  question = { id: crypto.randomUUID(), type, country, zoom, panIndex, options, countries: sequence,
    groupKey: exercise.groupKey };
  question.misses = new Set();
  question.revealed = false;
  const { misses, revealed, ...display } = question;
  send({ type: 'question', question: display });
}

async function selectNext() {
  const progress = replay(await readRecords(), app, facts);
  exercise = nextExercise(countries, groups, progress, lastCountry);
  groupIndex = 0;
  if (!exercise) {
    question = undefined;
    send({ type: 'status', text: 'No countries are available to practice.' });
    return;
  }
  if (exercise.countries) exercise.groupKey = crypto.randomUUID();
  lastCountry = exercise.countries?.at(-1) ?? exercise.country;
  present();
}

async function initialize() {
  const fetchData = async name => {
    const response = await fetch(new URL(`data/${name}.json`, import.meta.url));
    if (!response.ok) throw Error('World Map data unavailable');
    return response.json();
  };
  [geometry, countries, groups] = await Promise.all(['map.geo', 'countries', 'groups'].map(fetchData));
  names = new Map(geometry.features.map(({ properties }) => [properties.code, properties.name]));
  send({ type: 'geometry', geometry });
  await selectNext();
}

async function persist() {
  await Promise.all([saveObservation(pending.event, pending.targets), pending.feedback]);
  pending = undefined;
  if (exercise.countries && groupIndex < exercise.countries.length - 1) {
    groupIndex += 1;
    present();
  } else {
    question = undefined;
    try {
      await selectNext();
    } catch {
      recovery = () => run(selectNext, 'Could not load the next exercise.');
      retry.hidden = false;
      status.textContent = 'Could not load the next exercise.';
      send({ type: 'status', text: status.textContent });
    }
  }
}

function feedback(result) {
  send({ type: 'feedback', id: question.id, result });
}

function answer(data) {
  if (!question || question.id !== data.id || busy || pending) return;
  if (data.type === 'reveal' && !question.options && !question.revealed) {
    question.revealed = true;
    feedback('revealed');
    return;
  }
  if (data.type !== 'pick' || typeof data.code !== 'string' || !names.has(data.code)
      || (question.options && (!question.options.includes(data.code) || question.misses.has(data.code)))) return;
  if (data.code !== question.country) {
    question.misses.add(data.code);
    feedback('wrong');
    return;
  }
  const targets = [facts.get(question.country), topic];
  const event = {
    kind: 'learning-event', id: crypto.randomUUID(), type: 'attempt', occurredAtMs: Date.now(),
    origin: { app, activity: activityFor(exercise) },
    targets: targets.map(({ kind, id }) => ({ kind, id })),
    score: Number(!question.misses.size && !question.revealed),
  };
  feedback('correct');
  pending = { event, targets, feedback: delay(600) };
  void run(persist, 'Could not save this attempt.');
}

let ready = false;
addEventListener('message', ({ source, origin, data }) => {
  if (source !== frame.contentWindow || origin !== 'null' || !data) return;
  if (data.type === 'ready' && !ready) {
    ready = true;
    void run(initialize, 'Could not load World Map.');
  }
  answer(data);
});
mount.append(frame);
