import { engage } from 'vizint';

/** @typedef {[x: number, y: number]} Point */

/** @type {Point[]} */
const points = [[48, 265], [168, 42], [466, 42], [592, 265]];
const plot = /** @type {SVGSVGElement} */ (document.querySelector('#plot'));
const handles = /** @type {NodeListOf<SVGCircleElement>} */ (document.querySelectorAll('#handles circle'));
const parameter = /** @type {HTMLInputElement} */ (document.querySelector('#parameter'));
const parameterValue = /** @type {HTMLOutputElement} */ (document.querySelector('#parameter-value'));
const paths = Object.fromEntries(
  ['polygon', 'curve', 'level-one', 'level-two', 'trace'].map((id) => [
    id, /** @type {SVGPathElement} */ (document.querySelector(`#${id}`)),
  ]),
);
const curvePoint = /** @type {SVGCircleElement} */ (document.querySelector('#curve-point'));
const interpolated = /** @type {SVGGElement} */ (document.querySelector('#interpolated'));
const markers = ['level-one', 'level-one', 'level-one', 'level-two', 'level-two'].map((level) => {
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('r', '4');
  circle.setAttribute('class', level);
  interpolated.append(circle);
  return circle;
});
/** @type {{ id: number, start: DOMPoint, original: Point, moved: boolean } | undefined} */
let drag;

/** @param {number} t */
function levelsAt(t) {
  const levels = [points];
  for (let level = 0; levels[level].length > 1; level++) {
    const last = levels[level];
    levels.push(last.slice(1).map(([x, y], index) => {
      const [startX, startY] = last[index];
      return [startX + (x - startX) * t, startY + (y - startY) * t];
    }));
  }
  return levels;
}

/**
 * @param {SVGCircleElement} circle
 * @param {Point} point
 */
function place(circle, [x, y]) {
  circle.setAttribute('cx', String(x));
  circle.setAttribute('cy', String(y));
}

/**
 * @param {SVGPathElement} path
 * @param {Point[]} vertices
 */
function line(path, vertices) {
  path.setAttribute('d', 'M ' + vertices.map((point) => point.join(' ')).join(' L '));
}

function draw() {
  const t = Number(parameter.value);
  parameterValue.value = t.toFixed(2);
  const [, first, second, [at]] = levelsAt(t);
  paths.curve.setAttribute('d', `M ${points[0].join(' ')} C ${points.slice(1).flat().join(' ')}`);
  line(paths.polygon, points);
  line(paths['level-one'], first);
  line(paths['level-two'], second);
  line(paths.trace, Array.from({ length: 41 }, (_, index) => {
    const levels = levelsAt(t * index / 40);
    return levels[levels.length - 1][0];
  }));
  handles.forEach((handle, index) => place(handle, points[index]));
  [...first, ...second].forEach((point, index) => place(markers[index], point));
  place(curvePoint, at);
}


/**
 * @param {number} index
 * @param {number} x
 * @param {number} y
 */
function move(index, x, y) {
  /** @type {Point} */
  const next = [Math.round(Math.max(14, Math.min(626, x))), Math.round(Math.max(14, Math.min(306, y)))];
  if (next.every((value, axis) => value === points[index][axis])) return false;
  points[index] = next;
  draw();
  return true;
}

/** @type {Partial<Record<string, Point>>} */
const offsets = { ArrowLeft: [-4, 0], ArrowRight: [4, 0], ArrowUp: [0, -4], ArrowDown: [0, 4] };
handles.forEach((handle, index) => {
  handle.addEventListener('pointerdown', (event) => {
    if (drag || event.button !== 0) return;
    const matrix = plot.getScreenCTM();
    if (!matrix) return;
    handle.setPointerCapture(event.pointerId);
    const start = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    drag = { id: event.pointerId, start, original: points[index], moved: false };
  });
  handle.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    const matrix = plot.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    const [x, y] = drag.original;
    drag.moved = move(index, x + dx, y + dy) || drag.moved;
    if (drag.moved) engage();
  });
  handle.addEventListener('lostpointercapture', (event) => {
    if (drag?.id === event.pointerId) drag = undefined;
  });
  handle.addEventListener('keydown', (event) => {
    const offset = offsets[event.key];
    if (!Array.isArray(offset)) return;
    event.preventDefault();
    const [x, y] = points[index];
    if (move(index, x + offset[0], y + offset[1])) engage();
  });
});

parameter.addEventListener('input', draw);
draw();
