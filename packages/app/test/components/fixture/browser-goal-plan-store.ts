import { chromium } from "@playwright/test"
import { createServer } from "node:http"
import path from "node:path"
import type { GoalPlanClient } from "@deepagent-code/core/deepagent/goal-plan-client"

type Store = ReturnType<typeof import("../../../src/utils/goal-plan-draft").createGoalPlanDraftStore>
type Host = Window & {
  DACGoalPlanFixture: typeof import("../../../src/utils/goal-plan-draft")
  goalPlanStores: Map<number, Store>
}
let bundled: Promise<string> | undefined

// HappyDOM renders the editor; Chromium runs the original GUI IndexedDB transactions.
export async function createBrowserGoalPlanStoreFixture(directory: string) {
  bundled ??= (async () => {
    const { build } = await import("vite")
    const output = await build({
      configFile: false,
      logLevel: "error",
      build: {
        write: false,
        minify: false,
        lib: { entry: path.resolve(process.cwd(), "src/utils/goal-plan-draft.ts"), name: "DACGoalPlanFixture", formats: ["iife"] },
      },
    })
    const result = Array.isArray(output) ? output[0] : output
    if (!("output" in result)) throw new Error("Original browser Goal plan store did not build")
    const chunk = result.output.find((item) => item.type === "chunk")
    if (!chunk || chunk.type !== "chunk") throw new Error("Original browser Goal plan store chunk missing")
    return chunk.code
  })()
  const script = await bundled
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Owned Goal plan store</title>")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Owned Goal plan fixture did not bind")
  const initialized = await (async () => {
    const context = await chromium.launchPersistentContext(path.join(directory, "browser"), { headless: true })
    try {
      const page = await context.newPage()
      await page.goto(`http://127.0.0.1:${address.port}`)
      await page.addScriptTag({ content: script })
      await page.evaluate(() => { (window as unknown as Host).goalPlanStores = new Map() })
      return { context, page }
    } catch (error) {
      await context.close()
      throw error
    }
  })().catch(async (error: unknown) => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  })
  const page = initialized.page
  let next = 0
  const pending = new Set<Promise<unknown>>()
  function track<T>(operation: Promise<T>) {
    pending.add(operation)
    void operation.finally(() => pending.delete(operation)).catch(() => undefined)
    return operation
  }
  return {
    createStore() {
      const id = next++
      const ready = track(page.evaluate((id) => {
        const host = window as unknown as Host
        host.goalPlanStores.set(id, host.DACGoalPlanFixture.createGoalPlanDraftStore())
      }, id))
      const call = <T>(operation: "list" | "put" | "discard", args: unknown[]) => track(ready.then(() =>
        page.evaluate(async ({ id, operation, args }) => {
          const store = (window as unknown as Host).goalPlanStores.get(id)
          if (!store) throw new Error("Original browser Goal plan store missing")
          if (operation === "list") return store.list(args[0] as GoalPlanClient.Scope)
          if (operation === "put") return store.put(args[0] as GoalPlanClient.Draft, args[1] as number | undefined)
          return store.discard(args[0] as GoalPlanClient.Draft)
        }, { id, operation, args: args.map((value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))) }),
      )).then((value) => value as T)
      return {
        list: (scope: GoalPlanClient.Scope) => call<GoalPlanClient.Draft[]>("list", [scope]),
        put: (value: GoalPlanClient.Draft, revision?: number) => call<GoalPlanClient.Draft>("put", [value, revision]),
        discard: (value: GoalPlanClient.Draft) => call<void>("discard", [value]),
      }
    },
    records: () => page.evaluate(() => new Promise<GoalPlanClient.Draft[]>((resolve, reject) => {
      const request = indexedDB.open("deepagent-goal-plan-v1", 1)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const tx = database.transaction("intents", "readonly")
        const read = tx.objectStore("intents").getAll()
        tx.oncomplete = () => { database.close(); resolve(read.result) }
        tx.onerror = tx.onabort = () => { database.close(); reject(tx.error) }
      }
    })),
    async close() {
      await Promise.allSettled([...pending])
      await initialized.context.close()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}
