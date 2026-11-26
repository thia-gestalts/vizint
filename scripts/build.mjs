import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { app, entries } from '../src/catalog.mjs';
import { readActivityScript } from './activity-script.mjs';
import { buildLearningGraph, exerciseAnchor } from './learning-graph.mjs';
import { activityLearning, escapeHTML, writeLearningPages } from './learning-pages.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const output = new URL('dist/', root);
const vendor = 'vendor/thia-gestalts/';
const pin = JSON.parse(await read(vendor + 'pin.json'));
const lucide = import.meta.resolve('lucide-static/package.json');

for (const [path, expected] of Object.entries(pin.sha256)) {
  const contents = await readFile(new URL(vendor + path, root));
  if (createHash('sha256').update(contents).digest('hex') !== expected) {
    throw new Error(`Pinned schema changed: ${path}`);
  }
}

const graph = buildLearningGraph(entries, JSON.parse(await read(vendor + 'common/v2.json')));

function icon(name) {
  const svg = readFileSync(new URL(`icons/${name}.svg`, lucide), 'utf8');
  return svg.replace('<svg', '<svg aria-hidden="true" focusable="false"').trimEnd();
}

function accountDialog() {
  return `<dialog id="account-dialog" class="modal" aria-labelledby="account-title">
    <div class="modal-box max-w-sm rounded-xl">
      <form method="dialog">
        <button class="btn btn-ghost btn-sm btn-square absolute top-3 right-3" aria-label="Close account dialog">
          ${icon('x')}
        </button>
      </form>
      <h2 id="account-title" class="pr-9 text-xl font-semibold">Sign in</h2>
      <form id="olymp-account" method="post" class="mt-4">
        <fieldset id="account-controls" class="min-w-0">
          <div id="account-guest" class="space-y-4">
            <div class="grid gap-3">
              <label class="grid gap-1.5 text-sm font-medium">
                Login name
                <input class="input w-full" name="name" required autocomplete="username" autofocus>
              </label>
              <label class="grid gap-1.5 text-sm font-medium">
                Password
                <input class="input w-full" name="password" type="password" required autocomplete="current-password">
              </label>
            </div>
            <button id="account-submit" class="btn btn-primary w-full" type="submit">Sign in</button>
            <button id="account-mode" class="btn btn-link btn-sm w-full" type="button">Create an account</button>
            <p class="text-sm text-base-content/75">Signed-out practice stays on this device.</p>
          </div>
          <div id="account-member" hidden>
            <p id="account-name" class="wrap-anywhere font-medium"></p>
            <p id="olymp-status" class="mt-1 text-sm text-base-content/75" role="status"></p>
            <button class="btn btn-outline mt-4" type="submit">${icon('log-out')} Sign out</button>
          </div>
        </fieldset>
      </form>
      <p id="olymp-error" class="rounded-field text-sm text-base-content not-empty:mt-4 not-empty:bg-error/10 not-empty:p-3" role="alert"></p>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button type="submit" tabindex="-1" aria-hidden="true">Close</button>
    </form>
  </dialog>`;
}

function page(title, prefix, body, script = '') {
  return `<!doctype html>
<html lang="en" data-theme="corporate">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(title)}</title>
  <link rel="stylesheet" href="${prefix}site.css">
  <script type="module" src="${prefix}account.mjs"></script>
  ${script}
</head>
<body class="min-h-screen bg-base-200/55 text-base-content antialiased">
  <header class="border-b border-base-300 bg-base-100">
    <nav class="navbar mx-auto min-h-16 max-w-4xl justify-between px-4 sm:px-8" aria-label="Main">
      <a class="inline-flex items-center gap-2 rounded-md text-lg font-semibold tracking-tight" href="${prefix || './'}">
        <span class="grid size-9 place-items-center rounded-lg bg-primary text-primary-content">${icon('waypoints')}</span>
        Vizint
      </a>
      <button id="account-open" class="btn btn-outline btn-sm" type="button" aria-haspopup="dialog" aria-controls="account-dialog" disabled>
        ${icon('user-round')} <span id="account-label">Sign in</span>
      </button>
    </nav>
  </header>
  <main class="mx-auto max-w-4xl px-4 py-8 sm:px-8 sm:py-12">${body}</main>
  ${accountDialog()}
</body>
</html>
`;
}

await rm(output, { recursive: true, force: true });
await mkdir(output);
await import('./olymp.mjs');
await cp(new URL('src/shared/', root), output, { recursive: true });
await writeFile(new URL('catalog.mjs', output),
  `export const app = ${JSON.stringify(app)};\nexport const entries = ${JSON.stringify(graph.eventEntries)};\n`);
await cp(new URL(vendor, root), new URL('schemas/', output), { recursive: true });
await cp(new URL('LICENSE', lucide), new URL('lucide-license.txt', output));
const previews = new Set();
await writeLearningPages({ output, page, entries, graph });

