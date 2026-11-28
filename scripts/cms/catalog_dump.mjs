// Print the resolved catalog (views and topic pages) as JSON, or the error that stops it from loading.
// The CMS runs this after each save, so edits are checked by the same rules as the build.
// CMS_SRC points at another src folder, which the tests use.
import { pathToFileURL } from 'node:url';

const src = process.env.CMS_SRC ?? new URL('../../src/', import.meta.url).pathname;
try {
  const { entries, topics } = await import(pathToFileURL(`${src}/catalog.mjs`).href);
  process.stdout.write(JSON.stringify({ ok: true, entries, topics }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
}
