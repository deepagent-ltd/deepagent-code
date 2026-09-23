export * as PluginSignature from "./signature"

import { createHash, createPublicKey, verify } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { PluginLoader } from "./loader"
import { isRecord } from "@/util/record"

const manifestName = ".deepagent-code-signature.json"

export class SignatureError extends Error {
  readonly _tag = "PluginSignatureError"

  constructor(
    readonly spec: string,
    message: string,
  ) {
    super(`Plugin ${spec} signature rejected: ${message}`)
    this.name = "PluginSignatureError"
  }
}

/**
 * A configured trust store enforces signatures for every external plugin. An unset store keeps
 * existing unsigned installs working until an administrator opts into signed-only loading.
 * Keys are pinned by key ID in DEEPAGENT_CODE_PLUGIN_TRUST_KEYS (JSON mapping to PEM public keys).
 * Packages carry .deepagent-code-signature.json at their root and sign every package file.
 * Standalone file plugins carry <entry>.deepagent-code-signature.json and sign their entry file.
 * Both manifests contain algorithm "ed25519-sha256", keyId, digest (lowercase SHA-256 hex),
 * and signature (base64 Ed25519 over the 32 digest bytes).
 */
export async function check(row: PluginLoader.Resolved, trustJSON = process.env.DEEPAGENT_CODE_PLUGIN_TRUST_KEYS) {
  if (trustJSON === undefined) return
  let trusted: unknown
  try {
    trusted = JSON.parse(trustJSON)
  } catch {
    throw new SignatureError(row.spec, "trust store is not valid JSON")
  }
  if (!isRecord(trusted)) {
    throw new SignatureError(row.spec, "trust store must map key IDs to PEM public keys")
  }
  const entry = row.pkg ? undefined : fileURLToPath(row.entry)
  const root = row.pkg?.dir ?? path.dirname(fileURLToPath(row.entry))
  const manifestPath = row.pkg ? path.join(root, manifestName) : `${entry}.${manifestName.slice(1)}`
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch {
    throw new SignatureError(row.spec, `${manifestPath} is missing or invalid`)
  }
  if (!isRecord(manifest)) {
    throw new SignatureError(row.spec, "signature manifest must be an object")
  }
  if (
    manifest.algorithm !== "ed25519-sha256" ||
    typeof manifest.keyId !== "string" ||
    typeof manifest.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.digest) ||
    typeof manifest.signature !== "string"
  ) {
    throw new SignatureError(row.spec, "signature manifest fields are invalid")
  }
  const pem = trusted[manifest.keyId]
  if (typeof pem !== "string") throw new SignatureError(row.spec, `key ${manifest.keyId} is not trusted`)
  const digest = await hash(root, entry ? [path.basename(entry)] : undefined).catch((error) => {
    throw new SignatureError(row.spec, `package content cannot be verified: ${String(error)}`)
  })
  if (digest !== manifest.digest) throw new SignatureError(row.spec, "package content digest does not match")
  try {
    const key = createPublicKey(pem)
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !verify(null, Buffer.from(digest, "hex"), key, Buffer.from(manifest.signature, "base64"))
    ) {
      throw new SignatureError(row.spec, "Ed25519 signature does not verify")
    }
  } catch (error) {
    if (error instanceof SignatureError) throw error
    throw new SignatureError(row.spec, "trusted public key is invalid")
  }
}

/** Stable digest of every regular file in the plugin package, excluding only its signature manifest. */
export async function hash(root: string, selected?: string[]) {
  const files: string[] = []
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === manifestName || entry.name.endsWith(`.${manifestName.slice(1)}`)) continue
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Plugin package contains a symbolic link: ${file}`)
      if (entry.isDirectory()) {
        await visit(file)
        continue
      }
      if (!entry.isFile()) throw new Error(`Plugin package contains a non-file: ${file}`)
      files.push(file)
      if (files.length > 10_000) throw new Error("Plugin package has too many files to verify")
    }
  }
  if (selected) files.push(...selected.map((file) => path.join(root, file)))
  else await visit(root)
  const digest = createHash("sha256")
  for (const file of files.sort()) {
    const relative = path.relative(root, file).split(path.sep).join("/")
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
      throw new Error(`Plugin package file cannot be verified: ${relative}`)
    digest
      .update(relative)
      .update("\0")
      .update(String(stat.size))
      .update("\0")
      .update(await readFile(file))
  }
  return digest.digest("hex")
}
