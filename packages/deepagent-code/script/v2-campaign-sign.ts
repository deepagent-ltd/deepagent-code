// Production campaign signing tool for the V2 owner authorization chain.
// Usage (from packages/deepagent-code):
//   node --experimental-strip-types script/v2-campaign-sign.ts sign --key <private-key-pem> --commit <sha> --tree <sha> --build <id> [--package <digest>] [--seconds <lt>]
//   node --experimental-strip-types script/v2-campaign-sign.ts verify --public <public-key-pem> --payload <campaign-json>
// The campaign payload is canonicalized exactly like the core verifier (sorted keys, undefined
// filtered) and the 128-hex Ed25519 signature is the `signature` field of the output JSON.
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto"
import { readFileSync } from "node:fs"

const canonicalize = (value: unknown): unknown => {
  if (value === null || value === undefined || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
  )
}

const args = process.argv.slice(2)
const valueAfter = (flag: string) => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

if (args[0] === "sign") {
  const keyFile = valueAfter("--key")
  if (!keyFile) throw new Error("sign requires --key <private-key-pem> file path")
  const commit = valueAfter("--commit")
  const tree = valueAfter("--tree")
  if (!commit || !tree) throw new Error("sign requires --commit <sha> --tree <sha>")
  const buildID = valueAfter("--build") ?? createHash("sha256").update("dev-local-packaged").digest("hex")
  const packageDigest = valueAfter("--package") ?? ""
  const seconds = Number(valueAfter("--seconds") ?? 30 * 24 * 60 * 60)
  const campaignID = `v2-campaign-${randomUUID().slice(0, 8)}`
  const signable = {
    authorizationID: `auth_${campaignID}`,
    campaignID,
    subjectCommit: commit,
    subjectTree: tree,
    schemaDigest: createHash("sha256").update(commit + tree).digest("hex"),
    buildID,
    packageDigest,
    validFrom: Date.now() - 1_000,
    expiresAt: Date.now() + seconds * 1_000,
  }
  const privateKey = createPrivateKey(readFileSync(keyFile, "utf8"))
  const signature = sign(null, Buffer.from(JSON.stringify(canonicalize(signable))), privateKey).toString("hex")
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString()
  console.log(JSON.stringify({ ...signable, signature }, null, 2))
  console.error(`signatureDigest=${signature}`)
  console.error(`publicKeyFingerprint=${createHash("sha256").update(publicKeyPem).digest("hex")}`)
} else if (args[0] === "verify") {
  const publicFile = valueAfter("--public")
  const payloadFile = valueAfter("--payload")
  if (!publicFile || !payloadFile) throw new Error("verify requires --public <pem> --payload <campaign-json>")
  const { signature, ...rest } = JSON.parse(readFileSync(payloadFile, "utf8")) as Record<string, unknown>
  const publicKey = createPublicKey(readFileSync(publicFile, "utf8"))
  const ok = verify(null, Buffer.from(JSON.stringify(canonicalize(rest))), publicKey, Buffer.from(String(signature), "hex"))
  console.log(ok ? "VALID" : "INVALID")
  process.exitCode = ok ? 0 : 1
} else {
  throw new Error("usage: v2-campaign-sign.ts [sign|verify] ...")
}
