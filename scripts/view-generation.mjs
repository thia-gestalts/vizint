import { parseArgs } from 'node:util';
import { Script } from 'node:vm';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import ts from 'typescript';
import { parse, stringify } from 'yaml';
import { activityFrame } from './activity-frame.mjs';
import { activityProgram } from './activity-program.mjs';
import { escapeHTML } from './learning-pages.mjs';
import { fixtures } from './view-generation-fixtures.mjs';
import { activityLibraries, bundleActivity, libraryCatalog, libraryNamesInBrief, libraryReferences, libraryVersion, validateLibraries }
  from './activity-libraries.mjs';
import { nextRepair, preferredCandidate, repairBudgetMs, repairCallLimit, regressions } from './view-repair-policy.mjs';

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
const legacyPrompt = `Return one JSON object with these string fields: title, intro, markup, styles, code.
Create a small accessible educational activity. markup is an HTML fragment,
styles is plain CSS, and code is plain JavaScript in a classic script.
Use JSDoc comments for types. TypeScript syntax, including parameter and
return type annotations, is invalid. Type DOM lookups precisely for strict
checkJs. Put all interaction in code. The view runs in a sandboxed iframe.
Use no external assets, libraries or network calls. Keep the code concise.
Example: const slider = document.querySelector('#threshold');
if (slider instanceof HTMLInputElement) slider.addEventListener('input', () => Number(slider.value));`;
const libraryRequestSchema = {
  type: 'object', required: ['libraryRequest'], additionalProperties: false,
  properties: {
    libraryRequest: {
      type: 'object', required: ['package', 'reason'], additionalProperties: false,
      properties: { package: { type: 'string' }, reason: { type: 'string' } },
    },
  },
};
const activitySchema = {
  ...schema, required: [...fields, 'libraries'],
  properties: {
    ...schema.properties,
    libraries: { type: 'array', items: { type: 'string', enum: Object.keys(activityLibraries) } },
  },
};
const prompt = `Create a small accessible educational activity. Return the requested JSON fields.
markup is an HTML fragment, styles is plain CSS, and code is JavaScript with JSDoc for strict checkJs.
Connect each control to an observable change. Use SVG, canvas, or HTML as appropriate.
The activity runs offline in a sandboxed iframe. Use no URLs, external resources, network calls, or package globals.
Declare the packages you import in the libraries array. Use only static imports from declared supported packages.
Use an empty libraries array for plain browser JavaScript. TypeScript syntax is invalid.
When a library reference is supplied, use it and generate the activity.
Honor explicit library requirements. If a required library is unavailable, report it.
If a needed library has no supplied reference, you can return
{"libraryRequest":{"package":"npm package name without version","reason":"why this brief needs it"}}.
Supported packages:
${libraryCatalog()}`;
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

