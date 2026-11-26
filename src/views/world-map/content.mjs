import { readFileSync } from 'node:fs';

export default function worldMapEntry(app) {
  const read = name => JSON.parse(readFileSync(new URL(`data/${name}.json`, import.meta.url)));
  const countries = read('countries');
  const groups = read('groups');
  const names = new Map(read('map.geo').features.map(({ properties }) => [properties.code, properties.name]));
  const topic = { kind: 'topic', id: 'name:776f726c64206d6170', name: 'World Map' };
  const modes = [
    ['find-in-neighborhood', 'Find a country in its neighborhood', 'neighborhood'],
    ['find-on-world-map', 'Find a country on the world map', 'worldMap'],
    ['identify-country', 'Identify the highlighted country', 'identifyCountry'],
    ['distractor-choice', 'Distinguish neighboring countries', 'distractorChoice'],
    ['group-sequence', 'Identify countries in a regional group'],
  ];
  const facts = new Map();
  const exercises = modes.map(([id, title, field]) => {
    const codes = field
      ? Object.keys(countries).filter(code => countries[code][field]?.enabled)
      : Object.values(groups).filter(group => group.enabled).flatMap(group => group.countries);
    const targets = [...new Set(codes)].map(code => {
      if (!names.has(code)) throw Error(`Missing map country ${code}`);
      const fact = { kind: 'fact', id: `key:${app}:world-map/country/${code.toLowerCase()}`,
        statement: `Location of ${names.get(code)} on the world map` };
      facts.set(code, fact);
      return { target: { kind: fact.kind, id: fact.id } };
    });
    return { id, title, practices: targets, assesses: targets };
  });
  return {
    records: [topic, ...facts.values()], topics: [{ target: { kind: topic.kind, id: topic.id } }], exercises,
  };
}
