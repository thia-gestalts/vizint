import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';

const fsrsScheduler = fsrs();
const modes = {
  'find-in-neighborhood': 'neighborhood',
  'find-on-world-map': 'worldMap',
  'identify-country': 'identifyCountry',
  'distractor-choice': 'distractorChoice',
};
const pick = list => list[Math.floor(Math.random() * list.length)];
export const day = date => new Date(date).toLocaleDateString('en-CA');
export const activityFor = ({ type, panIndex, groupId }) =>
  ['world-map', type, type === 'find-in-neighborhood' ? panIndex : groupId].filter(value => value !== undefined).join('/');
export const retrievability = card => fsrsScheduler.get_retrievability(card, new Date(), false);

export function replay(records, app, facts) {
  const codes = new Map([...facts].map(([code, fact]) => [fact.id, code]));
  const countries = new Map();
  const instances = new Map();
  const groups = new Map();
  const events = [...new Map(records.filter(event => event.kind === 'learning-event'
    && event.type === 'attempt' && [0, 1].includes(event.score)
    && event.origin.app === app && event.origin.activity.startsWith('world-map/')
    && event.targets.some(target => target.kind === 'fact' && codes.has(target.id)))
    .map(event => [event.id, event])).values()]
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.id.localeCompare(b.id));
  for (const event of events) {
    const code = codes.get(event.targets.find(target => target.kind === 'fact' && codes.has(target.id)).id);
    const date = new Date(event.occurredAtMs);
    const rating = event.score ? Rating.Good : Rating.Again;
    const update = (cards, key) => cards.set(key,
      fsrsScheduler.next(cards.get(key) ?? createEmptyCard(date), date, rating).card);
    update(countries, code);
    update(instances, `${code}/${event.origin.activity}`);
    const [, type, groupId] = event.origin.activity.split('/');
    if (type === 'group-sequence') groups.set(groupId, day(date));
  }
  return { countries, instances, groups, events };
}

export function nextExercise(content, groups, progress, lastCountry, now = new Date()) {
  const due = card => !card || card.due <= now;
  const pool = (items, cardFor) => {
    const reviews = items.filter(item => cardFor(item) && due(cardFor(item)));
    const unseen = items.filter(item => !cardFor(item));
    return reviews.length ? reviews : unseen.length ? unseen : items;
  };
  const qualifying = Object.entries(groups).filter(([id, group]) =>
    group.enabled && group.countries.length > 1 && progress.groups.get(id) !== day(now)
    && group.countries.filter(code => due(progress.countries.get(code))).length >= group.countries.length / 2);
  if (qualifying.length && Math.random() < 0.2) {
    const [groupId, { countries }] = pick(qualifying);
    return { type: 'group-sequence', groupId, countries: Math.random() < 0.5 ? countries : [...countries].reverse() };
  }
  const identify = Object.keys(content).filter(code => content[code].identifyCountry?.enabled);
  const available = Object.entries(content).map(([country, data]) => ({
    country, data,
    types: Object.keys(modes).filter(type => data[modes[type]]?.enabled
      && (type !== 'identify-country' || identify.length > 1)
      && (type !== 'distractor-choice' || data.distractorChoice.distractors.length)),
  })).filter(candidate => candidate.types.length);
  const candidates = available.length > 1 ? available.filter(item => item.country !== lastCountry) : available;
  if (!candidates.length) return undefined;
  const eligible = pool(candidates, item => progress.countries.get(item.country));
  const roll = Math.random();
  const priority = roll < 0.5 ? 1 : roll < 0.8 ? 2 : 3;
  const preferred = eligible.filter(item => (item.data.learningPriority ?? 2) === priority);
  const { country, types, data } = pick(preferred.length ? preferred : eligible);
  const distractor = () => ({ country, type: 'distractor-choice', zoom: data.distractorChoice.zoom,
    panIndex: Math.floor(Math.random() * 9), distractor: pick(data.distractorChoice.distractors) });
  if (!progress.countries.has(country) && types.includes('distractor-choice')) return distractor();
  const instances = types.flatMap(type => type === 'find-in-neighborhood'
    ? Array.from({ length: 9 }, (_, panIndex) => ({ type, country, panIndex, zoom: data.neighborhood.zoom }))
    : [{ type, country }]);
  const exercise = pick(pool(instances, item => progress.instances.get(`${country}/${activityFor(item)}`)));
  if (exercise.type === 'distractor-choice') return distractor();
  if (exercise.type === 'identify-country') exercise.distractor = pick(identify.filter(code => code !== country));
  return exercise;
}
