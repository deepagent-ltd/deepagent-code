export * as PasswordBackend from "./auth-password.node"

import { randomBytes, timingSafeEqual, getFips } from "node:crypto"
import type { Parameters } from "./auth-runtime"
import { PasswordWorker } from "./auth-password-worker-client.node"

export async function verify(message: Buffer, _verifier: string, parameters: Parameters) {
  const key = await derive(message, parameters)
  const matches = key.length === parameters.tag.length && timingSafeEqual(key, parameters.tag)
  key.fill(0)
  return matches
}

export async function hash(message: Buffer) {
  const nonce = randomBytes(32)
  const key = await derive(message, { nonce, memory: 65_536, passes: 3, parallelism: 1, tag: Buffer.alloc(32) })
  const encoded = `$argon2id$v=19$m=65536,t=3,p=1$${nonce.toString("base64").replace(/=+$/, "")}$${key.toString("base64").replace(/=+$/, "")}`
  key.fill(0)
  return encoded
}

async function derive(message: Buffer, parameters: Parameters) {
  const { argon2 } = await import("node:crypto")
  if (typeof argon2 !== "function") throw new Error("Asynchronous Argon2 is unavailable")
  return new Promise<Buffer>((resolve, reject) => {
    argon2(
      "argon2id",
      {
        message,
        nonce: parameters.nonce,
        parallelism: parameters.parallelism,
        tagLength: parameters.tag.length,
        memory: parameters.memory,
        passes: parameters.passes,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    )
  }).catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_CRYPTO_ARGON2_NOT_SUPPORTED" &&
      getFips() === 0
    )
      return PasswordWorker.derive(message, parameters)
    throw new Error("Asynchronous Argon2 failed")
  })
}
