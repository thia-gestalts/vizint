/**
 * @typedef {(
 *   { type: 'question', id: string, prompt: string, options: string[] } |
 *   { type: 'feedback', id: string, correct: boolean, answer: string } |
 *   { type: 'saved', id: string }
 * )} HostMessage
 *
 * @typedef {(
 *   { type: 'ready' } |
 *   { type: 'answer', id: string, choice: number } |
 *   { type: 'next', id: string }
 * )} ViewMessage
 */

const questionPrompt = /** @type {HTMLParagraphElement} */ (document.querySelector('#prompt'));
const options = /** @type {HTMLDivElement} */ (document.querySelector('#options'));
const feedback = /** @type {HTMLParagraphElement} */ (document.querySelector('#feedback'));
const next = /** @type {HTMLButtonElement} */ (document.querySelector('#next'));
/** @type {string | undefined} */
let current;
let answered = false;

/** @param {ViewMessage} message */
function send(message) {
  parent.postMessage(message, '*');
}

/** @param {MessageEvent<HostMessage | null>} event */
function receive({ source, data }) {
  if (source !== parent || !data) return;
  if (data.type === 'question') {
    const focusNextQuestion = answered;
    current = data.id;
    answered = false;
    questionPrompt.textContent = data.prompt;
    feedback.textContent = '';
    next.hidden = true;
    options.replaceChildren(...data.options.map((label, choice) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        if (answered) return;
        answered = true;
        button.setAttribute('aria-pressed', 'true');
        for (const option of options.querySelectorAll('button')) option.disabled = true;
        send({ type: 'answer', id: data.id, choice });
      });
      return button;
    }));
    if (focusNextQuestion) options.querySelector('button')?.focus();
    return;
  }
  if (data.id !== current) return;
  if (data.type === 'feedback') {
    feedback.textContent = data.correct ? 'Correct.' : `The answer is ${data.answer}.`;
  }
  if (data.type === 'saved') next.hidden = false;
}

window.addEventListener('message', receive);
next.addEventListener('click', () => {
  if (current !== undefined) send({ type: 'next', id: current });
});
send({ type: 'ready' });
