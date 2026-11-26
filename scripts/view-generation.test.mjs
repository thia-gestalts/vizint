import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bundleActivity } from './activity-libraries.mjs';
import { findExamples } from './view-examples.mjs';
import { parseFenced, validateSpec } from './view-generation.mjs';
import { accepted, nextRepair, preferredCandidate, tierOf } from './view-repair-policy.mjs';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('./view-generation.mjs', import.meta.url));
const draft = {
  title: 'Example activity', intro: 'Try the example', markup: '<p id="report">Waiting</p>',
  styles: 'p { color: black; }', code: 'document.querySelector("#report")?.append(" Ready");', libraries: [],
};
const badSyntax = { ...draft, code: 'const value = ;' };
const typeError = { ...draft, code: '/** @type {number} */\nconst count = "one";\ndocument.body.dataset.count = String(count);' };
const browserCrash = { ...draft, code: 'throw new Error("repair regression");' };
const fenced = reply => [
  ['json', JSON.stringify({ title: reply.title, intro: reply.intro, libraries: reply.libraries ?? [] })],
  ['html', reply.markup], ['css', reply.styles], ['js', reply.code],
].map(([language, body]) => `\`\`\`${language}\n${body}\n\`\`\``).join('\n\n');

test('tiers rank drafts and repairs never accept a regression', () => {
  const checks = (overrides) => ({ syntax: 'pass', startup: 'pass', fixture: 'pass', type: 'pass', ...overrides });
  assert.equal(tierOf(checks()), 'publishable');
  assert.equal(tierOf(checks({ type: 'fail' })), 'working');
  assert.equal(tierOf(checks({ fixture: 'fail' })), 'starts');
  assert.equal(tierOf(checks({ startup: 'fail' })), 'broken');
  assert.equal(accepted(checks({ fixture: 'unverified' })), true);
  assert.equal(accepted(checks({ fixture: 'unverified', type: 'fail' })), false);

  const failure = (stage, overrides) => ({
    failure: 'validation', diagnostics: [{ stage, message: 'example' }], checks: checks(overrides),
  });
  const best = failure('type', { type: 'fail', typeErrors: 2 });
  const regression = failure('startup', { startup: 'fail', typeErrors: 0 });
  assert.equal(preferredCandidate(best, regression), false);
  assert.equal(preferredCandidate(best, failure('type', { type: 'fail', typeErrors: 1 })), true);
  assert.deepEqual(nextRepair('once', best, best, 0, false), { kind: 'repair', think: false });
  assert.equal(nextRepair('once', best, best, 1, false), null);
  assert.equal(nextRepair('none', best, best, 0, false), null);
  assert.deepEqual(nextRepair('loop', best, regression, 1, false, best), { kind: 'repair', think: true });
  assert.equal(nextRepair('loop', best, regression, 2, true, best), null);
  assert.deepEqual(nextRepair('loop', { failure: 'truncated', checks: {} }, { failure: 'truncated' }, 0, false),
    { kind: 'regenerate', think: false });
});

test('fenced replies parse into drafts or library requests', () => {
  assert.deepEqual(parseFenced(fenced(draft)), draft);
  const request = { libraryRequest: { package: 'three', reason: '3D' } };
  assert.deepEqual(parseFenced('Sure:\n```json\n' + JSON.stringify(request) + '\n```'), request);
  assert.equal(parseFenced('```html\n<p></p>\n```\n```javascript\nlet a = `x`;\n```').code, 'let a = `x`;');
  assert.throws(() => parseFenced('no blocks here'), /fenced code blocks/);
  assert.throws(() => parseFenced('```json\n{oops\n```'), /not valid JSON/);
});

test('run specs are validated and normalized', () => {
  const spec = validateSpec({ hypothesis: ' h ', fixtures: ['spring'], arms: [{ model: 'm' }, { model: 'checked-in', samples: 4 }] });
  assert.deepEqual(spec.origin, { kind: 'human', name: 'cli' });
  assert.deepEqual(spec.arms.map(arm => [arm.id, arm.samples, arm.examples, arm.temperature]), [['A', 3, 'none', 0.7], ['B', 1, 'none', 0.7]]);
  assert.equal(spec.arms[0].label, 'm · none examples');
  const bad = [
    { fixtures: ['spring'], arms: [{ model: 'm' }] },
    { hypothesis: 'h', arms: [{ model: 'm' }] },
    { hypothesis: 'h', fixtures: ['nope'], arms: [{ model: 'm' }] },
    { hypothesis: 'h', fixtures: ['spring'], arms: Array(5).fill({ model: 'm' }) },
    { hypothesis: 'h', fixtures: ['spring'], arms: [{ model: 'm', samples: 9 }] },
    { hypothesis: 'h', fixtures: ['spring'], arms: [{ model: '--help' }] },
    { hypothesis: 'h', brief: 'b', arms: [{ model: 'checked-in' }] },
    { hypothesis: 'h', brief: 'b', arms: [{ model: 'm' }], origin: { kind: 'robot', name: 'x' } },
  ];
  for (const input of bad) assert.throws(() => validateSpec(input), /Invalid run spec/);
});

