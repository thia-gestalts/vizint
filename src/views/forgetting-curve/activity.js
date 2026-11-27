import katex from 'katex';

const left = 56;
const right = 620;
const top = 16;
const bottom = 246;
const maxDays = 30;
const colors = { elapsed: '#007f75', halfLife: '#ab5416' };

const formula = /** @type {HTMLDivElement} */ (document.querySelector('#formula'));
const plot = /** @type {SVGSVGElement} */ (document.querySelector('#plot'));
const grid = /** @type {SVGGElement} */ (document.querySelector('#grid'));
const curve = /** @type {SVGPathElement} */ (document.querySelector('#curve'));
const guides = /** @type {SVGPathElement} */ (document.querySelector('#guides'));
const elapsed = /** @type {HTMLInputElement} */ (document.querySelector('#elapsed'));
const halfLife = /** @type {HTMLInputElement} */ (document.querySelector('#half-life'));
const elapsedValue = /** @type {HTMLOutputElement} */ (document.querySelector('#elapsed-value'));
const halfLifeValue = /** @type {HTMLOutputElement} */ (document.querySelector('#half-life-value'));
const elapsedHandle = /** @type {SVGGElement} */ (document.querySelector('#elapsed-handle'));
const halfLifeHandle = /** @type {SVGGElement} */ (document.querySelector('#half-life-handle'));
let engaged = false;

/** @param {number} days */
const x = (days) => left + (days / maxDays) * (right - left);
/** @param {number} p */
const y = (p) => bottom - p * (bottom - top);
/** @param {number} value */
const days = (value) => String(Number(value.toFixed(1)));

/**
 * @param {string} name
 * @param {Record<string, string | number>} attributes
 * @param {string} [text]
 */
function svg(name, attributes, text) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text) element.textContent = text;
  grid.append(element);
}

for (const p of [0, 0.25, 0.5, 0.75, 1]) {
  svg('path', { class: 'gridline', d: `M${left} ${y(p)}H${right}` });
  svg('text', { class: 'tick y', x: left - 8, y: y(p) }, p.toFixed(2));
}
for (let day = 0; day <= maxDays; day += 5) {
  svg('text', { class: 'tick x', x: x(day), y: bottom + 20 }, String(day));
}

function draw() {
  const delta = Number(elapsed.value);
  const h = Number(halfLife.value);
  const p = 2 ** (-delta / h);
  const points = Array.from({ length: 121 }, (_, index) => {
    const day = (maxDays * index) / 120;
    return `${x(day).toFixed(1)} ${y(2 ** (-day / h)).toFixed(1)}`;
  });
  curve.setAttribute('d', `M${points.join('L')}`);
  guides.setAttribute('d', `M${x(delta)} ${bottom}V${y(p)}H${left} M${x(h)} ${bottom}V${y(0.5)}H${left}`);
  elapsedHandle.setAttribute('transform', `translate(${x(delta)} ${y(p)})`);
  halfLifeHandle.setAttribute('transform', `translate(${x(h)} ${y(0.5)})`);
  elapsedHandle.setAttribute('aria-valuenow', String(delta));
  elapsedHandle.setAttribute('aria-valuetext', `${days(delta)} days, recall probability ${p.toFixed(2)}`);
  halfLifeHandle.setAttribute('aria-valuenow', String(h));
  halfLifeHandle.setAttribute('aria-valuetext', `${days(h)} days`);
  elapsedValue.value = days(delta);
  halfLifeValue.value = days(h);

  const exact = String(p).length <= 6;
  const D = (/** @type {string} */ tex) => String.raw`\textcolor{${colors.elapsed}}{${tex}}`;
  const H = (/** @type {string} */ tex) => String.raw`\textcolor{${colors.halfLife}}{${tex}}`;
  katex.render(
    String.raw`p = 2^{-${D(String.raw`\Delta`)}/${H('h')}} = 2^{-${D(days(delta))}/${H(days(h))}} ${exact ? '=' : String.raw`\approx`} ${exact ? String(p) : p.toFixed(2)}`,
    formula,
    { displayMode: true, throwOnError: true },
  );
}

function engage() {
  if (engaged) return;
  engaged = true;
  parent.postMessage({ type: 'control-point-moved' }, '*');
}

/**
 * @param {HTMLInputElement} input
 * @param {number} value
 */
function set(input, value) {
  const step = Number(input.step);
  const next = Math.min(Number(input.max), Math.max(Number(input.min), Math.round(value / step) * step));
  if (next === Number(input.value)) return;
  input.value = String(next);
  draw();
  engage();
}

/**
 * @param {SVGGElement} handle
 * @param {HTMLInputElement} input
 */
function bindHandle(handle, input) {
  /** @type {number | undefined} */
  let pointer;
  handle.addEventListener('pointerdown', (event) => {
    if (pointer !== undefined || event.button !== 0) return;
    pointer = event.pointerId;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (pointer !== event.pointerId) return;
    const matrix = plot.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    set(input, ((point.x - left) / (right - left)) * maxDays);
  });
  handle.addEventListener('lostpointercapture', () => { pointer = undefined; });
  handle.addEventListener('keydown', (event) => {
    const step = Number(input.step);
    /** @type {Partial<Record<string, number>>} */
    const offsets = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step };
    const offset = offsets[event.key];
    const value = event.key === 'Home' ? Number(input.min)
      : event.key === 'End' ? Number(input.max)
        : offset === undefined ? undefined : Number(input.value) + offset;
    if (value === undefined) return;
    event.preventDefault();
    set(input, value);
  });
}

bindHandle(elapsedHandle, elapsed);
bindHandle(halfLifeHandle, halfLife);
for (const input of [elapsed, halfLife]) {
  input.addEventListener('input', () => {
    draw();
    engage();
  });
}
draw();
