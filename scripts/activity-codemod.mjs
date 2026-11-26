// Deterministic, runtime-equivalent fixes for the DOM typing noise that strict
// checkJs reports in generated activities. Every edit either adds a JSDoc
// comment, adds a cast the browser check already verifies at runtime, makes an
// implicit DOM string conversion explicit, or strips TypeScript-only syntax.
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { parse } from 'yaml';
import { activityLanguageService } from './activity-program.mjs';

const htmlTypes = {
  a: 'HTMLAnchorElement', button: 'HTMLButtonElement', canvas: 'HTMLCanvasElement', details: 'HTMLDetailsElement',
  div: 'HTMLDivElement', fieldset: 'HTMLFieldSetElement', form: 'HTMLFormElement', h1: 'HTMLHeadingElement',
  h2: 'HTMLHeadingElement', h3: 'HTMLHeadingElement', h4: 'HTMLHeadingElement', h5: 'HTMLHeadingElement',
  h6: 'HTMLHeadingElement', img: 'HTMLImageElement', input: 'HTMLInputElement', label: 'HTMLLabelElement',
  li: 'HTMLLIElement', meter: 'HTMLMeterElement', ol: 'HTMLOListElement', option: 'HTMLOptionElement',
  output: 'HTMLOutputElement', p: 'HTMLParagraphElement', pre: 'HTMLPreElement', progress: 'HTMLProgressElement',
  select: 'HTMLSelectElement', span: 'HTMLSpanElement', table: 'HTMLTableElement', tbody: 'HTMLTableSectionElement',
  td: 'HTMLTableCellElement', textarea: 'HTMLTextAreaElement', th: 'HTMLTableCellElement', tr: 'HTMLTableRowElement',
  ul: 'HTMLUListElement',
};
const svgTypes = {
  circle: 'SVGCircleElement', defs: 'SVGDefsElement', ellipse: 'SVGEllipseElement', g: 'SVGGElement',
  line: 'SVGLineElement', marker: 'SVGMarkerElement', path: 'SVGPathElement', polygon: 'SVGPolygonElement',
  polyline: 'SVGPolylineElement', rect: 'SVGRectElement', svg: 'SVGSVGElement', text: 'SVGTextElement',
  tspan: 'SVGTSpanElement', use: 'SVGUseElement',
};
const inputProperties = new Set(['value', 'valueAsNumber', 'checked', 'min', 'max', 'step']);
const typeScriptOnly = new Set([8002, 8004, 8005, 8006, 8008, 8009, 8010, 8011, 8012, 8013, 8016, 8017]);
const implicitAny = new Set([7005, 7006, 7008, 7019, 7031, 7034]);

