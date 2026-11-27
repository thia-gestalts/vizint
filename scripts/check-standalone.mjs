// Checks that views are standalone: each published view.html works with no
// host, a copied view.html works offline with its inline data, and the site
// host only stores what a view may report.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { entries } from '../src/catalog.mjs';
import { activityFrame } from './activity-frame.mjs';
import { bundleActivity } from './activity-libraries.mjs';
import { server } from './serve.mjs';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
if (!process.argv.includes('--no-build')) {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
}

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}/`;
const scratch = await mkdtemp(join(tmpdir(), 'vizint-standalone-'));
let failures = 0;

async function check(name, run, { expectedErrors } = {}) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(`${message.text()} ${message.location().url}`);
  });
  page.on('request', request => requests.push(request.url()));
  try {
    await run(page, { errors, requests });
    assert.deepEqual(errors.filter(error => !expectedErrors?.test(error)), []);
    console.log(`✔ ${name}`);
  } catch (error) {
    failures++;
    console.error(`✖ ${name}\n  ${error.message.split('\n').join('\n  ')}`);
  } finally {
    await context.close();
  }
}

/** Answers the current world-map question correctly and returns its prompt. */
async function answerWorldMap(frame) {
  const prompt = await frame.locator('#prompt').textContent();
  const buttons = frame.locator('#answers button');
  if (await buttons.first().textContent() === 'I have no idea') {
    await buttons.first().click();
    await frame.locator('path[fill="#3b82f6"]').first().dispatchEvent('click');
  } else {
    await buttons.nth(0).click();
    if (!(await buttons.nth(0).getAttribute('class'))?.includes('correct')) await buttons.nth(1).click();
  }
  await frame.locator('#answers button.correct, path[fill="#22c55e"]').first().waitFor();
  return prompt;
}

const viewFile = slug => join(fileURLToPath(dist), slug, 'view.html');

try {
  // (a) Every view runs as a top-level page, with no host listening.
  for (const { slug, previewReady } of entries) {
    await check(`${slug}: view.html runs without a host`, async page => {
      await page.goto(`${origin}${slug}/view.html`);
      await page.locator(previewReady ?? 'body').first().waitFor({ timeout: 10_000 });
    });
  }

  // (b) A copied view.html works offline from its inline dataset.
  const copy = join(scratch, 'world-map.html');
  await copyFile(viewFile('world-map'), copy);
  await check('world-map: a copied view.html works offline on its inline dataset', async (page, { requests }) => {
    await page.goto(`${pathToFileURL(copy).href}#map=africa-countries`);
    await page.locator('#answers button').first().waitFor();
    assert.equal(await page.locator('select').inputValue(), 'africa-countries');
    await answerWorldMap(page);
    const network = requests.filter(url => !/^(file|data|blob):/.test(url));
    assert.deepEqual(network, [], 'no network requests');
  });

  // (c) Without its remote data, the copy says so, and the pack file opens it.
  await check('world-map: a copied view.html asks for data it cannot reach', async page => {
    await page.goto(pathToFileURL(copy).href);
    await page.locator('.vizint-dataset[data-state="error"]').waitFor();
    assert.match(await page.locator('#prompt').textContent(), /World data is not available here/);
  }, { expectedErrors: /file:\/\/.*\.vzpk|net::ERR_FAILED/ });
  const html = await readFile(viewFile('world-map'), 'utf8');
  const context = JSON.parse(/<script type="application\/json" id="vizint-view">(.*?)<\/script>/s.exec(html)[1]);
  const harness = join(scratch, 'harness.html');
  const filename = join(scratch, 'harness.js');
  await writeFile(harness, activityFrame({
    title: 'Harness', common: '', styles: '', markup: '<input type="file">', context,
    code: await bundleActivity({ filename, libraries: [], source: `import { slot } from 'vizint';
const map = slot('map');
document.querySelector('input').onchange = async ({ target }) => {
  try {
    const pack = await map.loadFile(target.files[0]);
    const countries = await pack.json('countries.json');
    document.body.dataset.result = pack.id + ' ' + map.current + ' ' + Object.keys(countries).length;
  } catch (error) {
    document.body.dataset.result = 'error ' + error.code;
  }
};` }),
  }));
  const packs = (await import('node:fs')).readdirSync(new URL('datasets/', dist));
  const pack = name => join(fileURLToPath(dist), 'datasets', packs.find(file => file.startsWith(name + '.')));
  await check('world-map: slot.loadFile opens a pack file and rejects others', async page => {
    await page.goto(pathToFileURL(harness).href);
    await page.locator('input').setInputFiles(pack('vie-fpt-speech'));
    await page.locator('body[data-result]').waitFor();
    assert.equal(await page.locator('body').getAttribute('data-result'), 'error integrity');
    await page.locator('input').setInputFiles(pack('world-countries'));
    await page.waitForFunction(() => document.body.dataset.result?.startsWith('world-countries'));
    assert.match(await page.locator('body').getAttribute('data-result'), /^world-countries world-countries \d{3}$/);
  });

  // (d) The site host stores observations, and only targets the view declares.
  await check('site: the host stores valid observations and drops forged ones', async page => {
    await page.goto(`${origin}world-map/`);
    const frame = page.frameLocator('#activity iframe');
    await frame.locator('#answers button').first().waitFor();
    await answerWorldMap(frame);
    const view = page.frames().find(item => item.url().endsWith('view.html') || item.url().includes('view.html#'));
    await view.evaluate(app => {
      parent.postMessage({ type: 'observation', event: {
        kind: 'learning-event', id: 'forged-event', type: 'attempt', occurredAtMs: Date.now(), score: 1,
        origin: { app, activity: 'world-map/x' }, targets: [{ kind: 'skill', id: `key:${app}:rounding/nearest-tenth` }],
      } }, '*');
    }, context.app);
    await page.waitForTimeout(500);
    const events = await page.evaluate(() => new Promise(resolve => {
      const request = indexedDB.open('vizint-learner', 1);
      request.onsuccess = () => {
        const all = request.result.transaction('records').objectStore('records').getAll();
        all.onsuccess = () => resolve(all.result.filter(record => record.kind === 'learning-event'));
      };
    }));
    assert.equal(events.length, 1);
    assert.match(events[0].origin.activity, /^world-map\//);
    assert.ok(events[0].targets.some(target => target.id.includes(':world-map/country/')));
  });
} finally {
  server.close();
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
