// Bounds cover the application's Bun defaults and explicit operator enrollment profile.
// This is a work allocation limit, not a bound on the process's total RSS.
export const policy = Object.freeze({
  passwordBytes: 65_536,
  phcBytes: 512,
  memoryKiB: 131_072,
  passes: 6,
  parallelism: 4,
  workKiBPasses: 393_216,
  concurrent: 2,
  pending: 32,
  waitMs: 5_000,
})

export type WorkerInput = {
  version: 1
  message: Uint8Array
  nonce: Uint8Array
  memory: number
  passes: number
  parallelism: number
  tagLength: number
}

export function isWorkerInput(input: unknown): input is WorkerInput {
  if (!input || typeof input !== "object") return false
  const data = input as Record<string, unknown>
  return (
    Object.keys(data).sort().join(",") === "memory,message,nonce,parallelism,passes,tagLength,version" &&
    data.version === 1 &&
    data.message instanceof Uint8Array &&
    data.message.length >= 1 &&
    data.message.length <= policy.passwordBytes &&
    data.nonce instanceof Uint8Array &&
    data.nonce.length >= 8 &&
    data.nonce.length <= 64 &&
    typeof data.memory === "number" &&
    Number.isSafeInteger(data.memory) &&
    typeof data.passes === "number" &&
    Number.isSafeInteger(data.passes) &&
    data.passes >= 1 &&
    data.passes <= policy.passes &&
    typeof data.parallelism === "number" &&
    Number.isSafeInteger(data.parallelism) &&
    data.parallelism >= 1 &&
    data.parallelism <= policy.parallelism &&
    data.memory >= 8 * data.parallelism &&
    data.memory <= policy.memoryKiB &&
    data.memory * data.passes <= policy.workKiBPasses &&
    typeof data.tagLength === "number" &&
    Number.isSafeInteger(data.tagLength) &&
    data.tagLength >= 16 &&
    data.tagLength <= 64
  )
}