/** Map element ids and classes in an HTML fragment to their tag names. */
export function markupElements(markup) {
  const ids = new Map();
  const classes = new Map();
  for (const [, tag, attributes = ''] of markup.matchAll(/<([a-zA-Z][\w-]*)(\s[^>]*)?>/g)) {
    const name = tag.toLowerCase();
    const id = attributes.match(/\sid\s*=\s*(["'])(.*?)\1/)?.[2];
    if (id) ids.set(id, name);
    for (const value of attributes.match(/\sclass\s*=\s*(["'])(.*?)\1/)?.[2].split(/\s+/).filter(Boolean) ?? []) {
      classes.set(value, classes.has(value) && classes.get(value) !== name ? null : name);
    }
  }
  return { ids, classes };
}

function typeOfTag(tag) {
  return svgTypes[tag] ?? htmlTypes[tag] ?? (tag ? 'HTMLElement' : undefined);
}

/** The tag a simple selector refers to, judged by its last compound. */
function selectorTag(selector, elements) {
  const last = selector.trim().split(/\s*[\s>+~]\s*/).at(-1);
  const match = last?.match(/^([a-zA-Z][\w-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)$/);
  if (!match) return undefined;
  const [, tag, id, classList] = match;
  if (tag) return tag.toLowerCase();
  if (id) return elements.ids.get(id);
  const names = classList.split('.').filter(Boolean).map(name => elements.classes.get(name)).filter(Boolean);
  return names.length && names.every(name => name === names[0]) ? names[0] : undefined;
}

function isCast(node) {
  return ts.isParenthesizedExpression(node.parent) && Boolean(ts.getJSDocTypeTag(node.parent));
}

function nodeAt(source, start, length) {
  let found;
  const visit = node => {
    if (node.getStart(source) <= start && start + length <= node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(source, visit);
  return found;
}

function applyEdits(text, edits) {
  const accepted = [];
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (accepted.some(other => edit.start < other.end && other.start < edit.end)) continue;
    accepted.push(edit);
  }
  let next = text;
  for (const edit of accepted) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  return { text: next, count: accepted.length };
}

function domCasts(text, elements) {
  const source = ts.createSourceFile('activity.js', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const edits = [];
  const wrap = (node, type, replacement = node.getText(source)) => edits.push({
    start: node.getStart(source), end: node.end, text: `/** @type {${type}} */ (${replacement})`,
  });
  // Resolve lookups like getElementById(frequencyId) through unique string constants.
  const constants = new Map();
  const collect = node => {
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const) {
      for (const declaration of node.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        const value = declaration.initializer && ts.isStringLiteralLike(declaration.initializer)
          ? declaration.initializer.text : null;
        constants.set(name, constants.has(name) ? null : value);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const literal = argument => ts.isStringLiteralLike(argument) ? argument.text
    : ts.isIdentifier(argument) ? constants.get(argument.text) ?? undefined : undefined;
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.arguments.length === 1 && literal(node.arguments[0]) !== undefined && isCast(node) &&
        node.expression.name.text === 'getElementById' && /^[A-Za-z][\w-]*$/.test(literal(node.arguments[0])) &&
        /^\s*SVG/.test(ts.getJSDocTypeTag(node.parent)?.typeExpression?.type.getText(source) ?? '')) {
      // An existing SVG cast over getElementById: HTMLElement does not convert to SVG types.
      edits.push({ start: node.getStart(source), end: node.end,
        text: `${node.expression.expression.getText(source)}.querySelector('#${literal(node.arguments[0])}')` });
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.arguments.length === 1 && literal(node.arguments[0]) !== undefined && !isCast(node) &&
        !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)) {
      const method = node.expression.name.text;
      const value = literal(node.arguments[0]);
      if (method === 'getElementById' || method === 'querySelector') {
        const tag = method === 'getElementById' ? elements.ids.get(value) : selectorTag(value, elements);
        const type = typeOfTag(tag);
        if (type && method === 'getElementById' && svgTypes[tag]) {
          // getElementById returns HTMLElement, which does not convert to an SVG element type.
          if (/^[A-Za-z][\w-]*$/.test(value)) {
            wrap(node, type, `${node.expression.expression.getText(source)}.querySelector('#${value}')`);
          }
        } else if (type) {
          wrap(node, type);
        }
      }
      if (method === 'getContext' && value === '2d') wrap(node, 'CanvasRenderingContext2D');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edits;
}

function diagnosticEdits(text, diagnostics) {
  const source = ts.createSourceFile('activity.js', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const edits = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.start === undefined) continue;
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').split('\n')[0];
    const node = nodeAt(source, diagnostic.start, diagnostic.length ?? 0);
    if (!node) continue;
    if (/^(?:Argument of type|Type) 'number' is not assignable to (?:parameter of )?type 'string'/.test(message)) {
      let target = node;
      if (diagnostic.code === 2322) {
        // Reported on the assignment target; convert the assigned value.
        while (target.parent && !(ts.isBinaryExpression(target.parent) &&
          target.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && target.parent.left === target)) {
          if (target.parent.getStart(source) !== diagnostic.start) break;
          target = target.parent;
        }
        if (!ts.isBinaryExpression(target.parent) || target.parent.left !== target) continue;
        target = target.parent.right;
      }
      if (ts.isExpression(target)) {
        edits.push({ start: target.getStart(source), end: target.end, text: `String(${target.getText(source)})` });
      }
    }
    if ((diagnostic.code === 2362 || diagnostic.code === 2363) && ts.isExpression(node) &&
        ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
      // The operator already coerces the string operand; make that explicit.
      edits.push({ start: node.getStart(source), end: node.end, text: `Number(${node.getText(source)})` });
    }
    const property = message.match(/^Property '(\w+)' does not exist on type '(EventTarget|HTMLElement|Element)'/);
    if (property && inputProperties.has(property[1]) && ts.isPropertyAccessExpression(node.parent) &&
        node.parent.name === node) {
      const target = node.parent.expression;
      edits.push({ start: target.getStart(source), end: target.end,
        text: `/** @type {HTMLInputElement} */ (${target.getText(source)})` });
    }
  }
  return edits;
}

/** Comment-only fixes: drop @param tags for missing parameters, rename typedefs that shadow lib types. */
function jsdocEdits(text, diagnostics) {
  const edits = [];
  const renames = new Set();
  for (const diagnostic of diagnostics) {
    if (diagnostic.start === undefined || diagnostic.file?.text !== text) continue;
    if (diagnostic.code === 8024) {
      const lineStart = text.lastIndexOf('\n', diagnostic.start) + 1;
      const lineEnd = text.indexOf('\n', diagnostic.start);
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      if (/^\s*\*\s*@param\b/.test(line)) edits.push({ start: lineStart, end: lineEnd === -1 ? text.length : lineEnd + 1, text: '' });
    }
    if (diagnostic.code === 2300) {
      const name = text.slice(diagnostic.start, diagnostic.start + diagnostic.length);
      const before = text.slice(Math.max(0, diagnostic.start - 200), diagnostic.start);
      if (/^\w+$/.test(name) && /@typedef\s*(?:\{.*\}\s*)?$/.test(before)) renames.add(name);
    }
  }
  for (const name of renames) {
    const source = ts.createSourceFile('activity.js', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    // Only JSDoc comments reference typedefs, so the rename never touches runtime code.
    for (const range of commentRanges(source)) {
      for (const match of text.slice(range.pos, range.end).matchAll(new RegExp(`\\b${name}\\b`, 'g'))) {
        const start = range.pos + match.index;
        edits.push({ start, end: start + name.length, text: `${name}Shape` });
      }
    }
  }
  return edits;
}

function commentRanges(source) {
  const ranges = new Map();
  const visit = node => {
    for (const range of ts.getLeadingCommentRanges(source.text, node.pos) ?? []) ranges.set(range.pos, range);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const range of ts.getLeadingCommentRanges(source.text, source.endOfFileToken.pos) ?? []) ranges.set(range.pos, range);
  return [...ranges.values()];
}

function stripTypeScript(text) {
  return ts.transpileModule(text, {
    fileName: 'activity.ts',
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true,
      removeComments: false,
    },
  }).outputText.replace(/\n?export \{\};\s*$/, '\n');
}

/**
 * Apply runtime-equivalent typing fixes. Each step is kept only when it does
 * not increase the error count.
 */
export function fixActivity({ markup = '', code, libraries = [] }, filename = resolve('.activity-codemod/activity.js')) {
  const elements = markupElements(markup);
  const language = activityLanguageService(filename, code, libraries);
  const fixes = new Map();
  const before = language.errors().length;
  let errors = before;
  const attempt = (kind, next, count) => {
    if (next === language.text || !count) return false;
    const previous = language.text;
    language.update(next);
    const after = language.errors().length;
    if (after > errors) {
      language.update(previous);
      return false;
    }
    errors = after;
    fixes.set(kind, (fixes.get(kind) ?? 0) + count);
    return true;
  };

  for (let pass = 0; pass < 3 && errors; pass++) {
    let changed = false;
    const tsOnly = language.errors().filter(item => typeScriptOnly.has(item.code)).length;
    if (tsOnly) changed = attempt('strip-typescript', stripTypeScript(language.text), tsOnly) || changed;

    const casts = applyEdits(language.text, domCasts(language.text, elements));
    changed = attempt('dom-cast', casts.text, casts.count) || changed;

    const conversions = applyEdits(language.text, diagnosticEdits(language.text, language.errors()));
    changed = attempt('explicit-conversion', conversions.text, conversions.count) || changed;

    const jsdoc = applyEdits(language.text, jsdocEdits(language.text, language.errors()));
    changed = attempt('jsdoc-cleanup', jsdoc.text, jsdoc.count) || changed;

    const untyped = language.errors().filter(item => implicitAny.has(item.code)).length;
    if (untyped) {
      const { changes } = language.service.getCombinedCodeFix(
        { type: 'file', fileName: filename }, 'inferFromUsage', {}, {});
      const edits = changes.flatMap(change => change.textChanges)
        .map(({ span, newText }) => ({ start: span.start, end: span.start + span.length, text: newText }));
      const inferred = applyEdits(language.text, edits);
      changed = attempt('infer-jsdoc', inferred.text, untyped) || changed;
    }
    if (!changed) break;
  }
  return {
    code: language.text, before, after: errors,
    fixes: [...fixes].map(([kind, count]) => ({ kind, count })),
  };
}

async function report(root) {
  const rows = [];
  for (const run of (await readdir(root, { withFileTypes: true })).filter(item => item.isDirectory())) {
    for (const attempt of await readdir(join(root, run.name), { withFileTypes: true })) {
      if (!attempt.isDirectory()) continue;
      const folder = join(root, run.name, attempt.name);
      const read = name => readFile(join(folder, name), 'utf8').catch(() => null);
      const [markup, code, manifest, saved] = await Promise.all(
        ['activity.html', 'activity.raw.js', 'view.yml', 'result.json'].map(read));
      const source = code ?? await read('activity.js');
      if (!source || markup === null) continue;
      const result = JSON.parse(saved ?? '{}');
      if (result.strategy === 'control') continue;
      const libraries = parse(manifest ?? '')?.libraries ?? [];
      const fixed = fixActivity({ markup, code: source, libraries });
      const checks = result.checks ?? {};
      const working = checks.startup === 'pass' && checks.fixture === 'pass';
      rows.push({ attempt: `${run.name}/${attempt.name}`, before: fixed.before, after: fixed.after, working,
        starts: checks.startup === 'pass', fixes: fixed.fixes });
    }
  }
  for (const row of rows) {
    console.log(`${String(row.before).padStart(3)} → ${String(row.after).padStart(3)}  ${row.working ? 'working' : row.starts ? 'starts ' : 'broken '}  ${row.attempt}  ${row.fixes.map(fix => `${fix.kind}×${fix.count}`).join(' ')}`);
  }
  const sum = key => rows.reduce((total, row) => total + row[key], 0);
  console.log(`\n${rows.length} drafts · type errors ${sum('before')} → ${sum('after')}`);
  console.log(`zero type errors: ${rows.filter(row => row.before === 0).length} → ${rows.filter(row => row.after === 0).length}`);
  console.log(`working fixture drafts now publishable: ${rows.filter(row => row.working && row.after === 0).length} of ${rows.filter(row => row.working).length}`);
  console.log(`starting drafts with zero type errors: ${rows.filter(row => row.starts && row.after === 0).length} of ${rows.filter(row => row.starts).length}`);
}

if (import.meta.main) {
  const [flag, root = '.view-generation'] = process.argv.slice(2);
  if (flag !== '--report') {
    console.error('Usage: node scripts/activity-codemod.mjs --report [RUNS_DIRECTORY]');
    process.exitCode = 1;
  } else {
    await report(resolve(root));
  }
}
