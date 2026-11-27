import { pairKey } from './languages.mjs';

const decay = 0.5 ** (1 / 20);
/** @template T @param {T[]} items @returns {T} */
const pick = items => items[Math.floor(Math.random() * items.length)];

/**
 * @typedef {import('./languages.mjs').Clip} Clip
 * @typedef {import('./languages.mjs').Candidate} Candidate
 * @param {Clip[]} catalog
 * @param {Set<string>} hidden
 * @param {string | undefined} previous
 * @param {Set<string>} usedWords
 * @param {{ origin: { activity: string }, score?: number }[]} events
 * @param {string} activity
 * @returns {{ clip: Clip, candidate: Candidate } | undefined}
 */
export function selectRound(catalog, hidden, previous, usedWords, events, activity) {
  const playable = catalog.filter(clip => !hidden.has(clip.filename));
  const fresh = playable.filter(clip => clip.filename !== previous);
  const pool = fresh.length ? fresh : playable;
  if (!pool.length) return;

  /** @type {Map<string, { count: number, weight: number, correct: number }>} */
  const pairs = new Map();
  /** @type {Map<string, number>} */
  const directions = new Map();
  for (const event of events) {
    if (!event.origin?.activity.startsWith(`${activity}/`)) continue;
    const [correct, distractor] = event.origin.activity.slice(activity.length + 1).split('/');
    if (!correct || !distractor) continue;
    const pair = pairKey(correct, distractor);
    const current = pairs.get(pair) ?? { count: 0, weight: 0, correct: 0 };
    pairs.set(pair, {
      count: current.count + 1,
      weight: current.weight * decay + 1,
      correct: current.correct * decay + (event.score ?? 0),
    });
    const key = `${pair}/${correct}`;
    directions.set(key, (directions.get(key) ?? 0) * decay + 1);
  }

  // Sample three clips to propose contrasts, then choose the direction and clip
  // from the full eligible pool so either direction can be practiced.
  const samplePool = [...pool];
  /** @type {Clip[]} */
  const sample = [];
  for (let i = 0; i < Math.min(3, pool.length); i += 1) {
    const index = Math.floor(Math.random() * samplePool.length);
    sample.push(samplePool[index]);
    samplePool[index] = samplePool[samplePool.length - 1];
    samplePool.pop();
  }
  const available = [...new Set(sample.flatMap(clip => clip.candidates.map(candidate => candidate.pair)))];
  let preferred;
  if (Math.random() < 0.5) {
    preferred = available.filter(pair => (pairs.get(pair)?.count ?? 0) < 10);
  } else {
    /** @param {string} pair */
    const score = pair => {
      const counts = pairs.get(pair);
      return counts ? (counts.correct + 2) / (counts.weight + 3) : -1;
    };
    const lowest = Math.min(...available.map(score));
    preferred = available.filter(pair => score(pair) === lowest);
  }
  const pair = pick(preferred.length ? preferred : available);
  /** @type {Map<string, { clip: Clip, candidate: Candidate }[]>} */
  const choices = new Map();
  for (const clip of pool) {
    for (const candidate of clip.candidates) {
      if (candidate.pair !== pair) continue;
      const list = choices.get(candidate.correct) ?? [];
      list.push({ clip, candidate });
      choices.set(candidate.correct, list);
    }
  }

  /** @param {string} key */
  const weight = key => directions.get(`${pair}/${key}`) ?? 0;
  const keys = [...choices.keys()].sort((a, b) => weight(a) - weight(b));
  let direction = keys[0];
  if (keys.length === 2) {
    const preferFirst = weight(keys[0]) === weight(keys[1]) ? 0.5 : 2 / 3;
    if (Math.random() >= preferFirst) direction = keys[1];
  }
  const matching = /** @type {{ clip: Clip, candidate: Candidate }[]} */ (choices.get(direction));
  const unused = matching.filter(({ candidate }) => !usedWords.has(candidate.word));
  const round = pick(unused.length ? unused : matching);
  usedWords.add(round.candidate.word);
  return round;
}
