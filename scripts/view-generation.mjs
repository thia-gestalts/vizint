import { parseArgs } from 'node:util';
import { Script } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import ts from 'typescript';
import { stringify } from 'yaml';
import { activityFrame } from './activity-frame.mjs';
import { activityProgram } from './activity-program.mjs';
import { escapeHTML } from './learning-pages.mjs';
import { fixtures } from './view-generation-fixtures.mjs';

const activityFiles = { markup: 'activity.html', styles: 'activity.css', code: 'activity.js' };
const fields = ['title', 'intro', ...Object.keys(activityFiles)];
const schema = {
  type: 'object',
  required: fields,
  properties: Object.fromEntries(fields.map(key => [key, { type: 'string' }])),
  additionalProperties: false,
};
const prompt = `Return one JSON object with these string fields: title, intro, markup, styles, code.
Create a small accessible educational activity. markup is an HTML fragment,
styles is plain CSS, and code is plain JavaScript in a classic script.
Use JSDoc comments for types. TypeScript syntax, including parameter and
return type annotations, is invalid. Type DOM lookups precisely for strict
checkJs. Put all interaction in code. The view runs in a sandboxed iframe.
Use no external assets, libraries or network calls. Keep the code concise.`;
const options = { temperature: 0, num_ctx: 4096, num_predict: 3000 };
const endpoint = process.env.VIZINT_OLLAMA_URL ?? 'http://localhost:11434';
const common = await readFile(new URL('../src/frame.css', import.meta.url), 'utf8');

