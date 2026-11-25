const decimal = (integer, places) => (integer / 10 ** places).toFixed(places);

export function newQuestion(previousValue) {
  // Sample an integer count of thousandths with a nonzero hundredths digit.
  // Grade using integers so a decimal tie is exact.
  const tenths = 12 + Math.floor(Math.random() * 88);
  const remainder = 10 + Math.floor(Math.random() * 90);
  let value = tenths * 100 + remainder;
  if (value === previousValue) value += remainder === 99 ? -1 : 1;

  const lower = Math.floor(value / 100);
  const upper = lower + 1;
  const correct = value % 100 >= 50 ? upper : lower;
  const options = [decimal(lower, 1), decimal(upper, 1), decimal(value, 3), decimal(Math.floor(value / 1000), 0)];
  for (let index = options.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [options[index], options[other]] = [options[other], options[index]];
  }

  return {
    id: crypto.randomUUID(),
    value,
    prompt: decimal(value, 3),
    options,
    correct: options.indexOf(decimal(correct, 1)),
  };
}
