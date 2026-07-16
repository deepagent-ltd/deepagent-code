import fsNode from "fs/promises"
import path from "path"
import { Global } from "@deepagent-code/core/global"
import { OFFICIAL_PROVIDER_ID_SET } from "@deepagent-code/core/provider-official"

/**
 * First-party settings store — the single home for settings that must NOT live in the
 * user-editable config file (`config.jsonc`, which is reserved for third-party
 * providers). Two families live here:
 *
 *   1. `deepagent`  — first-party runtime settings (prompt/intelligence/agent-mode/self-learning +
 *                     gateway knobs) that used to piggyback on `provider.deepagent.options`.
 *   2. `providers`  — per-official-provider transport tuning (header/chunk/request timeouts,
 *                     retries). Official providers deliberately ignore `config.provider.<id>`,
 *                     so their transport settings can only be edited here (via the connect
 *                     dialog's advanced section) — never through the config file.
 *
 * Stored at `~/.deepagent/code/settings.json` (same root as `account.json`), mode 0600,
 * atomic write. Read is cached in-memory and invalidated on write. This module is
 * backend-only; the renderer never imports it (it reads/writes through the config overlay).
 */
export namespace SettingsStore {
  export type PromptMode = "direct" | "intelligence"
  export type AgentMode = "general" | "high" | "xhigh" | "max" | "ultra"
  export type SelfLearning = "manual" | "auto"
  // Child-agent work intensity: "inherit" (default) → subagents run at the parent's agentMode;
  // "downgrade" → subagents run exactly one strength below the parent (ultra→max→…→general).
  export type SubagentIntensity = "inherit" | "downgrade"

  export interface DeepAgentSettings {
    promptMode?: PromptMode
    intelligenceModel?: string
    agentMode?: AgentMode
    subagentIntensity?: SubagentIntensity
    selfLearning?: SelfLearning
    runsDir?: string
    allowProviderExecutedTools?: boolean
    allowProviderExecutedToolNames?: string[]
    // V3.9 §C: the GLOBAL default for whether a new conversation starts with the Expert Panel
    // "armed". A per-session toggle in the chat dialog overrides this per conversation; this only
    // seeds the initial armed state. Undefined ≡ false (opt-in, grey rollout).
    expertPanelDefault?: boolean
  }

  /** Transport tuning for a single official provider. Mirrors the transport keys the provider
   * loader strips from `options` and applies as fetch-level abort controllers, PLUS an optional
   * `baseURL` endpoint override. Official providers deliberately ignore `config.provider.<id>`, so a
   * corporate proxy / self-hosted gateway / air-gapped mirror in front of an official provider can
   * ONLY be pointed to here (the connect dialog's advanced section) — never via the config file.
   * When `baseURL` is set, the OpenAI codex WebSocket transport is skipped (a proxy speaks HTTP, not
   * the ChatGPT-backend WS protocol); see plugin/openai/codex.ts. */
  export interface TransportSettings {
    baseURL?: string
    headerTimeout?: number | false
    chunkTimeout?: number
    timeout?: number | false
    maxRetries?: number
  }

  export interface Settings {
    deepagent?: DeepAgentSettings
    /** Keyed by official provider id (openai/zhipuai/zai/…). */
    providers?: Record<string, TransportSettings>
  }

  const FILE = () => path.join(Global.Path.data, "settings.json")

