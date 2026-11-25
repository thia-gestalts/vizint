const prediction = 5;
const baseline = 198;
const units = 16;
const plot = document.querySelector('#plot');
const handles = Array.from(plot.querySelectorAll('.handle'));
const errors = Array.from(plot.querySelectorAll('.error'));
const calculation = document.querySelector('#calculation');
const values = handles.map((handle) => Number(handle.getAttribute('aria-valuenow')));
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

bindVerticalPointDrag(plot, handles, values, units, draw);
draw();
