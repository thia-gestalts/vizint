import katex from 'katex';

const left = 56;
const right = 620;
const top = 16;
const bottom = 246;
const maxDays = 30;
const step = 0.5;
// Bounds the paper applies in practice: ĥ in [15 min, 9 months], p̂ in [0.0001, 0.9999].
const minHalfLife = 15 / (24 * 60);
const maxHalfLife = 274;
const colors = { now: '#007f75', bias: '#6a3fb5', correct: '#2f7d32', incorrect: '#c2362b' };

/** @typedef {{ day: number, correct: boolean, element: SVGGElement }} Review */

const $ = (/** @type {string} */ selector) => /** @type {any} */ (document.querySelector(selector));
const formula = /** @type {HTMLDivElement} */ ($('#formula'));
const plot = /** @type {SVGSVGElement} */ ($('#plot'));
const grid = /** @type {SVGGElement} */ ($('#grid'));
const hit = /** @type {SVGRectElement} */ ($('#hit'));
const fill = /** @type {SVGPathElement} */ ($('#fill'));
const jumps = /** @type {SVGPathElement} */ ($('#jumps'));
const curve = /** @type {SVGPathElement} */ ($('#curve'));
const guides = /** @type {SVGPathElement} */ ($('#guides'));
const reviewLayer = /** @type {SVGGElement} */ ($('#reviews'));
const nowHandle = /** @type {SVGGElement} */ ($('#now-handle'));
const bias = /** @type {HTMLInputElement} */ ($('#bias'));
const thetaCorrect = /** @type {HTMLInputElement} */ ($('#theta-correct'));
const thetaIncorrect = /** @type {HTMLInputElement} */ ($('#theta-incorrect'));

/** @type {Review[]} */
const reviews = [];
let now = 9.5;
let engaged = false;

/** @param {number} days */
const x = (days) => left + (days / maxDays) * (right - left);
/** @param {number} p */
const y = (p) => bottom - p * (bottom - top);
/** @param {number} value */
const num = (value) => String(Number(value.toFixed(2)));
/** @param {number} value */
const signed = (value) => (value < 0 ? `(${num(value).replace('-', '−')})` : num(value));
/** @param {number} value */
const snap = (value) => Math.round(value / step) * step;
/** @param {number} value @param {number} min @param {number} max */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * @param {string} name
 * @param {Record<string, string | number>} attributes
 * @param {Element} parent
 * @param {string} [text]
 */
function svg(name, attributes, parent, text) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text) element.textContent = text;
  parent.append(element);
  return element;
}

for (const p of [0, 0.25, 0.5, 0.75, 1]) {
  svg('path', { class: 'gridline', d: `M${left} ${y(p)}H${right}` }, grid);
  svg('text', { class: 'tick y', x: left - 8, y: y(p) }, grid, p.toFixed(2));
}
for (let day = 0; day <= maxDays; day += 5) {
  svg('text', { class: 'tick x', x: x(day), y: bottom + 20 }, grid, String(day));
}

/** Θ·x for the feature counts after a review, as in ĥ_Θ = 2^(Θ·x). */
function model(/** @type {number} */ correct, /** @type {number} */ incorrect) {
  const exponent = Number(bias.value) + Number(thetaCorrect.value) * correct + Number(thetaIncorrect.value) * incorrect;
  return { exponent, h: clamp(2 ** exponent, minHalfLife, maxHalfLife) };
}

/** @param {number} delta @param {number} h */
const recall = (delta, h) => clamp(2 ** (-delta / h), 0.0001, 0.9999);

/** Segments between reviews, each with the half-life learned from the reviews so far. */
function segments() {
  let correct = 0;
  let incorrect = 0;
  return reviews.map((review, index) => {
    if (review.correct) correct += 1;
    else incorrect += 1;
    const end = reviews[index + 1]?.day ?? maxDays;
    return { start: review.day, end, correct, incorrect, ...model(correct, incorrect) };
  });
}

