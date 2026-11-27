import { attempt, context, datasetPicker, history, historyReady, reportHeight, slot, state, target } from 'vizint';
import { buildCatalog, languages } from './languages.mjs';
import { selectRound } from './scheduler.mjs';

/**
 * @typedef {import('./languages.mjs').Clip} Clip
 * @typedef {import('./languages.mjs').Candidate} Candidate
 * @typedef {{ clip: Clip, candidate: Candidate, correct: number, firstAnswer: boolean, complete: boolean }} Round
 */

/** @param {string} selector */
const element = selector => /** @type {HTMLElement} */ (document.querySelector(selector));
const main = element('main');
const practice = element('#practice');
const prompt = element('#prompt');
const answers = element('#answers');
const audio = /** @type {HTMLAudioElement} */ (element('audio'));
const replay = /** @type {HTMLButtonElement} */ (element('#replay'));
const hide = /** @type {HTMLButtonElement} */ (element('#hide-clip'));
const audioStatus = element('#audio-status');
const status = element('#status');
const retry = element('#retry-load');
const native = element('#native');
const feedback = element('#feedback');
const license = /** @type {HTMLDialogElement} */ (element('#license'));
const openLicense = element('#open-license');
const notice = element('#notice');
const licenseLink = /** @type {HTMLAnchorElement} */ (element('#license-link'));
const answerButtons = () => /** @type {HTMLButtonElement[]} */ ([...answers.children]);

const speech = slot('speech');
element('#dataset').prepend(datasetPicker(speech));
/** @type {Map<string, Set<string>>} */
const usedWords = new Map();
/** @type {import('vizint').Pack | undefined} */
let pack;
let code = '';
/** @type {Clip[]} */
let catalog = [];
/** @type {Set<string>} */
let hidden = new Set();
/** @type {Round | undefined} */
let round;
let generation = 0;
let audioReady = false;
let audioFailed = false;
let focusAnswers = false;

function showNotice() {
  const option = speech.option();
  notice.textContent = option.notice ?? '';
  licenseLink.textContent = option.license;
  licenseLink.href = option.licenseUrl ?? '';
  openLicense.hidden = !option.notice;
}
openLicense.onclick = () => license.showModal();
element('#close-license').onclick = () => license.close();

function clearAudio() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  audioReady = audioFailed = false;
  replay.disabled = true;
  audioStatus.textContent = '';
}

/** @param {string} text */
function showStatus(text, canRetry = false) {
  round = undefined;
  practice.hidden = true;
  clearAudio();
  status.textContent = text;
  retry.hidden = !canRetry;
}

function showAudioError() {
  audioFailed = true;
  replay.disabled = false;
  audioStatus.textContent = 'Could not play this clip. Press Replay to retry.';
}

async function play() {
  if (!round) return;
  if (audioFailed) {
    replay.disabled = true;
    audioStatus.textContent = 'Loading audio…';
    void loadAudio(round);
    return;
  }
  if (!audioReady) return;
  const current = round;
  audioStatus.textContent = '';
  audio.currentTime = 0;
  try {
    await audio.play();
  } catch (error) {
    const { name } = /** @type {Error} */ (error);
    if (round !== current || name === 'AbortError') return;
    if (name === 'NotAllowedError') audioStatus.textContent = 'Press Replay to start audio.';
    else showAudioError();
  }
}

audio.addEventListener('error', () => { if (audioReady) showAudioError(); });
replay.onclick = play;

/** Clips are read from the dataset one at a time, as they are needed. @param {Round} current */
async function loadAudio(current) {
  audioFailed = false;
  try {
    const url = await /** @type {import('vizint').Pack} */ (pack).blobUrl(`audio/${current.clip.filename}`);
    if (round !== current) return;
    audio.src = url;
    audioReady = true;
    replay.disabled = false;
    audioStatus.textContent = '';
    for (const button of answerButtons()) button.disabled = current.complete || button.classList.contains('wrong');
    if (document.activeElement?.closest('.vizint-dataset')) prompt.focus({ preventScroll: true });
    if (focusAnswers && document.activeElement === document.body) answerButtons()[0]?.focus({ preventScroll: true });
    focusAnswers = false;
    void play();
  } catch {
    if (round === current) showAudioError();
  }
}

