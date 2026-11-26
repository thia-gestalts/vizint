const baseline = 198;
const units = 16;
const plot = /** @type {SVGSVGElement} */ (document.querySelector('#plot'));
const handles = /** @type {NodeListOf<SVGGElement>} */ (plot.querySelectorAll('.handle'));
const squares = Array.from(plot.querySelectorAll('.square'));
const errors = Array.from(plot.querySelectorAll('.error'));
const results = Array.from(document.querySelectorAll('output'));
const values = Array.from(handles, (handle) => Number(handle.getAttribute('aria-valuenow')));

function draw() {
  handles.forEach((handle, index) => {
    const { x, truth } = handle.dataset;
    const value = values[index];
    const y = baseline - value * units;
    const truthY = baseline - Number(truth) * units;
    const side = Math.abs(y - truthY);
    const square = squares[index];

    handle.setAttribute('transform', `translate(${x} ${y})`);
    handle.setAttribute('aria-valuenow', String(value));
    handle.setAttribute('aria-valuetext', `${value}, truth ${truth}`);
    errors[index].setAttribute('y1', String(y));
    errors[index].setAttribute('y2', String(truthY));
    square.setAttribute('y', String(Math.min(y, truthY)));
    square.setAttribute('width', String(side));
    square.setAttribute('height', String(side));
    const distance = Math.abs(value - Number(truth));
    results[index].value = `${distance}² = ${distance ** 2}`;
  });
}

bindVerticalPointDrag(plot, handles, values, units, draw);
draw();