async function ollama(path, body, timeout = 300_000) {
  const response = await fetch(new URL(path, endpoint), {
    ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Ollama ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function generate(model, brief, folder, repair) {
  const messages = [{ role: 'system', content: prompt }, { role: 'user', content: brief }];
  if (repair) messages.push(
    { role: 'assistant', content: repair.output },
    { role: 'user', content: 'Return the complete corrected JSON. Address these diagnostics:\n' + repair.error.slice(0, 1600) },
  );
  const request = {
    model, messages, format: schema, stream: false, think: false,
    options: { ...options, num_ctx: repair ? 8192 : options.num_ctx },
  };
  await writeFile(join(folder, 'request.json'), JSON.stringify(request, null, 2));
  const response = await ollama('/api/chat', request);
  await writeFile(join(folder, 'response.json'), JSON.stringify(response, null, 2));
  return response;
}

function parseDraft(content) {
  const draft = JSON.parse(content);
  if (!draft || typeof draft !== 'object' || Object.keys(draft).length !== schema.required.length ||
      !schema.required.every(key => typeof draft[key] === 'string' && draft[key].trim())) {
    throw new Error('Expected nonempty title, intro, markup, styles and code strings');
  }
  return draft;
}

async function writeDraft(folder, draft) {
  await Promise.all([
    ...Object.entries(activityFiles).map(([key, file]) => writeFile(join(folder, file), draft[key])),
    writeFile(join(folder, 'view.yml'), stringify({
      title: draft.title, intro: draft.intro, type: 'engagement', frameHeight: '32rem',
    })),
  ]);
}

async function checkBrowser(draft, folder, browser, fixture) {
  const context = await browser.newContext({
    viewport: { width: 768, height: 520 },
    reducedMotion: 'reduce', serviceWorkers: 'block', offline: true,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const source = activityFrame({ ...draft, common });
    await page.setContent(`<style>body{margin:0}iframe{display:block;width:100%;height:520px;border:0}</style>
      <iframe sandbox="allow-scripts" srcdoc="${escapeHTML(source)}"></iframe>`);
    try {
      const frame = page.frameLocator('iframe');
      await frame.locator('body').waitFor();
      await page.locator('iframe').screenshot({ path: join(folder, 'preview.png') });
      if (fixture) await fixture.check(frame, page);
    } finally {
      if (errors.length) throw new Error(errors.join('\n'));
    }
  } finally {
    await context.close();
  }
}

async function checkDraft(draft, folder, browser, fixture) {
  const filename = join(folder, 'activity.js');
  const diagnostics = ts.getPreEmitDiagnostics(activityProgram(filename, draft.code));
  const errors = [];
  if (diagnostics.length) {
    errors.push(ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: file => file,
      getCurrentDirectory: () => folder,
      getNewLine: () => '\n',
    }).trim());
  }
  try {
    new Script(draft.code, { filename: 'activity.js' });
    await checkBrowser(draft, folder, browser, fixture);
  } catch (error) {
    errors.push(error.message);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

async function readReference() {
  const folder = new URL('../src/views/bezier/', import.meta.url);
  const draft = { title: 'Bézier explorer', intro: 'Explore repeated interpolation.' };
  for (const [key, file] of Object.entries(activityFiles)) {
    draft[key] = await readFile(new URL(file, folder), 'utf8');
  }
  return draft;
}

async function attempt({ folder, model, brief, fixture, browser, reference, repair }) {
  await mkdir(folder);
  const result = { passed: false };
  const started = performance.now();
  let output;
  try {
    let draft = reference;
    if (!draft) {
      const response = await generate(model, brief, folder, repair);
      output = response.message?.content;
      result.generationSeconds = response.total_duration / 1e9;
      result.outputTokens = response.eval_count;
      const active = await ollama('/api/ps', undefined, 3000).catch(() => null);
      const loaded = active?.models?.find(item => item.name === model || item.name === model + ':latest');
      if (loaded) result.model = { digest: loaded.digest, bytes: loaded.size, vramBytes: loaded.size_vram };
      if (response.done_reason === 'length') throw new Error('Generation hit the output token limit');
      draft = parseDraft(output);
    }
    await writeDraft(folder, draft);
    await checkDraft(draft, folder, browser, fixture);
    result.passed = true;
  } catch (error) {
    result.error = error.cause ? `${error.message}: ${error.cause.message}` : error.message;
  }
  result.seconds = Math.round(performance.now() - started) / 1000;
  await writeFile(join(folder, 'result.json'), JSON.stringify(result, null, 2));
  return { result, output };
}

async function report(folder, rows) {
  await writeFile(join(folder, 'results.json'), JSON.stringify(rows, null, 2));
  const body = rows.map(({ model, name, attempts }) => `<tr><th>${escapeHTML(model)}</th>
    <td>${escapeHTML(name)}</td>
    ${[0, 1].map(index => {
      const run = attempts[index];
      if (!run) return '<td>—</td>';
      const base = run.path;
      const gpu = run.model?.bytes ? ` · ${Math.round(100 * run.model.vramBytes / run.model.bytes)}% of loaded bytes in VRAM` : '';
      return `<td><strong class="${run.passed ? 'pass' : 'fail'}">${run.passed ? 'Pass' : 'Fail'}</strong>
        · ${run.seconds}s${gpu}
        ${run.preview ? `<img src="${base}/preview.png" alt="Activity preview" loading="lazy">` : ''}
        ${run.error ? `<details><summary>Diagnostics</summary><pre>${escapeHTML(run.error)}</pre></details>` : ''}
        <a href="${base}/result.json">Result</a>
        ${run.draft ? ` · <a download href="${base}/activity.html">HTML</a>
          · <a download href="${base}/activity.css">CSS</a> · <a download href="${base}/activity.js">JS</a>
          · <a download href="${base}/view.yml">Manifest</a>` : ''}
        ${run.response ? ` · <a href="${base}/response.json">Response</a>` : ''}</td>`;
    }).join('')}</tr>`).join('');
  await writeFile(join(folder, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' file:">
<title>View generation results</title>
<style>
  body{font:15px system-ui;margin:2rem;color:#182237;background:#f7f8fb}
  table{width:100%;border-collapse:collapse;background:white}
  th,td{text-align:left;vertical-align:top;padding:1rem;border-bottom:1px solid #dbe1eb}
  img{display:block;width:min(100%,320px);margin:.5rem 0;border:1px solid #dbe1eb}
  pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:36rem}
  .pass{color:#086646}.fail{color:#a72e25}
</style>
<h1>View generation results</h1>
<p><a href="results.json">Results JSON</a></p>
<table><thead><tr><th>Model</th><th>Fixture</th><th>First pass</th><th>Repair</th></tr></thead>
<tbody>${body}</tbody></table></html>`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: 'string', multiple: true }, fixture: { type: 'string' },
      brief: { type: 'string' }, control: { type: 'boolean' },
      repair: { type: 'boolean' }, help: { type: 'boolean' },
    },
  });
  const [command] = positionals;
  if (values.help) {
    console.log('Usage: npm run views:local -- eval [--model NAME] [--fixture bezier|spring] [--control] [--repair]\n'
      + '       mise run gen "PROMPT" [--model NAME]\n'
      + '       mise run gen --brief FILE [--model NAME]');
    return;
  }
  const generating = command === 'generate';
  const inline = positionals.slice(1).join(' ').trim();
  const hasPrompt = Boolean(inline);
  const hasBriefFile = Boolean(values.brief);
  if ((!generating && (command !== 'eval' || positionals.length !== 1)) ||
      (generating && (hasPrompt === hasBriefFile || values.fixture || values.control)) ||
      (!generating && values.brief) || (values.fixture && !Object.hasOwn(fixtures, values.fixture))) {
    throw new Error('Invalid arguments. Use --help for usage.');
  }
  const models = values.model ?? (generating ? ['qwen3.5:4b'] : ['qwen3.5:4b', 'qwen3.5:9b']);
  const names = values.fixture ? [values.fixture] : Object.keys(fixtures);
  const reference = values.control ? await readReference() : undefined;
  const brief = values.brief ? await readFile(values.brief, 'utf8') : inline;
  const cases = reference ? [{ model: 'Checked-in view', name: 'bezier', reference }] :
    models.flatMap(model => generating ? [{ model, name: 'custom', brief }] :
      names.map(name => ({ model, name, brief: fixtures[name].brief })));

  const folder = resolve('.view-generation', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8));
  await mkdir(folder, { recursive: true });
  const browser = await chromium.launch(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: 'chrome' });
  const rows = [];
  try {
    for (const [index, entry] of cases.entries()) {
      const row = { model: entry.model, name: entry.name, attempts: [] };
      rows.push(row);
      let repair;
      for (let number = 1; number <= (values.repair ? 2 : 1); number++) {
        const path = `case-${index + 1}-attempt-${number}`;
        const attemptFolder = join(folder, path);
        console.log(`${entry.model} / ${entry.name} / attempt ${number}`);
        const { result, output } = await attempt({
          ...entry, browser, folder: attemptFolder, fixture: fixtures[entry.name], repair,
        });
        const exists = file => readFile(join(attemptFolder, file)).then(() => true, () => false);
        row.attempts.push({
          ...result, path, preview: await exists('preview.png'),
          draft: await exists('view.yml'), response: await exists('response.json'),
        });
        if (result.error) console.log(result.error);
        await report(folder, rows);
        if (result.passed || !output) break;
        repair = { output, error: result.error };
      }
    }
  } finally {
    await browser.close();
  }
  console.log(join(folder, 'index.html'));
  if (rows.some(row => !row.attempts.at(-1).passed)) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
