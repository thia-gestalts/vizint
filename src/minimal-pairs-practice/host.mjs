import { app, entries } from '../catalog.mjs';
import { readRecords, saveObservation, session } from '../storage.mjs';
import { buildCatalog, languages } from './languages.mjs';
import { selectRound } from './scheduler.mjs';

const mount = document.querySelector('#activity');
const entry = entries.find(item => item.slug === mount.dataset.entry);
const frame = document.querySelector('#activity-template').content.firstElementChild.cloneNode();
const retry = document.querySelector('#retry');
const status = document.querySelector('#save-status');
const profile = JSON.stringify(session ? [session.origin, session.account.id] : ['guest']);
const preferenceKey = `vizint-minimal-pairs-language/${profile}`;
const hiddenKey = code => `vizint-minimal-pairs-hidden/${profile}/${code}`;
const catalogs = new Map();
const usedWords = new Map();
const send = (data, transfer = []) => frame.contentWindow.postMessage(data, '*', transfer);
let generation = 0;
let initialized = false;
let language, hidden, events, round, pending, audioRequest;
let saving = false;

async function loadLanguage(code) {
  const request = ++generation;
  audioRequest?.abort();
  language = code;
  round = undefined;
  const pack = languages[code];
  send({ type: 'loading', code, pack });
  try {
    localStorage.setItem(preferenceKey, code);
    if (!usedWords.has(code)) usedWords.set(code, new Set());
    const clips = async () => {
      if (catalogs.has(code)) return catalogs.get(code);
      const response = await fetch(new URL(`data/${code}/clips.json`, import.meta.url));
      if (!response.ok) throw Error('Could not load clip data');
      const catalog = buildCatalog(await response.json(), code);
      catalogs.set(code, catalog);
      return catalog;
    };
    const [records] = await Promise.all([readRecords(), clips()]);
    if (request !== generation) return;
    events = records.filter(event => event.kind === 'learning-event' && event.type === 'attempt'
      && event.origin?.app === app && Number.isFinite(event.score))
      .sort((a, b) => a.occurredAtMs - b.occurredAtMs);
    hidden = new Set(JSON.parse(localStorage.getItem(hiddenKey(code)) ?? '[]'));
    nextRound();
  } catch {
    if (request === generation) send({ type: 'status', text: 'Could not load practice clips.', retry: true });
  }
}

async function loadAudio(current) {
  audioRequest?.abort();
  const controller = new AbortController();
  audioRequest = controller;
  const url = new URL(`data/${language}/audio/${encodeURIComponent(current.clip.filename)}`, import.meta.url);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw Error('Audio unavailable');
    const bytes = await response.arrayBuffer();
    if (round === current && !controller.signal.aborted) send({ type: 'audio', id: current.id, bytes }, [bytes]);
  } catch {
    if (round === current && !controller.signal.aborted) send({ type: 'audio-error', id: current.id });
  }
}

function nextRound() {
  const selected = selectRound(catalogs.get(language), hidden, round?.clip.filename, usedWords.get(language),
    events, `${entry.activity}/${language}`);
  if (!selected) {
    round = undefined;
    send({ type: 'status', text: 'No practice clips left for this language. Hidden clips stay excluded.' });
    return;
  }
  const { clip, candidate } = selected;
  const correct = Number(Math.random() < 0.5);
  const options = [candidate.label, candidate.label];
  options[correct] = clip.transcript;
  round = { ...selected, id: crypto.randomUUID(), correct, firstAnswer: true, complete: false };
  send({ type: 'round', id: round.id, options, index: candidate.index, nativeScript: clip.nativeScript });
  void loadAudio(round);
}

async function persist() {
  if (saving || !pending) return;
  saving = true;
  retry.hidden = true;
  status.textContent = '';
  try {
    await saveObservation(pending.event, pending.targets);
    events.push(pending.event);
    pending = undefined;
    send({ type: 'saved' });
    if (round.complete) nextRound();
  } catch {
    retry.hidden = false;
    status.textContent = 'Could not save this attempt.';
  } finally {
    saving = false;
  }
}
retry.addEventListener('click', persist);

function answer(choice) {
  if (round.complete || (!round.firstAnswer && choice !== round.correct)) return;
  const correct = choice === round.correct;
  round.complete = correct;
  send({ type: 'answer', id: round.id, correct, choice, saving: round.firstAnswer || Boolean(pending) });
  if (!round.firstAnswer) {
    if (!pending && correct) nextRound();
    return;
  }

  round.firstAnswer = false;
  const { candidate } = round;
  const skill = entry.targets.find(target => target.id.endsWith(`:${entry.activity}/${language}/${candidate.pair}`));
  const topic = entry.targets.find(target => target.name === `${languages[language].name} tones`);
  const targets = [skill, topic];
  const event = {
    kind: 'learning-event', id: crypto.randomUUID(), type: 'attempt', occurredAtMs: Date.now(),
    origin: { app, activity: `${entry.activity}/${language}/${candidate.correct}/${candidate.distractor}` },
    targets: targets.map(({ kind, id }) => ({ kind, id })), score: Number(correct),
  };
  pending = { event, targets };
  void persist();
}

function exerciseLanguage() {
  const code = location.hash.slice('#exercise-'.length);
  return location.hash.startsWith('#exercise-') && Object.hasOwn(languages, code) ? code : undefined;
}

addEventListener('hashchange', () => {
  const code = exerciseLanguage();
  if (initialized && code && code !== language && !pending) void loadLanguage(code);
});

addEventListener('message', ({ source, origin, data }) => {
  if (source !== frame.contentWindow || origin !== 'null' || !data) return;
  if (data.type === 'ready' && !initialized) {
    initialized = true;
    const code = exerciseLanguage() ?? localStorage.getItem(preferenceKey);
    if (Object.hasOwn(languages, code)) void loadLanguage(code);
    return;
  }
  if (data.type === 'height' && Number.isFinite(data.value)) {
    frame.style.height = `${Math.max(220, Math.min(1000, Math.ceil(data.value)))}px`;
  }
  if (data.type === 'language' && Object.hasOwn(languages, data.code) && !pending && data.code !== language) {
    if (exerciseLanguage() && data.code !== exerciseLanguage()) history.replaceState(null, '', location.pathname + location.search);
    void loadLanguage(data.code);
  }
  if (data.type === 'retry-load' && language && !round && !pending) void loadLanguage(language);
  if (data.type === 'credit' && language) {
    const pack = languages[language];
    if (data.link === 'dataset' || data.link === 'license') window.open(pack[`${data.link}Url`], '_blank', 'noopener,noreferrer');
  }
  if (!round || data.id !== round.id) return;
  if (data.type === 'answer' && (data.choice === 0 || data.choice === 1)) answer(data.choice);
  if (data.type === 'retry-audio' && !round.complete) void loadAudio(round);
  if (data.type === 'hide' && !pending && !round.complete) {
    try {
      const allHidden = new Set(JSON.parse(localStorage.getItem(hiddenKey(language)) ?? '[]'));
      allHidden.add(round.clip.filename);
      localStorage.setItem(hiddenKey(language), JSON.stringify([...allHidden]));
      hidden = allHidden;
      nextRound();
    } catch {
      send({ type: 'hide-error', id: round.id });
    }
  }
});
mount.append(frame);
