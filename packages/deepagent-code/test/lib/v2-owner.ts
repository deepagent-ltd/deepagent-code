import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Global } from "@deepagent-code/core/global"
import { V2OwnerAuthorization } from "@deepagent-code/core/session/runner/v2-owner-authorization"

// Process-wide dev V2-owner keypair for the test process.
//
// Why this must be a singleton: bun runs every test file in ONE process, and Context.Reference
// defaults cache process-wide on first access (effect's Context.getDefaultValue stores the value
// on the Reference object). The owner-qualification seam has two such references:
//
//   - CurrentOwnerAuthorizationPublicKey — default reads DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY
//   - CurrentOwnerCampaign — default derives from DEEPAGENT_CODE_V2_OWNER_DEV_MINT / installation version
//
// The dev mint (V2OwnerDevMint) signs its authorization row with the persisted keypair under
// Global.Path.state/v2-owner-dev. If two test files minted their own keypairs — or an unarmed file
// evaluated the reference defaults first — signer and verifier split and every owner-gated prompt
// route fails verification (503 v2_owner_unavailable) depending on test-file order. One shared
// pair (first writer wins, later callers adopt the persisted one) plus arming the env once in
// test/preload.ts keeps minter, verifier, and campaign identical for the whole process.
type Keypair = { readonly publicKeyPem: string; readonly privateKeyPem: string }

let cached: Keypair | undefined

const isKeypair = (value: unknown): value is Keypair =>
  typeof value === "object" &&
  value !== null &&
  "publicKeyPem" in value &&
  typeof value.publicKeyPem === "string" &&
  "privateKeyPem" in value &&
  typeof value.privateKeyPem === "string"

export const ownerDevKeypair = (): Keypair => {
  if (cached) return cached
  const file = path.join(Global.Path.state, "v2-owner-dev", "keypair.json")
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (isKeypair(parsed)) return (cached = parsed)
    } catch {
      // Fall through: a corrupt file is regenerated below, mirroring V2OwnerDevMint.devKeyPair.
    }
  }
  const pair = V2OwnerAuthorization.generateAuthorizationKeyPair()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(pair), { mode: 0o600 })
  return (cached = pair)
}
