const points = [[48, 265], [168, 42], [466, 42], [592, 265]];
const plot = document.querySelector('#plot');
const handles = Array.from(document.querySelectorAll('#handles circle'));
const parameter = document.querySelector('#parameter');
const parameterValue = document.querySelector('#parameter-value');
const paths = Object.fromEntries(
  ['polygon', 'curve', 'level-one', 'level-two', 'trace'].map((id) => [id, document.getElementById(id)]),
);
const curvePoint = document.querySelector('#curve-point');
const interpolated = document.querySelector('#interpolated');
const markers = ['level-one', 'level-one', 'level-one', 'level-two', 'level-two'].map((level) => {
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('r', '4');
  circle.setAttribute('class', level);
  interpolated.append(circle);
  return circle;
});
let drag;
let engaged = false;

function levelsAt(t) {
  const levels = [points];
  while (levels.at(-1).length > 1) {
    const last = levels.at(-1);
    levels.push(last.slice(1).map(([x, y], index) => {
      const [startX, startY] = last[index];
      return [startX + (x - startX) * t, startY + (y - startY) * t];
    }));
  }
  return levels;
}

function place(circle, [x, y]) {
  circle.setAttribute('cx', x);
  circle.setAttribute('cy', y);
}

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
  line(paths.trace, Array.from({ length: 41 }, (_, index) => levelsAt(t * index / 40).at(-1)[0]));
  handles.forEach((handle, index) => place(handle, points[index]));
  [...first, ...second].forEach((point, index) => place(markers[index], point));
  place(curvePoint, at);
}

function engage() {
  if (engaged) return;
  engaged = true;
  parent.postMessage({ type: 'control-point-moved' }, '*');
}

function move(index, x, y) {
  const next = [Math.round(Math.max(14, Math.min(626, x))), Math.round(Math.max(14, Math.min(306, y)))];
  if (next.every((value, axis) => value === points[index][axis])) return false;
  points[index] = next;
  draw();
  return true;
}

const offsets = { ArrowLeft: [-4, 0], ArrowRight: [4, 0], ArrowUp: [0, -4], ArrowDown: [0, 4] };
handles.forEach((handle, index) => {
  handle.addEventListener('pointerdown', (event) => {
    if (drag || event.button !== 0) return;
    handle.setPointerCapture(event.pointerId);
    const start = new DOMPoint(event.clientX, event.clientY).matrixTransform(plot.getScreenCTM().inverse());
    drag = { id: event.pointerId, start, original: points[index], moved: false };
  });
  handle.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(plot.getScreenCTM().inverse());
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