  // Cache is keyed by resolved file path so a mid-process home switch (TEST_HOME / DEEPAGENT_CODE_HOME
  // in tests) doesn't serve a stale other-home cache.
  let cache: { path: string; value: Settings } | undefined

  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v)

  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined)
  const posInt = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined
  const timeout = (v: unknown): number | false | undefined => (v === false ? false : posInt(v))
  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((i): i is string => typeof i === "string" && i.length > 0) : undefined

  // Legacy-compat: "wish" is the pre-rename value for "intelligence". Accept it on READ and
  // normalize to the canonical "intelligence" so a user's stored "wish" still resolves; we only
  // ever WRITE "intelligence" (or "direct"). Do NOT remove the "wish" branch.
  const promptMode = (v: unknown): PromptMode | undefined =>
    v === "direct" ? "direct" : v === "intelligence" || v === "wish" ? "intelligence" : undefined
  const agentMode = (v: unknown): AgentMode | undefined =>
    v === "general" || v === "high" || v === "xhigh" || v === "max" || v === "ultra" ? v : undefined
  const subagentIntensity = (v: unknown): SubagentIntensity | undefined =>
    v === "inherit" || v === "downgrade" ? v : undefined
  const selfLearning = (v: unknown): SelfLearning | undefined => (v === "manual" || v === "auto" ? v : undefined)

  function normalizeDeepAgent(input: unknown): DeepAgentSettings | undefined {
    if (!isRecord(input)) return undefined
    const out: DeepAgentSettings = {}
    const pm = promptMode(input.promptMode)
    if (pm) out.promptMode = pm
    // Legacy-compat: read the new `intelligenceModel` key first, fall back to the pre-rename
    // `wishModel` key so an existing user's configured model is not lost. We only WRITE
    // `intelligenceModel`. Do NOT drop the `wishModel` read.
    const wm = str(input.intelligenceModel) ?? str(input.wishModel)
    if (wm) out.intelligenceModel = wm
    const am = agentMode(input.agentMode)
    if (am) out.agentMode = am
    const si = subagentIntensity(input.subagentIntensity)
    if (si) out.subagentIntensity = si
    const sl = selfLearning(input.selfLearning)
    if (sl) out.selfLearning = sl
    const rd = str(input.runsDir)
    if (rd) out.runsDir = rd
    const apet = bool(input.allowProviderExecutedTools)
    if (apet !== undefined) out.allowProviderExecutedTools = apet
    const names = strArray(input.allowProviderExecutedToolNames)
    if (names) out.allowProviderExecutedToolNames = names
    const epd = bool(input.expertPanelDefault)
    if (epd !== undefined) out.expertPanelDefault = epd
    return Object.keys(out).length > 0 ? out : undefined
  }

  // Accept only a well-formed absolute http(s) endpoint. A malformed or non-http value is dropped
  // (not persisted) so a hand-edited settings file can never route an official provider somewhere
  // unexpected — the provider then falls back to its fixed catalog endpoint.
  const httpUrl = (v: unknown): string | undefined => {
    const s = str(v)
    if (!s) return undefined
    try {
      const u = new URL(s)
      return u.protocol === "http:" || u.protocol === "https:" ? s : undefined
    } catch {
      return undefined
    }
  }

  function normalizeTransport(input: unknown): TransportSettings | undefined {
    if (!isRecord(input)) return undefined
    const out: TransportSettings = {}
    const bu = httpUrl(input.baseURL)
    if (bu !== undefined) out.baseURL = bu
    const ht = timeout(input.headerTimeout)
    if (ht !== undefined) out.headerTimeout = ht
    const ct = posInt(input.chunkTimeout)
    if (ct !== undefined) out.chunkTimeout = ct
    const to = timeout(input.timeout)
    if (to !== undefined) out.timeout = to
    const mr = posInt(input.maxRetries)
    if (mr !== undefined) out.maxRetries = mr
    return Object.keys(out).length > 0 ? out : undefined
  }

  function normalize(input: unknown): Settings {
    if (!isRecord(input)) return {}
    const out: Settings = {}
    const da = normalizeDeepAgent(input.deepagent)
    if (da) out.deepagent = da
    if (isRecord(input.providers)) {
      const providers: Record<string, TransportSettings> = {}
      for (const [id, value] of Object.entries(input.providers)) {
        // Only keep transport settings for real official providers; drop anything else so a stale
        // or hand-edited id can never leak into the provider loader.
        if (!OFFICIAL_PROVIDER_ID_SET.has(id)) continue
        const t = normalizeTransport(value)
        if (t) providers[id] = t
      }
      if (Object.keys(providers).length > 0) out.providers = providers
    }
    return out
  }

  /** Read + validate the settings file. Cached in-memory; missing/broken file → empty settings. */
  export async function read(): Promise<Settings> {
    const file = FILE()
    if (cache && cache.path === file) return cache.value
    const value = await fsNode
      .readFile(file, "utf8")
      .then((text) => normalize(JSON.parse(text)))
      .catch(() => ({}) as Settings)
    cache = { path: file, value }
    return value
  }

  async function write(value: Settings): Promise<void> {
    const file = FILE()
    await fsNode.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fsNode.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    await fsNode.rename(tmp, file)
    cache = { path: file, value }
  }

  /** Drop the in-memory cache (tests / after an external mutation). */
  export function invalidate(): void {
    cache = undefined
  }

  /** Merge a partial patch (per family) into the stored settings and persist. Reports whether the
   * persisted value actually changed so callers can skip disposing running instances on no-op writes. */
  export async function update(patch: {
    deepagent?: DeepAgentSettings
    providers?: Record<string, TransportSettings>
  }): Promise<{ settings: Settings; changed: boolean }> {
    const current = await read()
    const next: Settings = { ...current }
    if (patch.deepagent) {
      next.deepagent = normalizeDeepAgent({ ...(current.deepagent ?? {}), ...patch.deepagent })
    }
    if (patch.providers) {
      const merged: Record<string, TransportSettings> = { ...(current.providers ?? {}) }
      for (const [id, value] of Object.entries(patch.providers)) {
        if (!OFFICIAL_PROVIDER_ID_SET.has(id)) continue
        const t = normalizeTransport({ ...(merged[id] ?? {}), ...value })
        if (t) merged[id] = t
        else delete merged[id]
      }
      next.providers = Object.keys(merged).length > 0 ? merged : undefined
    }
    // Strip empty families so the file stays tidy.
    if (next.deepagent && Object.keys(next.deepagent).length === 0) delete next.deepagent
    if (next.providers && Object.keys(next.providers).length === 0) delete next.providers
    const changed = JSON.stringify(next) !== JSON.stringify(current)
    if (changed) await write(next)
    return { settings: next, changed }
  }
}