async function generate(model, brief, folder, retry, result, deadline) {
  const legacy = ['repair-code', 'retry-truncated'].includes(retry?.kind);
  const codeOnly = ['repair-code', 'repair-js'].includes(retry?.kind);
  const named = [...new Set([
    ...libraryNamesInBrief(brief),
    ...(retry?.draft?.libraries ?? []),
    ...Object.keys(activityLibraries).filter(name => name === retry?.requestedLibrary),
  ])];
  const reference = legacy ? '' : await libraryReferences(named);
  const system = retry?.kind === 'repair-code'
    ? 'Repair a classic JavaScript activity. Use JSDoc for typing and preserve the teaching behavior. Return JSON with only a code field.'
    : legacy ? legacyPrompt : [prompt, reference].filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: system }, { role: 'user', content: brief }];
  if (retry?.kind === 'generate-with-library') {
    messages.push({ role: 'user', content: `The requested package "${retry.requestedLibrary}" is available.
Use the supplied reference and generate the complete activity. Include the package in libraries.` });
  }
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
  if (retry && ['repair-js', 'repair-activity', 'regenerate'].includes(retry.kind)) {
    const instruction = retry.kind === 'regenerate'
      ? 'Write a fresh compact activity focused on the essential interaction.'
      : codeOnly ? 'Return only the corrected code field. Keep the existing markup and styles.'
        : 'Return the complete corrected activity. Change only what the failure requires.';
    const diagnostics = retry.diagnostics.slice(0, 8).map(item => ({
      ...item, message: item.message.slice(0, 550),
    }));
    const draft = retry.kind === 'regenerate' ? null : codeOnly
      ? { markup: retry.draft.markup, code: retry.draft.code } : retry.draft;
    messages.push({ role: 'user', content: [
      instruction,
      'Fix the first reported failure and preserve working behavior. Use the offline runtime contract above.',
      JSON.stringify(diagnostics),
      draft ? JSON.stringify(draft) : '',
    ].filter(Boolean).join('\n') });
  }
  const draftFormat = codeOnly ? codeSchema : legacy ? schema : activitySchema;
  const allowLibraryRequest = !legacy && retry?.kind !== 'generate-with-library';
  const request = {
    model, messages,
    format: allowLibraryRequest ? { anyOf: [draftFormat, libraryRequestSchema] } : draftFormat,
    stream: false, think: retry?.think ?? false,
    options: retry ? { ...options, num_ctx: 8192, num_predict: 4500 } : options,
  };
  result.options = request.options;
  await writeFile(join(folder, 'request.json'), JSON.stringify(request, null, 2));
  result.think = request.think;
  const response = await ollama('/api/chat', request, remaining(deadline)).catch(error => {
    if (Number.isFinite(deadline) && error.name === 'TimeoutError') {
      throw Object.assign(new Error('Repair time budget expired'), { code: 'REPAIR_DEADLINE' });
    }
    throw error;
  });
  await writeFile(join(folder, 'response.json'), JSON.stringify(response, null, 2));
  return response;
}

function parseDraft(draft, expected = fields) {
  const allowed = expected === fields ? [...expected, 'libraries'] : expected;
  if (!draft || typeof draft !== 'object' || Object.keys(draft).some(key => !allowed.includes(key)) ||
      !expected.every(key => typeof draft[key] === 'string' && draft[key].trim())) {
    throw new Error('Expected nonempty strings for ' + expected.join(', '));
  }
  if (expected === fields && Object.hasOwn(draft, 'libraries')) validateLibraries(draft.libraries);
  return draft;
}

function parseLibraryRequest(value) {
  const request = value?.libraryRequest;
  const spec = typeof request?.package === 'string' &&
    request.package.trim().match(/^((?:@[a-z0-9_.-]+\/)?[a-z0-9_][a-z0-9_.-]*)(?:@([a-z0-9][a-z0-9.+-]*))?$/i);
  if (!spec || Object.keys(value).length !== 1 || Object.keys(request).length !== 2 ||
      typeof request.reason !== 'string' || !request.reason.trim()) {
    throw new Error('Expected a library request with an npm package name and a reason');
  }
  const [, name, version] = spec;
  const installed = libraryVersion(name);
  return { package: name, reason: request.reason, available: Boolean(installed && (!version || version === installed)),
    ...(version && { requestedVersion: version }), ...(installed && { installedVersion: installed }) };
}

async function writeDraft(folder, draft) {
  await Promise.all([
    ...Object.entries(activityFiles).map(([key, file]) => writeFile(join(folder, file), draft[key])),
    writeFile(join(folder, 'view.yml'), stringify({
      title: draft.title, intro: draft.intro, type: 'engagement', frameHeight: '32rem',
      ...(draft.libraries?.length && { libraries: draft.libraries }),
    })),
  ]);
}

function remaining(deadline, limit = 300_000) {
  const milliseconds = Math.floor(deadline - performance.now());
  if (milliseconds <= 0) throw new Error('Repair time budget expired');
  return Math.min(limit, milliseconds);
}

