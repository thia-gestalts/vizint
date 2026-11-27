// The part of a view that talks to the world. A view works standalone: every
// message here is optional, and nothing waits for a reply.
//
// View → host (only when embedded):
//   { type: 'hello', protocol, activity }
//   { type: 'observation', event }     a complete learning event
//   { type: 'state', key, value }      a per-view preference changed
//   { type: 'height', value }          only when the view calls reportHeight
// Host → view:
//   { type: 'history', events, state } past events of this view and its stored state

/**
 * @typedef {{ kind: string, id: string, name?: string, statement?: string, text?: string }} LearningRecord
 * @typedef {{ kind: string, id: string }} TargetRef
 * @typedef {{
 *   kind: 'learning-event', id: string, type: 'engagement' | 'attempt', occurredAtMs: number,
 *   origin: { app: string, activity: string }, targets: TargetRef[], score?: number,
 * }} LearningEvent
 * @typedef {{
 *   id: string, title: string, kind: string, hash: string, source: string, sourceUrl?: string,
 *   license: string, licenseUrl?: string, notice?: string, inline?: string, sources: string[],
 * }} DatasetOption
 * @typedef {{ label: string, kind: string, options: DatasetOption[] }} SlotContext
 * @typedef {{
 *   protocol: 1, app: string, activity: string, type: 'engagement' | 'attempt',
 *   targets: LearningRecord[], defaults: string[], datasets: Record<string, SlotContext>,
 * }} ViewContext
 */

export const protocol = 1;
const element = document.getElementById('vizint-view');

/**
 * What the build tells the view about itself. A frame built without it, such
 * as a generated draft, still runs, but has no learning targets.
 * @type {ViewContext}
 */
export const context = element?.textContent
  ? JSON.parse(element.textContent)
  : { protocol, app: '', activity: '', type: 'engagement', targets: [], defaults: [], datasets: {} };

export const embedded = window.parent !== window;

/** @param {Record<string, unknown>} message */
function post(message) {
  if (embedded) window.parent.postMessage(message, '*');
}

function uuid() {
  if (globalThis.isSecureContext && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// State: small per-view preferences, kept in localStorage where the view may
// use it, in memory otherwise, and mirrored to a host that stores them.

/** @type {Storage | undefined} */
let storage;
try {
  storage = window.localStorage;
  void storage.length;
} catch {
  storage = undefined;
}
const prefix = `vizint/${context.activity || location.pathname}/`;
/** @type {Map<string, unknown>} */
const memory = new Map();

export const state = {
  /** @param {string} key @returns {any} */
  get(key) {
    if (memory.has(key)) return memory.get(key);
    try {
      const stored = storage?.getItem(prefix + key);
      return stored == null ? undefined : JSON.parse(stored);
    } catch {
      return undefined;
    }
  },
  /** @param {string} key @param {unknown} value */
  set(key, value) {
    memory.set(key, value);
    try {
      storage?.setItem(prefix + key, JSON.stringify(value));
    } catch {
      // Storage can be full or blocked; memory still holds the value.
    }
    post({ type: 'state', key, value });
  },
};

// History: this view's past learning events. A host may supply earlier ones;
// the view's own observations are always added.

/** @type {Map<string, LearningEvent>} */
const events = new Map();
/** @type {Set<(events: LearningEvent[]) => void>} */
const historyListeners = new Set();
let historyReceived = false;
/** @type {() => void} */
let resolveHistory = () => {};
const historyArrival = new Promise(resolve => { resolveHistory = () => resolve(undefined); });

/** Past events, oldest first. */
export function history() {
  return [...events.values()].sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.id.localeCompare(b.id));
}

/** Calls back whenever a host delivers history. @param {(events: LearningEvent[]) => void} listener */
export function onHistory(listener) {
  historyListeners.add(listener);
  return () => { historyListeners.delete(listener); };
}

/**
 * Resolves once a host has sent history, at once when standalone, or after
 * `timeout` milliseconds. Use it to schedule the first exercise from what the
 * learner already did, without ever depending on a host.
 */
export function historyReady(timeout = 800) {
  if (!embedded || historyReceived) return Promise.resolve();
  return Promise.race([historyArrival, new Promise(resolve => setTimeout(resolve, timeout))]);
}

window.addEventListener('message', ({ source, data }) => {
  if (source !== window.parent || !embedded || !data || data.type !== 'history') return;
  if (Array.isArray(data.events)) {
    for (const event of data.events) {
      if (event?.kind === 'learning-event' && typeof event.id === 'string') events.set(event.id, event);
    }
  }
  if (data.state && typeof data.state === 'object') {
    for (const [key, value] of Object.entries(data.state)) memory.set(key, value);
  }
  historyReceived = true;
  resolveHistory();
  const list = history();
  for (const listener of historyListeners) listener(list);
});

// Learning targets and observations.

/**
 * A learning target this view declared: facts and skills by key, topics and
 * questions by name or text.
 * @param {'fact' | 'skill' | 'topic' | 'question'} kind
 * @param {string} keyOrName
 */
export function target(kind, keyOrName) {
  const wanted = keyOrName.toLowerCase();
  const found = context.targets.find(record => record.kind === kind && (
    kind === 'fact' || kind === 'skill'
      ? record.id === `key:${context.app}:${keyOrName}`
      : (record.name ?? record.text)?.toLowerCase() === wanted));
  if (!found) throw new Error(`This view declares no ${kind} ${keyOrName}`);
  return found;
}

/** @param {(LearningRecord | TargetRef | string)[] | undefined} targets @returns {TargetRef[]} */
function references(targets) {
  return (targets ?? context.defaults).map(item => {
    const id = typeof item === 'string' ? item : item.id;
    const record = context.targets.find(candidate => candidate.id === id
      && (typeof item === 'string' || candidate.kind === item.kind));
    if (!record) throw new Error(`Unknown learning target ${id}`);
    return { kind: record.kind, id: record.id };
  });
}

/** @param {LearningEvent} event */
function emit(event) {
  events.set(event.id, event);
  post({ type: 'observation', event });
  return event;
}

/**
 * @param {'engagement' | 'attempt'} type
 * @param {{ targets?: (LearningRecord | TargetRef | string)[], activity?: string }} options
 * @returns {LearningEvent}
 */
function observation(type, { targets, activity }) {
  return {
    kind: 'learning-event', id: uuid(), type, occurredAtMs: Date.now(),
    origin: { app: context.app, activity: activity ?? context.activity }, targets: references(targets),
  };
}

let engaged = false;

/** Records that the learner engaged with this view, once per page load. */
export function engage() {
  if (engaged) return;
  engaged = true;
  emit(observation('engagement', {}));
}

/**
 * Records a graded attempt. The view grades; a host only stores the result.
 * @param {{ score: number, targets?: (LearningRecord | TargetRef | string)[], activity?: string }} attempt
 */
export function attempt({ score, ...options }) {
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('An attempt score must be between 0 and 1');
  return emit({ ...observation('attempt', options), score });
}

/**
 * Lets a host size the frame to the view's content.
 * @param {Element} element
 * @param {() => number} [measure]
 */
export function reportHeight(element, measure = () => element.getBoundingClientRect().height) {
  if (!embedded) return;
  new ResizeObserver(() => post({ type: 'height', value: measure() })).observe(element);
}

post({ type: 'hello', protocol, activity: context.activity });
