import { parseArgs } from 'node:util';
import { Script } from 'node:vm';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import ts from 'typescript';
import { stringify } from 'yaml';
import { entries } from '../src/catalog.mjs';
import { fixActivity } from './activity-codemod.mjs';
import { activityFrame } from './activity-frame.mjs';
import { activityProgram } from './activity-program.mjs';
import { readActivityScript } from './activity-script.mjs';
import { escapeHTML } from './learning-pages.mjs';
import { fixtures } from './view-generation-fixtures.mjs';
import { exampleModes, selectExample } from './view-examples.mjs';
import { activityLibraries, bundleActivity, libraryCatalog, libraryNamesInBrief, libraryReferences, libraryVersion, normalizeLibraryNames, validateLibraries }
  from './activity-libraries.mjs';
import { accepted, nextRepair, preferredCandidate, regressions, repairBudgetMs, repairCallLimit, repairPolicies, tierOf, tiers }
  from './view-repair-policy.mjs';

const activityFiles = { markup: 'activity.html', styles: 'activity.css', code: 'activity.js' };
export const formats = ['fenced', 'json'];
export const checkedIn = 'checked-in';
export const limits = { arms: 4, samples: 5, hypothesis: 500, brief: 4000, label: 40, origin: 60, temperature: 1.5 };
export const armDefaults = { examples: 'none', samples: 3, temperature: 0.7, repair: 'none', format: 'fenced' };
const baseOptions = { num_ctx: 8192, num_predict: 4096 };
const endpoint = process.env.VIZINT_OLLAMA_URL ?? 'http://localhost:11434';
const common = await readFile(new URL('../src/frame.css', import.meta.url), 'utf8');
const runIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}$/;

const activitySchema = {
  type: 'object', required: ['title', 'intro', 'markup', 'styles', 'code', 'libraries'], additionalProperties: false,
  properties: {
    ...Object.fromEntries(['title', 'intro', 'markup', 'styles', 'code'].map(key => [key, { type: 'string' }])),
    libraries: { type: 'array', items: { type: 'string', enum: Object.keys(activityLibraries) } },
  },
};
const libraryRequestSchema = {
  type: 'object', required: ['libraryRequest'], additionalProperties: false,
  properties: {
    libraryRequest: {
      type: 'object', required: ['package', 'reason'], additionalProperties: false,
      properties: { package: { type: 'string' }, reason: { type: 'string' } },
    },
  },
};
const libraryRequestExample = '{"libraryRequest":{"package":"npm package name without version","reason":"why this brief needs it"}}';

export function describe() {
  return {
    fixtures: Object.entries(fixtures).map(([name, fixture]) => ({ name, view: fixture.view ?? null, brief: fixture.brief })),
    exampleModes, repairPolicies, formats, tiers, limits, armDefaults, checkedIn,
  };
}