async function checkBrowser(draft, folder, browser, fixture, checks, diagnostics, deadline) {
  const context = await browser.newContext({
    viewport: { width: 768, height: 520 },
    reducedMotion: 'reduce', serviceWorkers: 'block', offline: true,
  });
  let timer;
  try {
    if (Number.isFinite(deadline)) {
      timer = setTimeout(() => void context.close().catch(() => {}), remaining(deadline));
    }
    const page = await context.newPage();
    page.setDefaultTimeout(remaining(deadline, 3000));
    const errors = new Set();
    page.on('pageerror', error => errors.add(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.add(message.text());
    });
    const source = activityFrame({ ...draft, common });
    const frame = page.frameLocator('iframe');
    try {
      await page.setContent(`<style>body{margin:0}iframe{display:block;width:100%;height:520px;border:0}</style>
        <iframe sandbox="allow-scripts" srcdoc="${escapeHTML(source)}"></iframe>`);
      await frame.locator('body').waitFor();
      await page.locator('iframe').screenshot({ path: join(folder, 'preview.png') });
      if (errors.size) throw new Error([...errors].join('\n'));
      checks.startup = 'pass';
    } catch (error) {
      checks.startup = 'fail';
      diagnostics.push({ stage: 'startup', message: error.message });
      return;
    }
    if (fixture) {
      try {
        await fixture.check(frame, page);
        if (errors.size) throw new Error([...errors].join('\n'));
        checks.fixture = 'pass';
      } catch (error) {
        checks.fixture = 'fail';
        diagnostics.push({ stage: 'fixture', message: error.message });
      }
    }
  } finally {
    clearTimeout(timer);
    await context.close();
  }
}

async function checkDraft(draft, folder, browser, fixture, checks, diagnostics, deadline) {
  const filename = join(folder, 'activity.js');
  const types = ts.getPreEmitDiagnostics(activityProgram(filename, draft.code, draft.libraries))
    .filter(item => item.category === ts.DiagnosticCategory.Error);
  checks.typeErrors = types.length;
  checks.type = types.length ? 'fail' : 'pass';
  checks.typeCodes = [...new Set(types.map(item => item.code))].sort((a, b) => a - b);
  const format = {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => folder,
    getNewLine: () => '\n',
  };
  let code = draft.code;
  if (draft.libraries?.length) {
    try {
      code = await bundleActivity({ filename, source: code, libraries: draft.libraries });
      checks.bundle = 'pass';
    } catch (error) {
      checks.bundle = 'fail';
      diagnostics.push({ stage: 'bundle', message: error.message });
    }
  }
  try {
    if (checks.bundle !== 'fail') new Script(code, { filename: 'activity.js' });
    if (checks.bundle !== 'fail') checks.syntax = 'pass';
  } catch (error) {
    checks.syntax = 'fail';
    const location = error.stack.split('\n').slice(0, 3).join('\n');
    if (!draft.libraries?.length && /Cannot use import statement outside a module/i.test(error.message)) {
      diagnostics.push({ stage: 'bundle', message: 'Static imports require declaring the imported package in libraries.', location });
    } else {
      diagnostics.push({ stage: 'syntax', message: error.message, location });
    }
  }
  if (checks.syntax === 'pass') {
    await checkBrowser({ ...draft, code }, folder, browser, fixture, checks, diagnostics, deadline);
    checks.browser = checks.startup === 'pass' && checks.fixture !== 'fail' ? 'pass' : 'fail';
  }
  for (const code of checks.typeCodes) {
    const group = types.filter(item => item.code === code);
    diagnostics.push({
      stage: 'type', code, count: group.length,
      message: ts.formatDiagnostics(group.slice(0, 2), format).trim(),
    });
  }
  // The baseline policy still receives the original diagnostic ordering and scope.
  return [
    ts.formatDiagnostics(types, format).trim(),
    ...diagnostics.filter(item => item.stage !== 'type').map(item => item.message),
  ].filter(Boolean).join('\n');
}

async function readReference() {
  const folder = new URL('../src/views/bezier/', import.meta.url);
  const draft = { title: 'Bézier explorer', intro: 'Explore repeated interpolation.' };
  for (const [key, file] of Object.entries(activityFiles)) {
    draft[key] = await readFile(new URL(file, folder), 'utf8');
  }
  return draft;
}

