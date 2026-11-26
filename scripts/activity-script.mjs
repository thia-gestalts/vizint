import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function readActivityScript({ slug, sharedScript }) {
  const paths = [sharedScript, `src/views/${slug}/activity.js`].filter(Boolean);
  const parts = await Promise.all(paths.map(async (path) => {
    const file = fileURLToPath(new URL(`../${path}`, import.meta.url));
    return { file, source: await readFile(file, 'utf8') };
  }));
  return { parts, source: parts.map(({ source }) => source).join('\n') };
}
