import { entries, recordKey, Replica, request, signIn } from './olymp/client.js';
import { browserStore, remembered } from './olymp/browser.js';
import * as guest from './guest.mjs';

export const session = await remembered.read();
export const replica = session && new Replica(session, browserStore(session));
replica?.start();
remembered.onChange(() => location.reload());
addEventListener('pagehide', () => replica?.close());
addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

const profileLock = (work) => navigator.locks.request('vizint-profile', work);

export async function login(name, password, signup) {
  await profileLock(async () => {
    if (await remembered.read()) throw Error('Already signed in.');
    await remembered.save(await signIn(location.origin, { name, password, signup, device: 'Vizint' }));
  });
  location.reload();
}

export async function logout() {
  await profileLock(async () => {
    try {
      await request(session.origin, 'logout', { session, method: 'POST' });
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    replica.close();
    await remembered.clear(session);
  });
  location.reload();
}

export async function saveObservation(event, targets) {
  return profileLock(async () => {
    if ((await remembered.read())?.token !== session?.token) throw Error('The active profile changed.');
    if (!replica) return guest.saveObservation(event, targets);
    await replica.writeBatch(groups => {
      const existing = new Set(groups.filter(g => g.versions.some(v => !v.deleted)).map(g => g.key));
      return [...targets, event].filter(value => !existing.has(recordKey(value)))
        .map(value => ({ key: recordKey(value), value }));
    });
  });
}

export async function readRecords() {
  if (!replica) return guest.readRecords();
  return entries(await replica.records()).flatMap(g => g.versions.filter(v => !v.deleted).map(v => v.value));
}
