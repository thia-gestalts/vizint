const storeName = 'records';
let opening;

function database() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('vizint-learner', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(storeName, { keyPath: ['kind', 'id'] });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      opening = undefined;
      throw error;
    });
  }
  return opening;
}

export async function saveObservation(event, targets) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    const store = transaction.objectStore(storeName);
    for (const target of targets) store.put(target);
    store.put(event);
  });
}

export async function readRecords() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
