import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixActivity, markupElements } from './activity-codemod.mjs';

const markup = `<label>Threshold <input type="range" id="threshold" class="slider"></label>
<output id="count"></output>
<svg id="plot" viewBox="0 0 10 10"><circle id="marker" class="dot" r="1"></circle></svg>
<canvas id="paint"></canvas>`;

test('markup elements map ids and unambiguous classes to tags', () => {
  const { ids, classes } = markupElements(markup);
  assert.equal(ids.get('threshold'), 'input');
  assert.equal(ids.get('marker'), 'circle');
  assert.equal(classes.get('dot'), 'circle');
});

test('DOM lookups are cast by their markup element', () => {
  const code = `const slider = document.getElementById('threshold');
const marker = document.getElementById('marker');
const plot = document.querySelector('#plot');
const dot = plot.querySelector('.dot');
const count = document.querySelector('#count');
slider.addEventListener('input', () => {
  marker.setAttribute('cx', String(slider.valueAsNumber));
  dot.setAttribute('r', '2');
  count.value = slider.value;
});`;
  const fixed = fixActivity({ markup, code });
  assert.equal(fixed.after, 0, fixed.code);
  assert.ok(fixed.before > 0);
  assert.match(fixed.code, /\/\*\* @type \{HTMLInputElement\} \*\/ \(document\.getElementById\('threshold'\)\)/);
  assert.match(fixed.code, /\/\*\* @type \{SVGCircleElement\} \*\/ \(document\.querySelector\('#marker'\)\)/);
  assert.match(fixed.code, /\/\*\* @type \{SVGCircleElement\} \*\/ \(plot\.querySelector\('\.dot'\)\)/);
});

test('existing casts, instanceof narrowing and correct code stay untouched', () => {
  const code = `const slider = /** @type {HTMLInputElement} */ (document.querySelector('#threshold'));
const count = document.querySelector('#count');
if (count instanceof HTMLOutputElement) count.value = slider.value;`;
  const fixed = fixActivity({ markup, code });
  assert.equal(fixed.before, 0);
  assert.equal(fixed.code, code);
  assert.deepEqual(fixed.fixes, []);
});

test('numbers passed to DOM strings and string arithmetic become explicit', () => {
  const code = `const slider = /** @type {HTMLInputElement} */ (document.querySelector('#threshold'));
const marker = /** @type {SVGCircleElement} */ (document.querySelector('#marker'));
const count = /** @type {HTMLOutputElement} */ (document.querySelector('#count'));
marker.setAttribute('cx', slider.value * 10);
count.textContent = 3;`;
  const fixed = fixActivity({ markup, code });
  assert.equal(fixed.after, 0, fixed.code);
  assert.match(fixed.code, /setAttribute\('cx', String\(Number\(slider\.value\) \* 10\)\)/);
  assert.match(fixed.code, /textContent = String\(3\)/);
});

test('event targets, canvas contexts and implicit any parameters are typed', () => {
  const code = `const paint = /** @type {HTMLCanvasElement} */ (document.querySelector('#paint'));
const context = paint.getContext('2d');
function scale(value) { return value * 2; }
document.querySelector('#threshold')?.addEventListener('input', event => {
  context.fillRect(0, 0, scale(Number(event.target.value)), 1);
});`;
  const fixed = fixActivity({ markup, code });
  assert.equal(fixed.after, 0, fixed.code);
  assert.match(fixed.code, /@type \{CanvasRenderingContext2D\}/);
  assert.match(fixed.code, /@param \{number\} value/);
  assert.match(fixed.code, /@type \{HTMLInputElement\} \*\/ \(event\.target\)/);
});

test('TypeScript syntax is stripped from classic scripts', () => {
  const code = `const count: number = 2;
function double(value: number): number { return value * 2; }
document.body.dataset.count = String(double(count));`;
  const fixed = fixActivity({ markup, code });
  assert.equal(fixed.after, 0, fixed.code);
  assert.equal(fixed.fixes[0].kind, 'strip-typescript');
  assert.doesNotMatch(fixed.code, /: number/);
});

test('fixes are idempotent and real errors remain', () => {
  const code = `const slider = document.getElementById('threshold');
slider.addEventListener('input', () => missing(slider.value));`;
  const once = fixActivity({ markup, code });
  assert.equal(once.after, 1);
  const twice = fixActivity({ markup, code: once.code });
  assert.equal(twice.code, once.code);
  assert.deepEqual(twice.fixes, []);
});

test('lookups through string constants and comment-only JSDoc problems are fixed', () => {
  const code = `/**
 * @typedef {{ k: number, m: number }} Parameters
 */
const countId = 'count';
/**
 * @param {number} value
 * @param {HTMLInputElement} missingInput
 */
function show(value) {
  const count = document.getElementById(countId);
  /** @type {Parameters} */
  const parameters = { k: value, m: 1 };
  count.textContent = String(parameters.k);
}
show(2);`;
  const fixed = fixActivity({ markup, code });
  assert.equal(fixed.after, 0, fixed.code);
  assert.match(fixed.code, /@type \{HTMLOutputElement\} \*\/ \(document\.getElementById\(countId\)\)/);
  assert.match(fixed.code, /@typedef \{\{ k: number, m: number \}\} ParametersShape/);
  assert.match(fixed.code, /@type \{ParametersShape\}/);
  assert.doesNotMatch(fixed.code, /missingInput/);
});
