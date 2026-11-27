import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { parse } from 'yaml';
import { checkDraft } from './view-draft-check.mjs';
import { validateLibraries } from './activity-libraries.mjs';
import { fixtures } from './view-generation-fixtures.mjs';

const [folder, slug] = process.argv.slice(2);
const read = name => readFile(join(folder, name), 'utf8');
const fixture = Object.values(fixtures).find(item => item.view === slug);
const result = { status: 'incomplete', checks: {}, diagnostics: [],
  contract: fixture ? 'Checkout with fixture' : 'Checkout' };

try {
  const [manifest, markup, styles, source, common] = await Promise.all(
    ['view.yml', 'activity.html', 'activity.css', 'activity.js', '_frame.css'].map(read),
  );
  const entry = parse(manifest);
  if (!entry || ['title', 'intro', 'frameHeight'].some(key => typeof entry[key] !== 'string' || !entry[key].trim())
    || !['engagement', 'attempt'].includes(entry.type)) {
    throw new Error('The view manifest needs a title, intro, frameHeight, and supported type.');
  }
  if (entry.customHost) {
    result.status = 'unsupported';
    throw new Error('Custom hosts require the site build and preview.');
  }
  let code = source;
  if (entry.sharedScript) {
    if (!/^src\/[\w-]+\.js$/.test(entry.sharedScript)) throw new Error('Invalid shared script path.');
    code = (await read('_shared.js')) + '\n' + source;
  }
  if ('libraries' in entry) validateLibraries(entry.libraries);
  result.status = 'unavailable';
  const browser = await chromium.launch(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  try {
    const issue = await checkDraft({ ...entry, markup, styles, code, common }, folder, browser,
      fixture, result, performance.now() + 30_000, { codemod: false });
    result.status = issue ? 'fail' : 'pass';
  } finally {
    await browser.close();
  }
} catch (error) {
  result.diagnostics.push({ message: error.code === 'ENOENT' && result.status === 'incomplete'
    ? `Missing ${error.path.split('/').at(-1)}` : error.message });
}
await writeFile(join(folder, 'check.json'), JSON.stringify(result));
