import { nameId } from '../../name-id.mjs';

// Facts are per country, so practice on any map counts toward the same facts.
export default async function worldMapEntry(app, { datasets }) {
  const topic = { kind: 'topic', id: nameId('World Map'), name: 'World Map' };
  const modes = [
    ['find-in-neighborhood', 'Find a country in its neighborhood', 'neighborhood'],
    ['find-on-world-map', 'Find a country on the map', 'worldMap'],
    ['identify-country', 'Identify the highlighted country', 'identifyCountry'],
    ['distractor-choice', 'Distinguish neighboring countries', 'distractorChoice'],
    ['group-sequence', 'Identify countries in a regional group'],
  ];
  const maps = await Promise.all(datasets.map.map(async dataset => {
    const [geometry, countries, groups] = await Promise.all(['map.geo.json', 'countries.json', 'groups.json'].map(path => dataset.json(path)));
    return { countries, groups, names: new Map(geometry.features.map(({ properties }) => [properties.code, properties.name])) };
  }));
  const facts = new Map();
  const exercises = modes.map(([id, title, field]) => {
    const codes = new Set(maps.flatMap(({ countries, groups, names }) => {
      const found = field
        ? Object.keys(countries).filter(code => countries[code][field]?.enabled)
        : Object.values(groups).filter(group => group.enabled).flatMap(group => group.countries);
      for (const code of found) {
        if (!names.has(code)) throw Error(`Missing map country ${code}`);
        facts.set(code, { kind: 'fact', id: `key:${app}:world-map/country/${code.toLowerCase()}`,
          statement: `Location of ${names.get(code)} on the world map` });
      }
      return found;
    }));
    const targets = [...codes].sort().map(code => ({ target: { kind: 'fact', id: facts.get(code).id } }));
    return { id, title, practices: targets, assesses: targets };
  });
  return {
    records: [topic, ...[...facts.values()].sort((a, b) => a.id.localeCompare(b.id))],
    topics: [{ target: { kind: topic.kind, id: topic.id } }], exercises,
    topicLinks: [{ subject: { kind: topic.kind, id: topic.id }, relation: 'within', object: { kind: 'topic', id: nameId('Geography') } }],
  };
}
