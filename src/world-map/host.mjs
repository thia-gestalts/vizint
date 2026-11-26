import { app, entries } from '../catalog.mjs';
import { readRecords, saveObservation, session } from '../storage.mjs';
import { activityFor, day, nextExercise, replay, retrievability } from './scheduler.mjs';

const mount = document.querySelector('#activity');
const entry = entries.find(item => item.slug === mount.dataset.entry);
const frame = document.querySelector('#activity-template').content.firstElementChild.cloneNode();
const retry = document.querySelector('#retry');
const status = document.querySelector('#save-status');
const topic = entry.targets.find(record => record.kind === 'topic');
const facts = new Map(entry.targets.filter(record => record.kind === 'fact')
  .map(record => [record.id.split('/').at(-1).toUpperCase(), record]));
const profile = JSON.stringify(session ? [session.origin, session.account.id] : ['guest']);
const timeKey = `vizint-world-map-time/${profile}`;
const themeKey = `vizint-world-map-theme/${profile}`;
const send = message => frame.contentWindow.postMessage(message, '*');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const states = ['New', 'Learning', 'Review', 'Relearning'];
let geometry, countries, groups, names, exercise, lastCountry, question, pending;
let groupIndex = 0;
let page = 'practice';
let busy = false;
let recovery;
let theme = localStorage.getItem(themeKey) === 'dark' ? 'dark' : 'light';
const time = () => JSON.parse(localStorage.getItem(timeKey) ?? '{}');
const duration = ms => ms >= 3_600_000
  ? `${Math.floor(ms / 3_600_000)}h ${Math.floor(ms / 60_000) % 60}m`
  : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.floor(ms / 1000) % 60}s` : `${Math.floor(ms / 1000)}s`;

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
  send({ type: 'theme', value: theme });
  await selectNext();
  if (page === 'stats') void stats();
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
  if (page === 'stats') void stats();
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

async function stats() {
  if (!names) return;
  try {
    const progress = replay(await readRecords(), app, facts);
    const times = time();
    const attempts = new Map();
    for (const event of progress.events) {
      const date = day(event.occurredAtMs);
      attempts.set(date, (attempts.get(date) ?? 0) + 1);
    }
    const now = new Date();
    const history = Array.from({ length: 14 }, (_, index) => {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + index - 13);
      const key = day(date);
      return [date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        attempts.get(key) ?? 0, duration(times[key] ?? 0), times[key] ?? 0];
    });
    send({ type: 'stats', stats: {
      summary: [['Countries practiced', progress.countries.size], ['Attempts today', attempts.get(day(now)) ?? 0],
        ['Total attempts', progress.events.length],
        ['Time practiced on this device', duration(Object.values(times).reduce((sum, ms) => sum + ms, 0))]],
      countries: [...progress.countries].map(([code, card]) =>
        [names.get(code), states[card.state], `${Math.round(retrievability(card) * 100)}%`,
          card.stability > 1 ? `${Math.round(card.stability)}d` : '—'])
        .sort(([a], [b]) => a.localeCompare(b)),
      history,
    } });
  } catch {
    send({ type: 'stats-error', text: 'Could not load statistics. Reopen Stats to retry.' });
  }
}

let seconds = 0;
function flushTime() {
  if (!seconds) return;
  const key = day(Date.now());
  const ms = seconds * 1000;
  seconds = 0;
  // The synchronous update also works when the document is being hidden.
  const values = time();
  values[key] = (values[key] ?? 0) + ms;
  localStorage.setItem(timeKey, JSON.stringify(values));
}
setInterval(() => {
  if (page !== 'practice' || !question || document.hidden || !document.hasFocus()) return;
  seconds += 1;
  if (seconds >= 5) flushTime();
}, 1000);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushTime(); });
addEventListener('pagehide', flushTime);

let ready = false;
addEventListener('message', ({ source, origin, data }) => {
  if (source !== frame.contentWindow || origin !== 'null' || !data) return;
  if (data.type === 'ready' && !ready) {
    ready = true;
    void run(initialize, 'Could not load World Map.');
  }
  if (data.type === 'page' && ['practice', 'stats', 'settings'].includes(data.page)) {
    page = data.page;
    flushTime();
    if (page === 'stats') void stats();
  }
  if (data.type === 'theme' && ['light', 'dark'].includes(data.value)) {
    theme = data.value;
    localStorage.setItem(themeKey, theme);
    send({ type: 'theme', value: theme });
  }
  answer(data);
});
mount.append(frame);
