// The site's host for every view. A view does all of its own learning logic and
// works without any host; this one listens, stores what the view reports,
// returns the learner's history, and keeps the view's preferences.
import { app, entries } from './catalog.mjs';
import { readRecords, saveObservation, session } from './storage.mjs';

const mount = document.querySelector('#activity');
const entry = entries.find(({ slug }) => slug === mount.dataset.entry);
const frame = document.querySelector('#activity-template').content.firstElementChild.cloneNode();
const retry = document.querySelector('#retry');
const status = document.querySelector('#save-status');
const allowed = new Map(entry.targets.map(record => [`${record.kind}:${record.id}`, record]));
const inScope = activity => activity === entry.activity || activity.startsWith(entry.activity + '/');
const profile = JSON.stringify(session ? [session.origin, session.account.id] : ['guest']);
const stateKey = `vizint-view-state/${profile}/${entry.slug}`;
const pending = [];
let saving = false;

function readState() {
  try {
    return JSON.parse(localStorage.getItem(stateKey) ?? '{}');
  } catch {
    return {};
  }
}

const send = message => frame.contentWindow.postMessage(message, '*');

// Stored dataset choices, or the one an exercise link asks for, open the view
// on the right dataset at once.
function viewUrl() {
  const choice = new URLSearchParams();
  for (const [key, value] of Object.entries(readState())) {
    if (key.startsWith('slot:') && typeof value === 'string') choice.set(key.slice(5), value);
  }
  const linked = entry.exercises.find(({ anchor }) => location.hash === '#' + anchor);
  if (linked) choice.set(linked.dataset.slot, linked.dataset.id);
  return 'view.html' + (choice.size ? '#' + choice : '');
}

function valid(event) {
  return event?.kind === 'learning-event' && typeof event.id === 'string' && event.type === entry.type
    && Number.isFinite(event.occurredAtMs) && event.origin?.app === app && typeof event.origin.activity === 'string'
    && inScope(event.origin.activity) && Array.isArray(event.targets) && event.targets.length > 0
    && event.targets.every(target => allowed.has(`${target?.kind}:${target?.id}`))
    && (event.type === 'attempt' ? Number.isFinite(event.score) && event.score >= 0 && event.score <= 1 : !('score' in event));
}

async function persist() {
  if (saving) return;
  saving = true;
  retry.hidden = true;
  status.textContent = '';
  try {
    while (pending.length) {
      const event = pending[0];
      await saveObservation(event, event.targets.map(target => allowed.get(`${target.kind}:${target.id}`)));
      pending.shift();
    }
  } catch {
    retry.hidden = false;
    status.textContent = 'Could not save your progress.';
  } finally {
    saving = false;
  }
}

async function sendHistory() {
  let events = [];
  try {
    events = (await readRecords()).filter(record => record.kind === 'learning-event'
      && record.origin?.app === app && typeof record.origin.activity === 'string' && inScope(record.origin.activity));
  } catch {
    status.textContent = 'Could not load your earlier progress.';
  }
  send({ type: 'history', events, state: readState() });
}

window.addEventListener('message', ({ source, origin, data }) => {
  // allow-scripts without allow-same-origin gives the view an opaque origin.
  if (source !== frame.contentWindow || origin !== 'null' || !data) return;
  if (data.type === 'hello') void sendHistory();
  if (data.type === 'observation') {
    if (!valid(data.event)) return;
    pending.push(data.event);
    void persist();
  }
  if (data.type === 'state' && typeof data.key === 'string' && data.key.length <= 200) {
    try {
      localStorage.setItem(stateKey, JSON.stringify({ ...readState(), [data.key]: data.value }));
    } catch {
      // Preferences are a convenience; the view keeps working without them.
    }
  }
  if (data.type === 'height' && Number.isFinite(data.value)) {
    frame.style.height = `${Math.max(160, Math.min(1600, Math.ceil(data.value)))}px`;
  }
});

addEventListener('hashchange', () => {
  const linked = entry.exercises.find(({ anchor }) => location.hash === '#' + anchor);
  if (linked) frame.contentWindow.location.replace(new URL(viewUrl(), location.href).href);
});

retry.addEventListener('click', persist);
frame.src = viewUrl();
mount.append(frame);
