import { engage, reportHeight } from 'vizint';

const presets = {
  balanced: [40, 10, 10, 40],
  mostlyYes: [79, 10, 10, 1],
  chance: [25, 25, 25, 25],
  opposite: [0, 50, 50, 0],
};
const buttons = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('button[data-preset]'));
const counts = /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[type="number"]'));
const totals = ['row-yes', 'row-no', 'col-yes', 'col-no', 'total'].map(viewElement);
const kappa = viewElement('kappa');
const interpretation = viewElement('interpretation');
const error = viewElement('count-error');
const percent = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 2 });

/** @param {string} id */
function viewElement(id) {
  return /** @type {HTMLElement} */ (document.getElementById(id));
}

/** @param {string} id @param {number[]} shares */
function renderAgreement(id, shares) {
  const value = viewElement(id);
  const bar = viewElement(id + '-bar');
  const [yes, no] = shares;
  value.textContent = shares.length ? percent.format(yes + no) : '—';
  bar.setAttribute('aria-label', shares.length
    ? `${percent.format(yes)} both Yes, ${percent.format(no)} both No`
    : 'Agreement breakdown unavailable');
  bar.querySelectorAll('span').forEach((segment, index) => {
    segment.style.width = `${(shares[index] ?? 0) * 100}%`;
  });
}

function render() {
  const validity = Array.from(counts, input => {
    input.setAttribute('aria-invalid', String(!input.validity.valid));
    return input.validity.valid;
  });
  const valid = validity.every(Boolean);
  const [yesYes, yesNo, noYes, noNo] = Array.from(counts, input => input.valueAsNumber);
  const rowYes = yesYes + yesNo;
  const rowNo = noYes + noNo;
  const colYes = yesYes + noYes;
  const colNo = yesNo + noNo;
  const total = rowYes + rowNo;
  [rowYes, rowNo, colYes, colNo, total].forEach((count, index) => {
    totals[index].textContent = valid ? String(count) : '—';
  });

  error.textContent = valid ? '' : 'Enter a whole number from 0 to 9999 in each cell.';
  if (!valid || total === 0) {
    renderAgreement('observed', []);
    renderAgreement('expected', []);
    kappa.textContent = valid ? 'Undefined' : '—';
    interpretation.textContent = valid ? 'Add at least one paired rating to calculate agreement.' : '';
    return;
  }

  const expectedYes = rowYes * colYes;
  const expectedNo = rowNo * colNo;
  const possiblePairs = total ** 2;
  renderAgreement('observed', [yesYes / total, noNo / total]);
  renderAgreement('expected', [expectedYes / possiblePairs, expectedNo / possiblePairs]);

  // Work in counts of possible pairings to keep equality and zero checks exact.
  const expectedPairs = expectedYes + expectedNo;
  const difference = (yesYes + noNo) * total - expectedPairs;
  if (expectedPairs === possiblePairs) {
    kappa.textContent = 'Undefined';
    interpretation.textContent = 'Both raters always use the same label, so expected agreement is 100%.';
    return;
  }

  const score = difference / (possiblePairs - expectedPairs);
  kappa.textContent = Math.abs(score) < 0.0005 && score !== 0
    ? score.toExponential(2)
    : score.toFixed(3);
  if (difference === 0) {
    interpretation.textContent = 'Observed agreement equals the chance baseline.';
  } else if (difference > 0) {
    interpretation.textContent = 'Observed agreement is higher than the chance baseline.';
  } else {
    interpretation.textContent = 'Observed agreement is lower than the chance baseline.';
  }
}

/** @param {keyof typeof presets} preset */
function loadPreset(preset) {
  counts.forEach((input, index) => { input.value = String(presets[preset][index]); });
  buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preset === preset)));
  render();
}

buttons.forEach(button => button.addEventListener('click', () => {
  engage();
  loadPreset(/** @type {keyof typeof presets} */ (button.dataset.preset));
}));

counts.forEach(input => input.addEventListener('input', () => {
  engage();
  buttons.forEach(button => button.setAttribute('aria-pressed', 'false'));
  render();
}));

loadPreset('balanced');
kappa.dataset.ready = '';
reportHeight(document.body);
