import { attempt } from 'vizint';
import { newQuestion } from './questions.mjs';

const questionPrompt = /** @type {HTMLParagraphElement} */ (document.querySelector('#prompt'));
const options = /** @type {HTMLDivElement} */ (document.querySelector('#options'));
const feedback = /** @type {HTMLParagraphElement} */ (document.querySelector('#feedback'));
const next = /** @type {HTMLButtonElement} */ (document.querySelector('#next'));
let question = newQuestion();
let answered = false;

/** @param {number} choice */
function answer(choice) {
  if (answered) return;
  answered = true;
  for (const option of options.querySelectorAll('button')) option.disabled = true;
  options.children[choice].setAttribute('aria-pressed', 'true');
  const correct = choice === question.correct;
  feedback.textContent = correct ? 'Correct.' : `The answer is ${question.options[question.correct]}.`;
  attempt({ score: Number(correct) });
  next.hidden = false;
}

function show() {
  const focus = answered;
  answered = false;
  questionPrompt.textContent = question.prompt;
  feedback.textContent = '';
  next.hidden = true;
  options.replaceChildren(...question.options.map((label, choice) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => answer(choice));
    return button;
  }));
  if (focus) options.querySelector('button')?.focus();
}

next.addEventListener('click', () => {
  question = newQuestion(question.value);
  show();
});
show();
