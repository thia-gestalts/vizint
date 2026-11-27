// Dataset slots: a view names the datasets it can show by hash, and the
// learner picks one. A pack is found inline in the view, at one of its declared
// URLs, or in a file the learner provides.

import { DatasetError, Pack, blobSource, bytesSource, httpSource, openPack } from './pack.js';
import { context, state } from './view.js';

/**
 * @typedef {import('./view.js').DatasetOption} DatasetOption
 * @typedef {{ state: 'idle' | 'loading' | 'ready' } | { state: 'error', error: DatasetError }} SlotStatus
 */

/** @param {string} text */
function decodeBase64(text) {
  const binary = atob(text.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Selections in the frame's URL fragment, such as `#map=africa-countries`. */
function fragment() {
  return new URLSearchParams(location.hash.slice(1));
}

export class DatasetSlot {
  /** @type {Map<string, Promise<Pack>>} */
  #packs = new Map();
  /** @type {Set<(slot: DatasetSlot) => void>} */
  #changes = new Set();
  /** @type {Set<(slot: DatasetSlot) => void>} */
  #statuses = new Set();
  /** @type {SlotStatus} */
  status = { state: 'idle' };

  /** @param {string} name @param {import('./view.js').SlotContext} config */
  constructor(name, config) {
    this.name = name;
    this.label = config.label;
    this.kind = config.kind;
    this.options = config.options;
    const wanted = [fragment().get(name), state.get(`slot:${name}`)];
    this.current = wanted.find(id => typeof id === 'string' && this.options.some(option => option.id === id))
      ?? this.options[0].id;
    addEventListener('hashchange', () => {
      const id = fragment().get(name);
      if (id && id !== this.current && this.options.some(option => option.id === id)) this.select(id);
    });
  }

  /** @param {string} [id] */
  option(id = this.current) {
    const option = this.options.find(item => item.id === id);
    if (!option) throw new Error(`Dataset ${id} is not an option of ${this.name}`);
    return option;
  }

  /** @param {string} id */
  select(id) {
    this.option(id);
    if (id === this.current) return;
    this.current = id;
    state.set(`slot:${this.name}`, id);
    this.#setStatus({ state: 'idle' });
    for (const listener of this.#changes) listener(this);
  }

  /** Called when the selection changes or its data became available. @param {(slot: DatasetSlot) => void} listener */
  onChange(listener) {
    this.#changes.add(listener);
    return () => { this.#changes.delete(listener); };
  }

  /** @param {(slot: DatasetSlot) => void} listener */
  onStatus(listener) {
    this.#statuses.add(listener);
    return () => { this.#statuses.delete(listener); };
  }

  /** @param {SlotStatus} status */
  #setStatus(status) {
    this.status = status;
    for (const listener of this.#statuses) listener(this);
  }

  /** Opens the selected dataset, or another option. @param {string} [id] */
  load(id = this.current) {
    const option = this.option(id);
    let pending = this.#packs.get(id);
    if (!pending) {
      pending = this.#open(option);
      this.#packs.set(id, pending);
      pending.catch(() => this.#packs.delete(id));
    }
    if (id === this.current) {
      this.#setStatus({ state: 'loading' });
      pending.then(
        () => { if (id === this.current) this.#setStatus({ state: 'ready' }); },
        error => { if (id === this.current) this.#setStatus({ state: 'error', error: asDatasetError(error) }); },
      );
    }
    return pending;
  }

  /** @param {DatasetOption} option */
  async #open(option) {
    const inline = option.inline && document.getElementById(option.inline)?.textContent;
    if (inline) return openPack(bytesSource(decodeBase64(inline)), option.hash);
    /** @type {DatasetError[]} */
    const failures = [];
    for (const url of option.sources) {
      try {
        return await openPack(httpSource(new URL(url, document.baseURI)), option.hash);
      } catch (error) {
        failures.push(asDatasetError(error));
      }
    }
    const error = new DatasetError('needs-file', `The ${option.title} data is not available here.`);
    error.cause = failures;
    throw error;
  }

  /**
   * Uses a pack file the learner provides. The file must hash to one of this
   * slot's options, which then becomes the selection.
   * @param {Blob} file
   */
  async loadFile(file) {
    const pack = await openPack(blobSource(file));
    const option = this.options.find(item => item.hash === pack.hash);
    if (!option) throw new DatasetError('integrity', `This file is not one of the ${this.label} datasets.`);
    this.#packs.set(option.id, Promise.resolve(pack));
    if (option.id !== this.current) {
      this.select(option.id);
    } else {
      this.#setStatus({ state: 'idle' });
      for (const listener of this.#changes) listener(this);
    }
    return pack;
  }
}

/** @param {unknown} error */
function asDatasetError(error) {
  return error instanceof DatasetError ? error : new DatasetError('unavailable', String(error));
}

/** @type {Map<string, DatasetSlot>} */
const slots = new Map();

/** The dataset slot this view declared under `name`. @param {string} name */
export function slot(name) {
  let found = slots.get(name);
  if (!found) {
    const config = context.datasets[name];
    if (!config) throw new Error(`This view declares no dataset slot ${name}`);
    found = new DatasetSlot(name, config);
    slots.set(name, found);
  }
  return found;
}

/** @param {string} text @param {string | undefined} url */
function credit(text, url) {
  if (!url) return document.createTextNode(text);
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = text;
  return link;
}

/**
 * A standard control for a slot: a selector when there is a choice, the
 * selected dataset's source and license, and its loading status.
 * @param {string | DatasetSlot} name
 */
export function datasetPicker(name) {
  const target = typeof name === 'string' ? slot(name) : name;
  const root = document.createElement('div');
  root.className = 'vizint-dataset';
  const label = document.createElement('label');
  const select = document.createElement('select');
  select.append(...target.options.map(option => new Option(option.title, option.id)));
  select.onchange = () => target.select(select.value);
  label.append(target.label + ' ', select);
  label.hidden = target.options.length < 2;
  const source = document.createElement('small');
  source.className = 'vizint-dataset-credit';
  const status = document.createElement('span');
  status.className = 'vizint-dataset-status';
  status.setAttribute('role', 'status');
  const render = () => {
    const option = target.option();
    select.value = target.current;
    source.replaceChildren(credit(option.source, option.sourceUrl), ' · ', credit(option.license, option.licenseUrl));
    root.dataset.state = target.status.state;
    status.textContent = target.status.state === 'loading' ? 'Loading…'
      : target.status.state === 'error' ? target.status.error.message : '';
  };
  target.onChange(render);
  target.onStatus(render);
  render();
  root.append(label, source, status);
  return root;
}