function draw() {
  const parts = segments();
  now = clamp(now, reviews[0].day, maxDays);
  let line = '';
  let area = '';
  let jump = '';
  for (const { start, end, h } of parts) {
    const count = Math.max(2, Math.ceil((end - start) * 8));
    const points = Array.from({ length: count + 1 }, (_, index) => {
      const day = start + ((end - start) * index) / count;
      return `${x(day).toFixed(1)} ${y(recall(day - start, h)).toFixed(1)}`;
    });
    if (line) jump += `M${line.split(/[ML]/).at(-1)}V${y(recall(0, h))}`;
    line += `M${points.join('L')}`;
    area += `M${x(start)} ${bottom}L${points.join('L')}L${x(end)} ${bottom}Z`;
  }
  curve.setAttribute('d', line);
  fill.setAttribute('d', area);
  jumps.setAttribute('d', jump);

  const current = [...parts].reverse().find((part) => part.start <= now) ?? parts[0];
  const delta = now - current.start;
  const p = recall(delta, current.h);
  guides.setAttribute('d', `M${x(now)} ${bottom}V${y(p)}H${left}`);
  nowHandle.setAttribute('transform', `translate(${x(now)} ${y(p)})`);
  nowHandle.setAttribute('aria-valuenow', String(now));
  nowHandle.setAttribute('aria-valuetext', `day ${num(now)}, ${num(delta)} days since the last review, predicted recall ${p.toFixed(2)}`);

  for (const review of reviews) {
    review.element.classList.toggle('correct', review.correct);
    review.element.classList.toggle('incorrect', !review.correct);
    review.element.setAttribute('transform', `translate(${x(review.day)} ${y(1)})`);
    review.element.setAttribute('aria-label', `Review on day ${num(review.day)}, ${review.correct ? 'recalled' : 'forgotten'}. Arrows move, Enter toggles, Delete removes.`);
    /** @type {SVGTextElement} */ (review.element.querySelector('text')).textContent = review.correct ? '✓' : '✗';
  }

  for (const input of [bias, thetaCorrect, thetaIncorrect]) {
    /** @type {HTMLOutputElement} */ ($(`#${input.id}-value`)).value = num(Number(input.value));
  }

  const c = (/** @type {keyof typeof colors} */ name, /** @type {string} */ tex) => String.raw`\textcolor{${colors[name]}}{${tex}}`;
  const hText = current.h >= 1 ? `${num(current.h)}\\text{ days}` : `${num(current.h * 24)}\\text{ hours}`;
  const clipped = current.h !== 2 ** current.exponent;
  katex.render(
    String.raw`\begin{aligned}
\hat h_\Theta &= 2^{\Theta\cdot\mathbf{x}}
 = 2^{${c('bias', String.raw`\theta_b`)} + ${c('correct', String.raw`\theta_\oplus`)} x_\oplus + ${c('incorrect', String.raw`\theta_\ominus`)} x_\ominus}
 = 2^{${c('bias', signed(Number(bias.value)))} + ${c('correct', signed(Number(thetaCorrect.value)))}\cdot ${current.correct} + ${c('incorrect', signed(Number(thetaIncorrect.value)))}\cdot ${current.incorrect}}
 ${clipped ? String.raw`\to` : '='} ${hText} \\
\hat p_\Theta &= 2^{-${c('now', String.raw`\Delta`)}/\hat h_\Theta} = 2^{-${c('now', num(delta))}/${num(current.h)}} \approx ${p.toFixed(2)}
\end{aligned}`,
    formula,
    { displayMode: true, throwOnError: true },
  );
}

function engage() {
  if (engaged) return;
  engaged = true;
  parent.postMessage({ type: 'control-point-moved' }, '*');
}

function changed() {
  draw();
  engage();
}

/** @param {PointerEvent} event */
function toPlot(event) {
  const matrix = plot.getScreenCTM();
  if (!matrix) return undefined;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  return { day: ((point.x - left) / (right - left)) * maxDays, y: point.y };
}

/** Free day nearest to `day`, keeping reviews at least one step apart and between neighbours. */
function placeable(/** @type {number} */ day, /** @type {Review | undefined} */ moving) {
  const index = moving ? reviews.indexOf(moving) : -1;
  if (moving) {
    const min = index > 0 ? reviews[index - 1].day + step : 0;
    const max = index < reviews.length - 1 ? reviews[index + 1].day - step : maxDays;
    return clamp(snap(day), min, max);
  }
  const target = clamp(snap(day), 0, maxDays);
  return reviews.some((review) => review.day === target) ? undefined : target;
}

