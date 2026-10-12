export * as PasswordBackend from "./auth-password.bun"

import type { Parameters } from "./auth-runtime"

export function verify(message: Buffer, verifier: string, _parameters: Parameters) {
  return Bun.password.verify(message, verifier, "argon2id")
}

export function hash(message: Buffer) {
  return Bun.password.hash(message, { algorithm: "argon2id", memoryCost: 65_536, timeCost: 3 })
}
