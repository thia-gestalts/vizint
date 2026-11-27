import { engage, reportHeight } from 'vizint';

const positiveScores = [94, 88, 81, 72, 64, 56, 43, 31];
const negativeScores = [76, 53, 47, 36, 25, 18, 11, 5];
const thresholds = [100, ...new Set([...positiveScores, ...negativeScores])].sort((a, b) => b - a);

/** @param {number} threshold */
function ratesAt(threshold) {
  return {
    truePositive: positiveScores.filter((score) => score >= threshold).length / positiveScores.length,
    falsePositive: negativeScores.filter((score) => score >= threshold).length / negativeScores.length,
  };
}

/** @param {number} rate */
const x = (rate) => 64 + 288 * rate;
/** @param {number} rate */
const y = (rate) => 276 - 256 * rate;
const points = thresholds.map(ratesAt);
const curve = `M${points.map((point) => `${x(point.falsePositive)} ${y(point.truePositive)}`).join('L')}`;

let auc = 0;
for (let index = 1; index < points.length; index++) {
  const previous = points[index - 1];
  const current = points[index];
  auc += (current.falsePositive - previous.falsePositive) * (current.truePositive + previous.truePositive) / 2;
}

const rocArea = /** @type {SVGPathElement} */ (document.querySelector('#roc-area'));
const rocCurve = /** @type {SVGPathElement} */ (document.querySelector('#roc-curve'));
const aucValue = /** @type {HTMLElement} */ (document.querySelector('#auc-value'));

const threshold = /** @type {HTMLInputElement} */ (document.querySelector('#threshold'));
const thresholdValue = /** @type {HTMLElement} */ (document.querySelector('#threshold-value'));
const truePositiveRate = /** @type {HTMLElement} */ (document.querySelector('#true-positive-rate'));
const falsePositiveRate = /** @type {HTMLElement} */ (document.querySelector('#false-positive-rate'));
const operatingPoint = /** @type {SVGCircleElement} */ (document.querySelector('#operating-point'));
const percent = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 });

rocArea.setAttribute('d', `${curve}L${x(1)} ${y(0)}Z`);
rocCurve.setAttribute('d', curve);
aucValue.textContent = auc.toFixed(2);

function updateThreshold() {
  const { truePositive, falsePositive } = ratesAt(threshold.valueAsNumber);
  thresholdValue.textContent = threshold.value;
  truePositiveRate.textContent = percent.format(truePositive);
  falsePositiveRate.textContent = percent.format(falsePositive);
  operatingPoint.setAttribute('cx', String(x(falsePositive)));
  operatingPoint.setAttribute('cy', String(y(truePositive)));
}

threshold.addEventListener('input', () => {
  updateThreshold();
  engage();
});
updateThreshold();
reportHeight(document.body);
