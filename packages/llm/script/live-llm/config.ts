import path from "node:path"
import os from "node:os"
import { mkdir, realpath, stat } from "node:fs/promises"

export type LiveLLMConfig = {
  providerID: "deepseek"
  modelID: string
  modelRevision?: string
  baseURL: string
  apiKey: string
  apiKeyFile: string
  timeoutMs: number
  artifactDirectory: string
}

export type ModelFingerprint = Omit<LiveLLMConfig, "apiKey" | "apiKeyFile" | "timeoutMs" | "artifactDirectory">

export async function loadLiveLLMConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LiveLLMConfig> {
  if (environment.DEEPAGENT_CODE_LIVE_LLM_API_KEY?.trim() || environment.DEEPSEEK_API_KEY?.trim()) {
    throw new Error(
      "Raw API key environment variables are not accepted by live LLM tests; " +
        "set DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE to a chmod 600 key file",
    )
  }
  const apiKeyFile = await validateLiveLLMKeyFile(
    requiredString(environment.DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE, "DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE"),
  )
  const apiKey = (await Bun.file(apiKeyFile).text()).trim()
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error("Live LLM key file must contain exactly one non-empty line")

  const baseURL = (environment.DEEPAGENT_CODE_LIVE_LLM_BASE_URL?.trim() || "https://api.deepseek.com").replace(
    /\/$/,
    "",
  )
  const endpoint = new URL(baseURL)
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "api.deepseek.com") {
    throw new Error(`Official DeepSeek live tests require https://api.deepseek.com, received ${baseURL}`)
  }

  const timeoutMs = Number(environment.DEEPAGENT_CODE_LIVE_LLM_TIMEOUT_MS || 120_000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60_000) {
    throw new Error("DEEPAGENT_CODE_LIVE_LLM_TIMEOUT_MS must be an integer between 1000 and 900000")
  }

  return {
    providerID: "deepseek",
    modelID: environment.DEEPAGENT_CODE_LIVE_LLM_MODEL?.trim() || "deepseek-v4-flash",
    modelRevision: environment.DEEPAGENT_CODE_LIVE_LLM_REVISION?.trim() || undefined,
    baseURL,
    apiKey,
    apiKeyFile,
    timeoutMs,
    artifactDirectory: liveLLMArtifactDirectory(environment),
  }
}

export function liveLLMArtifactDirectory(environment: Readonly<Record<string, string | undefined>> = process.env) {
  return (
    environment.DEEPAGENT_CODE_LIVE_LLM_ARTIFACT_DIR?.trim() ||
    path.resolve(import.meta.dir, "../../.artifacts/live-llm")
  )
}

export async function validateLiveLLMKeyFile(file: string) {
  const resolved = await realpath(file).catch(() => {
    throw new Error(`Live LLM key file does not exist: ${file}`)
  })
  if (resolved.includes("}")) throw new Error("Live LLM key file path cannot contain }")
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error(`Live LLM key file is not a regular file: ${resolved}`)
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`Live LLM key file must not be readable by group or others; run: chmod 600 ${resolved}`)
  }
  return resolved
}

export function liveLLMKeyFileReference(config: Pick<LiveLLMConfig, "apiKeyFile">) {
  return `{file:${config.apiKeyFile}}`
}

export async function preflightLiveLLM(config: LiveLLMConfig) {
  const startedAt = Date.now()
  const response = await fetch(`${config.baseURL}/models`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(Math.min(config.timeoutMs, 30_000)),
  })
  if (!response.ok) throw new Error(`DeepSeek model preflight failed with HTTP ${response.status}`)
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data))
    throw new Error("DeepSeek model preflight returned invalid JSON")
  const models = payload.data.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []))
  if (!models.includes(config.modelID)) {
    throw new Error(`DeepSeek model ${config.modelID} is not available; reported models: ${models.join(", ")}`)
  }
  return { models, durationMs: Date.now() - startedAt }
}

export function modelFingerprint(config: LiveLLMConfig): ModelFingerprint {
  return {
    providerID: config.providerID,
    modelID: config.modelID,
    modelRevision: config.modelRevision,
    baseURL: config.baseURL,
  }
}

export async function writeLiveArtifact(
  config: Pick<LiveLLMConfig, "artifactDirectory"> & Partial<Pick<LiveLLMConfig, "apiKey">>,
  suite: string,
  artifact: unknown,
  options?: {
    redactions?: ReadonlyArray<{ value: string; replacement?: string }>
  },
) {
  await mkdir(config.artifactDirectory, { recursive: true })
  const replacements = [
    { value: await realpath(os.tmpdir()), replacement: "<tmp>" },
    { value: os.tmpdir(), replacement: "<tmp>" },
    ...(process.env.HOME ? [{ value: process.env.HOME, replacement: "<home>" }] : []),
    ...[config.apiKey, process.env.DEEPAGENT_CODE_LIVE_LLM_API_KEY, process.env.DEEPSEEK_API_KEY].flatMap((value) =>
      value ? [{ value, replacement: "<redacted>" }] : [],
    ),
    ...(options?.redactions ?? []).map((item) => ({
      value: item.value,
      replacement: item.replacement ?? "<redacted>",
    })),
  ]
  const serialized = replacements
    .filter((item) => item.value.length > 1)
    .sort((a, b) => b.value.length - a.value.length)
    .reduce(
      (contents, item) => contents.replaceAll(item.value, item.replacement),
      JSON.stringify(artifact, undefined, 2) ?? "null",
    )
  await Bun.write(path.join(config.artifactDirectory, `${suite}.json`), `${serialized}\n`)
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