async function attempt({ folder, model, brief, fixture, browser, reference, seed, retry,
  modelDigest, deadline = Infinity }) {
  await mkdir(folder);
  const result = {
    passed: false,
    strategy: seed ? 'replay-source' : reference ? 'control' : retry?.kind ?? 'generate',
    diagnostics: [],
    checks: { response: 'skipped', type: 'skipped', syntax: 'skipped', browser: 'skipped',
      startup: 'skipped', bundle: 'skipped', fixture: fixture ? 'skipped' : 'unverified' },
  };
  const started = performance.now();
  let draft = reference ?? seed?.draft;
  let stage = 'request';
  try {
    if (seed?.libraryRequest) {
      stage = 'library-request';
      result.libraryRequest = seed.libraryRequest;
      result.checks.response = 'pass';
      throw new Error(`Saved model requested ${seed.libraryRequest.package}: ${seed.libraryRequest.reason}`);
    }
    if (seed && !draft) {
      stage = 'truncated';
      result.checks.response = 'fail';
      throw new Error('Saved generation hit the output token limit');
    }
    if (!draft) {
      result.requestedModel = model;
      if (modelDigest) result.model = { digest: modelDigest };
      const response = await generate(model, brief, folder, retry, result, deadline);
      result.generationSeconds = response.total_duration / 1e9;
      result.loadSeconds = response.load_duration / 1e9;
      result.outputTokens = response.eval_count;
      result.promptTokens = response.prompt_eval_count;
      result.doneReason = response.done_reason;
      const active = await ollama('/api/ps', undefined, remaining(deadline, 1000)).catch(() => null);
      const loaded = active?.models?.find(item => item.name === model || item.name === model + ':latest');
      if (loaded) result.model = {
        digest: loaded.digest, bytes: loaded.size, vramBytes: loaded.size_vram, contextLength: loaded.context_length,
      };
      if (response.done_reason === 'length') {
        stage = 'truncated';
        throw new Error('Generation hit the output token limit');
      }
      stage = 'response';
      const output = JSON.parse(response.message?.content);
      if (output && Object.hasOwn(output, 'libraryRequest')) {
        result.libraryRequest = parseLibraryRequest(output);
        result.checks.response = 'pass';
        stage = 'library-request';
        const { package: name, requestedVersion, reason, available } = result.libraryRequest;
        const spec = requestedVersion ? `${name}@${requestedVersion}` : name;
        throw new Error(`Model requested ${spec} (${available ? 'available' : 'unavailable'}): ${reason}`);
      }
      draft = ['repair-code', 'repair-js'].includes(retry?.kind)
        ? { ...retry.draft, ...parseDraft(output, ['code']) }
        : parseDraft(output);
      result.checks.response = 'pass';
    } else if (seed) {
      result.checks.response = 'pass';
    }
    result.libraries = draft.libraries ?? [];
    stage = 'artifacts';
    await writeDraft(folder, draft);
    stage = 'validation';
    const error = await checkDraft(draft, folder, browser, fixture, result.checks, result.diagnostics, deadline);
    remaining(deadline);
    if (error) {
      result.failure = stage;
      result.error = error;
    } else {
      result.passed = true;
    }
  } catch (error) {
    result.failure = error.code === 'REPAIR_DEADLINE' || performance.now() >= deadline - 1 ? 'deadline'
      : stage === 'validation' ? 'infrastructure' : stage;
    result.error = error.cause ? `${error.message}: ${error.cause.message}` : error.message;
    result.diagnostics.push({ stage: result.failure, message: result.error });
    if (['response', 'truncated'].includes(stage)) result.checks.response = 'fail';
  }
  result.seconds = (performance.now() - started) / 1000;
  await writeFile(join(folder, 'result.json'), JSON.stringify(result, null, 2));
  return { result, draft };
}

async function saveResults(folder, rows) {
  const temporary = join(folder, 'results.json.tmp');
  await writeFile(temporary, JSON.stringify(rows, null, 2));
  await rename(temporary, join(folder, 'results.json'));
}

function installedDigest(tags, model) {
  return tags.find(item => item.name === model || item.name === model + ':latest')?.digest;
}

