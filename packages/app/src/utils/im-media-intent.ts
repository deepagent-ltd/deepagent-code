import { MediaIntent } from "@deepagent-code/core/im/media-intent"
import { MediaBatch } from "@deepagent-code/core/im/media-batch"

// IndexedDB transactions arbitrate tabs. No in-memory/localStorage success fallback: if
// durable client storage is unavailable, attachment dispatch remains disabled.
export function createMediaIntentStore(factory: IDBFactory = indexedDB) {
  return createMediaStore(factory, "intents", MediaIntent.records, MediaIntent.upsert)
}

export function createMediaBatchStore(factory: IDBFactory = indexedDB) {
  return createMediaStore(factory, "batches", MediaBatch.records, MediaBatch.upsert)
}

type Stored = { id: string; revision: number; scope: MediaIntent.Scope }
function createMediaStore<Value extends Stored>(
  factory: IDBFactory,
  name: string,
  decode: (input: unknown) => Value[],
  upsert: (values: Value[], value: Value, revision?: number) => Value[],
) {
  let closed = false
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("deepagent-im-media-v1", 2)
    request.onupgradeneeded = () => {
      for (const name of ["intents", "batches"])
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" })
    }
    request.onsuccess = () => {
      if (closed) {
        request.result.close()
        reject(new Error("media_store_unavailable"))
        return
      }
      resolve(request.result)
    }
    request.onerror = () => reject(new Error("media_store_unavailable"))
    request.onblocked = () => {
      closed = true
      reject(new Error("media_store_unavailable"))
    }
  })
  async function transaction<T>(mode: IDBTransactionMode, change: (values: Value[], store: IDBObjectStore) => T) {
    const db = await database
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(name, mode, { durability: "strict" })
      const store = tx.objectStore(name)
      const request = store.getAll()
      let value: T
      let failure: unknown
      request.onsuccess = () => {
        try {
          value = change(decode(request.result), store)
        } catch (error) {
          failure = error
          tx.abort()
        }
      }
      tx.oncomplete = () => resolve(value)
      tx.onerror = tx.onabort = () => reject(failure ?? new Error("media_store_unavailable"))
    })
  }
  return {
    list: (scope: MediaIntent.Scope) =>
      transaction("readonly", (values) => values.filter((value) => MediaIntent.sameScope(value.scope, scope))),
    put: (value: Value, expectedRevision?: number) =>
      transaction("readwrite", (values, store) => {
        const next = upsert(values, value, expectedRevision)
        for (const retired of values.filter((item) => !next.some((entry) => entry.id === item.id)))
          store.delete(retired.id)
        store.put(value)
        return value
      }),
    discard: (value: Value) =>
      transaction("readwrite", (values, store) => {
        const current = values.find((item) => item.id === value.id)
        if (current && (current.revision !== value.revision || !MediaIntent.sameScope(current.scope, value.scope)))
          throw new Error("media_store_conflict")
        store.delete(value.id)
      }),
    close: () => {
      closed = true
      void database.then((value) => value.close()).catch(() => undefined)
    },
  }
}
