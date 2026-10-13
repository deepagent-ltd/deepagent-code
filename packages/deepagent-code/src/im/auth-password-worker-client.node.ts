export * as PasswordWorker from "./auth-password-worker-client.node.ts"

import { Worker } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import type { Parameters } from "./auth-runtime"
import { policy, isWorkerInput } from "./auth-password-policy.ts"

const live = { count: 0 }

// The worker is an application asset, never a caller-controlled script or URL. Electron's
// ASAR-aware fs does not make Node Worker loaders ASAR-aware, so target the unpacked sibling.
function asset() {
  const filename = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./auth-password-worker.node.ts" : "./auth-password-worker.node.js",
      import.meta.url,
    ),
  )
  return pathToFileURL(filename.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`))
}

export async function derive(message: Buffer, parameters: Parameters, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted || live.count >= policy.concurrent) throw new Error("Credential worker unavailable")
  const data = {
    version: 1,
    message,
    nonce: parameters.nonce,
    memory: parameters.memory,
    passes: parameters.passes,
    parallelism: parameters.parallelism,
    tagLength: parameters.tag.length,
  }
  if (!isWorkerInput(data)) throw new Error("Invalid credential worker input")
  const worker = new Worker(asset(), {
    workerData: { ...data, message: new Uint8Array(message), nonce: new Uint8Array(parameters.nonce) },
    env: {},
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    stdout: true,
    stderr: true,
  })
  live.count++
  // A dedicated worker emits no logs. Consume unexpected output without exposing any input.
  worker.stdout.resume()
  worker.stderr.resume()
  return new Promise<Buffer>((resolve, reject) => {
    const state: { value?: Buffer; failed: boolean } = { failed: false }
    const stop = () => {
      state.failed = true
      // Never settle or release the shared Argon2 slot before actual worker exit.
      void worker.terminate().catch(() => undefined)
    }
    const timer = setTimeout(stop, 30_000)
    signal?.addEventListener("abort", stop, { once: true })
    worker.once("error", stop)
    worker.on("message", (value: unknown) => {
      if (state.value || !(value instanceof Uint8Array) || value.byteLength !== parameters.tag.length) {
        stop()
        return
      }
      state.value = Buffer.from(value)
    })
    worker.once("exit", (code) => {
      live.count--
      clearTimeout(timer)
      signal?.removeEventListener("abort", stop)
      if (state.failed || code !== 0 || !state.value) {
        state.value?.fill(0)
        reject(new Error("Credential worker unavailable"))
        return
      }
      resolve(state.value)
    })
    if (signal?.aborted) stop()
  })
}
