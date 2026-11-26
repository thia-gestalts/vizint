import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { nameId } from '../../name-id.mjs';
import { languages as packs } from './languages.mjs';

export default function minimalPairsEntry(app) {
  const { languages } = parse(readFileSync(new URL('learning.yml', import.meta.url), 'utf8'));
  const records = [];
  const topics = [];
  const exercises = [];
  const topicLinks = [];
  const link = ({ kind, id }) => ({ target: { kind, id } });

  for (const [code, { name, topic, within = [], tones }] of Object.entries(languages)) {
    const topicRecord = { kind: 'topic', id: nameId(topic), name: topic };
    for (const broader of within) {
      topicLinks.push({ subject: link(topicRecord).target, relation: 'within', object: { kind: 'topic', id: nameId(broader) } });
    }
    records.push(topicRecord);
    topics.push(link(topicRecord));
    const keys = packs[code].tones;
    if (keys.length !== Object.keys(tones).length || keys.some(key => !Object.hasOwn(tones, key))) {
      throw new Error(`Tone labels do not match the ${code} practice pack`);
    }
    const skills = keys.flatMap((first, index) => keys.slice(index + 1).map(second => ({
      kind: 'skill',
      id: `key:${app}:minimal-pairs-practice/${code}/${[first, second].sort().join('-')}`,
      name: `Distinguish ${tones[first]} and ${tones[second]} in ${name} speech`,
    })));
    records.push(...skills);
    exercises.push({ id: code, title: `Practice ${name} tones`, topics: [link(topicRecord)],
      practices: skills.map(link), assesses: skills.map(link) });
  }

  return {
    records, topics, exercises, topicLinks,
  };
}