test('retrieval excludes the fixture view and falls back to term overlap', async () => {
  const unavailable = async () => { throw new Error('offline'); };
  const brief = 'Drag control points of a cubic Bézier curve';
  const open = await findExamples(brief, { search: unavailable, limit: 3 });
  assert.equal(open.results[0].slug, 'bezier');
  assert.match(open.mode, /^lexical/);
  const held = await findExamples(brief, { exclude: ['bezier'], search: unavailable, limit: 3 });
  assert.ok(held.results.every(result => result.slug !== 'bezier'));
});

test('bundler rejects undeclared direct imports and local paths', async () => {
  const filename = '/tmp/vizint-activity.js';
  for (const source of ["import { Scene } from 'three';", "import './private.js';"]) {
    await assert.rejects(bundleActivity({ filename, source, libraries: ['d3'] }), /Activity import .* is unavailable/);
  }
});

test('local runner with a mock Ollama server', async t => {
  const requests = [];
  let replies = [];
  const tags = [{ name: 'qwen3.5:4b', digest: 'mock-digest' }, { name: 'qwen3.5:9b', digest: 'mock-large' }];
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url !== '/api/chat') {
      response.end(JSON.stringify(request.url === '/api/version' ? { version: 'mock' } : { models: tags }));
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const call = JSON.parse(body);
    requests.push(call);
    const queued = replies.shift();
    const reply = typeof queued === 'function' ? queued(call) : queued;
    if (!reply) {
      response.writeHead(500).end('No mock reply');
      return;
    }
    if (reply.hang) return;
    const content = call.format ? JSON.stringify(reply)
      : reply.libraryRequest ? '```json\n' + JSON.stringify(reply) + '\n```' : fenced(reply);
    response.end(JSON.stringify({
      message: { content }, eval_count: 50, prompt_eval_count: 50,
      total_duration: 1000000, load_duration: 100000, done_reason: reply.truncated ? 'length' : 'stop',
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const cwd = await mkdtemp(join(tmpdir(), 'vizint-view-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const root = join(cwd, '.view-generation');
  async function run(args, queue, expectedExit = 0, nodeArgs = []) {
    requests.length = 0;
    replies = [...queue];
    const before = new Set(await readdir(root).catch(() => []));
    const result = await exec(process.execPath, [...nodeArgs, runner, ...args], {
      cwd, env: { ...process.env, VIZINT_OLLAMA_URL: `http://127.0.0.1:${server.address().port}` },
    }).then(value => ({ ...value, code: 0 }), error => error);
    assert.equal(result.code, expectedExit, result.stderr + result.stdout);
    assert.equal(replies.length, 0, 'All expected model calls were made');
    const [id] = (await readdir(root)).filter(item => !before.has(item));
    const read = name => readFile(join(root, id, name), 'utf8').then(JSON.parse);
    return { id, settings: await read('run.json'), spec: await read('experiment.json'), rows: await read('results.json'), read };
  }

  await t.test('first-pass success uses one fenced call with a retrieved example', async () => {
    const { rows, spec } = await run(['generate', 'Teach squared errors by dragging points', '--samples', '1'], [draft]);
    assert.equal(rows[0].passed, true);
    assert.equal(rows[0].tier, 'starts');
    assert.equal(rows[0].attempts[0].checks.fixture, 'unverified');
    assert.equal(requests[0].think, false);
    assert.equal(requests[0].format, undefined);
    assert.deepEqual(requests[0].options, { num_ctx: 8192, num_predict: 4096, temperature: 0.7, seed: 1000 });
    assert.match(requests[0].messages[0].content, /Reference activity/);
    assert.deepEqual(spec.origin, { kind: 'human', name: 'cli' });
  });

  await t.test('the codemod turns a working fixture draft publishable', async () => {
    const working = {
      ...draft,
      markup: `<input type="range" id="threshold" min="0" max="1" step="0.01">
        <p id="false-positives">0</p><p id="false-negatives">0</p>`,
      code: `const scores = [[0.9, 1], [0.6, 1], [0.2, 1], [0.8, 0], [0.4, 0], [0.1, 0]];
function update() {
  const threshold = Number(document.getElementById('threshold').value);
  document.getElementById('false-positives').textContent = scores.filter(([s, y]) => s >= threshold && !y).length;
  document.getElementById('false-negatives').textContent = scores.filter(([s, y]) => s < threshold && y).length;
}
document.getElementById('threshold').addEventListener('input', update);
update();`,
    };
    const { rows, id } = await run(['eval', '--fixture', 'classifier-threshold', '--samples', '1'], [working]);
    const [attempt] = rows[0].attempts;
    assert.equal(rows[0].tier, 'publishable');
    assert.ok(attempt.checks.typeErrorsRaw > 0);
    assert.equal(attempt.checks.typeErrors, 0);
    assert.deepEqual(attempt.codemod.map(fix => fix.kind), ['dom-cast', 'explicit-conversion']);
    const files = await readdir(join(root, id, attempt.path));
    assert.ok(files.includes('activity.raw.js'));
    assert.doesNotMatch(requests[0].messages[0].content, /libraryRequest/);
  });

  await t.test('a two-arm spec samples each arm in a recorded order', async () => {
    const spec = join(cwd, 'spec.json');
    await writeFile(spec, JSON.stringify({
      hypothesis: 'A fixed example helps', origin: { kind: 'agent', name: 'test-agent' }, fixtures: ['spring'],
      arms: [{ model: 'qwen3.5:4b', samples: 2 }, { model: 'qwen3.5:9b', examples: 'fixed', samples: 2, temperature: 0.2 }],
    }));
    const result = await run(['run', '--spec', spec], [draft, draft, draft, draft]);
    assert.deepEqual(result.spec.origin, { kind: 'agent', name: 'test-agent' });
    assert.deepEqual(result.rows.map(row => [row.arm, row.sample]),
      result.settings.order.spring.flatMap(arm => [[arm, 1], [arm, 2]]));
    assert.ok(result.rows.every(row => row.tier === 'starts' && row.finished));
    const byModel = model => requests.filter(call => call.model === model);
    assert.deepEqual(byModel('qwen3.5:4b').map(call => call.options.seed), [1000, 2000]);
    assert.ok(byModel('qwen3.5:9b').every(call => call.options.temperature === 0.2 &&
      call.messages[0].content.includes('Reference activity "Squared errors"')));
    assert.ok(byModel('qwen3.5:4b').every(call => !call.messages[0].content.includes('Reference activity')));
  });

  await t.test('fixtures reject library requests', async () => {
    const { rows } = await run(['eval', '--fixture', 'spring', '--samples', '1'],
      [{ libraryRequest: { package: 'd3', reason: 'Plotting' } }]);
    assert.equal(rows[0].attempts[0].failure, 'response');
    assert.equal(rows[0].tier, 'broken');
  });

  await t.test('retrieval for an eval never returns the fixture own view', async () => {
    const { rows } = await run(['eval', '--fixture', 'bezier', '--samples', '1', '--examples', 'retrieved'], [draft]);
    const { example } = rows[0].attempts[0];
    assert.notEqual(example.slug, 'bezier');
    assert.match(example.retrieval, /^lexical/);
  });

  await t.test('checked-in control runs without a model', async () => {
    const spec = join(cwd, 'control.json');
    await writeFile(spec, JSON.stringify({ hypothesis: 'Control', fixtures: ['bezier', 'spring'], arms: [{ model: 'checked-in' }] }));
    const { rows } = await run(['run', '--spec', spec], []);
    assert.deepEqual(rows.map(row => [row.fixture, row.tier]), [['bezier', 'publishable']]);
  });

  await t.test('repair once sends the failing draft back in the fenced format', async () => {
    const { rows } = await run(['generate', 'Teach an example', '--samples', '1', '--repair', 'once'], [badSyntax, draft]);
    assert.equal(rows[0].attempts[1].strategy, 'repair');
    assert.match(requests[1].messages.at(-1).content, /```js\nconst value = ;\n```/);
    assert.equal(rows[0].passed, true);
    assert.equal(rows[0].selectedAttempt, 'case-1-attempt-2');
  });

  await t.test('repair loop escalates to thinking on a repeated failure', async () => {
    const { rows } = await run(['generate', 'Teach an example', '--samples', '1', '--repair', 'loop'],
      [badSyntax, badSyntax, draft]);
    assert.deepEqual(requests.map(({ think }) => think), [false, false, true]);
    assert.equal(rows[0].passed, true);
  });

  await t.test('repair regression retains the best draft and exits nonzero', async () => {
    const { rows, read } = await run(['generate', 'Teach an example', '--samples', '1', '--repair', 'loop'],
      [typeError, browserCrash, typeError], 1);
    assert.equal(rows[0].selectedAttempt, 'case-1-attempt-1');
    assert.equal(rows[0].stopReason, 'stalled-after-escalation');
    assert.deepEqual(rows[0].attempts[1].regressions, ['startup']);
    assert.equal((await read('case-1-attempt-2/result.json')).checks.startup, 'fail');
  });

  await t.test('the json format remains available as an arm option', async () => {
    const { rows } = await run(['generate', 'Teach an example', '--samples', '1', '--format', 'json'], [draft]);
    assert.equal(requests[0].format.anyOf.length, 2);
    assert.equal(rows[0].passed, true);
  });

  await t.test('model can report an unavailable package with a reason', async () => {
    const request = { package: 'plotly.js', reason: 'The requested figure uses a Plotly surface.' };
    const { rows } = await run(['generate', 'Use Plotly', '--samples', '1'], [{ libraryRequest: request }], 1);
    assert.equal(rows[0].stopReason, 'unsupported-dependency');
    assert.deepEqual(rows[0].attempts[0].libraryRequest, { ...request, available: false });
    assert.equal(requests.length, 1);
  });

  await t.test('an incompatible version remains an explicit request', async () => {
    const reply = { libraryRequest: { package: 'three@0.186.1', reason: 'Uses the r186 API.' } };
    const { rows } = await run(['generate', 'Build a scene', '--samples', '1'], [reply], 1);
    assert.equal(rows[0].stopReason, 'unsupported-dependency');
    assert.deepEqual(rows[0].attempts[0].libraryRequest, {
      package: 'three', reason: 'Uses the r186 API.', requestedVersion: '0.186.1',
      installedVersion: '0.187.0', available: false,
    });
  });

  await t.test('model can request a D3 reference and generate an offline bundle', async () => {
    const code = await readFile(new URL('./activity-library-examples/d3.js', import.meta.url), 'utf8');
    const request = { libraryRequest: { package: 'd3@7.9.0', reason: 'I need the SVG scale API.' } };
    const result = await run(['generate', 'Plot some points', '--samples', '1'], [
      request, { ...draft, markup: '<svg viewBox="0 0 200 60"></svg>', code, libraries: ['d3'] },
    ]);
    const attempts = result.rows[0].attempts;
    assert.equal(attempts[0].libraryRequest.available, true);
    assert.equal(attempts[0].libraryRequest.requestedVersion, '7.9.0');
    assert.equal(attempts[1].strategy, 'generate-with-library');
    assert.equal(attempts[1].checks.bundle, 'pass');
    assert.equal(attempts[1].checks.startup, 'pass');
    assert.match(requests[1].messages[0].content, /import \{ scaleLinear, select \} from 'd3'/);
    const manifest = await readFile(join(root, result.id, attempts[1].path, 'view.yml'), 'utf8');
    assert.match(manifest, /libraries:\n  - d3/);
  });

  await t.test('Three.js alias supplies the reference and runs the offline bundle', async () => {
    const code = await readFile(new URL('./activity-library-examples/three.js', import.meta.url), 'utf8');
    const result = await run(['generate', 'Draw a cube. Use 3js', '--samples', '1'], [{ ...draft, code, libraries: ['three'] }]);
    const [attempt] = result.rows[0].attempts;
    assert.equal(attempt.checks.type, 'pass');
    assert.equal(attempt.checks.bundle, 'pass');
    assert.equal(attempt.checks.startup, 'pass');
    assert.match(requests[0].messages[0].content, /from 'three';/);
  });

  await t.test('expired repair request is recorded as a deadline', async () => {
    const accelerate = `const original = AbortSignal.timeout;
      AbortSignal.timeout = ms => original(ms > 100000 && ms <= 120000 ? 100 : ms);`;
    const { rows, read } = await run(['generate', 'Teach an example', '--samples', '1', '--repair', 'loop'],
      [badSyntax, { hang: true }], 1, ['--import', 'data:text/javascript,' + encodeURIComponent(accelerate)]);
    assert.equal(requests.length, 2);
    assert.equal(rows[0].selectedAttempt, 'case-1-attempt-1');
    assert.equal(rows[0].stopReason, 'deadline');
    assert.equal((await read('case-1-attempt-2/result.json')).failure, 'deadline');
  });
});
