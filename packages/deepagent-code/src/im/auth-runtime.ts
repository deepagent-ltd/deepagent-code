export * as AuthRuntime from "./auth-runtime"

import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { PasswordBackend } from "#operator-password"

export type Parameters = ReturnType<typeof parse>

export { policy } from "./auth-password-policy"
import { policy } from "./auth-password-policy"
const live = { count: 0 }
const waiting = new Set<() => void>()
const unavailable = () =>
  new LocalOperatorSchema.Error({
    code: "LOCAL_OPERATOR_UNAVAILABLE",
    message: "Local credential verification is unavailable or exceeds its supported resource profile",
  })

export async function verify(password: string, verifier: string, signal?: AbortSignal): Promise<boolean> {
  const parsed = parse(verifier)
  return runCredentialWork(password, (message) => PasswordBackend.verify(message, verifier, parsed), signal)
}

export async function hash(password: string, signal?: AbortSignal): Promise<string> {
  return runCredentialWork(password, async (message) => {
    const verifier = await PasswordBackend.hash(message)
    parse(verifier)
    return verifier
  }, signal)
}

async function runCredentialWork<A>(password: string, operation: (message: Buffer) => Promise<A>, signal?: AbortSignal) {
  const message = passwordBytes(password)
  const permit = { release: undefined as (() => void) | undefined }
  try {
    permit.release = await acquireCredentialSlot(signal)
    if (signal?.aborted) throw unavailable()
    return await operation(message)
  } catch {
    // Native errors may contain input details. No cached verification or witness
    // is shared; every caller still verifies and rechecks current SQL authority.
    throw unavailable()
  } finally {
    message.fill(0)
    permit.release?.()
  }
}

async function acquireCredentialSlot(signal?: AbortSignal) {
  if (signal?.aborted) throw unavailable()
  const release = () => {
    live.count--
    waiting.values().next().value?.()
  }
  if (live.count < policy.concurrent) {
    live.count++
    return release
  }
  if (waiting.size >= policy.pending) throw unavailable()
  return new Promise<() => void>((resolve, reject) => {
    const complete = () => {
      if (!waiting.delete(ready)) return false
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
      return true
    }
    const ready = () => {
      if (!complete()) return
      live.count++
      resolve(release)
    }
    const cancel = () => { if (complete()) reject(unavailable()) }
    const timer = setTimeout(cancel, policy.waitMs)
    waiting.add(ready)
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}

function passwordBytes(password: string) {
  if (typeof password !== "string" || !password.length || password.length > policy.passwordBytes) throw unavailable()
  const bytes = Buffer.from(password, "utf8")
  // Preserve exact UTF-8, including NUL and composed/decomposed forms. Never normalize or replace lone surrogates.
  if (bytes.length > policy.passwordBytes || bytes.toString("utf8") !== password) {
    bytes.fill(0)
    throw unavailable()
  }
  return bytes
}

function parse(verifier: string) {
  if (typeof verifier !== "string" || verifier.length > policy.phcBytes) throw unavailable()
  const parts =
    /^\$argon2id\$v=19\$m=([1-9][0-9]{0,5}),t=([1-9]),p=([1-9])\$([A-Za-z0-9+/]{11,86})\$([A-Za-z0-9+/]{22,86})$/.exec(
      verifier,
    )
  if (!parts) throw unavailable()
  const memory = Number(parts[1])
  const passes = Number(parts[2])
  const parallelism = Number(parts[3])
  const nonce = Buffer.from(parts[4]!, "base64")
  const tag = Buffer.from(parts[5]!, "base64")
  if (
    memory < 8 * parallelism ||
    memory > policy.memoryKiB ||
    passes > policy.passes ||
    parallelism > policy.parallelism ||
    memory * passes > policy.workKiBPasses ||
    nonce.length < 8 ||
    nonce.length > 64 ||
    tag.length < 16 ||
    tag.length > 64 ||
    nonce.toString("base64").replace(/=+$/, "") !== parts[4] ||
    tag.toString("base64").replace(/=+$/, "") !== parts[5]
  )
    throw unavailable()
  return { memory, passes, parallelism, nonce, tag }
}
