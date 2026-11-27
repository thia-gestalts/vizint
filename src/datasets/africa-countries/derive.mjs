// The world map restricted to meta.codes. Groups survive only when all of
// their countries are in the set, and distractors only when they are too, so
// every exercise stays answerable on this map.
const json = bytes => JSON.parse(new TextDecoder().decode(bytes));
const encode = value => new TextEncoder().encode(JSON.stringify(value));

export default async function deriveRegion({ dataset, files }) {
  const source = await files(dataset.meta.from);
  const codes = new Set(dataset.meta.codes);
  const geometry = json(source.get('map.geo.json'));
  const features = geometry.features.filter(feature => codes.has(feature.properties.code));
  const missing = [...codes].filter(code => !features.some(feature => feature.properties.code === code));
  if (missing.length) throw new Error(`Map geometry lacks ${missing.join(', ')}`);

  const countries = {};
  for (const [code, data] of Object.entries(json(source.get('countries.json')))) {
    if (!codes.has(code)) continue;
    const distractors = data.distractorChoice.distractors.filter(other => codes.has(other));
    countries[code] = {
      ...data,
      distractorChoice: { ...data.distractorChoice, distractors, enabled: data.distractorChoice.enabled && distractors.length > 0 },
    };
  }
  const groups = Object.fromEntries(Object.entries(json(source.get('groups.json')))
    .filter(([, group]) => group.countries.every(code => codes.has(code))));

  return new Map([
    ['countries.json', encode(countries)],
    ['groups.json', encode(groups)],
    ['map.geo.json', encode({ ...geometry, features })],
  ]);
}