/** Validate and normalize a run spec. Arm ids are assigned by position. */
export function validateSpec(input) {
  const fail = message => { throw new Error(`Invalid run spec: ${message}`); };
  const text = (value, max) => typeof value === 'string' && value.trim() && value.trim().length <= max;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('expected an object');
  for (const key of Object.keys(input)) {
    if (!['hypothesis', 'origin', 'fixtures', 'brief', 'arms'].includes(key)) fail(`unknown field ${key}`);
  }
  if (!text(input.hypothesis, limits.hypothesis)) fail(`hypothesis must be 1–${limits.hypothesis} characters`);
  const origin = input.origin ?? { kind: 'human', name: 'cli' };
  if (!origin || typeof origin !== 'object' || Object.keys(origin).some(key => !['kind', 'name'].includes(key)) ||
      !['human', 'agent'].includes(origin.kind) || !text(origin.name, limits.origin)) {
    fail('origin needs kind human or agent and a short name');
  }
  const hasBrief = input.brief !== undefined;
  if (hasBrief === (input.fixtures !== undefined)) fail('give either fixtures or brief');
  if (hasBrief && !text(input.brief, limits.brief)) fail(`brief must be 1–${limits.brief} characters`);
  if (!hasBrief && (!Array.isArray(input.fixtures) || !input.fixtures.length ||
      new Set(input.fixtures).size !== input.fixtures.length ||
      input.fixtures.some(name => typeof name !== 'string' || !Object.hasOwn(fixtures, name)))) {
    fail(`fixtures must be unique names from ${Object.keys(fixtures).join(', ')}`);
  }
  if (!Array.isArray(input.arms) || !input.arms.length || input.arms.length > limits.arms) {
    fail(`arms must list 1–${limits.arms} arms`);
  }
  const arms = input.arms.map((arm, index) => {
    const id = String.fromCharCode(65 + index);
    if (!arm || typeof arm !== 'object' || Array.isArray(arm)) fail(`arm ${id} must be an object`);
    for (const key of Object.keys(arm)) {
      if (!['id', 'label', 'model', ...Object.keys(armDefaults)].includes(key)) fail(`arm ${id} has unknown field ${key}`);
    }
    const value = { ...armDefaults, ...arm, id };
    if (!text(value.model, 100) || value.model.startsWith('-')) fail(`arm ${id} needs a model name`);
    if (!exampleModes.includes(value.examples)) fail(`arm ${id} examples must be ${exampleModes.join(', ')}`);
    if (!repairPolicies.includes(value.repair)) fail(`arm ${id} repair must be ${repairPolicies.join(', ')}`);
    if (!formats.includes(value.format)) fail(`arm ${id} format must be ${formats.join(', ')}`);
    if (!Number.isInteger(value.samples) || value.samples < 1 || value.samples > limits.samples) {
      fail(`arm ${id} samples must be 1–${limits.samples}`);
    }
    if (typeof value.temperature !== 'number' || !(value.temperature >= 0 && value.temperature <= limits.temperature)) {
      fail(`arm ${id} temperature must be 0–${limits.temperature}`);
    }
    if (value.label !== undefined && (typeof value.label !== 'string' || value.label.length > limits.label)) {
      fail(`arm ${id} label must be at most ${limits.label} characters`);
    }
    if (value.model === checkedIn) {
      if (hasBrief) fail('checked-in arms need fixtures');
      Object.assign(value, { samples: 1, examples: 'none', repair: 'none' });
    }
    value.model = value.model.trim();
    value.label = value.label?.trim() || (value.model === checkedIn ? 'Checked-in view'
      : [value.model, `${value.examples} examples`, value.repair !== 'none' && `repair ${value.repair}`,
        value.format !== 'fenced' && value.format].filter(Boolean).join(' · '));
    return value;
  });
  return {
    hypothesis: input.hypothesis.trim(), origin: { kind: origin.kind, name: origin.name.trim() },
    ...(hasBrief ? { brief: input.brief.trim() } : { fixtures: [...input.fixtures] }), arms,
  };
}

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

function systemPrompt({ format, allowLibraries, reference, example }) {
  const libraries = allowLibraries ? [
    'Declare imported packages in libraries. Use only static imports from declared supported packages.',
    'Use an empty libraries list for plain browser JavaScript. When a library reference is supplied, use it.',
    'Supported packages:', libraryCatalog(),
  ] : ['Use plain browser JavaScript without imports. libraries is an empty list.'];
  const reply = format === 'fenced' ? [
    'Reply with exactly four fenced code blocks in this order and nothing else:',
    '```json\n{"title": "Short title", "intro": "One sentence for the learner.", "libraries": []}\n```',
    '```html\n<!-- the activity markup fragment -->\n```', '```css\n/* the activity styles */\n```',
    '```js\n// the activity script\n```',
    ...(allowLibraries ? [`If a needed library has no supplied reference, reply with only a json block:\n${libraryRequestExample}`] : []),
  ] : [
    'Return one JSON object with string fields title, intro, markup, styles and code, and a libraries array.',
    ...(allowLibraries ? [`If a needed library has no supplied reference, you can return ${libraryRequestExample}`] : []),
  ];
  return [
    [
      'Create a small accessible educational activity that runs offline in a sandboxed iframe.',
      'Write an HTML fragment, plain CSS, and browser JavaScript. Connect each control to an observable change.',
      'Keep it compact: one focused visual, the essential controls, short CSS, and no explanatory prose blocks.',
      'Use SVG, canvas, or HTML as appropriate. Use no URLs, external resources, network calls, or package globals.',
      'Write plain JavaScript checked with strict checkJs. Use JSDoc comments for types; TypeScript syntax is invalid.',
      ...libraries,
    ].join('\n'),
    reply.join('\n'), reference, example,
  ].filter(Boolean).join('\n\n');
}

