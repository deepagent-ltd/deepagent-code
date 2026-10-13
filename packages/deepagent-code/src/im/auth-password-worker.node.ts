import { parentPort, workerData } from "node:worker_threads"
import { argon2id } from "hash-wasm"
import { isWorkerInput } from "./auth-password-policy.ts"

// Fixed one-shot binary derivation. No executable, module, path, URL, or options object
// supplied by a caller reaches the package API.
const data: unknown = workerData
if (!parentPort || !isWorkerInput(data)) throw new Error("Invalid credential worker input")
try {
  const result = await argon2id({
    password: data.message,
    salt: data.nonce,
    parallelism: data.parallelism,
    iterations: data.passes,
    memorySize: data.memory,
    hashLength: data.tagLength,
    outputType: "binary",
  })
  parentPort.postMessage(result)
  result.fill(0)
} finally {
  data.message.fill(0)
  data.nonce.fill(0)
  parentPort.close()
}