async function readReplay(ids, tags) {
  const pairs = [];
  const skipped = [];
  for (const id of new Set(ids)) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}$/.test(id)) {
      throw new Error(`Invalid run ID: ${id}`);
    }
    const folder = resolve('.view-generation', id);
    const skip = (reason, attempt) => skipped.push({ runId: id, attempt, reason });
    try {
      if (!(await lstat(folder)).isDirectory()) throw new Error('Expected a run directory');
      const settings = JSON.parse(await readFile(join(folder, 'run.json'), 'utf8'));
      const rows = JSON.parse(await readFile(join(folder, 'results.json'), 'utf8'));
      if (!rows.length) skip('No recorded cases');
      for (const row of rows) {
        const first = row.attempts[0];
        const path = first?.path;
        if (row.model === 'Checked-in view' || first?.strategy === 'control') {
          skip('Checked-in control', path);
          continue;
        }
        if (!/^case-[1-9]\d*-attempt-1$/.test(path ?? '')) {
          skip('Missing first attempt', path);
          continue;
        }
        if (first.passed) {
          skip('First attempt already passed', path);
          continue;
        }
        try {
          if (!(await lstat(join(folder, path))).isDirectory()) throw new Error('Expected an attempt directory');
          const read = async name => {
            const file = join(folder, path, name);
            if (!(await lstat(file)).isFile()) throw new Error(`Expected a regular ${name} artifact`);
            return readFile(file, 'utf8');
          };
          const request = JSON.parse(await read('request.json'));
          const planned = settings.cases?.find(item => item.model === row.model && item.fixture === row.name);
          const brief = request.messages?.find(message => message.role === 'user')?.content ?? planned?.brief;
          if (request.model !== row.model) throw new Error('Saved request model differs from the case model');
          if (typeof brief !== 'string' || !brief.trim()) throw new Error('Missing original brief');
          if (row.name !== 'custom' && fixtures[row.name]?.brief !== brief) {
            throw new Error('Saved brief does not match the current fixture');
          }
          const digest = installedDigest(tags, row.model);
          if (!digest) throw new Error(`Model is not installed: ${row.model}`);
          if (first.model?.digest && first.model.digest !== digest) throw new Error('Installed model digest differs');
          const response = JSON.parse(await read('response.json'));
          const seed = {};
          if (first.failure === 'library-request') {
            seed.libraryRequest = parseLibraryRequest(JSON.parse(response.message.content));
          } else if (response.done_reason !== 'length' && first.failure !== 'truncated') {
            const { title, intro, libraries } = parse(await read('view.yml'));
            const draft = { title, intro, ...(libraries !== undefined && { libraries }) };
            for (const [key, file] of Object.entries(activityFiles)) draft[key] = await read(file);
            seed.draft = parseDraft(draft);
          }
          pairs.push({
            pairId: String(pairs.length + 1), model: row.model, name: row.name, brief,
            source: { runId: id, attempt: path, digest: first.model?.digest ?? null },
            seed, order: randomInt(2) ? ['once', 'loop'] : ['loop', 'once'],
          });
        } catch (error) {
          skip(error.message, path);
        }
      }
    } catch (error) {
      skip(error.message);
    }
  }
  return { pairs, skipped };
}

