// Inline editing: every [data-path] field saves when it loses focus. Escape reverts, Enter saves single-line fields,
// Ctrl/Cmd+Enter saves text areas. Add and delete buttons reload the page so indices stay current.
const $ = (selector, root = document) => root.querySelector(selector);
const toast = $('#toast');
let toastTimer;

function say(message, error = false) {
  toast.textContent = message;
  toast.classList.toggle('!bg-red-700', error);
  toast.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.opacity = 0; }, error ? 6000 : 1500);
}

function showCheck(check) {
  if (!check) return;
  const badge = $('#catalog');
  badge.textContent = check.ok ? 'catalog ok' : 'catalog error';
  badge.title = check.error || 'src/catalog.mjs loads';
  badge.classList.toggle('!bg-emerald-100', check.ok);
  badge.classList.toggle('!text-emerald-800', check.ok);
  badge.classList.toggle('!bg-red-100', !check.ok);
  badge.classList.toggle('!text-red-800', !check.ok);
  const panel = $('#catalog-error');
  panel.textContent = check.error || '';
  panel.classList.toggle('hidden', check.ok);
}

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { data = { ok: false, error: `${response.status} ${response.statusText}` }; }
  return data;
}

const target = el => ({ file: el.dataset.file, slug: el.dataset.slug, path: JSON.parse(el.dataset.path) });
const original = el => JSON.parse(el.dataset.value);

function read(el) {
  const type = el.dataset.type;
  if (type === 'bool') return el.checked;
  if (type === 'json') return JSON.parse(el.value);
  if (type === 'number') return el.value.trim() === '' ? null : Number(el.value);
  if (type === 'list') {
    const items = el.value.split(',').map(item => item.trim()).filter(Boolean);
    return items.length ? items : null;
  }
  return el.value.trim() === '' ? null : el.value.trim();
}

function display(el, value) {
  if (el.dataset.type === 'bool') el.checked = !!value;
  else if (el.dataset.type === 'list') el.value = (value || []).join(', ');
  else if (el.dataset.type !== 'json') el.value = value ?? '';
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function save(el) {
  const old = original(el);
  let value;
  try { value = read(el); } catch { return; }
  if (same(value, old) || el.dataset.state === 'saving') return;
  el.dataset.state = 'saving';
  const body = { ...target(el), value, old };
  let result;
  if (el.dataset.rename) {
    result = await post('/api/rename', { ...body, kind: el.dataset.rename });
    if (result.confirm) {
      const where = result.confirm.map(item => `  ${item.file}: ${item.count}`).join('\n');
      if (!confirm(`Rename “${old}” to “${value}” in every reference?\n\n${where}`)) {
        el.dataset.state = '';
        display(el, old);
        return;
      }
      result = await post('/api/rename', { ...body, kind: el.dataset.rename, confirm: true });
    }
  } else {
    result = await post('/api/set', body);
  }
  if (!result.ok) {
    el.dataset.state = 'error';
    el.title = result.error;
    say(result.error, true);
    return;
  }
  el.dataset.value = JSON.stringify(value ?? null);
  el.dataset.state = 'saved';
  el.title = '';
  showCheck(result.check);
  say(result.renamed > 1 ? `Renamed ${result.renamed} references` : 'Saved');
  setTimeout(() => { if (el.dataset.state === 'saved') el.dataset.state = ''; }, 1200);
  if (result.renamed > 1) location.reload();
}

function grow(el) {
  if (el.tagName !== 'TEXTAREA') return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}

document.querySelectorAll('textarea[data-path]').forEach(grow);
document.addEventListener('input', event => grow(event.target));
document.addEventListener('focusout', event => {
  const el = event.target;
  if (el.matches('input[data-path]:not([type=checkbox]), textarea[data-path]')) save(el);
});
document.addEventListener('change', event => {
  const el = event.target;
  if (el.matches('select[data-path], input[type=checkbox][data-path]')) save(el);
});
document.addEventListener('keydown', event => {
  const el = event.target;
  if (!el.matches('[data-path]')) return;
  if (event.key === 'Escape') {
    display(el, original(el));
    el.dataset.state = '';
    grow(el);
    el.blur();
  } else if (event.key === 'Enter' && (el.tagName === 'INPUT' || event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    el.blur();
  }
});

function setIn(item, path, value) {
  let node = item;
  for (const segment of path.slice(0, -1)) node = node[segment];
  node[path.at(-1)] = value;
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-append], [data-delete], [data-check]');
  if (!button) return;
  if (button.matches('[data-check]')) {
    const dialog = $('#check');
    $('#check-title').textContent = 'npm run check:views …';
    $('#check-output').textContent = '';
    dialog.showModal();
    const result = await post('/api/check', {});
    $('#check-title').textContent = result.ok ? '✓ check:views passed' : '✗ check:views failed';
    $('#check-output').textContent = result.output ?? result.error;
    return;
  }
  let result;
  if (button.matches('[data-append]')) {
    const item = JSON.parse(button.dataset.item);
    for (const [question, path] of JSON.parse(button.dataset.prompts || '[]')) {
      const answer = prompt(question, path.reduce((node, key) => node[key], item));
      if (answer === null || !answer.trim()) return;
      setIn(item, path, answer.trim());
    }
    const json = JSON.stringify(item).replaceAll('"{uuid}"', JSON.stringify(crypto.randomUUID()));
    result = await post('/api/append', { ...target(button), item: JSON.parse(json) });
  } else {
    if (!confirm(`Delete this ${button.dataset.what}?`)) return;
    result = await post('/api/delete', { ...target(button), old: original(button) });
  }
  if (!result.ok) return say(result.error, true);
  location.reload();
});

const filter = $('#filter');
filter?.addEventListener('input', () => {
  const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
  document.querySelectorAll('[data-search]').forEach(row => {
    row.hidden = !words.every(word => row.dataset.search.includes(word));
  });
});
