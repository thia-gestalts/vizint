import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { entries } from '../src/catalog.mjs';
import { readFileSync } from 'node:fs';
import { buildLearningGraph } from './learning-graph.mjs';
import { server } from './serve.mjs';

buildLearningGraph(entries, JSON.parse(readFileSync(new URL('../vendor/thia-gestalts/common/v2.json', import.meta.url))));

const width = 768;
const height = 464;
const build = () => execFileSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], {
  cwd: new URL('../', import.meta.url),
  stdio: 'inherit',
});

async function capturePreview(page, origin, { slug, previewReady, previewHash = '' }, folder) {
  const response = await page.goto(new URL(`${slug}/${previewHash}`, origin).href);
  if (!response?.ok()) throw new Error(`Could not load ${slug}.`);
  const iframe = page.locator('#activity iframe');
  await iframe.evaluate((element, size) => {
    element.style.width = `${size.width}px`;
    element.style.height = `${size.height}px`;
    element.style.minHeight = element.style.height;
  }, { width, height });
  await iframe.contentFrame().locator(previewReady ?? 'body').first().waitFor();
  const screenshot = await iframe.screenshot({ animations: 'disabled' });
  try {
    await writeFile(new URL('preview.png', folder), screenshot, { flag: 'wx' });
    console.log(`Saved src/views/${slug}/preview.png`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

const missing = [];
for (const entry of entries) {
  const folder = new URL(`../src/views/${entry.slug}/`, import.meta.url);
  if (!(await readdir(folder)).includes('preview.png')) missing.push({ entry, folder });
}
if (!missing.length) {
  console.log('All views already have previews.');
} else {
  build();
  const browser = await chromium.launch(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: 'chrome' });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}/`;
    const page = await browser.newPage({
      viewport: { width: 896, height: 720 },
      reducedMotion: 'reduce',
    });
    for (const { entry, folder } of missing) {
      await capturePreview(page, origin, entry, folder);
    }
  } finally {
    server.close();
    await browser.close();
  }
  build();
}
