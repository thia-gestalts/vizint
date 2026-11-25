const baseline = 198;
const units = 16;
const plot = document.querySelector('#plot');
const handles = Array.from(plot.querySelectorAll('.handle'));
const squares = Array.from(plot.querySelectorAll('.square'));
const errors = Array.from(plot.querySelectorAll('.error'));
const results = Array.from(document.querySelectorAll('output'));
const values = handles.map((handle) => Number(handle.getAttribute('aria-valuenow')));

function draw() {
  handles.forEach((handle, index) => {
    const { x, truth } = handle.dataset;
    const value = values[index];
    const y = baseline - value * units;
    const truthY = baseline - Number(truth) * units;
    const side = Math.abs(y - truthY);
    const square = squares[index];

    handle.setAttribute('transform', `translate(${x} ${y})`);
    handle.setAttribute('aria-valuenow', value);
    handle.setAttribute('aria-valuetext', `${value}, truth ${truth}`);
    errors[index].setAttribute('y1', y);
    errors[index].setAttribute('y2', truthY);
    square.setAttribute('y', Math.min(y, truthY));
    square.setAttribute('width', side);
    square.setAttribute('height', side);
    const distance = Math.abs(value - Number(truth));
    results[index].value = `${distance}² = ${distance ** 2}`;
  });
}

bindVerticalPointDrag(plot, handles, values, units, draw);
draw();
