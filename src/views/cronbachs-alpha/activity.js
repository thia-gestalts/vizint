import { engage, reportHeight } from 'vizint';

const items = ['A', 'B', 'C', 'D'];
const firstItems = [
  [1, 1, 2],
  [2, 3, 1],
  [3, 2, 3],
  [3, 4, 3],
  [4, 3, 5],
  [5, 5, 4],
];
const fourthItem = {
  aligned: [1, 2, 3, 3, 4, 5],
  mixed: [3, 5, 1, 4, 2, 3],
  opposing: [5, 4, 3, 3, 2, 1],
};
const choices = [1, 2, 3, 4, 5];

const responseBody = /** @type {HTMLTableSectionElement} */ (document.querySelector('#responses'));
const reverse = /** @type {HTMLInputElement} */ (document.querySelector('#reverse'));
const presetButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('button[data-preset]'));
const itemVarianceCells = document.querySelectorAll('tfoot td');
const alphaValue = /** @type {HTMLElement} */ (document.querySelector('#alpha'));
const interpretation = /** @type {HTMLElement} */ (document.querySelector('#interpretation'));
const itemVarianceValue = /** @type {HTMLElement} */ (document.querySelector('#item-variance'));
const totalVarianceValue = /** @type {HTMLElement} */ (document.querySelector('#total-variance'));
const itemBar = /** @type {HTMLElement} */ (document.querySelector('#item-bar'));
const totalBar = /** @type {HTMLElement} */ (document.querySelector('#total-bar'));
const axisEnd = /** @type {HTMLElement} */ (document.querySelector('#axis-end'));

let responses = firstItems.map((row, person) => [...row, fourthItem.aligned[person]]);

/** @param {number} response @param {string} item */
function applyScoring(response, item) {
  return reverse.checked && item === 'D' ? 6 - response : response;
}

const rows = responses.map((_, person) => {
  const row = document.createElement('tr');
  const name = document.createElement('th');
  name.scope = 'row';
  name.textContent = String(person + 1);
  row.append(name);

  const inputs = items.map((item, index) => {
    const cell = row.insertCell();
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Person ${person + 1}, item ${item}`);
    select.append(...choices.map(value => new Option(String(value))));
    select.addEventListener('change', () => {
      // Reversing a score again recovers the underlying response.
      responses[person][index] = applyScoring(Number(select.value), item);
      for (const button of presetButtons) button.setAttribute('aria-pressed', 'false');
      engage();
      render();
    });
    cell.append(select);
    return select;
  });

  const total = row.insertCell();
  total.className = 'total';
  total.innerHTML = '<span></span><div class="track" aria-hidden="true"><span></span></div>';
  responseBody.append(row);
  return {
    inputs,
    totalValue: /** @type {HTMLSpanElement} */ (total.querySelector('span')),
    totalBar: /** @type {HTMLElement} */ (total.querySelector('.track span')),
  };
});

/** @param {number[]} values */
function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/** @param {number[]} values */
function sampleVariance(values) {
  const mean = sum(values) / values.length;
  return sum(values.map(value => (value - mean) ** 2)) / (values.length - 1);
}

function render() {
  const scored = responses.map(row => row.map((response, index) => applyScoring(response, items[index])));
  const totals = scored.map(sum);
  const itemVariances = items.map((_, index) => sampleVariance(scored.map(row => row[index])));
  const sumOfItemVariances = sum(itemVariances);
  const totalVariance = sampleVariance(totals);
  const scale = Math.max(30, Math.ceil(totalVariance / 10) * 10);
  const alpha = totalVariance === 0 ? null : items.length / (items.length - 1) * (1 - sumOfItemVariances / totalVariance);

  rows.forEach(({ inputs, totalValue, totalBar }, person) => {
    inputs.forEach((input, index) => {
      const value = String(scored[person][index]);
      input.value = value;
      input.dataset.score = value;
    });
    totalValue.textContent = String(totals[person]);
    totalBar.style.width = `${totals[person] / (items.length * 5) * 100}%`;
  });
  itemVariances.forEach((value, index) => {
    itemVarianceCells[index].textContent = value.toFixed(2);
  });

  itemVarianceValue.textContent = sumOfItemVariances.toFixed(2);
  totalVarianceValue.textContent = totalVariance.toFixed(2);
  itemBar.style.width = `${sumOfItemVariances / scale * 100}%`;
  totalBar.style.width = `${totalVariance / scale * 100}%`;
  axisEnd.textContent = String(scale);

  alphaValue.textContent = alpha === null ? 'Undefined' : (Math.abs(alpha) < 0.0005 ? 0 : alpha).toFixed(3);
  if (alpha === null) {
    interpretation.textContent = 'Everyone has the same total, so the variance of the totals is zero.';
  } else if (totalVariance < sumOfItemVariances - 1e-10) {
    interpretation.textContent = 'Item scores tend to cancel out, narrowing the spread of the totals.';
  } else if (totalVariance > sumOfItemVariances + 1e-10) {
    interpretation.textContent = 'Item scores tend to rise together, widening the spread of the totals.';
  } else {
    interpretation.textContent = 'The variance of the totals equals the sum of the item variances.';
  }
}

for (const button of presetButtons) {
  button.addEventListener('click', () => {
    const preset = /** @type {keyof typeof fourthItem} */ (button.dataset.preset);
    responses = firstItems.map((row, person) => [...row, fourthItem[preset][person]]);
    reverse.checked = false;
    for (const choice of presetButtons) choice.setAttribute('aria-pressed', String(choice === button));
    engage();
    render();
  });
}

reverse.addEventListener('change', () => {
  engage();
  render();
});

render();
reportHeight(document.body);