/** @param {number} day @param {boolean} correct */
function addReview(day, correct) {
  const free = placeable(day, undefined);
  if (free === undefined) return;
  const element = /** @type {SVGGElement} */ (svg('g', { class: 'review', tabindex: 0, role: 'button' }, reviewLayer));
  svg('circle', { r: 11 }, element);
  svg('text', {}, element);
  /** @type {Review} */
  const review = { day: free, correct, element };
  const index = reviews.findIndex((other) => other.day > free);
  if (index === -1) reviews.push(review);
  else {
    reviews.splice(index, 0, review);
    reviewLayer.insertBefore(element, reviews[index + 1].element);
  }
  bindReview(review);
  return review;
}

/** @param {Review} review */
function removeReview(review) {
  if (reviews.length === 1) return false;
  reviews.splice(reviews.indexOf(review), 1);
  review.element.remove();
  return true;
}

/** @param {Review} review */
function bindReview(review) {
  const { element } = review;
  /** @type {{ id: number, startX: number, dragged: boolean } | undefined} */
  let drag;
  element.addEventListener('pointerdown', (event) => {
    if (drag || event.button !== 0) return;
    event.stopPropagation();
    drag = { id: event.pointerId, startX: event.clientX, dragged: false };
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    const point = toPlot(event);
    if (!point) return;
    if (Math.abs(event.clientX - drag.startX) > 4 || point.y > y(0.85)) drag.dragged = true;
    if (!drag.dragged) return;
    element.classList.toggle('removing', point.y > bottom && reviews.length > 1);
    const day = placeable(point.day, review);
    if (day !== undefined && day !== review.day) {
      review.day = day;
      changed();
    }
    element.setAttribute('transform', `translate(${x(review.day)} ${Math.max(y(1), point.y)})`);
  });
  element.addEventListener('pointerup', (event) => {
    if (drag?.id !== event.pointerId) return;
    const point = toPlot(event);
    if (!drag.dragged) {
      review.correct = !review.correct;
      changed();
    } else if (point && point.y > bottom && removeReview(review)) {
      changed();
    }
    element.classList.remove('removing');
    draw();
  });
  element.addEventListener('lostpointercapture', () => { drag = undefined; });
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') review.correct = !review.correct;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') review.day = placeable(review.day - step, review) ?? review.day;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') review.day = placeable(review.day + step, review) ?? review.day;
    else if (event.key === 'Delete' || event.key === 'Backspace') {
      const index = reviews.indexOf(review);
      if (!removeReview(review)) return;
      (reviews[Math.min(index, reviews.length - 1)].element).focus();
    } else return;
    event.preventDefault();
    changed();
  });
}

hit.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const point = toPlot(event);
  if (point && addReview(point.day, true)) changed();
});

/** @type {number | undefined} */
let nowPointer;
nowHandle.addEventListener('pointerdown', (event) => {
  if (nowPointer !== undefined || event.button !== 0) return;
  nowPointer = event.pointerId;
  nowHandle.setPointerCapture(event.pointerId);
});
nowHandle.addEventListener('pointermove', (event) => {
  if (nowPointer !== event.pointerId) return;
  const point = toPlot(event);
  if (!point) return;
  const next = clamp(snap(point.day), reviews[0].day, maxDays);
  if (next === now) return;
  now = next;
  changed();
});
nowHandle.addEventListener('lostpointercapture', () => { nowPointer = undefined; });
nowHandle.addEventListener('keydown', (event) => {
  /** @type {Partial<Record<string, number>>} */
  const offsets = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step };
  const offset = offsets[event.key];
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? maxDays : offset === undefined ? undefined : now + offset;
  if (next === undefined) return;
  event.preventDefault();
  now = next;
  changed();
});

for (const [id, correct] of /** @type {const} */ ([['#review-correct', true], ['#review-incorrect', false]])) {
  $(id).addEventListener('click', () => {
    const existing = reviews.find((review) => review.day === snap(now));
    if (existing) existing.correct = correct;
    else addReview(now, correct);
    changed();
  });
}
for (const input of [bias, thetaCorrect, thetaIncorrect]) input.addEventListener('input', changed);

for (const [day, correct] of /** @type {const} */ ([[0, true], [2, true], [5, false], [7, true], [12, true], [22, true]])) {
  addReview(day, correct);
}
draw();
