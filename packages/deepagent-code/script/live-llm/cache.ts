import { mkdir, rename } from "node:fs/promises"
import path from "node:path"
import type { ExecutionStack, ModelSuite } from "./routes"

export const successCacheTTL = 24 * 60 * 60 * 1000

export type SuccessCacheKeyInput = {
  pushedRef: string
  objectOID: string
  commitOID: string
  suite: ModelSuite
  suiteVersion: string
  stack: ExecutionStack
  providerID: string
  modelID: string
  modelRevision?: string
  processIdentity: string
  generationParametersHash: string
  harnessHash: string
  routeManifestHash: string
  relevantSourceHash: string
  buildArtifactHash?: string
  sandboxProfileHash?: string
  oracleHash?: string
}

export type SuccessCacheEntry = {
  key: string
  completedAt: number
  identity?: SuccessCacheKeyInput
}

export type SuccessCache = {
  version: 1
  entries: SuccessCacheEntry[]
}

export function successCacheKey(input: SuccessCacheKeyInput) {
  const required = [
    input.pushedRef,
    input.objectOID,
    input.commitOID,
    input.suiteVersion,
    input.providerID,
    input.modelID,
    input.processIdentity,
    input.generationParametersHash,
    input.harnessHash,
    input.routeManifestHash,
    input.relevantSourceHash,
  ]
  if (required.some((value) => !value)) throw new Error("Cannot create a live LLM cache key with empty identity fields")

  return `v1:${new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        pushedRef: input.pushedRef,
        objectOID: input.objectOID,
        commitOID: input.commitOID,
        suite: input.suite,
        suiteVersion: input.suiteVersion,
        stack: input.stack,
        providerID: input.providerID,
        modelID: input.modelID,
        modelRevision: input.modelRevision || `process:${input.processIdentity}`,
        generationParametersHash: input.generationParametersHash,
        harnessHash: input.harnessHash,
        routeManifestHash: input.routeManifestHash,
        relevantSourceHash: input.relevantSourceHash,
        buildArtifactHash: input.buildArtifactHash || "",
        sandboxProfileHash: input.sandboxProfileHash || "",
        oracleHash: input.oracleHash || "",
      }),
    )
    .digest("hex")}`
}

export function canReuseSuccess(
  entry: SuccessCacheEntry,
  input: SuccessCacheKeyInput,
  now = Date.now(),
  ttl = successCacheTTL,
) {
  if (ttl < 0 || entry.completedAt > now || now - entry.completedAt > ttl) return false
  return entry.key === successCacheKey(input)
}

export async function readSuccessCache(file: string): Promise<SuccessCache> {
  if (!(await Bun.file(file).exists())) return { version: 1, entries: [] }
  const payload: unknown = await Bun.file(file).json()
  if (!isRecord(payload) || payload.version !== 1 || !Array.isArray(payload.entries)) {
    throw new Error(`Invalid live LLM success cache: ${file}`)
  }
  const entries = payload.entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.completedAt !== "number") return []
    return [{ key: entry.key, completedAt: entry.completedAt, identity: cacheIdentity(entry.identity) }]
  })
  if (entries.length !== payload.entries.length) throw new Error(`Invalid live LLM success cache entry: ${file}`)
  return { version: 1, entries }
}

export async function writeSuccessCache(file: string, cache: SuccessCache) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, `${JSON.stringify(cache, undefined, 2)}\n`)
  await rename(temporary, file)
}

function cacheIdentity(value: unknown): SuccessCacheKeyInput | undefined {
  if (value === undefined) return
  if (!isRecord(value)) throw new Error("Invalid live LLM cache identity")
  return value as SuccessCacheKeyInput
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
