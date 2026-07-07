import * as Log from "@deepagent-code/core/util/log"
import { serviceUse } from "@deepagent-code/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@deepagent-code/core/global"
import fsNode from "fs/promises"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { InstallationLocal, InstallationVersion } from "@deepagent-code/core/installation/version"
import { existsSync } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@deepagent-code/core/v1/config/console-state"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Cause, Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { JsonError, InvalidError } from "@deepagent-code/core/v1/config/error"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { ConfigPermissionV1 } from "@deepagent-code/core/v1/config/permission"
import { ConfigPluginV1 } from "@deepagent-code/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { Npm } from "@deepagent-code/core/npm"
import { SettingsStore } from "@/settings/store"
import { OFFICIAL_PROVIDER_ID_SET } from "@deepagent-code/core/provider-official"
import { withTransientReadRetry } from "@/util/effect-http-client"

const log = Log.create({ service: "config" })

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown, source: string) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  log.warn("tui keys in deepagent-code config are deprecated; move them to tui.json", { path: source })
  return copy
}

// Classify a thrown config-load error into a user-facing ConfigError, or return undefined when the error is
// not a known config parse/validation failure (so callers can rethrow unexpected defects). ConfigParse throws
// JsonError for JSONC syntax problems and InvalidError for schema/field validation problems
// (see config/parse.ts); both carry a `path` and a descriptive message we surface verbatim.
function toConfigError(error: unknown, fallbackSource: string): ConfigError | undefined {
  if (JsonError.isInstance(error)) {
    return {
      source: error.data.path || fallbackSource,
      kind: "json",
      message: error.data.message ?? "Invalid JSON",
    }
  }
  if (InvalidError.isInstance(error)) {
    const issues = error.data.issues
    const message =
      error.data.message ??
      (issues && issues.length
        ? issues
            .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
            .join("; ")
        : "Invalid configuration")
    return {
      source: error.data.path || fallbackSource,
      kind: "schema",
      message,
    }
  }
  return undefined
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
}

// A non-fatal config-load problem surfaced to the user (e.g. in Settings → Providers) so they can tell
// *why* a provider/config file was not imported, instead of it being silently dropped. `kind` distinguishes
// a JSONC syntax error ("json") from a schema/field validation failure ("schema").
export type ConfigError = {
  source: string
  kind: "json" | "schema"
  message: string
}

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
  errors: ConfigError[]
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly getErrors: () => Effect.Effect<ConfigError[]>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Config") {}

export const use = serviceUse(Service)