for (const entry of entries) {
  const { slug, activity, title, intro, source, frameHeight, learning, type } = entry;
  const exercises = learning?.exercises ?? [];
  const activeExercise = !entry.customHost && type === 'attempt' ? exercises[0] : undefined;
  const links = graph.byActivity.get(activity);
  const markup = await read(`src/${slug}/activity.html`);
  const bundle = async (filename, format, external = []) => (await build({
    entryPoints: [fileURLToPath(new URL(`src/${slug}/${filename}`, root))],
    bundle: true, format, external, write: false, minify: true, legalComments: 'inline',
  })).outputFiles[0].text;
  const code = entry.customHost ? await bundle('activity.js', 'iife') : (await readActivityScript(entry)).source;
  const styles = await read(`src/${slug}/activity.css`);
  const common = await read('src/frame.css');
  // Activity scripts exist only inside the sandboxed document in the output.
  const frame = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';${entry.media ? ' media-src blob:;' : ''} form-action 'none'; base-uri 'none'">
<title>${escapeHTML(title)}</title><style>${common}\n${styles}</style></head>
<body>${markup}<script>${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  const path = new URL(`${slug}/`, output);
  await mkdir(path);
  const folder = new URL(`src/${slug}/`, root);
  if ((await readdir(folder)).includes('preview.png')) {
    await cp(new URL('preview.png', folder), new URL('preview.png', path));
    previews.add(slug);
  }
  if (entry.assets) await cp(new URL(`src/${slug}/${entry.assets}/`, root), new URL(`${entry.assets}/`, path), { recursive: true });
  if (entry.customHost) await writeFile(new URL('host.mjs', path), await bundle('host.mjs', 'esm', ['../catalog.mjs', '../storage.mjs']));
  await writeFile(new URL('index.html', path), page(`${title} | Vizint`, '../', `
    <div class="flex flex-wrap items-center gap-2">
      <a class="btn btn-ghost btn-sm -ml-2" href="../">${icon('arrow-left')} All activities</a>
      <a class="link link-hover link-primary text-sm" href="../learn/">Find learning material</a>
    </div>
    <h1 class="mt-3 text-3xl leading-tight font-semibold tracking-tight sm:text-5xl">${escapeHTML(title)}</h1>
    <p class="mt-3 max-w-prose leading-relaxed text-base-content/75">${escapeHTML(intro)}</p>
    <template id="activity-template"><iframe class="block w-full rounded-xl border border-base-300 bg-base-100" style="height: ${escapeHTML(frameHeight)}" title="${escapeHTML(title)}" sandbox="allow-scripts" srcdoc="${escapeHTML(frame)}"></iframe></template>
    <div class="mt-6"${activeExercise ? ` id="${exerciseAnchor(activeExercise)}"` : ''}>
      <div id="activity" data-entry="${slug}"></div>
    </div>
    <noscript><p class="alert alert-info">Enable JavaScript to use this activity.</p></noscript>
    <p id="save-status" class="text-sm text-base-content/75 not-empty:mt-3" role="status"></p>
    <button class="btn btn-outline btn-sm mt-2" type="button" id="retry" hidden>${icon('rotate-ccw')} Retry saving</button>
    ${activityLearning(links)}
    ${exercises.map((exercise) => {
      const details = activityLearning(links, exercise);
      if (!details) return '';
      const anchor = exercise === activeExercise ? '' : ` id="${exerciseAnchor(exercise)}"`;
      if (entry.collapseExercises) return `<details${anchor} class="mt-6"><summary>${escapeHTML(exercise.title)}</summary>${details}</details>`;
      return `<section${anchor} class="mt-8">
        <h2 class="text-lg font-semibold">${escapeHTML(exercise.title)}</h2>
        ${details}
      </section>`;
    }).join('')}
    ${source ? `<footer class="mt-5 text-sm text-base-content/75">${escapeHTML(source)}</footer>` : ''}`,  `<script type="module" src="${entry.customHost ? './' : '../'}host.mjs"></script>`));
}

await writeFile(new URL('index.html', output), page('Vizint', '', `
  <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">Explore and practice</h1>
  <a class="btn btn-outline mt-4" href="./learn/">${icon('search')} Find learning material</a>
  <div class="mt-6 grid gap-5 sm:mt-8 sm:grid-cols-2">${entries.map(({ slug, title, intro }) => `
    <article class="card relative rounded-xl border border-base-300 bg-base-100 transition-colors hover:border-primary focus-within:border-primary">
      ${previews.has(slug) ? `<img class="h-auto w-full rounded-t-xl border-b border-base-300 bg-base-200 object-cover" src="./${slug}/preview.png" width="768" height="464" alt="" decoding="async">` : ''}
      <div class="card-body gap-2 p-5">
        <div class="flex items-start justify-between gap-3">
          <h2 class="card-title leading-snug"><a class="after:absolute after:inset-0 after:rounded-xl" href="./${slug}/">${escapeHTML(title)}</a></h2>
          <span class="shrink-0 text-primary">${icon('arrow-right')}</span>
        </div>
        <p class="text-sm leading-relaxed text-base-content/75">${escapeHTML(intro)}</p>
      </div>
    </article>`).join('')}
  </div>`));

console.log(`Built ${entries.length} entries for ${app} with schemas pinned to ${pin.commit}.`);
