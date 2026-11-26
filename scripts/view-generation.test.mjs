import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bundleActivity } from './activity-libraries.mjs';
import { nextRepair, preferredCandidate } from './view-repair-policy.mjs';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('./view-generation.mjs', import.meta.url));
const draft = {
  title: 'Example activity', intro: 'Try the example', markup: '<p id="report">Waiting</p>',
  styles: 'p { color: black; }', code: 'document.querySelector("#report")?.append(" Ready");',
};
const badSyntax = { ...draft, code: 'const value: number = 1;' };
const startupPass = { ...draft, code: 'document.getElementById("report").textContent = "Ready";' };
const browserCrash = { code: 'throw new Error("repair regression");' };

test('routing keeps regressions out and escalates a repeated failure', () => {
  const failure = (stage, checks) => ({
    failure: 'validation', diagnostics: [{ stage, message: 'example' }], checks,
  });
  const best = failure('type', { syntax: 'pass', startup: 'pass', typeErrors: 2 });
  const regression = failure('startup', { syntax: 'pass', startup: 'fail', typeErrors: 0 });
  assert.equal(preferredCandidate(best, regression), false);
  assert.deepEqual(nextRepair('loop', best, best, 0, false), { kind: 'repair-js', think: false });
  assert.deepEqual(nextRepair('loop', best, regression, 1, false, best), { kind: 'repair-activity', think: true });
  assert.equal(nextRepair('loop', best, regression, 2, true, best), null);
  assert.equal(nextRepair('once', best, regression, 1, false), null);
  assert.equal(nextRepair('loop', best, { failure: 'deadline' }, 1, true), null);
  assert.equal(nextRepair('loop', best, { failure: 'request' }, 1, true), null);
  const improved = { ...best, checks: { ...best.checks, typeErrors: 1 } };
  assert.equal(preferredCandidate(best, improved), true);
  assert.equal(nextRepair('loop', improved, improved, 1, false, best).think, true);

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
  const tag = { name: 'qwen3.5:4b', digest: 'mock-digest' };
  const tags = [tag, { name: 'qwen3.5:9b', digest: 'mock-escalation' }];
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
    response.end(JSON.stringify({
      message: { content: JSON.stringify(reply) }, eval_count: 50, prompt_eval_count: 50,
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
    assert.equal(result.code, expectedExit, result.stderr);
    assert.equal(replies.length, 0, 'All expected model calls were made');
    const [id] = (await readdir(root)).filter(item => !before.has(item));
    const read = name => readFile(join(root, id, name), 'utf8').then(JSON.parse);
    return { id, settings: await read('run.json'), rows: await read('results.json'), read };
  }

  await t.test('first-pass success uses one call', async () => {
    const { rows } = await run(['generate', 'Teach an example'], [draft]);
    assert.equal(rows[0].passed, true);
    assert.equal(rows[0].attempts[0].checks.fixture, 'unverified');
    assert.equal(requests[0].think, false);
  });

  await t.test('ROC fixture accepts an SVG text readout', async () => {
    const roc = {
      ...draft,
      markup: `<select id="ranking">
        <option>perfect</option><option>tied</option><option>reversed</option>
      </select>
      <input type="range" id="threshold" min="0" max="1" step="0.01">
      <svg><text id="auc" x="10" y="20">1.000</text>
        <circle id="operating-point" cx="10" cy="50" r="3" />
      </svg>`,
      code: `const rank = document.querySelector('select');
      const threshold = document.querySelector('input');
      const auc = document.querySelector('text');
      const point = document.querySelector('circle');
      if (rank && threshold && auc && point) {
        rank.addEventListener('change', () => {
          auc.textContent = rank.value === 'perfect' ? '1.000' : rank.value === 'tied' ? '0.500' : '0.000';
        });
        threshold.addEventListener('input', () => {
          point.setAttribute('cx', threshold.valueAsNumber > 0.2 ? '10' : '50');
          point.setAttribute('cy', threshold.valueAsNumber > 0.9 ? '50' : '10');
        });
      }`,
    };
    const { rows } = await run(['eval', '--fixture', 'roc-auc', '--model', 'qwen3.5:4b'], [roc]);
    assert.equal(rows[0].attempts[0].checks.fixture, 'pass');
  });

  await t.test('targeted repair and thinking escalation', async () => {
    const { rows } = await run(['generate', 'Teach an example', '--escalation-model', 'qwen3.5:9b'],
      [badSyntax, { code: badSyntax.code }, draft]);
    assert.deepEqual(requests.map(({ think }) => think), [false, false, true]);
    assert.equal(requests[2].model, 'qwen3.5:9b');
    assert.equal(rows[0].selectedAttempt, 'case-1-attempt-3');
    assert.equal(rows[0].passed, true);
  });

  await t.test('repair regression retains draft, artifacts, and nonzero exit', async () => {
    const { rows, read } = await run(['generate', 'Teach an example'], [startupPass, browserCrash, startupPass], 1);
    assert.equal(rows[0].selectedAttempt, 'case-1-attempt-1');
    assert.equal(rows[0].stopReason, 'stalled-after-escalation');
    assert.deepEqual(rows[0].attempts[1].regressions, ['startup']);
    assert.equal((await read('case-1-attempt-2/result.json')).checks.startup, 'fail');
  });

  await t.test('model can report an unavailable package with a reason', async () => {
    const request = { package: 'plotly.js', reason: 'The requested figure uses a Plotly surface.' };
    const { rows } = await run(['generate', 'Use Plotly'], [{ libraryRequest: request }], 1);
    assert.equal(rows[0].stopReason, 'unsupported-dependency');
    assert.deepEqual(rows[0].attempts[0].libraryRequest, { ...request, available: false });
    assert.equal(requests.length, 1);
  });

  await t.test('an incompatible version remains an explicit request', async () => {
    const reply = { libraryRequest: { package: 'three@0.186.1', reason: 'Uses the r186 API.' } };
    const { rows } = await run(['generate', 'Build a scene'], [reply], 1);
    assert.equal(rows[0].stopReason, 'unsupported-dependency');
    assert.deepEqual(rows[0].attempts[0].libraryRequest, {
      package: 'three', reason: 'Uses the r186 API.', requestedVersion: '0.186.1',
      installedVersion: '0.187.0', available: false,
    });
  });

  await t.test('model can request a D3 reference and generate an offline bundle', async () => {
    const code = await readFile(new URL('./activity-library-examples/d3.js', import.meta.url), 'utf8');
    const request = { libraryRequest: { package: 'd3@7.9.0', reason: 'I need the SVG scale API.' } };
    const result = await run(['generate', 'Plot some points'], [
      request, { ...draft, markup: '<svg viewBox="0 0 200 60"></svg>', code, libraries: ['d3'] },
    ]);
    const attempts = result.rows[0].attempts;
    assert.equal(attempts[0].libraryRequest.available, true);
    assert.equal(attempts[0].libraryRequest.package, 'd3');
    assert.equal(attempts[0].libraryRequest.requestedVersion, '7.9.0');
    assert.equal(requests[1].format.type, 'object');
    assert.equal(attempts[1].strategy, 'generate-with-library');
    assert.equal(attempts[1].checks.bundle, 'pass');
    assert.equal(attempts[1].checks.startup, 'pass');
    assert.match(requests[1].messages[0].content, /import \{ scaleLinear, select \} from 'd3'/);
    const manifest = await readFile(join(root, result.id, attempts[1].path, 'view.yml'), 'utf8');
    assert.match(manifest, /libraries:\n  - d3/);
  });

  await t.test('Three.js alias supplies the reference and runs the offline bundle', async () => {
    const code = await readFile(new URL('./activity-library-examples/three.js', import.meta.url), 'utf8');
    const result = await run(['generate', 'Draw a cube. Use 3js'], [
      { ...draft, code, libraries: ['three'] },
    ]);
    const [attempt] = result.rows[0].attempts;
    assert.equal(attempt.checks.type, 'pass');
    assert.equal(attempt.checks.bundle, 'pass');
    assert.equal(attempt.checks.startup, 'pass');
    assert.match(requests[0].messages[0].content, /from 'three';/);
  });

  await t.test('expired repair request is recorded as a deadline', async () => {
    const accelerate = `const original = AbortSignal.timeout;
      AbortSignal.timeout = ms => original(ms > 100000 && ms <= 120000 ? 100 : ms);`;
    const { rows, read } = await run(['generate', 'Teach an example'], [badSyntax, { hang: true }], 1,
      ['--import', 'data:text/javascript,' + encodeURIComponent(accelerate)]);
    assert.equal(requests.length, 2);
    assert.equal(rows[0].selectedAttempt, 'case-1-attempt-1');
    assert.equal(rows[0].stopReason, 'deadline');
    assert.equal((await read('case-1-attempt-2/result.json')).failure, 'deadline');
  });

  await t.test('language comparison keeps identical conditions and separates fixture and type outcomes', async () => {
    const reply = call => {
      const typed = call.messages[0].content.includes('TypeScript with native type annotations');
      const code = typed ? `const typed: string = 1;
      const slider = document.querySelector('input');
      const fp = document.querySelector('#false-positives');
      const fn = document.querySelector('#false-negatives');
      slider?.addEventListener('input', () => {
        if (!fp || !fn) return;
        fp.textContent = slider.valueAsNumber < 0.5 ? '2' : '1';
        fn.textContent = slider.valueAsNumber < 0.5 ? '1' : '2';
      });` : 'document.body.dataset.loaded = "true";';
      return { ...draft, code, libraries: [], markup: `<input id="threshold" type="range" min="0" max="1" step="0.01">
        <p id="false-positives">0</p><p id="false-negatives">0</p>` };
    };
    const result = await run(['compare', '--fixture', 'classifier-threshold'], [reply, reply]);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].options, requests[1].options);
    assert.deepEqual(requests[0].messages[1], requests[1].messages[1]);
    assert.equal(requests[0].model, requests[1].model);
    assert.deepEqual(result.rows.map(row => row.language), result.settings.cases[0].order);
    assert.deepEqual(result.rows.map(row => row.order), [1, 2]);
    for (const row of result.rows) {
      const [attempt] = row.attempts;
      const typed = row.language === 'typescript';
      assert.equal(row.working, typed);
      assert.equal(row.passed, false);
      assert.equal(attempt.checks.type, typed ? 'fail' : 'pass');
      assert.equal(attempt.checks.bundle, 'pass');
      const files = await readdir(join(root, result.id, attempt.path));
      assert.ok(files.includes(typed ? 'activity.ts' : 'activity.js'));
      assert.ok(files.includes('activity.bundle.js'));
    }
  });

  await t.test('experiment times out a model call and still completes the other arm', async () => {
    const accelerate = `const original = AbortSignal.timeout;
      AbortSignal.timeout = ms => original(ms > 100000 && ms <= 120000 ? 150 : ms);`;
    const { rows } = await run(['compare', '--fixture', 'classifier-threshold'], [{ hang: true }, draft],
      0, ['--import', 'data:text/javascript,' + encodeURIComponent(accelerate)]);
    assert.equal(rows[0].stopReason, 'deadline');
    assert.equal(rows[0].finished, true);
    assert.equal(rows[1].finished, true);
  });

  await t.test('paired replay rejects an installed digest mismatch', async () => {
    const source = await run(['generate', 'Teach an example', '--no-repair'], [badSyntax], 1);
    const originalDigest = tag.digest;
    tag.digest = 'updated-model';
    try {
      const replay = await run(['replay', source.id], [], 1);
      assert.deepEqual(replay.rows, []);
      assert.equal(replay.settings.skipped[0].reason, 'Installed model digest differs');
    } finally {
      tag.digest = originalDigest;
    }
  });

  await t.test('paired replay shares a truncated first attempt', async () => {
    const source = await run(['generate', 'Teach an example', '--no-repair'], [{ truncated: true }], 1);
    const replay = await run(['replay', source.id], [draft, draft]);
    assert.equal(replay.rows.length, 2);
    assert.deepEqual(replay.rows.map(row => row.policy), replay.settings.cases[0].order);
    assert.deepEqual(replay.rows.map(row => row.order), [1, 2]);
    assert.equal(replay.rows[0].attempts[0].path, replay.rows[1].attempts[0].path);
    assert.equal(replay.rows[0].attempts[0].failure, 'truncated');
    assert.ok(replay.rows.every(row => row.passed && row.source.runId === source.id));
  });
});
