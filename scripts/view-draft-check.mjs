import { Script } from 'node:vm';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { fixActivity } from './activity-codemod.mjs';
import { activityFrame } from './activity-frame.mjs';
import { activityProgram } from './activity-program.mjs';
import { bundleActivity, libraryStyles } from './activity-libraries.mjs';
import { escapeHTML } from './learning-pages.mjs';

const common = await readFile(new URL('../src/frame.css', import.meta.url), 'utf8');

export function remaining(deadline, limit = 300_000) {
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
    const source = activityFrame({ common, libraryStyles: await libraryStyles(draft.libraries), ...draft });
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

export async function checkDraft(draft, folder, browser, fixture, result, deadline, { codemod = true } = {}) {
  const { checks, diagnostics } = result;
  const filename = join(folder, 'activity.js');
  const libraries = draft.libraries ?? [];
  const fixed = codemod && fixActivity({ markup: draft.markup, code: draft.code, libraries }, filename);
  if (fixed) {
    checks.typeErrorsRaw = fixed.before;
    result.codemod = fixed.fixes;
  }
  if (fixed && fixed.code !== draft.code) {
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
