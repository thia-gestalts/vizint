import { login, logout, session, replica } from './storage.mjs';

const opener = document.querySelector('#account-open');
const dialog = document.querySelector('#account-dialog');
const title = document.querySelector('#account-title');
const form = document.querySelector('#olymp-account');
const controls = document.querySelector('#account-controls');
const error = document.querySelector('#olymp-error');
const mode = document.querySelector('#account-mode');
const submit = document.querySelector('#account-submit');
const password = form.elements.namedItem('password');
let signup = false;

function setSignup(nextSignup) {
  signup = nextSignup;
  title.textContent = submit.textContent = signup ? 'Create account' : 'Sign in';
  mode.textContent = signup ? 'Back to sign in' : 'Create an account';
  password.autocomplete = signup ? 'new-password' : 'current-password';
  password.value = '';
  error.textContent = '';
}

if (session) {
  document.querySelector('#account-label').textContent = title.textContent = 'Account';
  document.querySelector('#account-guest').remove();
  document.querySelector('#account-member').hidden = false;
  document.querySelector('#account-name').textContent = session.account.name;
  const status = document.querySelector('#olymp-status');
  const refresh = async () => { status.textContent = await replica.syncStatus(); };
  void refresh();
  setInterval(refresh, 750);
} else {
  mode.addEventListener('click', () => {
    setSignup(!signup);
    form.elements.namedItem('name').focus();
  });
  dialog.addEventListener('close', () => form.reset());
}

opener.addEventListener('click', () => {
  if (!controls.disabled) {
    error.textContent = '';
    if (!session) setSignup(false);
  }
  dialog.showModal();
});
opener.disabled = false;

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (controls.disabled) return;
  const data = new FormData(form);
  error.textContent = '';
  controls.disabled = true;
  form.setAttribute('aria-busy', 'true');
  try {
    if (session) await logout();
    else await login(data.get('name'), data.get('password'), signup);
  } catch (failure) {
    error.textContent = failure.message;
    controls.disabled = false;
    form.removeAttribute('aria-busy');
    if (dialog.open && !dialog.contains(document.activeElement)) event.submitter?.focus();
  }
});
