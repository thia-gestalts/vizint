const prediction = 5;
const baseline = 198;
const units = 16;
const plot = /** @type {SVGSVGElement} */ (document.querySelector('#plot'));
const handles = /** @type {NodeListOf<SVGGElement>} */ (plot.querySelectorAll('.handle'));
const errors = Array.from(plot.querySelectorAll('.error'));
const calculation = /** @type {HTMLOutputElement} */ (document.querySelector('#calculation'));
const values = Array.from(handles, (handle) => Number(handle.getAttribute('aria-valuenow')));
function draw() {
  const squares = values.map((value, index) => {
    const y = baseline - value * units;
    const handle = handles[index];
    handle.setAttribute('transform', `translate(${handle.dataset.x} ${y})`);
    handle.setAttribute('aria-valuenow', String(value));
    const label = handle.querySelector('text');
    if (label) label.textContent = String(value);
    errors[index].setAttribute('y1', String(y));
    return (value - prediction) ** 2;
  });
  const mean = squares.reduce((sum, square) => sum + square, 0) / values.length;
  const result = Number.isInteger(mean) ? `= ${mean}` : `≈ ${mean.toFixed(2)}`;
  calculation.value = `(${squares.join(' + ')}) ÷ ${values.length} ${result}`;
}

bindVerticalPointDrag(plot, handles, values, units, draw);
draw();
