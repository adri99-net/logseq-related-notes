// Tiny IndexedDB wrapper: one record per page, holding its embedding and a content hash.

export interface VecRecord {
  name: string; // page name (lower-cased key)
  title: string; // original page name for display
  hash: string; // hash of the text that was embedded
  model: string; // model id the vector came from
  vec: Float32Array;
}

const DB_NAME = "logseq-related-notes";
const STORE = "vectors";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "name" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const getAll = () => tx<VecRecord[]>("readonly", (s) => s.getAll());
export const put = (r: VecRecord) => tx("readwrite", (s) => s.put(r));
export const del = (name: string) => tx("readwrite", (s) => s.delete(name));
export const clear = () => tx("readwrite", (s) => s.clear());
