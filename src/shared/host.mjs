import { app, entries } from './catalog.mjs';
import { newQuestion } from './rounding.mjs';
import { saveObservation } from './storage.mjs';

const mount = document.querySelector('#activity');
const entry = entries.find(({ slug }) => slug === mount.dataset.entry);
const frame = document.querySelector('#activity-template').content.firstElementChild.cloneNode();
const retry = document.querySelector('#retry');
let question;
let observation;
let saving = false;
let saved = false;

function send(message) {
  // allow-scripts without allow-same-origin gives the activity an opaque origin.
  frame.contentWindow.postMessage(message, '*');
}

function showQuestion() {
  if (!question) question = newQuestion();
  const { id, prompt, options } = question;
  send({ type: 'question', id, prompt, options });
}

async function persist() {
  if (saving || saved) return;
  saving = true;
  retry.hidden = true;
  try {
    await saveObservation(observation, [entry.target]);
    saved = true;
    if (question) send({ type: 'saved', id: question.id });
  } catch {
    retry.hidden = false;
  } finally {
    saving = false;
  }
}

function observe(score) {
  const { kind, id } = entry.target;
  observation = {
    kind: 'learning-event',
    id: crypto.randomUUID(),
    type: entry.type,
    occurredAtMs: Date.now(),
    origin: { app, activity: entry.activity },
    targets: [{ kind, id }],
  };
  if (entry.type === 'attempt') observation.score = score;
  void persist();
}

window.addEventListener('message', ({ source, origin, data }) => {
  if (source !== frame.contentWindow || origin !== 'null' || !data) return;
  if (entry.type === 'engagement') {
    if (data.type === 'control-point-moved' && !observation) observe();
    return;
  }

  if (data.type === 'ready') {
    showQuestion();
    return;
  }
  if (!question || data.id !== question.id) return;

  if (data.type === 'answer' && Number.isInteger(data.choice)
      && data.choice >= 0 && data.choice < question.options.length && !observation) {
    const correct = data.choice === question.correct;
    send({ type: 'feedback', id: question.id, correct, answer: question.options[question.correct] });
    observe(Number(correct));
  }
  if (data.type === 'next' && saved) {
    question = newQuestion(question.value);
    observation = undefined;
    saved = false;
    status.textContent = '';
    showQuestion();
  }
});

retry.addEventListener('click', persist);
mount.append(frame);
