import { createHash } from "node:crypto"
import { Worker } from "node:worker_threads"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { sharedBrowserComputationAsset } from "./shared-browser-compute-asset"

const active = new Map<string, { started: boolean }>()
type Command = Extract<BrowserSchema.Command, { type: "evaluate" | "program" }>
export type SharedBrowserScriptPage = {
  text: string
  truncated: boolean
  refs: NonNullable<BrowserSchema.Result["refs"]>
  frameID: string
  observationRevision: number
  generation: number
}

/** Main-only diagnostic of actual worker entry, never an authorization source. */
export function sharedBrowserComputationState(resourceKey: string) { return active.get(resourceKey) }

/** Approved source sees only immutable public JSON inside a fresh QuickJS WASM
 * interpreter. Worker termination is joined before the resource slot is freed. */
export function createSharedBrowserComputation(input: {
  resourceKey: string
  command: Command
  page: SharedBrowserScriptPage
  deadline: number
  current: () => Promise<void>
  currentNow: () => void
  fail: (code: BrowserSchema.Error["code"]) => never
}) {
  input.currentNow()
  if (active.has(input.resourceKey) || active.size >= 4) return input.fail("BROWSER_CAPACITY")
  const projection = CanonicalJson.stringify({ argsJSON: input.command.argsJSON, page: input.page })
  const bytes = Buffer.byteLength(projection)
  if (bytes > 1_048_576) return input.fail("BROWSER_OUTPUT_LIMIT")
  const timeout = Math.min(BrowserSchema.MAX_SCRIPT_MS, input.deadline - Date.now())
  if (timeout <= 0) return input.fail("BROWSER_CANCELLED")
  const deadline = Date.now() + timeout
  active.set(input.resourceKey, { started: false })
  const state: { worker?: Worker; failed?: BrowserSchema.Error["code"]; json?: string } = {}
  const interrupted = Promise.withResolvers<void>()
  const cancel = () => {
    state.failed = "BROWSER_CANCELLED"
    interrupted.resolve()
    void state.worker?.terminate().catch(() => undefined)
  }
  const timer = setTimeout(cancel, timeout)
  const current = async () => {
    if (Date.now() >= deadline) cancel()
    if (state.failed) return input.fail(state.failed)
    await Promise.race([input.current(), interrupted.promise])
    if (Date.now() >= deadline) cancel()
    if (state.failed) return input.fail(state.failed)
    input.currentNow()
  }
  const operation = (async () => {
    await current()
    const asset = sharedBrowserComputationAsset()
    if (Date.now() >= deadline || state.failed) return input.fail("BROWSER_CANCELLED")
    const worker = new Worker(asset.code, { eval: true, workerData: { source: input.command.source, argsJSON: input.command.argsJSON,
      pageJSON: CanonicalJson.stringify(input.page), wasm: new Uint8Array(asset.wasm), deadline },
      env: {}, execArgv: [], stdout: true, stderr: true,
      // V8 limits supplement, and do not replace, the imported WASM hard maximum.
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } })
    state.worker = worker
    worker.stdout.resume()
    worker.stderr.resume()
    await new Promise<void>((resolve) => {
      const invalid = () => { state.failed ??= "BROWSER_INVALID_RECORD"; void worker.terminate().catch(() => undefined) }
      worker.once("error", invalid)
      worker.on("message", (message: unknown) => {
        if (Date.now() >= deadline) cancel()
        if (state.failed) return
        if (!message || typeof message !== "object" || !("type" in message)) { invalid(); return }
        if (message.type === "started" && !active.get(input.resourceKey)?.started) {
          active.set(input.resourceKey, { started: true }); return
        }
        if (message.type !== "result" || state.json !== undefined || !("json" in message) || typeof message.json !== "string" ||
          Buffer.byteLength(message.json) > BrowserSchema.MAX_SCRIPT_RESULT_BYTES || !("memoryBytes" in message) ||
          !Number.isSafeInteger(message.memoryBytes) || Number(message.memoryBytes) > 32 * 1024 * 1024) { invalid(); return }
        state.json = message.json
      })
      worker.once("exit", (code) => { if (code !== 0 || state.json === undefined) state.failed ??= "BROWSER_INVALID_RECORD"; resolve() })
      if (state.failed) void worker.terminate().catch(() => undefined)
    })
    await current()
    if (state.json === undefined) return input.fail("BROWSER_INVALID_RECORD")
    return { json: state.json, evidence: { version: 1 as const, context: "snapshot-json-v1" as const,
      sha256: createHash("sha256").update(projection).digest("hex"), bytes, frameID: input.page.frameID,
      observationRevision: input.page.observationRevision, generation: input.page.generation } }
  })()
  return { cancel, result: operation.finally(() => { clearTimeout(timer); active.delete(input.resourceKey) }) }
}
