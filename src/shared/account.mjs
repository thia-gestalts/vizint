import { login, logout, session, replica } from './storage.mjs';

const form = document.querySelector('#olymp-account');
const status = document.querySelector('#olymp-status');
if (session) {
  form.replaceChildren(document.createTextNode(session.account.name + ' '));
  const button = document.createElement('button');
  button.textContent = 'Sign out';
  form.append(button);
  const refresh = async () => { status.textContent = await replica.syncStatus(); };
  await refresh();
  setInterval(refresh, 750);
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(form);
  const error = document.querySelector('#olymp-error');
  error.textContent = '';
  for (const field of form.elements) field.disabled = true;
  try {
    if (session) await logout();
    else await login(data.get('name'), data.get('password'), event.submitter?.value === 'create');
  } catch (failure) {
    error.textContent = failure.message;
    for (const field of form.elements) field.disabled = false;
  }
});
