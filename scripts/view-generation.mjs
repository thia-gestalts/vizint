import { parseArgs } from 'node:util';
import { Script } from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
const codeSchema = {
  type: 'object', required: ['code'], properties: { code: { type: 'string' } },
  additionalProperties: false,
};
const prompt = `Return one JSON object with these string fields: title, intro, markup, styles, code.
Create a small accessible educational activity. markup is an HTML fragment,
styles is plain CSS, and code is plain JavaScript in a classic script.
Use JSDoc comments for types. TypeScript syntax, including parameter and
return type annotations, is invalid. Type DOM lookups precisely for strict
checkJs. Put all interaction in code. The view runs in a sandboxed iframe.
Use no external assets, libraries or network calls. Keep the code concise.
Example: const slider = document.querySelector('#threshold');
if (slider instanceof HTMLInputElement) slider.addEventListener('input', () => Number(slider.value));`;
const options = { temperature: 0, num_ctx: 4096, num_predict: 3000 };
const endpoint = process.env.VIZINT_OLLAMA_URL ?? 'http://localhost:11434';
const common = await readFile(new URL('../src/frame.css', import.meta.url), 'utf8');

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: new URL('../', import.meta.url), encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

async function ollama(path, body, timeout = 300_000) {
  const response = await fetch(new URL(path, endpoint), {
    ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Ollama ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function generate(model, brief, folder, retry, result) {
  const system = retry?.kind === 'repair-code'
    ? 'Repair a classic JavaScript activity. Use JSDoc for typing and preserve the teaching behavior. Return JSON with only a code field.'
    : prompt;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: brief }];
  if (retry?.kind === 'repair-code') messages.push(
    { role: 'user', content: `Repair the JavaScript below. Return only a JSON object with the field "code".
Keep the existing HTML, CSS, and element IDs. For example:
const slider = document.querySelector('#threshold');
if (!(slider instanceof HTMLInputElement)) throw new Error('Missing threshold input');
For canvas, also check the result of getContext('2d'). Never use TypeScript casts.

HTML:\n${retry.draft.markup}\n
JavaScript:\n${retry.draft.code}\n
Diagnostics:\n${retry.error.slice(0, 3000)}` },
  );
  if (retry?.kind === 'retry-truncated') messages.push({
    role: 'user', content: 'Keep the complete activity compact. Focus on one plot and the essential controls.',
  });
  const request = {
    model, messages, format: retry?.kind === 'repair-code' ? codeSchema : schema, stream: false, think: false,
    options: retry ? { ...options, num_ctx: 8192, num_predict: 4500 } : options,
  };
  result.options = request.options;
  await writeFile(join(folder, 'request.json'), JSON.stringify(request, null, 2));
  const response = await ollama('/api/chat', request);
  await writeFile(join(folder, 'response.json'), JSON.stringify(response, null, 2));
  return response;
}

function parseDraft(content, expected = fields) {
  const draft = JSON.parse(content);
  if (!draft || typeof draft !== 'object' || Object.keys(draft).length !== expected.length ||
      !expected.every(key => typeof draft[key] === 'string' && draft[key].trim())) {
    throw new Error('Expected nonempty strings for ' + expected.join(', '));
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

async function checkDraft(draft, folder, browser, fixture, checks) {
  const filename = join(folder, 'activity.js');
  const diagnostics = ts.getPreEmitDiagnostics(activityProgram(filename, draft.code));
  checks.typeErrors = diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error).length;
  checks.typeCodes = [...new Set(diagnostics.map(item => item.code))].sort((a, b) => a - b);
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
    checks.syntax = 'pass';
  } catch (error) {
    checks.syntax = 'fail';
    errors.push(error.message);
  }
  if (checks.syntax === 'pass') {
    try {
      await checkBrowser(draft, folder, browser, fixture);
      checks.browser = 'pass';
    } catch (error) {
      checks.browser = 'fail';
      errors.push(error.message);
    }
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

async function attempt({ folder, model, brief, fixture, browser, reference, retry }) {
  await mkdir(folder);
  const result = { passed: false, strategy: reference ? 'control' : retry?.kind ?? 'generate' };
  const started = performance.now();
  let draft = reference;
  let stage = 'request';
  try {
    if (!draft) {
      const response = await generate(model, brief, folder, retry, result);
      result.generationSeconds = response.total_duration / 1e9;
      result.outputTokens = response.eval_count;
      result.promptTokens = response.prompt_eval_count;
      result.doneReason = response.done_reason;
      const active = await ollama('/api/ps', undefined, 3000).catch(() => null);
      const loaded = active?.models?.find(item => item.name === model || item.name === model + ':latest');
      if (loaded) result.model = { digest: loaded.digest, bytes: loaded.size, vramBytes: loaded.size_vram };
      if (response.done_reason === 'length') {
        stage = 'truncated';
        throw new Error('Generation hit the output token limit');
      }
      stage = 'response';
      const output = response.message?.content;
      draft = retry?.kind === 'repair-code'
        ? { ...retry.draft, ...parseDraft(output, ['code']) }
        : parseDraft(output);
    }
    stage = 'artifacts';
    await writeDraft(folder, draft);
    stage = 'validation';
    result.checks = { syntax: 'skipped', browser: 'skipped' };
    await checkDraft(draft, folder, browser, fixture, result.checks);
    result.passed = true;
  } catch (error) {
    result.failure = stage;
    result.error = error.cause ? `${error.message}: ${error.cause.message}` : error.message;
  }
  result.seconds = Math.round(performance.now() - started) / 1000;
  await writeFile(join(folder, 'result.json'), JSON.stringify(result, null, 2));
  return { result, draft };
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
        <div>${run.strategy}${run.failure ? ` · ${run.failure}` : ''}</div>
        ${run.options ? `<div>${run.outputTokens ?? '—'}/${run.options.num_predict} output tokens · ${run.options.num_ctx} context</div>` : ''}
        ${run.checks ? `<div>Syntax ${run.checks.syntax} · Browser ${run.checks.browser} · ${run.checks.typeErrors ?? '—'} type errors</div>` : ''}
        ${run.preview ? `<img src="${base}/preview.png" alt="Activity preview" loading="lazy">` : ''}
        ${run.error ? `<details><summary>Diagnostics</summary><pre>${escapeHTML(run.error)}</pre></details>` : ''}
        <a href="${base}/result.json">Result</a>
        ${run.draft ? ` · <a download href="${base}/activity.html">HTML</a>
          · <a download href="${base}/activity.css">CSS</a> · <a download href="${base}/activity.js">JS</a>
          · <a download href="${base}/view.yml">Manifest</a>` : ''}
        ${run.request ? ` · <a href="${base}/request.json">Request</a>` : ''}
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
<p><a href="results.json">Results JSON</a> · <a href="run.json">Run settings</a></p>
<table><thead><tr><th>Model</th><th>Fixture</th><th>First pass</th><th>Retry</th></tr></thead>
<tbody>${body}</tbody></table></html>`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      model: { type: 'string', multiple: true }, fixture: { type: 'string' },
      brief: { type: 'string' }, control: { type: 'boolean' },
      repair: { type: 'boolean' }, help: { type: 'boolean' },
    },
  });
  const [command] = positionals;
  if (values.help) {
    console.log(`Usage: npm run views:local -- eval [--model NAME] [--fixture ${Object.keys(fixtures).join('|')}] [--control] [--repair]\n`
      + '       mise run gen "PROMPT" [--model NAME] [--no-repair]\n'
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
  const retryEnabled = values.repair ?? generating;
  const sources = await Promise.all([
    import.meta.url, new URL('./view-generation-fixtures.mjs', import.meta.url),
    new URL('./activity-frame.mjs', import.meta.url), new URL('./activity-program.mjs', import.meta.url),
  ].map(url => readFile(new URL(url))));
  const fingerprint = createHash('sha256');
  for (const source of sources) fingerprint.update(source).update('\0');
  fingerprint.update(common);
  const runtime = reference ? null : await ollama('/api/version', undefined, 3000).catch(() => null);
  const commit = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain']);
  const metadata = {
    command, retryEnabled, runnerHash: fingerprint.digest('hex'),
    git: { commit, dirty: status === null ? null : Boolean(status) },
    node: process.version, typescript: ts.version, ollama: runtime?.version,
    cases: cases.map(({ model, name, brief }) => ({ model, fixture: name, brief })),
  };
  await writeFile(join(folder, 'run.json'), JSON.stringify(metadata, null, 2));
  const browser = await chromium.launch(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: 'chrome' });
  const rows = [];
  try {
    await writeFile(join(folder, 'run.json'), JSON.stringify({ ...metadata, browser: browser.version() }, null, 2));
    for (const [index, entry] of cases.entries()) {
      const row = { model: entry.model, name: entry.name, attempts: [] };
      rows.push(row);
      let retry;
      for (let number = 1; number <= (retryEnabled ? 2 : 1); number++) {
        const path = `case-${index + 1}-attempt-${number}`;
        const attemptFolder = join(folder, path);
        console.log(`${entry.model} / ${entry.name} / attempt ${number}`);
        const { result, draft } = await attempt({
          ...entry, browser, folder: attemptFolder, fixture: fixtures[entry.name], retry,
        });
        const exists = file => readFile(join(attemptFolder, file)).then(() => true, () => false);
        row.attempts.push({
          ...result, path, preview: await exists('preview.png'),
          draft: await exists('view.yml'), request: await exists('request.json'), response: await exists('response.json'),
        });
        if (result.error) console.log(result.error);
        await report(folder, rows);
        if (entry.reference) break;
        if (result.failure === 'truncated') retry = { kind: 'retry-truncated' };
        else if (result.failure === 'validation') retry = { kind: 'repair-code', draft, error: result.error };
        else break;
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