function renderDraft(draft, format) {
  if (format === 'json') return JSON.stringify(draft);
  const header = JSON.stringify({ title: draft.title, intro: draft.intro, libraries: draft.libraries ?? [] });
  return [['json', header], ['html', draft.markup], ['css', draft.styles], ['js', draft.code]]
    .map(([language, body]) => `\`\`\`${language}\n${body}\n\`\`\``).join('\n');
}

async function generate({ model, brief, folder, retry, result, deadline, format, temperature, seed, example, allowLibraries }) {
  const named = allowLibraries ? [...new Set([
    ...libraryNamesInBrief(brief), ...(retry?.draft?.libraries ?? []),
    ...Object.keys(activityLibraries).filter(name => name === retry?.requestedLibrary),
  ])] : [];
  const reference = await libraryReferences(named);
  const system = systemPrompt({ format, allowLibraries, reference, example: example?.text });
  const messages = [{ role: 'system', content: system }, { role: 'user', content: brief }];
  if (retry?.kind === 'generate-with-library') {
    messages.push({ role: 'user', content: `The requested package "${retry.requestedLibrary}" is available.
Use the supplied reference and write the complete activity. Include the package in libraries.` });
  }
  if (retry?.kind === 'regenerate') {
    messages.push({ role: 'user', content: 'Write a fresh, compact activity focused on the essential interaction.' });
  }
  if (retry?.kind === 'repair') {
    const diagnostics = retry.diagnostics.slice(0, 8).map(item => ({ ...item, message: item.message.slice(0, 550) }));
    messages.push({ role: 'user', content: [
      'The draft below failed these checks. Return the complete corrected activity in the same reply format.',
      'Fix the first reported failure and preserve working behavior.',
      JSON.stringify(diagnostics), renderDraft(retry.draft, format),
    ].join('\n') });
  }
  const allowRequest = allowLibraries && retry?.kind !== 'generate-with-library';
  const request = {
    model, messages, stream: false, think: retry?.think ?? false,
    options: { ...baseOptions, temperature, seed },
    ...(format === 'json' && { format: allowRequest ? { anyOf: [activitySchema, libraryRequestSchema] } : activitySchema }),
  };
  result.options = request.options;
  result.think = request.think;
  await writeFile(join(folder, 'request.json'), JSON.stringify(request, null, 2));
  const response = await ollama('/api/chat', request, remaining(deadline)).catch(error => {
    if (Number.isFinite(deadline) && error.name === 'TimeoutError') {
      throw Object.assign(new Error('Repair time budget expired'), { code: 'REPAIR_DEADLINE' });
    }
    throw error;
  });
  await writeFile(join(folder, 'response.json'), JSON.stringify(response, null, 2));
  return { response, allowRequest };
}

