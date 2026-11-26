const knowledgeKinds = ['fact', 'skill'];
const relations = {
  topics: ['topic'],
  teaches: knowledgeKinds,
  answers: ['question'],
  practices: knowledgeKinds,
  assesses: knowledgeKinds,
  prerequisites: ['view', 'topic', ...knowledgeKinds],
};
const routeSegment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const identity = ({ kind, id }) => `${kind}:${id}`;
export const recordLabel = (record) => record.name ?? record.statement ?? record.text;
export const exerciseAnchor = (exercise) => `exercise-${exercise.id}`;
export const compareWeights = (a, b) => (b.weight ?? -1) - (a.weight ?? -1);

export function buildLearningGraph(entries, common) {
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

  for (const { entry, learning } of scopes) {
    for (const record of learning.records ?? []) {
      const { kind, id } = record;
      const label = record[labelFields[kind]];
      const validId = typeof id === 'string' && Object.hasOwn(idsByKind, kind)
        && idsByKind[kind].some((pattern) => pattern.test(id));
      if (!validId || typeof label !== 'string' || !label.trim()
          || Object.keys(record).length !== 3) {
        throw new Error(`Invalid Gestalt record ${identity(record)} in ${entry.activity}`);
      }
      const key = identity(record);
      if (records.has(key)) throw new Error(`Duplicate Gestalt record: ${key}`);
      records.set(key, record);
    }
  }

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

  const eventEntries = entries.map(({ slug, activity, type, learning }) => {
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

  return { byActivity, backlinks, eventEntries, records };
}
