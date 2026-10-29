/**
 * The browser's own database: projects and the media they point at.
 *
 * IndexedDB rather than `localStorage`, because a render is a Blob and a
 * project is JSON: both have to survive a reload without an upload. Two stores
 * keep them apart — a rename never rewrites a clip.
 */

const DB_NAME = "comfy-cinematic";
const DB_VERSION = 1;

export const PROJECT_STORE = "projects";
export const MEDIA_STORE = "media";

let opening: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  if (opening) return opening;

  opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser cannot store projects."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      // Another tab upgrading the schema must not deadlock this one.
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open the project store."));
    request.onblocked = () => reject(new Error("Close the other tabs of this app and try again."));
  }).catch((error: unknown) => {
    // A failed open must not be remembered forever.
    opening = undefined;
    throw error;
  });

  return opening;
}

function run<T>(store: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = work(transaction.objectStore(store));
        let result: T;
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () => reject(request.error ?? new Error("The project store refused that."));
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error ?? new Error("The project store refused that."));
        transaction.onabort = () => reject(transaction.error ?? new Error("The project store stopped."));
      }),
  );
}

export function getRecord<T>(store: string, key: string) {
  return run<T | undefined>(store, "readonly", (handle) => handle.get(key) as IDBRequest<T | undefined>);
}

export function putRecord<T>(store: string, value: T) {
  return run<IDBValidKey>(store, "readwrite", (handle) => handle.put(value));
}

export function deleteRecord(store: string, key: string) {
  return run<undefined>(store, "readwrite", (handle) => handle.delete(key) as IDBRequest<undefined>);
}

export function allRecords<T>(store: string) {
  return run<T[]>(store, "readonly", (handle) => handle.getAll() as IDBRequest<T[]>);
}

export function allKeys(store: string) {
  return run<IDBValidKey[]>(store, "readonly", (handle) => handle.getAllKeys());
}

/**
 * Ask the browser to keep this origin's storage.
 *
 * Eviction is what would silently empty a library, and a browser only grants
 * the request once there is something worth keeping — so this is called on
 * every save and the answer is ignored.
 */
export function requestPersistence() {
  try {
    void navigator.storage?.persist?.().catch(() => false);
  } catch {
    // Older browsers have no persistence API at all.
  }
}
