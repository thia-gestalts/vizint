import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { entries } from '../src/catalog.mjs';
import { embedSearch } from './learning-embeddings.mjs';
import { buildLearningGraph } from './learning-graph.mjs';
import { createQueryIndex, kinds, neighbors, rank, relations } from './learning-query.mjs';

const string = { type: 'string' };

export async function main([command, ...args]) {
  const options = {
    search: { kind: string, limit: string, lexical: { type: 'boolean' } },
    neighbors: { direction: string, relation: string },
  };
  if (!Object.hasOwn(options, command)) throw new Error('Expected search or neighbors');
  const { values, positionals: [input, ...extra] } = parseArgs({
    args, options: options[command], allowPositionals: true,
  });
  if (!input?.trim() || extra.length) throw new Error('Expected one query or item ID');
  const schema = JSON.parse(readFileSync(new URL('../vendor/thia-gestalts/common/v2.json', import.meta.url)));
  const index = createQueryIndex(entries, buildLearningGraph(entries, schema));
  if (command === 'neighbors') {
    if (values.direction !== undefined && !['in', 'out', 'both'].includes(values.direction)) throw new Error('Invalid direction');
    if (values.relation !== undefined && !relations.includes(values.relation)) throw new Error('Invalid relation');
    return neighbors(index, input, values);
  }

  if (values.kind !== undefined && !kinds.includes(values.kind)) throw new Error('Invalid kind');
  const limit = Number(values.limit ?? 10);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Limit must be a positive integer');
  const items = [...index.items.values()].filter(item => values.kind === undefined || item.kind === values.kind);
  let mode = 'lexical';
  let vectors, queryVector;
  if (!values.lexical && items.length) {
    try {
      ({ vectors, queryVector } = await embedSearch(items, input.trim()));
      mode = 'hybrid';
    } catch (error) {
      console.error(`Semantic search unavailable: ${error.message}`);
    }
  }
  return { mode, results: rank(items, input, limit, vectors, queryVector) };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
