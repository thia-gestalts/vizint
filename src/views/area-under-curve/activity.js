import { engage, reportHeight } from 'vizint';

const limit = /** @type {HTMLInputElement} */ (document.querySelector('#limit'));
const count = /** @type {HTMLInputElement} */ (document.querySelector('#count'));
const limitValue = /** @type {HTMLSpanElement} */ (document.querySelector('#limit-value'));
const countValue = /** @type {HTMLSpanElement} */ (document.querySelector('#count-value'));
const exactArea = /** @type {HTMLOutputElement} */ (document.querySelector('#exact-area'));
const estimatedArea = /** @type {HTMLOutputElement} */ (document.querySelector('#estimated-area'));
const area = /** @type {SVGPathElement} */ (document.querySelector('#area'));
const rectangles = /** @type {SVGPathElement} */ (document.querySelector('#rectangles'));
const curve = /** @type {SVGPathElement} */ (document.querySelector('#curve'));
const endpoint = /** @type {SVGCircleElement} */ (document.querySelector('#endpoint'));
const formatArea = new Intl.NumberFormat('en', { maximumFractionDigits: 4 });

/** @param {number} x */
const plotX = (x) => 44 + 85 * x;
/** @param {number} y */
const plotY = (y) => 244 - 13 * y;

const origin = `${plotX(0)} ${plotY(0)}`;

/** @param {number} end */
function curveTo(end) {
  return `Q ${plotX(end / 2)} ${plotY(0)} ${plotX(end)} ${plotY(end ** 2)}`;
}

function draw() {
  const end = limit.valueAsNumber;
  const pieces = count.valueAsNumber;
  const width = end / pieces;
  const rectanglePaths = [];
  let estimate = 0;

  // The first rectangle has height zero because it starts at x = 0.
  for (let index = 1; index < pieces; index++) {
    const left = index * width;
    const height = left ** 2;
    estimate += width * height;
    rectanglePaths.push(
      `M ${plotX(left)} ${plotY(0)} V ${plotY(height)} H ${plotX((index + 1) * width)} V ${plotY(0)} Z`,
    );
  }

  area.setAttribute('d', `M ${origin} ${curveTo(end)} V ${plotY(0)} Z`);
  rectangles.setAttribute('d', rectanglePaths.join(' '));
  endpoint.setAttribute('cx', String(plotX(end)));
  endpoint.setAttribute('cy', String(plotY(end ** 2)));
  limitValue.textContent = limit.value;
  countValue.textContent = count.value;
  exactArea.value = formatArea.format(end ** 3 / 3);
  estimatedArea.value = formatArea.format(estimate);
}

for (const control of [limit, count]) {
  control.addEventListener('input', () => {
    draw();
    engage();
  });
}
curve.setAttribute('d', `M ${origin} ${curveTo(Number(limit.max))}`);
draw();
reportHeight(document.body);
