const form = document.querySelector('#learning-search');
const query = form.elements.namedItem('q');
const kind = form.elements.namedItem('kind');
const results = document.querySelector('#search-results');
const status = document.querySelector('#search-status');
const browse = document.querySelector('#search-browse');
const parameters = new URLSearchParams(location.search);

const normalize = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const alphabetical = new Intl.Collator('en', { sensitivity: 'base' });
let indexRequest;
let searchVersion = 0;

function readIndex() {
  return indexRequest ??= fetch('./search-index.json').then(async (response) => {
    if (!response.ok) throw new Error('Search index unavailable');
    const items = await response.json();
    return items.map((item) => ({ ...item, normalized: normalize(item.label) }));
  }).catch((error) => {
    indexRequest = undefined;
    throw error;
  });
}

function renderItem({ label, kind, path, preview }) {
  const item = document.createElement('li');
  item.className = 'flex items-center gap-3 rounded-lg border border-base-300 bg-base-100 p-3';
  if (preview) {
    const image = document.createElement('img');
    image.className = 'w-20 h-auto shrink-0 rounded-md border border-base-300 bg-base-200 object-cover';
    Object.assign(image, { src: '../' + preview, width: 768, height: 464, alt: '', loading: 'lazy', decoding: 'async' });
    item.append(image);
  }
  const link = document.createElement('a');
  link.className = 'link link-hover link-primary font-medium';
  link.href = '../' + path;
  link.textContent = label;
  const type = document.createElement('span');
  type.className = 'ml-2 text-sm text-base-content/75 capitalize';
  type.textContent = kind;
  item.append(link, type);
  return item;
}

async function search() {
  const version = ++searchVersion;
  const text = normalize(query.value).replace(/\s+/g, ' ');
  const filter = kind.value;
  browse.hidden = Boolean(text);
  results.replaceChildren();
  status.textContent = '';
  if (!text) return;

  try {
    const index = await readIndex();
    if (version !== searchVersion) return;
    const terms = text.split(' ');
    const rank = ({ normalized }) => normalized === text ? 0 : normalized.startsWith(text) ? 1 : 2;
    const matches = index
      .filter(({ kind, normalized }) => (!filter || kind === filter)
        && terms.every((term) => normalized.includes(term)))
      .sort((a, b) => rank(a) - rank(b) || alphabetical.compare(a.label, b.label));
    results.replaceChildren(...matches.map(renderItem));
    status.textContent = matches.length
      ? matches.length + (matches.length === 1 ? ' result' : ' results')
      : 'No matching learning material.';
  } catch {
    if (version === searchVersion) {
      status.textContent = 'Search is temporarily unavailable. Try again.';
      browse.hidden = false;
    }
  }
}

if (parameters.has('q')) query.value = parameters.get('q');
if (parameters.has('kind')) kind.value = parameters.get('kind');
if (kind.selectedIndex === -1) kind.value = '';
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = new URL(location.href);
  if (query.value.trim()) url.searchParams.set('q', query.value.trim());
  else url.searchParams.delete('q');
  if (kind.value) url.searchParams.set('kind', kind.value);
  else url.searchParams.delete('kind');
  history.replaceState(null, '', url);
  void search();
});
kind.addEventListener('change', () => form.requestSubmit());
void search();
