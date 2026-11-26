const languageButtons = [...document.querySelectorAll('#languages button')];
const practice = document.querySelector('#practice');
const prompt = document.querySelector('#prompt');
const answers = document.querySelector('#answers');
const audio = document.querySelector('audio');
const replay = document.querySelector('#replay');
const hide = document.querySelector('#hide-clip');
const audioStatus = document.querySelector('#audio-status');
const status = document.querySelector('#status');
const retry = document.querySelector('#retry-load');
const native = document.querySelector('#native');
const feedback = document.querySelector('#feedback');
const credits = document.querySelector('#credits');
const license = document.querySelector('#license');
const send = data => parent.postMessage(data, '*');
let pack, current, audioUrl;
let audioFailed = false;
let inFlight = false;
let awaitingSave = false;
let focusAnswers = false;

for (const button of languageButtons) {
  button.onclick = () => send({ type: 'language', code: button.dataset.code });
}
retry.onclick = () => send({ type: 'retry-load' });
document.querySelector('#open-license').onclick = () => license.showModal();
document.querySelector('#close-license').onclick = () => license.close();
for (const button of document.querySelectorAll('[data-credit]')) {
  button.onclick = () => send({ type: 'credit', link: button.dataset.credit });
}

function lockNavigation() {
  for (const button of languageButtons) button.disabled = awaitingSave;
  hide.disabled = awaitingSave || inFlight;
}

function clearAudio() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = undefined;
  audioFailed = false;
  replay.disabled = true;
  audioStatus.textContent = '';
}

async function play() {
  if (!current) return;
  if (audioFailed) {
    replay.disabled = true;
    audioStatus.textContent = 'Loading audio…';
    send({ type: 'retry-audio', id: current });
    return;
  }
  if (!audioUrl) return;
  const requested = audioUrl;
  audioStatus.textContent = '';
  audio.currentTime = 0;
  try {
    await audio.play();
  } catch (error) {
    if (requested !== audioUrl || error.name === 'AbortError') return;
    if (error.name === 'NotAllowedError') audioStatus.textContent = 'Press Replay to start audio.';
    else showAudioError();
  }
}

function showAudioError() {
  audioFailed = true;
  replay.disabled = false;
  audioStatus.textContent = 'Could not play this clip. Press Replay to retry.';
}

audio.addEventListener('error', () => { if (audioUrl) showAudioError(); });
replay.onclick = play;
hide.onclick = () => { if (current) send({ type: 'hide', id: current }); };

function choose(choice) {
  if (!current || inFlight || answers.children[choice]?.disabled) return;
  focusAnswers = answers.contains(document.activeElement);
  inFlight = true;
  lockNavigation();
  send({ type: 'answer', id: current, choice });
}

addEventListener('keydown', event => {
  if (!current || license.open || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.code === 'Space' && !event.target.closest?.('button, audio, a, input, select, textarea, [contenteditable]')) {
    event.preventDefault();
    void play();
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (event.target.closest?.('audio, #languages')) return;
    event.preventDefault();
    choose(Number(event.key === 'ArrowRight'));
  }
});

function answerButton(label, choice, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.disabled = true;
  button.onclick = () => choose(choice);
  const spelling = document.createElement('span');
  spelling.className = 'spelling';
  spelling.lang = pack.lang;
  const characters = [...label];
  const mark = document.createElement('mark');
  mark.textContent = characters[index];
  spelling.append(characters.slice(0, index).join(''), mark, characters.slice(index + 1).join(''));
  const key = document.createElement('kbd');
  key.setAttribute('aria-hidden', 'true');
  key.textContent = choice === 0 ? '←' : '→';
  button.append(...(choice === 0 ? [key, spelling] : [spelling, key]));
  return button;
}

addEventListener('message', ({ source, data }) => {
  if (source !== parent || !data) return;
  if (data.type === 'loading' || data.type === 'status') {
    current = undefined;
    practice.hidden = true;
    clearAudio();
    retry.hidden = !data.retry;
    status.textContent = data.text ?? 'Loading practice clips…';
    if (data.type === 'loading') {
      pack = data.pack;
      credits.hidden = false;
      document.querySelector('[data-credit="dataset"]').textContent = pack.dataset;
      document.querySelector('[data-credit="license"]').textContent = pack.license;
      document.querySelector('#notice').textContent = pack.notice;
      for (const button of languageButtons) button.setAttribute('aria-pressed', String(button.dataset.code === data.code));
    }
    return;
  }
  if (data.type === 'round') {
    current = data.id;
    inFlight = false;
    lockNavigation();
    practice.hidden = false;
    status.textContent = '';
    retry.hidden = true;
    feedback.textContent = '';
    clearAudio();
    audioStatus.textContent = 'Loading audio…';
    native.textContent = data.nativeScript ?? '';
    native.hidden = !data.nativeScript;
    answers.replaceChildren(...data.options.map((label, choice) => answerButton(label, choice, data.index)));
    return;
  }
  if (data.type === 'saved') {
    awaitingSave = false;
    lockNavigation();
    return;
  }
  if (data.id !== current) return;
  if (data.type === 'audio') {
    clearAudio();
    audioUrl = URL.createObjectURL(new Blob([data.bytes], { type: 'audio/mpeg' }));
    audio.src = audioUrl;
    replay.disabled = false;
    for (const button of answers.children) button.disabled = button.classList.contains('wrong');
    if (languageButtons.includes(document.activeElement)) prompt.focus({ preventScroll: true });
    if (focusAnswers && document.activeElement === document.body) answers.firstElementChild.focus({ preventScroll: true });
    focusAnswers = false;
    void play();
  }
  if (data.type === 'audio-error') showAudioError();
  if (data.type === 'hide-error') audioStatus.textContent = 'Could not hide this clip. Try again.';
  if (data.type === 'answer') {
    const button = answers.children[data.choice];
    button.classList.add(data.correct ? 'correct' : 'wrong');
    button.disabled = true;
    inFlight = data.correct;
    awaitingSave = data.saving;
    lockNavigation();
    if (data.correct) {
      audio.pause();
      feedback.textContent = 'Correct.';
    } else {
      feedback.textContent = 'Incorrect.';
      if (focusAnswers) answers.children[1 - data.choice].focus({ preventScroll: true });
    }
  }
});

const main = document.querySelector('main');
new ResizeObserver(() => {
  send({ type: 'height', value: main.getBoundingClientRect().height + main.offsetTop * 2 });
}).observe(main);
send({ type: 'ready' });
