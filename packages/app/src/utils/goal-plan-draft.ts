import { GoalPlanClient } from "@deepagent-code/core/deepagent/goal-plan-client"

// IndexedDB transactions arbitrate tabs. No in-memory/localStorage success fallback: if
// durable client storage is unavailable, plan edit dispatch remains disabled.
export function createGoalPlanDraftStore(factory: IDBFactory = indexedDB) {
  let closed = false
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("deepagent-goal-plan-v1", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("intents", { keyPath: "id" })
    request.onsuccess = () => {
      if (closed) {
        request.result.close()
        reject(new Error("goal_plan_store_unavailable"))
        return
      }
      resolve(request.result)
    }
    request.onerror = () => reject(new Error("goal_plan_store_unavailable"))
    request.onblocked = () => {
      closed = true
      reject(new Error("goal_plan_store_unavailable"))
    }
  })
  async function transaction<T>(
    mode: IDBTransactionMode,
    change: (values: GoalPlanClient.Draft[], store: IDBObjectStore) => T,
  ) {
    const db = await database
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction("intents", mode, { durability: "strict" })
      const store = tx.objectStore("intents")
      const request = store.getAll()
      let value: T
      let failure: unknown
      request.onsuccess = () => {
        try {
          value = change(GoalPlanClient.records(request.result), store)
        } catch (error) {
          failure = error
          tx.abort()
        }
      }
      tx.oncomplete = () => resolve(value)
      tx.onerror = tx.onabort = () => reject(failure ?? new Error("goal_plan_store_unavailable"))
    })
  }
  return {
    list: (scope: GoalPlanClient.Scope) =>
      transaction("readonly", (values) => values.filter((value) => GoalPlanClient.sameScope(value.scope, scope))),
    put: (value: GoalPlanClient.Draft, expectedRevision?: number) =>
      transaction("readwrite", (values, store) => {
        const next = GoalPlanClient.upsert(values, value, expectedRevision)
        for (const retired of values.filter((item) => !next.some((entry) => entry.id === item.id)))
          store.delete(retired.id)
        store.put(value)
        return value
      }),
    discard: (value: GoalPlanClient.Draft) =>
      transaction("readwrite", (values, store) => {
        const current = values.find((item) => item.id === value.id)
        if (current && (current.revision !== value.revision || !GoalPlanClient.sameScope(current.scope, value.scope)))
          throw new Error("goal_plan_store_conflict")
        store.delete(value.id)
      }),
    close: () => {
      closed = true
      void database.then((value) => value.close()).catch(() => undefined)
    },
  }
}