async function runCase({ entry, row, folder, browser, tags, rows, escalationModel, shared }) {
  const fixture = fixtures[entry.name];
  const index = rows.indexOf(row) + 1;
  async function record({ retry, deadline, model = entry.model } = {}) {
    const path = `case-${index}-attempt-${row.attempts.length + 1}`;
    const attemptFolder = join(folder, path);
    console.log(`${model} / ${entry.name} / ${row.policy} / attempt ${row.attempts.length + 1}`);
    const value = await attempt({
      brief: entry.brief, reference: entry.reference,
      browser, fixture, folder: attemptFolder, retry, deadline, model,
      modelDigest: installedDigest(tags, model),
    });
    const exists = file => lstat(join(attemptFolder, file)).then(() => true, () => false);
    row.attempts.push({
      ...value.result, path, preview: await exists('preview.png'), draft: await exists('view.yml'),
      request: await exists('request.json'), response: await exists('response.json'),
    });
    if (value.result.error) console.log(value.result.error);
    return value;
  }

  let latest = shared ?? await record();
  if (shared) row.attempts.push({ ...shared.result, path: shared.path });
  let best = latest;
  row.selectedAttempt = latest.draft ? row.attempts.at(-1).path : null;
  await saveResults(folder, rows);
  const started = performance.now();
  const deadline = started + repairBudgetMs;
  let calls = 0;
  let escalated = false;
  let retry;
  let previous;
  while (calls < repairCallLimit && performance.now() < deadline &&
    (retry = nextRepair(row.policy, best.result, latest.result, calls, escalated, previous))) {
    if (retry.think) escalated = true;
    const model = retry.think && escalationModel ? escalationModel : entry.model;
    previous = latest.result;
    latest = await record({
      retry: { ...retry, ...best, diagnostics: best.result.diagnostics, error: best.result.error,
        requestedLibrary: latest.result.libraryRequest?.package },
      deadline, model,
    });
    calls++;
    const lostChecks = latest.draft ? regressions(best.result, latest.result) : [];
    row.attempts.at(-1).regressions = lostChecks;
    latest.result.elapsedSeconds = row.attempts.at(-1).elapsedSeconds = (performance.now() - started) / 1000;
    if (latest.draft && latest.result.failure !== 'deadline' && preferredCandidate(best.result, latest.result)) {
      best = latest;
      row.selectedAttempt = row.attempts.at(-1).path;
    }
    await saveResults(folder, rows);
  }
  row.elapsedSeconds = (performance.now() - started) / 1000;
  row.passed = best.result.passed;
  row.stopReason = row.passed ? 'passed'
    : latest.result.libraryRequest ? latest.result.libraryRequest.available ? 'library-request' : 'unsupported-dependency'
    : latest.result.failure === 'deadline' || performance.now() >= deadline ? 'deadline'
      : ['request', 'artifacts', 'infrastructure'].includes(latest.result.failure) ? 'infrastructure-error'
        : calls >= repairCallLimit ? 'call-limit'
          : escalated ? 'stalled-after-escalation' : 'no-further-repair';
  row.finished = true;
  await saveResults(folder, rows);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      model: { type: 'string', multiple: true }, fixture: { type: 'string' },
      brief: { type: 'string' }, control: { type: 'boolean' }, repair: { type: 'boolean' },
      'repair-policy': { type: 'string' }, 'escalation-model': { type: 'string' }, help: { type: 'boolean' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help) {
    console.log(`Usage: mise run views:eval -- [--model NAME] [--fixture ${Object.keys(fixtures).join('|')}] [--control]
       mise run gen -- "PROMPT" [--model NAME]
       mise run gen -- --brief FILE
       mise run views:replay -- RUN_ID...
Generation and eval accept --repair-policy none|once|loop. --repair and --no-repair are aliases for once and none.
The loop and replay accept --escalation-model NAME.`);
    return;
  }
  const generating = command === 'generate';
  const replay = command === 'replay';
  const inline = args.join(' ').trim();
  const policy = values['repair-policy'] ?? (values.repair === undefined
    ? (generating ? 'loop' : 'none') : values.repair ? 'once' : 'none');
  const escalationModel = values['escalation-model'];
  if (!['none', 'once', 'loop'].includes(policy) ||
      (values['repair-policy'] !== undefined && values.repair !== undefined) ||
      (!replay && escalationModel !== undefined && (policy !== 'loop' || !escalationModel.trim())) ||
      (replay && (!args.length || values.model || values.fixture || values.control || values.brief ||
        values['repair-policy'] !== undefined || values.repair !== undefined || escalationModel?.trim() === '')) ||
      (!generating && !replay && (command !== 'eval' || args.length)) ||
      (generating && (Boolean(inline) === Boolean(values.brief) || values.fixture || values.control)) ||
      (!generating && values.brief) || (values.fixture && !Object.hasOwn(fixtures, values.fixture))) {
    throw new Error('Invalid arguments. Use --help for usage.');
  }
  const models = values.model ?? (generating ? ['qwen3.5:4b'] : ['qwen3.5:4b', 'qwen3.5:9b']);
  const names = values.fixture ? [values.fixture] : Object.keys(fixtures);
  const reference = values.control ? await readReference() : undefined;
  const brief = values.brief ? await readFile(values.brief, 'utf8') : inline;
  const runtime = reference ? null : await ollama('/api/version', undefined, 3000).catch(() => null);
  const tags = reference ? [] : (await ollama('/api/tags', undefined, 3000)
    .catch(error => { if (replay || escalationModel) throw error; return null; }))?.models ?? [];
  if (escalationModel && !installedDigest(tags, escalationModel)) {
    throw new Error(`Escalation model is not installed: ${escalationModel}`);
  }
  const { pairs, skipped } = replay ? await readReplay(args, tags) : { pairs: [], skipped: [] };
  const cases = replay ? pairs : reference ? [{ model: 'Checked-in view', name: 'bezier', reference }] :
    models.flatMap(model => generating ? [{ model, name: 'custom', brief }] :
      names.map(name => ({ model, name, brief: fixtures[name].brief })));

  const folder = resolve('.view-generation', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8));
  await mkdir(folder, { recursive: true });
  const sources = await Promise.all([
    import.meta.url, new URL('./view-repair-policy.mjs', import.meta.url),
    new URL('./activity-libraries.mjs', import.meta.url), new URL('../package-lock.json', import.meta.url),
    ...Object.keys(activityLibraries).map(name => new URL(`./activity-library-examples/${name}.js`, import.meta.url)),
    new URL('./view-generation-fixtures.mjs', import.meta.url),
    new URL('./activity-frame.mjs', import.meta.url), new URL('./activity-program.mjs', import.meta.url),
  ].map(url => readFile(new URL(url))));
  const fingerprint = createHash('sha256');
  for (const source of sources) fingerprint.update(source).update('\0');
  const runnerHash = fingerprint.update(common).digest('hex');
  const checks = createHash('sha256');
  for (const source of sources.slice(2)) checks.update(source).update('\0');
  const checkHash = checks.update(common).update(checkDraft.toString()).update(checkBrowser.toString()).digest('hex');
  const commit = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain']);
  const metadata = {
    command, retryEnabled: replay || policy !== 'none', repairPolicy: replay ? undefined : policy,
    escalationModel, runnerHash, checkHash,
    git: { commit, dirty: status === null ? null : Boolean(status) },
    node: process.version, typescript: ts.version, ollama: runtime?.version,
    cases: cases.map(({ model, name, brief, pairId, source, order }) =>
      ({ model, fixture: name, brief, pairId, source, order })),
    ...(replay && { skipped, sourceRunIds: [...new Set(args)] }),
  };
  await writeFile(join(folder, 'run.json'), JSON.stringify(metadata, null, 2));
  const rows = [];
  await saveResults(folder, rows);
  const runId = basename(folder);
  console.log(`Run ${runId}: http://127.0.0.1:8765/runs/${runId} (mise run views:admin)`);
  if (!cases.length) {
    process.exitCode = 1;
    return;
  }
  const browser = await chromium.launch(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: 'chrome' });
  try {
    metadata.browser = browser.version();
    await writeFile(join(folder, 'run.json'), JSON.stringify(metadata, null, 2));
    for (const entry of cases) {
      if (!replay) {
        const row = { model: entry.model, name: entry.name, policy: entry.reference ? 'none' : policy,
          attempts: [], finished: false };
        rows.push(row);
        await runCase({ entry, row, folder, browser, tags, rows, escalationModel });
        continue;
      }
      const path = `case-${rows.length + 1}-attempt-1`;
      const shared = await attempt({ ...entry, folder: join(folder, path), browser, fixture: fixtures[entry.name] });
      shared.path = path;
      for (const [index, arm] of entry.order.entries()) {
        const row = { model: entry.model, name: entry.name, pairId: entry.pairId,
          source: entry.source, order: index + 1, policy: arm, attempts: [], finished: false };
        rows.push(row);
        await runCase({ entry, row, folder, browser, tags, rows, escalationModel, shared });
      }
    }
  } finally {
    await browser.close();
  }
  if (replay ? rows.some(row => row.stopReason === 'infrastructure-error') : rows.some(row => !row.passed)) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
