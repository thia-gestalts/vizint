const prompt = document.querySelector('#prompt');
const options = document.querySelector('#options');
const feedback = document.querySelector('#feedback');
const next = document.querySelector('#next');
let current;
let answered = false;

function send(message) {
  parent.postMessage(message, '*');
}

window.addEventListener('message', ({ source, data }) => {
  if (source !== parent || !data) return;
  if (data.type === 'question') {
    const focusNextQuestion = answered;
    current = data.id;
    answered = false;
    prompt.textContent = data.prompt;
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
        for (const option of options.children) option.disabled = true;
        send({ type: 'answer', id: current, choice });
      });
      return button;
    }));
    if (focusNextQuestion) options.firstElementChild.focus();
    return;
  }
  if (data.id !== current) return;
  if (data.type === 'feedback') {
    feedback.textContent = data.correct ? 'Correct.' : `The answer is ${data.answer}.`;
  }
  if (data.type === 'saved') next.hidden = false;
});

next.addEventListener('click', () => send({ type: 'next', id: current }));
send({ type: 'ready' });