/** Parse a fenced reply: a json header block, then html, css and js blocks. */
export function parseFenced(content) {
  // Small models glue fences onto the previous line: "}```" closes a block, "}```html" also opens the next.
  const text = String(content).replace(/([^\s`])[ \t]*```([\w+-]+)?/g,
    (_, last, language) => `${last}\n\`\`\`` + (language ? `\n\`\`\`${language}` : ''));
  const blocks = [...text.matchAll(/^```[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)]
    .map(([, language, body]) => ({ language: language.toLowerCase(), body: body.replace(/\n$/, '') }));
  if (!blocks.length) throw new Error('Expected fenced code blocks');
  const header = blocks.find(block => block.language === 'json');
  let meta = {};
  if (header) {
    try {
      meta = JSON.parse(header.body);
    } catch {
      // Tolerate stray text around the object, such as a trailing comma.
      const start = header.body.indexOf('{'), end = header.body.lastIndexOf('}');
      try {
        if (start < 0 || end < start) throw new Error();
        meta = JSON.parse(header.body.slice(start, end + 1));
      } catch {
        throw new Error('The json header block is not valid JSON');
      }
    }
  }
  if (meta && typeof meta === 'object' && Object.hasOwn(meta, 'libraryRequest')) return meta;
  const body = (...names) => blocks.find(block => names.includes(block.language))?.body;
  return {
    title: meta?.title, intro: meta?.intro, libraries: meta?.libraries ?? [],
    markup: body('html'), styles: body('css') ?? '', code: body('js', 'javascript', 'mjs'),
  };
}

function parseDraft(draft) {
  const required = ['title', 'intro', 'markup', 'code'];
  if (!draft || typeof draft !== 'object' || !required.every(key => typeof draft[key] === 'string' && draft[key].trim()) ||
      typeof (draft.styles ?? '') !== 'string') {
    throw new Error('Expected a nonempty title, intro, html and js');
  }
  const libraries = normalizeLibraryNames(draft.libraries ?? []);
  validateLibraries(libraries);
  // Declare supported packages the code imports but the header forgot.
  for (const [, name] of draft.code.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)) {
    if (Object.hasOwn(activityLibraries, name) && !libraries.includes(name)) libraries.push(name);
  }
  return { title: draft.title, intro: draft.intro, markup: draft.markup, styles: draft.styles ?? '', code: draft.code, libraries };
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

async function checkDraft(draft, folder, browser, fixture, result, deadline) {
  const { checks, diagnostics } = result;
  const filename = join(folder, 'activity.js');
  const libraries = draft.libraries ?? [];
  const fixed = fixActivity({ markup: draft.markup, code: draft.code, libraries }, filename);
  checks.typeErrorsRaw = fixed.before;
  result.codemod = fixed.fixes;
  if (fixed.code !== draft.code) {
    await writeFile(join(folder, 'activity.raw.js'), draft.code);
    await writeFile(filename, fixed.code);
    draft.code = fixed.code;
  }
  const types = ts.getPreEmitDiagnostics(activityProgram(filename, draft.code, libraries))
    .filter(item => item.category === ts.DiagnosticCategory.Error);
  checks.typeErrors = types.length;
  checks.type = types.length ? 'fail' : 'pass';
  checks.typeCodes = [...new Set(types.map(item => item.code))].sort((a, b) => a - b);
  const format = { getCanonicalFileName: file => file, getCurrentDirectory: () => folder, getNewLine: () => '\n' };
  let code = draft.code;
  if (libraries.length) {
    try {
      code = await bundleActivity({ filename, source: code, libraries });
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
    if (!libraries.length && /Cannot use import statement outside a module/i.test(error.message)) {
      diagnostics.push({ stage: 'bundle', message: 'Static imports require declaring the imported package in libraries.', location });
    } else {
      diagnostics.push({ stage: 'syntax', message: error.message, location });
    }
  }
  if (checks.syntax === 'pass') {
    await checkBrowser({ ...draft, code }, folder, browser, fixture, checks, diagnostics, deadline);
    checks.browser = checks.startup === 'pass' && checks.fixture !== 'fail' ? 'pass' : 'fail';
  }
  for (const typeCode of checks.typeCodes) {
    const group = types.filter(item => item.code === typeCode);
    diagnostics.push({
      stage: 'type', code: typeCode, count: group.length,
      message: ts.formatDiagnostics(group.slice(0, 2), format).trim(),
    });
  }
  return [
    ...diagnostics.filter(item => item.stage !== 'type').map(item => item.message),
    ts.formatDiagnostics(types, format).trim(),
  ].filter(Boolean).join('\n');
}

async function readView(slug) {
  const entry = entries.find(item => item.slug === slug);
  if (!entry) throw new Error(`Unknown checked-in view ${slug}`);
  const folder = new URL(`../src/views/${slug}/`, import.meta.url);
  const read = file => readFile(new URL(file, folder), 'utf8');
  return {
    title: entry.title, intro: entry.intro, markup: await read('activity.html'), styles: await read('activity.css'),
    code: (await readActivityScript(entry)).source, libraries: entry.libraries ?? [],
  };
}

async function attempt({ folder, model, brief, fixture, browser, reference, retry, modelDigest, deadline = Infinity,
  format, temperature, seed, example, allowLibraries }) {
  await mkdir(folder);
  const result = {
    passed: false,
    strategy: reference ? 'control' : retry?.kind ?? 'generate',
    diagnostics: [],
    checks: { response: 'skipped', type: 'skipped', syntax: 'skipped', browser: 'skipped',
      startup: 'skipped', bundle: 'skipped', fixture: fixture ? 'skipped' : 'unverified' },
    ...(example && { example: { mode: example.mode, slug: example.slug, retrieval: example.retrieval,
      truncated: example.truncated, skipped: example.skipped } }),
  };
  const started = performance.now();
  let draft = reference && { ...reference };
  let stage = 'request';
  try {
    if (!draft) {
      result.requestedModel = model;
      if (modelDigest) result.model = { digest: modelDigest };
      const { response, allowRequest } = await generate({
        model, brief, folder, retry, result, deadline, format, temperature, seed, example, allowLibraries,
      });
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
      const content = response.message?.content ?? '';
      const output = format === 'json' ? JSON.parse(content) : parseFenced(content);
      if (output && Object.hasOwn(output, 'libraryRequest')) {
        if (!allowRequest) throw new Error('Library requests are not available for this brief');
        result.libraryRequest = parseLibraryRequest(output);
        result.checks.response = 'pass';
        stage = 'library-request';
        const { package: name, requestedVersion, reason, available } = result.libraryRequest;
        const spec = requestedVersion ? `${name}@${requestedVersion}` : name;
        throw new Error(`Model requested ${spec} (${available ? 'available' : 'unavailable'}): ${reason}`);
      }
      draft = parseDraft(output);
      if (!allowLibraries && draft.libraries.length) throw new Error('This brief allows no libraries');
      result.checks.response = 'pass';
    }
    result.libraries = draft.libraries ?? [];
    stage = 'artifacts';
    await writeDraft(folder, draft);
    stage = 'validation';
    const error = await checkDraft(draft, folder, browser, fixture, result, deadline);
    remaining(deadline);
    if (error) {
      result.failure = stage;
      result.error = error;
    }
    result.passed = !error && accepted(result.checks);
  } catch (error) {
    result.failure = error.code === 'REPAIR_DEADLINE' || performance.now() >= deadline - 1 ? 'deadline'
      : stage === 'validation' ? 'infrastructure' : stage;
    result.error = error.cause ? `${error.message}: ${error.cause.message}` : error.message;
    result.diagnostics.push({ stage: result.failure, message: result.error });
    if (['response', 'truncated'].includes(stage)) result.checks.response = 'fail';
    result.passed = false;
  }
  result.tier = tierOf(result.checks);
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

async function runSample({ arm, target, row, folder, browser, tags, rows, example }) {
  const index = rows.indexOf(row) + 1;
  async function record({ retry, deadline } = {}) {
    const path = `case-${index}-attempt-${row.attempts.length + 1}`;
    const attemptFolder = join(folder, path);
    console.log(`${arm.id} ${arm.label} / ${target.name} / sample ${row.sample} / attempt ${row.attempts.length + 1}`);
    const value = await attempt({
      brief: target.brief, fixture: target.fixture, reference: target.reference, browser, folder: attemptFolder,
      retry, deadline, model: arm.model, modelDigest: installedDigest(tags, arm.model), format: arm.format,
      temperature: arm.temperature, seed: row.sample * 1000 + row.attempts.length, example,
      allowLibraries: !target.fixture,
    });
    const exists = file => lstat(join(attemptFolder, file)).then(() => true, () => false);
    row.attempts.push({
      ...value.result, path, preview: await exists('preview.png'), draft: await exists('view.yml'),
      request: await exists('request.json'), response: await exists('response.json'),
    });
    if (value.result.error) console.log(value.result.error.split('\n').slice(0, 4).join('\n'));
    return value;
  }

  let latest = await record();
  let best = latest;
  row.selectedAttempt = latest.draft ? row.attempts.at(-1).path : null;
  await saveResults(folder, rows);
  const started = performance.now();
  const deadline = started + repairBudgetMs;
  let calls = 0;
  let escalated = false;
  let retry;
  let previous;
  while (!target.reference && calls < repairCallLimit && performance.now() < deadline &&
    (retry = nextRepair(arm.repair, best.result, latest.result, calls, escalated, previous))) {
    if (retry.think) escalated = true;
    previous = latest.result;
    latest = await record({
      retry: { ...retry, ...best, diagnostics: best.result.diagnostics, requestedLibrary: latest.result.libraryRequest?.package },
      deadline,
    });
    calls++;
    row.attempts.at(-1).regressions = latest.draft ? regressions(best.result, latest.result) : [];
    row.attempts.at(-1).elapsedSeconds = (performance.now() - started) / 1000;
    if (latest.draft && latest.result.failure !== 'deadline' && preferredCandidate(best.result, latest.result)) {
      best = latest;
      row.selectedAttempt = row.attempts.at(-1).path;
    }
    await saveResults(folder, rows);
  }
  row.elapsedSeconds = row.attempts.reduce((total, item) => total + (item.seconds ?? 0), 0);
  row.passed = best.result.passed;
  row.tier = best.draft ? tierOf(best.result.checks) : 'broken';
  row.typeErrors = best.result.checks.typeErrors;
  row.typeErrorsRaw = best.result.checks.typeErrorsRaw;
  row.stopReason = row.passed ? 'passed'
    : latest.result.libraryRequest ? latest.result.libraryRequest.available ? 'library-request' : 'unsupported-dependency'
      : latest.result.failure === 'deadline' || performance.now() >= deadline ? 'deadline'
        : ['request', 'artifacts', 'infrastructure'].includes(latest.result.failure) ? 'infrastructure-error'
          : calls >= repairCallLimit ? 'call-limit'
            : escalated ? 'stalled-after-escalation' : 'no-further-repair';
  row.finished = true;
  await saveResults(folder, rows);
}

function shuffled(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

const usage = `Usage:
  node scripts/view-generation.mjs run --spec FILE
  node scripts/view-generation.mjs eval [--model NAME]... [--fixture NAME]... [ARM OPTIONS]
  node scripts/view-generation.mjs generate "PROMPT" | --brief FILE [--model NAME] [ARM OPTIONS]
  node scripts/view-generation.mjs describe
Arm options: --examples ${exampleModes.join('|')} --samples 1-${limits.samples} --temperature 0-${limits.temperature}
             --repair ${repairPolicies.join('|')} --format ${formats.join('|')}
generate defaults to --examples retrieved --repair loop; eval and run use the arm defaults.
Add --hypothesis TEXT to label a run. Fixtures: ${Object.keys(fixtures).join(', ')}.`;

async function main() {
  const string = { type: 'string' };
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      spec: string, model: { type: 'string', multiple: true }, fixture: { type: 'string', multiple: true },
      brief: string, examples: string, samples: string, temperature: string, repair: string, format: string,
      hypothesis: string, help: { type: 'boolean' },
    },
  });
  const [command, ...args] = positionals;
  if (command === 'describe') {
    console.log(JSON.stringify(describe()));
    return;
  }
  if (command === 'validate') {
    // Reads a spec on stdin and prints the normalized spec, for the evaluation dashboard.
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    try {
      console.log(JSON.stringify(validateSpec(JSON.parse(text))));
    } catch (error) {
      console.log(JSON.stringify({ error: error instanceof SyntaxError ? 'Invalid run spec: expected JSON' : error.message }));
      process.exitCode = 2;
    }
    return;
  }
  if (values.help || !['run', 'eval', 'generate'].includes(command)) {
    console.log(usage);
    if (!values.help) process.exitCode = 1;
    return;
  }
  const generating = command === 'generate';
  let input;
  if (command === 'run') {
    if (!values.spec || args.length) throw new Error('Use run --spec FILE. Use --help for usage.');
    input = JSON.parse(await readFile(values.spec, 'utf8'));
  } else {
    const inline = args.join(' ').trim();
    if (generating ? Boolean(inline) === Boolean(values.brief) || values.fixture : args.length || values.brief) {
      throw new Error('Invalid arguments. Use --help for usage.');
    }
    const number = value => value === undefined ? undefined : Number(value);
    const arm = model => Object.fromEntries(Object.entries({
      model, examples: values.examples ?? (generating ? 'retrieved' : undefined), samples: number(values.samples),
      temperature: number(values.temperature), repair: values.repair ?? (generating ? 'loop' : undefined), format: values.format,
    }).filter(([, value]) => value !== undefined));
    input = {
      hypothesis: values.hypothesis ?? (generating ? 'Generate a draft for a custom brief' : 'Fixture evaluation'),
      origin: { kind: 'human', name: 'cli' },
      ...(generating ? { brief: values.brief ? await readFile(values.brief, 'utf8') : inline }
        : { fixtures: values.fixture ?? Object.keys(fixtures) }),
      arms: (values.model ?? ['qwen3.5:4b']).map(arm),
    };
  }
  const spec = validateSpec(input);
  const needsModels = spec.arms.some(arm => arm.model !== checkedIn);
  const runtime = needsModels ? await ollama('/api/version', undefined, 3000).catch(() => null) : null;
  const tags = needsModels ? (await ollama('/api/tags', undefined, 3000)).models ?? [] : [];
  for (const arm of spec.arms) {
    if (arm.model !== checkedIn && !installedDigest(tags, arm.model)) throw new Error(`Model is not installed: ${arm.model}`);
  }

  const targets = spec.brief ? [{ name: 'custom', brief: spec.brief, exclude: [] }]
    : spec.fixtures.map(name => ({
      name, brief: fixtures[name].brief, fixture: fixtures[name], view: fixtures[name].view,
      exclude: [name, fixtures[name].view, ...(fixtures[name].excludeViews ?? [])].filter(Boolean),
    }));
  const order = Object.fromEntries(targets.map(target => [target.name, shuffled(spec.arms.map(arm => arm.id))]));
  const cases = targets.flatMap(target => order[target.name].flatMap(id => {
    const arm = spec.arms.find(item => item.id === id);
    if (arm.model === checkedIn && !target.view) return [];
    return Array.from({ length: arm.samples }, (_, index) => ({ arm: id, fixture: target.name, sample: index + 1 }));
  }));

  const reservedId = process.env.VIZINT_EVAL_RUN_ID;
  if (reservedId && !runIdPattern.test(reservedId)) throw new Error('Invalid reserved evaluation run ID');
  const folder = resolve('.view-generation', reservedId ??
    new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8));
  await mkdir(folder, { recursive: true });
  const sources = await Promise.all([
    import.meta.url, new URL('./view-repair-policy.mjs', import.meta.url), new URL('./view-examples.mjs', import.meta.url),
    new URL('./activity-libraries.mjs', import.meta.url), new URL('../package-lock.json', import.meta.url),
    ...Object.keys(activityLibraries).map(name => new URL(`./activity-library-examples/${name}.js`, import.meta.url)),
    new URL('./view-generation-fixtures.mjs', import.meta.url), new URL('./activity-codemod.mjs', import.meta.url),
    new URL('./activity-frame.mjs', import.meta.url), new URL('./activity-program.mjs', import.meta.url),
  ].map(url => readFile(new URL(url))));
  const fingerprint = createHash('sha256');
  for (const source of sources) fingerprint.update(source).update('\0');
  const runnerHash = fingerprint.update(common).digest('hex');
  const checks = createHash('sha256');
  for (const source of sources.slice(3)) checks.update(source).update('\0');
  const checkHash = checks.update(common).update(checkDraft.toString()).update(checkBrowser.toString()).digest('hex');
  const status = git(['status', '--porcelain']);
  const metadata = {
    command: 'run', runnerHash, checkHash,
    git: { commit: git(['rev-parse', 'HEAD']), dirty: status === null ? null : Boolean(status) },
    node: process.version, typescript: ts.version, ollama: runtime?.version,
    models: Object.fromEntries(spec.arms.filter(arm => arm.model !== checkedIn)
      .map(arm => [arm.model, installedDigest(tags, arm.model)])),
    order, cases,
  };
  await writeFile(join(folder, 'experiment.json'), JSON.stringify(spec, null, 2));
  await writeFile(join(folder, 'run.json'), JSON.stringify(metadata, null, 2));
  const rows = [];
  await saveResults(folder, rows);
  const runId = basename(folder);
  console.log(`Run ${runId}: open it in the evaluation dashboard (mise run views:admin)`);
  if (!cases.length) {
    process.exitCode = 1;
    return;
  }
  const browser = await chromium.launch(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: 'chrome' });
  const examples = new Map();
  try {
    metadata.browser = browser.version();
    await writeFile(join(folder, 'run.json'), JSON.stringify(metadata, null, 2));
    for (const planned of cases) {
      const arm = spec.arms.find(item => item.id === planned.arm);
      const target = { ...targets.find(item => item.name === planned.fixture) };
      if (arm.model === checkedIn) target.reference = await readView(target.view);
      const key = `${arm.examples}\0${target.name}`;
      if (!examples.has(key)) examples.set(key, await selectExample(arm.examples, target.brief, { exclude: target.exclude }));
      const row = { ...planned, model: arm.model, attempts: [], finished: false };
      rows.push(row);
      await runSample({ arm, target, row, folder, browser, tags, rows, example: examples.get(key) });
    }
  } finally {
    await browser.close();
  }
  for (const arm of spec.arms) {
    const own = rows.filter(row => row.arm === arm.id);
    console.log(`${arm.id} ${arm.label}: ${tiers.toReversed().map(tier => `${tier} ${own.filter(row => row.tier === tier).length}`).join(', ')}`);
  }
  if (generating ? !rows.some(row => row.passed) : rows.some(row => row.stopReason === 'infrastructure-error')) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
