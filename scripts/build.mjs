import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { app, entries } from '../src/catalog.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const output = new URL('dist/', root);
const vendor = 'vendor/thia-gestalts/';
const pin = JSON.parse(await read(vendor + 'pin.json'));

for (const [path, expected] of Object.entries(pin.sha256)) {
  const contents = await readFile(new URL(vendor + path, root));
  if (createHash('sha256').update(contents).digest('hex') !== expected) {
    throw new Error(`Pinned schema changed: ${path}`);
  }
}

function escapeHTML(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function page(title, prefix, body, script = '') {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(title)}</title>
  <link rel="stylesheet" href="${prefix}site.css">
  ${script}
</head>
<body>
  <header><nav aria-label="Main"><a href="${prefix || './'}">Vizint</a></nav></header>
  <main>${body}</main>
</body>
</html>
`;
}

await rm(output, { recursive: true, force: true });
await mkdir(output);
await cp(new URL('src/shared/', root), output, { recursive: true });
await cp(new URL('src/catalog.mjs', root), new URL('catalog.mjs', output));
await cp(new URL(vendor, root), new URL('schemas/', output), { recursive: true });
await writeFile(new URL('index.html', output), page('Vizint', '', `
  <h1>Explore and practice</h1>
  <div class="catalog">${entries.map(({ slug, title, intro }) => `
    <article><h2><a href="./${slug}/">${escapeHTML(title)}</a></h2>
    <p>${escapeHTML(intro)}</p></article>`).join('')}
  </div>`));

for (const entry of entries) {
  const { slug, title, intro, source } = entry;
  const markup = await read(`src/${slug}/activity.html`);
  const code = await read(`src/${slug}/activity.js`);
  const styles = await read(`src/${slug}/activity.css`);
  const common = await read('src/frame.css');
  // Activity scripts exist only inside the sandboxed document in the output.
  const frame = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<title>${escapeHTML(title)}</title><style>${common}\n${styles}</style></head>
<body>${markup}<script>${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  const path = new URL(`${slug}/`, output);
  await mkdir(path);
  await writeFile(new URL('index.html', path), page(`${title} | Vizint`, '../', `
    <h1>${escapeHTML(title)}</h1>
    <p class="intro">${escapeHTML(intro)}</p>
    <template id="activity-template"><iframe class="${slug}" title="${escapeHTML(title)}" sandbox="allow-scripts" srcdoc="${escapeHTML(frame)}"></iframe></template>
    <div id="activity" data-entry="${slug}"></div>
    <noscript>Enable JavaScript to use this activity.</noscript>
    <p id="save-status" role="status"></p>
    <button type="button" id="retry" hidden>Retry saving</button>
    <footer>${escapeHTML(source)}</footer>`, '<script type="module" src="../host.mjs"></script>'));
}

console.log(`Built ${entries.length} entries for ${app} with schemas pinned to ${pin.commit}.`);
