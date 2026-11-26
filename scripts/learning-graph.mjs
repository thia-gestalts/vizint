import { nameId as deriveNameId } from '../src/name-id.mjs';

const knowledgeKinds = ['fact', 'skill'];
const relations = {
  topics: ['topic'],
  teaches: knowledgeKinds,
  answers: ['question'],
  practices: knowledgeKinds,
  assesses: knowledgeKinds,
  prerequisites: ['view', 'topic', ...knowledgeKinds],
};
export const topicRelations = ['within', 'related'];
const routeSegment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const identity = ({ kind, id }) => `${kind}:${id}`;
export const recordLabel = (record) => record.name ?? record.statement ?? record.text;
export const exerciseAnchor = (exercise) => `exercise-${exercise.id}`;
export const compareWeights = (a, b) => (b.weight ?? -1) - (a.weight ?? -1);

export function buildLearningGraph(entries, common, topics = []) {
  const { nameId, learningTargetId, uuid } = common.$defs;
  const topicId = new RegExp(nameId.pattern);
  const uuidId = new RegExp(uuid.pattern);
  const targetIds = learningTargetId.oneOf.map((schema) => new RegExp(schema.pattern ?? uuid.pattern));
  const idsByKind = { topic: [topicId], fact: targetIds, skill: targetIds, question: [uuidId] };
  const labelFields = { topic: 'name', fact: 'statement', skill: 'name', question: 'text' };
  const views = new Map();
  const records = new Map();
  const scopes = [];
  const slugs = new Set();

  for (const entry of entries) {
    if (typeof entry.activity !== 'string' || !entry.activity.trim() || views.has(entry.activity)) {
      throw new Error(`Invalid or duplicate activity ID: ${entry.activity}`);
    }
    if (typeof entry.slug !== 'string' || !routeSegment.test(entry.slug)
        || slugs.has(entry.slug) || entry.slug === 'learn') {
      throw new Error(`Invalid or duplicate activity route: ${entry.slug}`);
    }
    views.set(entry.activity, entry);
    slugs.add(entry.slug);

    const learning = entry.learning ?? {};
    const exercises = learning.exercises ?? [];
    scopes.push({ entry, learning });
    const exerciseIds = new Set();
    for (const exercise of exercises) {
      if (typeof exercise.id !== 'string' || !routeSegment.test(exercise.id) || exerciseIds.has(exercise.id)
          || typeof exercise.title !== 'string' || !exercise.title.trim()) {
        throw new Error(`Invalid or duplicate exercise: ${entry.activity}/${exercise.id}`);
      }
      exerciseIds.add(exercise.id);
      scopes.push({ entry, exercise, learning: exercise });
    }
  }

  const declarations = [
    ...scopes.flatMap(({ entry, learning }) => (learning.records ?? []).map((record) => [record, entry.activity])),
    ...topics.map(({ slug, record }) => [record, `topic folder ${slug}`]),
  ];
  for (const [record, location] of declarations) {
    const { kind, id } = record;
    const label = record[labelFields[kind]];
    const validId = typeof id === 'string' && Object.hasOwn(idsByKind, kind)
      && idsByKind[kind].some((pattern) => pattern.test(id));
    if (!validId || typeof label !== 'string' || !label.trim()
        || Object.keys(record).length !== 3) {
      throw new Error(`Invalid Gestalt record ${identity(record)} in ${location}`);
    }
    if (kind === 'topic' && deriveNameId(label) !== id) {
      throw new Error(`Topic ${identity(record)} does not match its name in ${location}`);
    }
    const key = identity(record);
    if (records.has(key)) throw new Error(`Duplicate Gestalt record: ${key}`);
    records.set(key, record);
  }

  const topicFolders = new Map(topics.map((folder) => [identity(folder.record), folder]));
  const topicLinks = [];
  const linkKeys = new Set();
  const assertions = [
    ...scopes.flatMap(({ entry, exercise, learning }) => (learning.topicLinks ?? [])
      .map((link) => [link, `view:${entry.activity}`, exercise])),
    ...topics.flatMap(({ slug, links }) => links.map((link) => [link, `topic-folder:${slug}`])),
  ];
  for (const [{ subject, relation, object }, source, exercise] of assertions) {
    const subjectKey = subject && identity(subject);
    const objectKey = object && identity(object);
    if (exercise || subject?.kind !== 'topic' || object?.kind !== 'topic' || !topicRelations.includes(relation)) {
      throw new Error(`Invalid topic link from ${source}`);
    }
    for (const key of [subjectKey, objectKey]) {
      if (!records.has(key)) throw new Error(`Unresolved topic link target ${key} from ${source}`);
    }
    if (subjectKey === objectKey) throw new Error(`Self-referential topic link ${subjectKey} from ${source}`);
    const [first, second] = relation === 'related' ? [subjectKey, objectKey].sort() : [subjectKey, objectKey];
    const linkKey = `${first} ${relation} ${second}`;
    if (linkKeys.has(linkKey)) throw new Error(`Duplicate topic link ${linkKey} from ${source}`);
    linkKeys.add(linkKey);
    topicLinks.push({ subject: records.get(subjectKey), relation, object: records.get(objectKey), source });
  }

  const linked = (key, relation, from, to) => topicLinks
    .filter((link) => link.relation === relation && identity(link[from]) === key).map((link) => link[to]);
  const topicGraph = {
    broader: (key) => linked(key, 'within', 'subject', 'object'),
    narrower: (key) => linked(key, 'within', 'object', 'subject'),
    related: (key) => [...linked(key, 'related', 'subject', 'object'), ...linked(key, 'related', 'object', 'subject')],
    // Narrower topics reachable through `within`, nearest first. Cycles are tolerated.
    descendants(key, maxDepth = 4) {
      const found = [];
      const seen = new Set([key]);
      let frontier = [{ key, via: [] }];
      for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
        frontier = frontier.flatMap(({ key: parent, via }) => topicGraph.narrower(parent).flatMap((topic) => {
          const child = identity(topic);
          if (seen.has(child)) return [];
          seen.add(child);
          const step = { topic, depth, via };
          found.push(step);
          return [{ key: child, via: [...via, topic] }];
        }));
      }
      return found;
    },
  };

  const byActivity = new Map(entries.map(({ activity }) => [activity, []]));
  const backlinks = new Map();
  for (const { entry, exercise, learning } of scopes) {
    const location = exercise ? `${entry.activity}/${exercise.id}` : entry.activity;
    for (const [relation, kinds] of Object.entries(relations)) {
      const seen = new Set();
      for (const { target, weight, reason } of learning[relation] ?? []) {
        if (!target || !kinds.includes(target.kind) || typeof target.id !== 'string'
            || (!exercise && (relation === 'practices' || relation === 'assesses'))) {
          throw new Error(`Invalid ${relation} target in ${location}`);
        }
        const key = identity(target);
        const resolved = target.kind === 'view' ? views.get(target.id) : records.get(key);
        if (!resolved) throw new Error(`Unresolved ${relation} target ${key} in ${location}`);
        if (seen.has(key)) throw new Error(`Duplicate ${relation} target ${key} in ${location}`);
        if (weight !== undefined && (!Number.isFinite(weight) || weight < 0 || weight > 1)) {
          throw new Error(`Invalid ${relation} weight for ${key} in ${location}`);
        }
        if (reason !== undefined && (relation !== 'prerequisites'
            || typeof reason !== 'string' || !reason.trim())) {
          throw new Error(`Invalid ${relation} reason for ${key} in ${location}`);
        }

        seen.add(key);
        const link = { entry, exercise, relation, target, resolved, weight, reason };
        byActivity.get(entry.activity).push(link);
        if (!backlinks.has(key)) backlinks.set(key, []);
        backlinks.get(key).push(link);
      }
    }
  }

  const eventEntries = entries.map(({ slug, activity, type, learning, customHost }) => {
    if (customHost) return { slug, activity, type, targets: learning.records };
    const exercise = learning?.exercises?.[0];
    if (type === 'attempt' && (learning?.exercises?.length !== 1 || !exercise?.assesses?.length)) {
      throw new Error(`Attempt ${activity} must define one assessed exercise for its interactive frame`);
    }
    const topics = exercise?.topics?.length ? exercise.topics : learning?.topics ?? [];
    const links = type === 'attempt' ? [...exercise.assesses, ...topics] : learning?.topics ?? [];
    const targets = new Map(links.map(({ target }) => [identity(target), records.get(identity(target))]));
    if (targets.size === 0) throw new Error(`Missing learning event targets for ${activity}`);
    return { slug, activity, type, targets: [...targets.values()] };
  });

  return { byActivity, backlinks, eventEntries, records, topicFolders, topicLinks, topicGraph };
}
