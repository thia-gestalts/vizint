import { engage, reportHeight } from 'vizint';

const inputs = [...document.querySelectorAll('input')];
const bars = document.querySelectorAll(/** @type {'div'} */ ('div.share'));
const buttons = [...document.querySelectorAll('.presets button')];
const presets = [
  [45, 5, 5, 45],
  [0, 5, 5, 90],
  [0, 50, 50, 0],
  [0, 10, 0, 90],
];
const explanations = [
  'Both classes are usually predicted correctly.',
  'Accuracy stays at 90% even though every actual positive is missed.',
  'Every prediction is wrong, so the labels are perfectly anticorrelated.',
  'Accuracy is 90%, but MCC is undefined because all predictions have the same label.',
];

const main = /** @type {HTMLElement} */ (document.querySelector('main'));
const score = /** @type {HTMLElement} */ (document.getElementById('mcc'));
const accuracy = /** @type {HTMLElement} */ (document.getElementById('accuracy'));
const marker = /** @type {HTMLElement} */ (document.getElementById('marker'));
const interpretation = /** @type {HTMLElement} */ (document.getElementById('interpretation'));
const calculation = /** @type {HTMLElement} */ (document.getElementById('calculation'));

function update() {
  const counts = inputs.map(input => input.valueAsNumber);
  const valid = inputs.every(input => input.validity.valid && input.value !== '');
  const [tp, fn, fp, tn] = counts;
  const total = valid ? tp + fn + fp + tn : 0;
  const numerator = tp * tn - fp * fn;
  const denominator = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn));
  const mcc = valid && denominator > 0 ? numerator / denominator : null;
  const preset = valid ? presets.findIndex(values => values.every((value, index) => value === counts[index])) : -1;

  buttons.forEach((button, index) => button.setAttribute('aria-pressed', String(index === preset)));
  bars.forEach((bar, index) => {
    bar.style.width = total ? `${100 * counts[index] / total}%` : '0%';
  });
  score.textContent = mcc === null ? (valid ? 'Undefined' : '—') : mcc.toFixed(3);
  accuracy.textContent = total ? `${(100 * (tp + tn) / total).toFixed(1)}%` : '—';
  marker.toggleAttribute('hidden', mcc === null);
  if (mcc !== null) marker.style.left = `${50 * (mcc + 1)}%`;

  calculation.textContent = valid
    ? `${numerator} / √(${tp + fp} × ${tp + fn} × ${tn + fp} × ${tn + fn})`
    : 'Enter all four counts to see the calculation.';
  if (!valid) {
    interpretation.textContent = 'Enter whole counts from 0 to 1,000,000.';
  } else if (!total) {
    interpretation.textContent = 'Add at least one case to calculate accuracy.';
  } else if (preset >= 0) {
    interpretation.textContent = explanations[preset];
  } else if (mcc === null) {
    interpretation.textContent = 'An actual or predicted class is empty, making the denominator zero.';
  } else {
    interpretation.textContent = mcc > 0 ? 'Actual and predicted labels are positively correlated.'
      : mcc < 0 ? 'Actual and predicted labels are negatively correlated.'
      : 'Actual and predicted labels have zero correlation.';
  }
}

buttons.forEach((button, index) => button.addEventListener('click', () => {
  inputs.forEach((input, cell) => { input.value = String(presets[index][cell]); });
  engage();
  update();
}));
main.addEventListener('input', () => {
  engage();
  update();
});
update();
reportHeight(main);
