import { chromium } from "@playwright/test"
import { createServer } from "node:http"
import path from "node:path"
import type { MediaIntent } from "@deepagent-code/core/im/media-intent"
import type { MediaBatch } from "@deepagent-code/core/im/media-batch"

type Store = ReturnType<typeof import("../../../src/utils/im-media-intent").createMediaIntentStore>
  | ReturnType<typeof import("../../../src/utils/im-media-intent").createMediaBatchStore>
type Host = Window & {
  DACMediaFixture: typeof import("../../../src/utils/im-media-intent")
  mediaStores: Map<number, Store>
}
let bundled: Promise<string> | undefined

// HappyDOM owns the component; locked Chromium owns the original durable GUI store.
// This adapter forwards operations, never replaces schema, revisions or transactions.
export async function createBrowserMediaStoreFixture(directory: string) {
  bundled ??= (async () => {
    const { build } = await import("vite")
    const output = await build({
      configFile: false,
      logLevel: "error",
      build: {
        write: false,
        minify: false,
        lib: {
          entry: path.resolve(process.cwd(), "src/utils/im-media-intent.ts"),
          name: "DACMediaFixture",
          formats: ["iife"],
        },
      },
    })
    const result = Array.isArray(output) ? output[0] : output
    if (!("output" in result)) throw new Error("Original browser media store did not build")
    const chunk = result.output.find((item) => item.type === "chunk")
    if (!chunk || chunk.type !== "chunk") throw new Error("Original browser media store chunk missing")
    return chunk.code
  })()
  const script = await bundled
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Owned media store</title>")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Owned media fixture did not bind")
  const initialized = await (async () => {
    const context = await chromium.launchPersistentContext(directory, { headless: true })
    try {
      const page = await context.newPage()
      await page.goto(`http://127.0.0.1:${address.port}`)
      await page.addScriptTag({ content: script })
      await page.evaluate(async () => {
        const host = window as unknown as Host
        host.mediaStores = new Map()
        const probes = [host.DACMediaFixture.createMediaIntentStore(), host.DACMediaFixture.createMediaBatchStore()]
        await Promise.all(probes.map((store) => store.list({ server: location.origin, directory: "/fixture", workspaceID: "fixture", groupID: "fixture", memberID: "fixture" })))
        probes.forEach((store) => store.close())
      })
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
  function store<Value extends MediaIntent.Record | MediaBatch.Record>(kind: "intents" | "batches") {
    const id = next++
    const ready = track(page.evaluate(({ id, kind }) => {
      const host = window as unknown as Host
      host.mediaStores.set(id, kind === "intents" ? host.DACMediaFixture.createMediaIntentStore() : host.DACMediaFixture.createMediaBatchStore())
    }, { id, kind }))
    const call = <T>(operation: "list" | "put" | "discard" | "close", args: unknown[]) => track(ready.then(() => page.evaluate(async ({ id, operation, args }) => {
      try {
        const host = window as unknown as Host
        const current = host.mediaStores.get(id)
        if (!current) throw new Error("Original browser store missing")
        if (operation === "list") return { value: await current.list(args[0] as MediaIntent.Scope) }
        if (operation === "put") return { value: await current.put(args[0] as MediaIntent.Record & MediaBatch.Record, args[1] as number | undefined) }
        if (operation === "discard") return { value: await current.discard(args[0] as MediaIntent.Record & MediaBatch.Record) }
        current.close()
        host.mediaStores.delete(id)
        return { value: undefined }
      } catch (error) {
        if (!(error instanceof Error)) throw error
        return { error: { name: error.name, message: error.message } }
      }
    }, { id, operation, args: args.map((value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))) }))).then((result) => {
      // Playwright prefixes thrown messages. Preserve the original error contract across IPC.
      if (result.error) throw Object.assign(new Error(result.error.message), { name: result.error.name })
      return result.value as T
    })
    return {
      list: (scope: MediaIntent.Scope) => call<Value[]>("list", [scope]),
      put: (value: Value, revision?: number) => call<Value>("put", [value, revision]),
      discard: (value: Value) => call<void>("discard", [value]),
      close: () => { void call<void>("close", []).catch(() => undefined) },
    }
  }
  async function records(kind: "intents" | "batches", values?: unknown[]) {
    return page.evaluate(({ kind, values }) => new Promise<unknown[]>((resolve, reject) => {
      const request = indexedDB.open("deepagent-im-media-v1", 2)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction(kind, values === undefined ? "readonly" : "readwrite", { durability: "strict" })
        const objectStore = transaction.objectStore(kind)
        if (values !== undefined) {
          objectStore.clear()
          values.forEach((value) => objectStore.put(value))
        }
        const read = objectStore.getAll()
        transaction.oncomplete = () => { database.close(); resolve(read.result) }
        transaction.onerror = transaction.onabort = () => { database.close(); reject(transaction.error) }
      }
    }), { kind, values })
  }
  return {
    createMediaIntentStore: () => store<MediaIntent.Record>("intents"),
    createMediaBatchStore: () => store<MediaBatch.Record>("batches"),
    records,
    drain: () => Promise.allSettled([...pending]),
    async close() {
      await Promise.allSettled([...pending])
      await initialized.context.close()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}