function globalConfigFile() {
  const candidates = ["deepagent-code.jsonc", "deepagent-code.json", "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

// Single canonical global config file. We still LOAD the legacy names for backward compatibility
// (loadGlobal merges all of them), but users should only ever have to edit ONE file. This
// consolidates any legacy config.json / deepagent-code.json into deepagent-code.jsonc at startup
// and removes the old files, so plugins and providers no longer end up split across files.
const CANONICAL_GLOBAL_CONFIG = "deepagent-code.jsonc"
const LEGACY_GLOBAL_CONFIGS = ["config.json", "deepagent-code.json"]

async function migrateGlobalConfigFiles() {
  const dir = Global.Path.config
  const canonicalPath = path.join(dir, CANONICAL_GLOBAL_CONFIG)
  const legacyPaths = LEGACY_GLOBAL_CONFIGS.map((name) => path.join(dir, name)).filter((file) => existsSync(file))
  if (legacyPaths.length === 0) return

  // Parse strictly: if ANY legacy or canonical file is broken (bad JSON OR invalid schema), skip
  // migration entirely so the normal load path still surfaces the error via getErrors() against the
  // original file. We must not silently move/drop content from a file the user needs to be told is
  // broken — moving it would also relabel the error against the wrong (canonical) filename.
  const parseStrict = (raw: string): Record<string, unknown> | undefined => {
    try {
      const value = ConfigParse.jsonc(raw, "migrate")
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
      // Schema-validate too: an invalid-field file must keep surfacing its schema error in place.
      ConfigParse.schema(ConfigV1.Info, value, "migrate")
      return value as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  // Load order = config.json -> deepagent-code.json -> deepagent-code.jsonc, so the canonical
  // .jsonc wins over legacy. Build the merged object in that precedence.
  let merged: Record<string, unknown> = {}
  for (const file of legacyPaths) {
    const parsed = parseStrict(await fsNode.readFile(file, "utf8").catch(() => ""))
    if (!parsed) return // broken legacy file — leave everything in place for error reporting
    merged = { ...merged, ...parsed }
  }

  let canonicalExisting: Record<string, unknown> | undefined
  if (existsSync(canonicalPath)) {
    canonicalExisting = parseStrict(await fsNode.readFile(canonicalPath, "utf8").catch(() => ""))
    if (!canonicalExisting) return // broken canonical file — don't touch anything
  }

  if (canonicalExisting) {
    // Preserve the user's existing .jsonc (and its comments): patch in only the legacy keys that
    // aren't already set in the canonical file.
    let text = await fsNode.readFile(canonicalPath, "utf8").catch(() => "{}")
    for (const [key, value] of Object.entries(merged)) {
      if (key in canonicalExisting) continue
      text = patchJsonc(text, { [key]: value })
    }
    await fsNode.writeFile(canonicalPath, text)
  } else {
    merged.$schema ??= "https://deepagent-code.ai/config.json"
    await fsNode.mkdir(dir, { recursive: true }).catch(() => {})
    await fsNode.writeFile(canonicalPath, JSON.stringify(merged, null, 2))
  }

  for (const file of legacyPaths) await fsNode.unlink(file).catch(() => {})
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

// ── First-party settings overlay ─────────────────────────────────────────────────────────────────
// First-party runtime settings live in SettingsStore (~/.deepagent/code/settings.json), NOT the
// user config file (which is reserved for third-party providers). To keep every existing reader
// working unchanged (backend gatewayConfig/intelligenceModel read `provider.deepagent.options`; the frontend
// reads the synced config), we OVERLAY those settings onto the in-memory config on read, and
// INTERCEPT+STRIP them on write so they never land in the config file.

// The DeepAgent first-party settings are surfaced under this pseudo-provider id (matches the historic
// `provider.deepagent.options` location that every reader already knows).
const DEEPAGENT_PSEUDO_PROVIDER_ID = "deepagent"

// Transport keys that official providers accept only via SettingsStore (config is ignored for them).
const OFFICIAL_TRANSPORT_KEYS = ["headerTimeout", "chunkTimeout", "timeout", "maxRetries"] as const

/**
 * Merge SettingsStore values onto a config object (returns a shallow-cloned copy; never mutates input).
 * - deepagent runtime settings → `provider.deepagent.options` (always; deepagent is not an official
 *   provider so this never triggers the official-conflict check in the provider loader).
 * - official-provider transport → `provider.<id>.options` (only when `officialTransport` is true;
 *   the backend provider loader reads transport straight from SettingsStore, and overlaying an
 *   official id into the config the loader sees would trip the official-conflict rejection — so this
 *   overlay is for the FRONTEND view only, via getGlobal()).
 */
function overlaySettings(info: Info, settings: SettingsStore.Settings, officialTransport: boolean): Info {
  if (!settings.deepagent && !(officialTransport && settings.providers)) return info
  const provider = { ...(info.provider ?? {}) }

  if (settings.deepagent && Object.keys(settings.deepagent).length > 0) {
    const existing = provider[DEEPAGENT_PSEUDO_PROVIDER_ID] ?? {}
    provider[DEEPAGENT_PSEUDO_PROVIDER_ID] = {
      name: "DeepAgent",
      ...existing,
      options: { ...(existing.options ?? {}), ...settings.deepagent },
      models: existing.models ?? {},
    }
  }

  if (officialTransport && settings.providers) {
    for (const [id, transport] of Object.entries(settings.providers)) {
      if (!transport || Object.keys(transport).length === 0) continue
      const existing = provider[id] ?? {}
      provider[id] = {
        ...existing,
        options: { ...(existing.options ?? {}), ...transport },
      }
    }
  }

  return { ...info, provider }
}

/**
 * Pull first-party settings out of an incoming config patch and produce (a) the SettingsStore patch
 * to persist and (b) a cleaned config with those keys removed so they never reach the config file.
 */
function extractSettingsPatch(config: Info): {
  cleaned: Info
  patch: { deepagent?: SettingsStore.DeepAgentSettings; providers?: Record<string, SettingsStore.TransportSettings> }
  hasPatch: boolean
} {
  const patch: {
    deepagent?: SettingsStore.DeepAgentSettings
    providers?: Record<string, SettingsStore.TransportSettings>
  } = {}
  if (!config.provider) return { cleaned: config, patch, hasPatch: false }

  const provider = { ...config.provider }
  let changed = false

  // deepagent: the whole pseudo-provider entry is first-party — route its options, drop it from file.
  const deepagent = provider[DEEPAGENT_PSEUDO_PROVIDER_ID]
  if (deepagent) {
    const opts = (deepagent.options ?? {}) as Record<string, unknown>
    patch.deepagent = {
      promptMode: opts.promptMode as SettingsStore.PromptMode | undefined,
      // Legacy-compat: prefer the new `intelligenceModel` option key, fall back to the pre-rename
      // `wishModel` so a config written before the rename still carries the user's model over.
      intelligenceModel:
        typeof opts.intelligenceModel === "string"
          ? opts.intelligenceModel
          : typeof opts.wishModel === "string"
            ? opts.wishModel
            : undefined,
      agentMode: opts.agentMode as SettingsStore.AgentMode | undefined,
      subagentIntensity: opts.subagentIntensity as SettingsStore.SubagentIntensity | undefined,
      selfLearning: opts.selfLearning as SettingsStore.SelfLearning | undefined,
      runsDir: typeof opts.runsDir === "string" ? opts.runsDir : undefined,
      allowProviderExecutedTools:
        typeof opts.allowProviderExecutedTools === "boolean" ? opts.allowProviderExecutedTools : undefined,
      allowProviderExecutedToolNames: Array.isArray(opts.allowProviderExecutedToolNames)
        ? (opts.allowProviderExecutedToolNames.filter((i) => typeof i === "string") as string[])
        : undefined,
    }
    delete provider[DEEPAGENT_PSEUDO_PROVIDER_ID]
    changed = true
  }

  // official providers: route only the transport keys; the rest of an official entry is ignored by
  // the loader anyway, so we drop the whole entry to keep the file third-party-only.
  const providers: Record<string, SettingsStore.TransportSettings> = {}
  for (const id of Object.keys(provider)) {
    if (!OFFICIAL_PROVIDER_ID_SET.has(id)) continue
    const opts = (provider[id]?.options ?? {}) as Record<string, unknown>
    const transport: SettingsStore.TransportSettings = {}
    for (const key of OFFICIAL_TRANSPORT_KEYS) {
      if (key in opts) (transport as Record<string, unknown>)[key] = opts[key]
    }
    if (Object.keys(transport).length > 0) providers[id] = transport
    delete provider[id]
    changed = true
  }
  if (Object.keys(providers).length > 0) patch.providers = providers

  const hasPatch = patch.deepagent !== undefined || patch.providers !== undefined
  return { cleaned: changed ? { ...config, provider } : config, patch, hasPatch }
}

/**
 * One-shot migration: move any `provider.deepagent.options` from the config file into SettingsStore,
 * then strip the `provider.deepagent` entry from the file so the config file is third-party-only.
 * Idempotent: if SettingsStore already has deepagent settings we still strip the stale file entry.
 */
async function migrateFirstPartySettings() {
  const file = globalConfigFile()
  let text: string
  try {
    text = await fsNode.readFile(file, "utf8")
  } catch {
    return // no config file yet — nothing to migrate
  }
  let parsed: Record<string, unknown>
  try {
    const value = ConfigParse.jsonc(text, "settings-migrate")
    if (!isRecord(value)) return
    ConfigParse.schema(ConfigV1.Info, value, "settings-migrate") // skip migration if the file is broken
    parsed = value as Record<string, unknown>
  } catch {
    return
  }
  const provider = isRecord(parsed.provider) ? parsed.provider : undefined
  const deepagent = provider && isRecord(provider.deepagent) ? provider.deepagent : undefined
  if (!deepagent) return

  const opts = isRecord(deepagent.options) ? deepagent.options : {}
  const existing = await SettingsStore.read()
  if (!existing.deepagent) {
    await SettingsStore.update({
      deepagent: {
        promptMode: opts.promptMode as SettingsStore.PromptMode | undefined,
        // Legacy-compat: prefer the new `intelligenceModel` key, fall back to legacy `wishModel`.
        intelligenceModel:
          typeof opts.intelligenceModel === "string"
            ? opts.intelligenceModel
            : typeof opts.wishModel === "string"
              ? opts.wishModel
              : undefined,
        agentMode: opts.agentMode as SettingsStore.AgentMode | undefined,
        subagentIntensity: opts.subagentIntensity as SettingsStore.SubagentIntensity | undefined,
        selfLearning: opts.selfLearning as SettingsStore.SelfLearning | undefined,
        runsDir: typeof opts.runsDir === "string" ? opts.runsDir : undefined,
        allowProviderExecutedTools:
          typeof opts.allowProviderExecutedTools === "boolean" ? opts.allowProviderExecutedTools : undefined,
        allowProviderExecutedToolNames: Array.isArray(opts.allowProviderExecutedToolNames)
          ? (opts.allowProviderExecutedToolNames.filter((i) => typeof i === "string") as string[])
          : undefined,
      },
    })
  }
  // Strip provider.deepagent from the file (preserving comments/formatting for the rest).
  const stripped = patchJsonc(text, { deepagent: undefined }, ["provider"])
  if (stripped !== text) await fsNode.writeFile(file, stripped).catch(() => {})
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env }
            : { text, type: "virtual", ...options, env },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(parsed, source), source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      if (!data.$schema) {
        data.$schema = "https://deepagent-code.ai/config.json"
        const updated = text.replace(/^\s*\{/, '{\n  "$schema": "https://deepagent-code.ai/config.json",')
        yield* fs.writeFileString(options.path, updated).pipe(Effect.catch(() => Effect.void))
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      log.info("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      const errors: ConfigError[] = []
      // A single broken global config file (bad JSON or invalid field) must not wipe the whole global config
      // and must tell the user *why*. loadFileSafe captures the parse/validation error into `errors` and
      // returns an empty config instead of letting the failure propagate and silently zero everything out.
      const loadFileSafe = (filepath: string) =>
        loadFile(filepath, env).pipe(
          Effect.catchCause((cause) => {
            const classified = toConfigError(Cause.squash(cause), filepath)
            if (!classified) return Effect.failCause(cause)
            errors.push(classified)
            log.warn("config file skipped due to error", { path: filepath, kind: classified.kind })
            return Effect.succeed({} as Info)
          }),
        )
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.DEEPAGENT_CODE_CONFIG && !Flag.DEEPAGENT_CODE_CONFIG_DIR && !Flag.DEEPAGENT_CODE_CONFIG_CONTENT) {
        // Consolidate any legacy config.json / deepagent-code.json into the single canonical
        // deepagent-code.jsonc and remove the old files, so there is one config file to edit.
        // Best-effort: a failure here must not block config loading (we still merge all names below).
        yield* Effect.promise(() => migrateGlobalConfigFiles()).pipe(Effect.catch(() => Effect.void))
        // Move any first-party runtime settings (provider.deepagent.options) out of the config file
        // into SettingsStore, so the config file stays third-party-only. Best-effort.
        yield* Effect.promise(() => migrateFirstPartySettings()).pipe(Effect.catch(() => Effect.void))
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* fs
            .writeWithDirs(file, JSON.stringify({ $schema: "https://deepagent-code.ai/config.json" }, null, 2))
            .pipe(Effect.catch(() => Effect.void))
        }
      }
      result = mergeConfig(result, yield* loadFileSafe(path.join(Global.Path.config, "config.json")))
      result = mergeConfig(result, yield* loadFileSafe(path.join(Global.Path.config, "deepagent-code.json")))
      result = mergeConfig(result, yield* loadFileSafe(path.join(Global.Path.config, "deepagent-code.jsonc")))

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              result["$schema"] = "https://deepagent-code.ai/config.json"
              result = mergeConfig(result, rest)
              await fsNode.writeFile(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch(() => {}),
        )
      }

      return { config: result, errors }
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.sync(() => log.error("failed to load global config, using defaults", { error: String(error) })),
        ),
        Effect.orElseSucceed((): { config: Info; errors: ConfigError[] } => ({ config: {}, errors: [] })),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      const base = (yield* cachedGlobal).config
      // Frontend view: overlay first-party settings so the app renders current values. Official
      // transport is included here (getGlobal is only read by the app / global routes, never by the
      // provider loader), so the connect dialog can show/edit timeouts.
      const settings = yield* Effect.promise(() => SettingsStore.read())
      return overlaySettings(base, settings, true)
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        const configErrors: ConfigError[] = []
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "DEEPAGENT_CODE_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          return mergePluginOrigins(source, next.plugin, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/deepagent-code`
            log.debug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown)
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  log.debug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://deepagent-code.ai/config.json"
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            log.debug("loaded remote config from well-known", { url })
          }
        }

        if (Object.keys(authEnv).length) {
          const loaded = yield* loadGlobal(authEnv)
          configErrors.push(...loaded.errors)
          yield* merge(Global.Path.config, loaded.config, "global")
        } else {
          const cached = yield* cachedGlobal
          configErrors.push(...cached.errors)
          yield* merge(Global.Path.config, cached.config, "global")
        }

        if (Flag.DEEPAGENT_CODE_CONFIG) {
          yield* merge(Flag.DEEPAGENT_CODE_CONFIG, yield* loadFile(Flag.DEEPAGENT_CODE_CONFIG, authEnv))
          log.debug("loaded custom config", { path: Flag.DEEPAGENT_CODE_CONFIG })
        }

        if (!Flag.DEEPAGENT_CODE_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("deepagent-code", ctx.directory, ctx.worktree).pipe(
            Effect.orDie,
          )) {
            yield* merge(file, yield* loadFile(file, authEnv), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.DEEPAGENT_CODE_CONFIG_DIR) {
          log.debug("loading config from DEEPAGENT_CODE_CONFIG_DIR", { path: Flag.DEEPAGENT_CODE_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          if (dir.endsWith(".deepagent-code") || dir === Flag.DEEPAGENT_CODE_CONFIG_DIR) {
            for (const file of ["deepagent-code.json", "deepagent-code.jsonc"]) {
              const source = path.join(dir, file)
              log.debug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source, authEnv))
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          const dep = yield* npmSvc
            .install(dir, {
              add: [
                {
                  name: "@deepagent-code/plugin",
                  version: InstallationLocal ? undefined : InstallationVersion,
                },
              ],
            })
            .pipe(
              Effect.exit,
              Effect.tap((exit) =>
                Exit.isFailure(exit)
                  ? Effect.sync(() => {
                      log.warn("background dependency install failed", { dir, error: String(exit.cause) })
                    })
                  : Effect.void,
              ),
              Effect.asVoid,
              Effect.forkDetach,
            )
          deps.push(dep)

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.deepagent-code/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        if (process.env.DEEPAGENT_CODE_CONFIG_CONTENT) {
          const source = "DEEPAGENT_CODE_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.DEEPAGENT_CODE_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          log.debug("loaded custom config from DEEPAGENT_CODE_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              process.env["DEEPAGENT_CODE_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("DEEPAGENT_CODE_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(JSON.stringify(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              for (const providerID of Object.keys(next.provider ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) => {
              log.debug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              })
              return Effect.void
            }),
          )
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["deepagent-code.json", "deepagent-code.jsonc"]) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          result = mergeConfigConcatArrays(
            result,
            yield* loadConfig(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            }),
          )
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.DEEPAGENT_CODE_PERMISSION) {
          try {
            result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.DEEPAGENT_CODE_PERMISSION))
          } catch (err) {
            log.warn("DEEPAGENT_CODE_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            log.warn("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        if (Flag.DEEPAGENT_CODE_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.DEEPAGENT_CODE_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        return {
          config: result,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
          errors: configErrors,
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      const base = yield* InstanceState.use(state, (s) => s.config)
      // Backend view: overlay ONLY the deepagent runtime settings (gatewayConfig/intelligenceModel read them
      // from provider.deepagent.options). Official-provider transport is deliberately NOT overlaid
      // here — the provider loader reads transport straight from SettingsStore, and injecting an
      // official id into the config it sees would trip the official-conflict rejection.
      const settings = yield* Effect.promise(() => SettingsStore.read())
      return overlaySettings(base, settings, false)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const getErrors = Effect.fn("Config.getErrors")(function* () {
      return yield* InstanceState.use(state, (s) => s.errors)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file)
      yield* fs
        .writeFileString(file, JSON.stringify(mergeDeep(writable(existing), writable(config)), null, 2))
        .pipe(Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      // Route first-party settings (deepagent runtime + official transport) to SettingsStore and strip
      // them from the config payload so they never land in the third-party-only config file.
      const { cleaned, patch, hasPatch } = extractSettingsPatch(config)
      let settingsChanged = false
      if (hasPatch) {
        const result = yield* Effect.promise(() => SettingsStore.update(patch))
        settingsChanged = result.changed
      }

      const file = globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"
      const patchGlobal = writableGlobal(cleaned)

      let next: Info
      let changed: boolean
      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(before, file), file)
        const merged = mergeDeep(writable(existing), patchGlobal)
        const serialized = JSON.stringify(merged, null, 2)
        changed = serialized !== before
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
        next = merged
      } else {
        const updated = patchJsonc(before, patchGlobal)
        next = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(updated, file), file)
        changed = updated !== before
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      if (changed) yield* invalidate()
      // Re-overlay the persisted settings onto the returned info so the caller (app) immediately sees
      // the values it just set, including official transport (this is the getGlobal-equivalent view).
      const settings = yield* Effect.promise(() => SettingsStore.read())
      return { info: overlaySettings(next, settings, true), changed: changed || settingsChanged }
    })

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      getErrors,
      update,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Account.defaultLayer),
  Layer.provide(Npm.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export * as Config from "./config"