/** @param {string} label @param {number} choice @param {number} index */
function answerButton(label, choice, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.disabled = true;
  button.onclick = () => choose(choice);
  const spelling = document.createElement('span');
  spelling.className = 'spelling';
  spelling.lang = languages[code].lang;
  const characters = [...label];
  const mark = document.createElement('mark');
  mark.textContent = characters[index];
  spelling.append(characters.slice(0, index).join(''), mark, characters.slice(index + 1).join(''));
  const key = document.createElement('kbd');
  key.setAttribute('aria-hidden', 'true');
  key.textContent = choice === 0 ? '←' : '→';
  button.append(...(choice === 0 ? [key, spelling] : [spelling, key]));
  return button;
}

function nextRound() {
  const events = history().filter(event => event.type === 'attempt' && event.origin.app === context.app
    && Number.isFinite(event.score));
  const selected = selectRound(catalog, hidden, round?.clip.filename,
    /** @type {Set<string>} */ (usedWords.get(code)), events, `${context.activity}/${code}`);
  if (!selected) {
    showStatus('No practice clips left for this language. Hidden clips stay excluded.');
    return;
  }
  const { clip, candidate } = selected;
  const correct = Number(Math.random() < 0.5);
  const options = [candidate.label, candidate.label];
  options[correct] = clip.transcript;
  round = { clip, candidate, correct, firstAnswer: true, complete: false };
  practice.hidden = false;
  status.textContent = '';
  retry.hidden = true;
  feedback.textContent = '';
  clearAudio();
  audioStatus.textContent = 'Loading audio…';
  hide.disabled = false;
  native.textContent = clip.nativeScript ?? '';
  native.hidden = !clip.nativeScript;
  answers.replaceChildren(...options.map((label, choice) => answerButton(label, choice, candidate.index)));
  void loadAudio(round);
}

/** The view grades the answer itself; only the first answer of a round counts. @param {number} choice */
function choose(choice) {
  const current = round;
  const button = answerButtons()[choice];
  if (!current || current.complete || !button || button.disabled) return;
  if (!current.firstAnswer && choice !== current.correct) return;
  focusAnswers = answers.contains(document.activeElement);
  const correct = choice === current.correct;
  button.classList.add(correct ? 'correct' : 'wrong');
  button.disabled = true;
  if (current.firstAnswer) {
    current.firstAnswer = false;
    const { candidate } = current;
    attempt({
      score: Number(correct),
      targets: [target('skill', `${context.activity}/${code}/${candidate.pair}`), target('topic', `${languages[code].name} tones`)],
      activity: `${context.activity}/${code}/${candidate.correct}/${candidate.distractor}`,
    });
  }
  if (correct) {
    current.complete = true;
    hide.disabled = true;
    for (const other of answerButtons()) other.disabled = true;
    audio.pause();
    feedback.textContent = 'Correct.';
    setTimeout(() => { if (round === current) nextRound(); }, 700);
  } else {
    feedback.textContent = 'Incorrect.';
    if (focusAnswers) answerButtons()[1 - choice]?.focus({ preventScroll: true });
  }
}

hide.onclick = () => {
  if (!round || round.complete) return;
  hidden.add(round.clip.filename);
  state.set(`hidden/${code}`, [...hidden]);
  nextRound();
};

addEventListener('keydown', event => {
  const origin = /** @type {Element | null} */ (event.target);
  if (!round || license.open || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.code === 'Space' && !origin?.closest?.('button, audio, a, input, select, textarea, [contenteditable]')) {
    event.preventDefault();
    void play();
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (origin?.closest?.('audio, select')) return;
    event.preventDefault();
    choose(Number(event.key === 'ArrowRight'));
  }
});

async function start() {
  const request = ++generation;
  showNotice();
  showStatus('Loading practice clips…');
  try {
    const loaded = await speech.load();
    const clips = await loaded.json('clips.json');
    await historyReady();
    if (request !== generation) return;
    const language = String(loaded.meta.language);
    if (!Object.hasOwn(languages, language)) throw new Error(`Unsupported language ${language}`);
    pack = loaded;
    code = language;
    catalog = buildCatalog(clips, code);
    const stored = state.get(`hidden/${code}`);
    hidden = new Set(Array.isArray(stored) ? stored : []);
    if (!usedWords.has(code)) usedWords.set(code, new Set());
    nextRound();
  } catch (error) {
    if (request !== generation) return;
    const { code: reason, message } = /** @type {{ code?: string, message: string }} */ (error);
    showStatus(reason === 'needs-file' ? message : 'Could not load practice clips.', true);
  }
}

retry.onclick = () => void start();
speech.onChange(() => void start());
reportHeight(main, () => main.getBoundingClientRect().height + main.offsetTop * 2);
void start();
