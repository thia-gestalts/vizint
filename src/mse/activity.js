const prediction = 5;
const baseline = 198;
const units = 16;
const plot = document.querySelector('#plot');
const handles = Array.from(plot.querySelectorAll('.handle'));
const errors = Array.from(plot.querySelectorAll('.error'));
const calculation = document.querySelector('#calculation');
const values = handles.map((handle) => Number(handle.getAttribute('aria-valuenow')));
const steps = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };
let drag;
let engaged = false;

function draw() {
  const squares = values.map((value, index) => {
    const y = baseline - value * units;
    const handle = handles[index];
    handle.setAttribute('transform', `translate(${handle.dataset.x} ${y})`);
    handle.setAttribute('aria-valuenow', value);
    handle.querySelector('text').textContent = value;
    errors[index].setAttribute('y1', y);
    return (value - prediction) ** 2;
  });
  const mean = squares.reduce((sum, square) => sum + square, 0) / values.length;
  const result = Number.isInteger(mean) ? `= ${mean}` : `≈ ${mean.toFixed(2)}`;
  calculation.value = `(${squares.join(' + ')}) ÷ ${values.length} ${result}`;
}

function move(index, value) {
  const next = Math.max(0, Math.min(10, Math.round(value)));
  if (values[index] === next) return;
  values[index] = next;
  draw();
  if (!engaged) {
    engaged = true;
    parent.postMessage({ type: 'control-point-moved' }, '*');
  }
}

function pointerY(event) {
  return new DOMPoint(event.clientX, event.clientY).matrixTransform(plot.getScreenCTM().inverse()).y;
}

handles.forEach((handle, index) => {
  handle.addEventListener('touchstart', (event) => {
    // Keep a drag within this frame from scrolling the containing page.
    event.preventDefault();
  }, { passive: false });
  handle.addEventListener('pointerdown', (event) => {
    if (drag || event.button !== 0) return;
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, startY: pointerY(event), value: values[index] };
  });
  handle.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    move(index, drag.value + (drag.startY - pointerY(event)) / units);
  });
  handle.addEventListener('lostpointercapture', (event) => {
    if (drag?.id === event.pointerId) drag = undefined;
  });
  handle.addEventListener('keydown', (event) => {
    const destinations = { Home: 0, End: 10 };
    const next = destinations[event.key] ?? values[index] + steps[event.key];
    if (!Number.isFinite(next)) return;
    event.preventDefault();
    move(index, next);
  });
});

draw();
