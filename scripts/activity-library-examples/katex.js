import katex from 'katex';

const formula = document.querySelector('#formula');
if (!formula) throw new Error('Missing formula element');
const x = 3;
katex.render(String.raw`f(x) = x^2 \quad f(${x}) = ${x ** 2}`, formula, { displayMode: true });
