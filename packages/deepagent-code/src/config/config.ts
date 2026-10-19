import * as Log from "@deepagent-code/core/util/log"
import { serviceUse } from "@deepagent-code/core/effect/service-use"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@deepagent-code/core/global"
import fsNode from "fs/promises"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { InstallationLocal, InstallationVersion } from "@deepagent-code/core/installation/version"
import { existsSync, readdirSync, statSync, watch } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@deepagent-code/core/v1/config/console-state"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { EffectBridge } from "@/effect/bridge"
import { Cause, Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema, ScopedCache, Semaphore } from "effect"
import { JsonError, InvalidError } from "@deepagent-code/core/v1/config/error"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { MixedNativeFields } from "@deepagent-code/core/config"
import { ConfigPermissionV1 } from "@deepagent-code/core/v1/config/permission"
import { ConfigPluginV1 } from "@deepagent-code/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { ConfigFileWrite } from "./file-write"
import { Npm } from "@deepagent-code/core/npm"
import { SettingsStore } from "@/settings/store"
import { SettingsTransaction } from "@/settings/transaction"
import { OFFICIAL_PROVIDER_ID_SET } from "@deepagent-code/core/provider-official"
import { withTransientReadRetry } from "@/util/effect-http-client"

const log = Log.create({ service: "config" })

// Root and Location layers can cache the same global files independently. Keep only
// invalidation identity process-wide; configuration values remain layer-owned.
const globalConfigGenerations = new Map<string, { value: number }>()

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

export function normalizeLoadedConfig(data: unknown, source: string) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (hadLegacy) {
    delete copy.theme
    delete copy.keybinds
    delete copy.tui
    log.warn("tui keys in deepagent-code config are deprecated; move them to tui.json", { path: source })
  }
  // Validate native fields before excluding them from this legacy-only projection.
  // The source bytes (including global consolidation) retain both generations.
  ConfigParse.schema(
    MixedNativeFields,
    Object.fromEntries(Object.entries(copy).filter(([key]) => Object.hasOwn(MixedNativeFields.fields, key))),
    source,
  )
  delete copy.providers
  delete copy.permissions
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
  mcp_origins?: Record<string, string>
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
  generation: number
  config: Info
  mcpAccountSource?: Account.Source
  readonlyRemote?: { sources: { source: string; config: Pick<Info, "command" | "skills"> }[]; unavailable: boolean }
  directories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
  errors: ConfigError[]
}

export type McpSnapshot = Readonly<{ config: Info; source: string; accountSource?: Account.Source }>

export type ReadSnapshot = McpSnapshot &
  Readonly<{ directories: string[]; directory: string; worktree: string; remoteCurrent: boolean }>

export class McpRemovalError extends Schema.TaggedErrorClass<McpRemovalError>()("ConfigMcpRemovalError", {
  reason: Schema.Literals(["readonly", "changed"]),
}) {}

export interface Interface {
  readonly readonlySnapshot?: (input: {
    directory: string
    worktree: string
    observed?: InstanceContext
  }) => Effect.Effect<ReadSnapshot>
  readonly mcpSnapshot?: () => Effect.Effect<McpSnapshot>
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly getErrors: () => Effect.Effect<ConfigError[]>
  readonly update: (config: Info, expected?: ConfigFileWrite.Observation) => Effect.Effect<void>
  readonly updateGlobal: (
    config: Info,
    expected?: ConfigFileWrite.Observation,
  ) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly removeGlobalMcp?: (name: string, original: McpSnapshot) => Effect.Effect<void, McpRemovalError>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
  readonly watch?: (
    changed: () => Effect.Effect<void>,
    options?: { readonly mcpOnly?: boolean },
  ) => Effect.Effect<() => void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Config") {}

export const use = serviceUse(Service)

export function globalConfigFile() {
  const candidates = ["config.jsonc", "config.json", "deepagent-code.jsonc", "deepagent-code.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

// Single canonical global config file. We still LOAD the legacy names for backward compatibility
// (loadGlobal merges all of them), but users should only ever have to edit ONE file. This
// consolidates any legacy config.json / deepagent-code.json / deepagent-code.jsonc into the single
// canonical config.jsonc at startup and removes the old files, so plugins and providers no longer end
// up split across files. config.jsonc lives in the roaming config home (%APPDATA%\deepagent-code on
// Windows, ~/.deepagent/code elsewhere).
const CANONICAL_GLOBAL_CONFIG = "config.jsonc"
const LEGACY_GLOBAL_CONFIGS = ["config.json", "deepagent-code.json", "deepagent-code.jsonc"]

function migrateGlobalConfigFiles() {
  const canonicalPath = path.join(Global.Path.config, CANONICAL_GLOBAL_CONFIG)
  const candidates = LEGACY_GLOBAL_CONFIGS.map((name) => path.join(Global.Path.config, name))
  return ConfigFileWrite.transaction([canonicalPath, ...candidates], (tx) =>
    Effect.gen(function* () {
      const legacy = candidates.map(tx.file).filter((file) => file.text !== undefined)
      if (!legacy.length) return
      const parseStrict = (file: ConfigFileWrite.File) => {
        if (file.text === undefined) return undefined
        try {
          const value = ConfigParse.jsonc(file.text, file.path)
          if (!isRecord(value)) return undefined
          ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(value, file.path), file.path)
          return value
        } catch (error) {
          if (toConfigError(error, file.path)) return undefined
          throw error
        }
      }
      // Every participating source remains locked until the canonical publication and removals.
      // This is cooperative maintenance, not a recoverable multi-file migration transaction.
      const parsed = legacy.map(parseStrict)
      if (parsed.some((value) => value === undefined)) return
      const merged = parsed.reduce<Record<string, unknown>>((value, next) => mergeDeep(value, next ?? {}), {})
      const canonical = tx.file(canonicalPath)
      const existing = parseStrict(canonical)
      if (canonical.text !== undefined && !existing) return
      const base = canonical.text ?? [...legacy].reverse().find((file) => file.path.endsWith(".jsonc"))?.text
      const baseParsed = base === undefined ? undefined : ConfigParse.jsonc(base, canonicalPath)
      const fill = (
        text: string,
        values: Record<string, unknown>,
        present: Record<string, unknown>,
        keys: string[] = [],
      ): string =>
        Object.entries(values).reduce((text, [key, value]) => {
          if (!Object.hasOwn(present, key)) return patchJsonc(text, { [key]: value }, keys)
          return isRecord(value) && isRecord(present[key]) ? fill(text, value, present[key], [...keys, key]) : text
        }, text)
      const text =
        base === undefined
          ? JSON.stringify({ $schema: "https://ai.deepagent.ltd/config.schema.json", ...merged }, null, 2)
          : fill(base, merged, existing ?? (isRecord(baseParsed) ? baseParsed : {}))
      if (text !== canonical.text) yield* tx.write(canonical, text)
      for (const file of legacy) {
        if (file.path === canonical.path) continue
        yield* tx.remove(file)
      }
    }),
  )
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
  const { plugin_origins: _plugin_origins, mcp_origins: _mcp_origins, ...next } = info
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
    const values = {
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
      expertPanelDefault: typeof opts.expertPanelDefault === "boolean" ? opts.expertPanelDefault : undefined,
      allowProviderExecutedTools:
        typeof opts.allowProviderExecutedTools === "boolean" ? opts.allowProviderExecutedTools : undefined,
      allowProviderExecutedToolNames: Array.isArray(opts.allowProviderExecutedToolNames)
        ? (opts.allowProviderExecutedToolNames.filter((i) => typeof i === "string") as string[])
        : undefined,
    }
    // Omitted fields are not removals. Preserve independently stored settings;
    // an explicitly supplied undefined still clears its original field.
    patch.deepagent = Object.fromEntries(Object.entries(values).filter(([key]) =>
      Object.hasOwn(opts, key) || key === "intelligenceModel" && Object.hasOwn(opts, "wishModel"))) as SettingsStore.DeepAgentSettings

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
function migrateFirstPartySettings() {
  const candidates = ["config.jsonc", ...LEGACY_GLOBAL_CONFIGS].map((name) => path.join(Global.Path.config, name))
  return SettingsTransaction.apply({
    files: candidates, request: { kind: "legacy_first_party_settings" },
    prepare: (tx, existing) => {
      const current = tx.file(globalConfigFile())
      if (current.text === undefined) return { settings: existing, value: undefined }
      const parsed = (() => {
        try {
          const value = ConfigParse.jsonc(current.text, "settings-migrate")
          if (!isRecord(value)) return undefined
          ConfigParse.schema(ConfigV1.Info, value, "settings-migrate")
          return value
        } catch { return undefined }
      })()
      const provider = parsed && isRecord(parsed.provider) ? parsed.provider : undefined
      const deepagent = provider && isRecord(provider.deepagent) ? provider.deepagent : undefined
      if (!deepagent) return { settings: existing, value: undefined }
      const opts = isRecord(deepagent.options) ? deepagent.options : {}
      const settings = existing.deepagent ? existing : SettingsStore.merge(existing, {
        deepagent: {
          promptMode: opts.promptMode as SettingsStore.PromptMode | undefined,
          intelligenceModel: typeof opts.intelligenceModel === "string" ? opts.intelligenceModel :
            typeof opts.wishModel === "string" ? opts.wishModel : undefined,
          agentMode: opts.agentMode as SettingsStore.AgentMode | undefined,
          subagentIntensity: opts.subagentIntensity as SettingsStore.SubagentIntensity | undefined,
          selfLearning: opts.selfLearning as SettingsStore.SelfLearning | undefined,
          runsDir: typeof opts.runsDir === "string" ? opts.runsDir : undefined,
          allowProviderExecutedTools: typeof opts.allowProviderExecutedTools === "boolean" ? opts.allowProviderExecutedTools : undefined,
          allowProviderExecutedToolNames: Array.isArray(opts.allowProviderExecutedToolNames) ?
            opts.allowProviderExecutedToolNames.filter((value): value is string => typeof value === "string") : undefined,
        },
      })
      return { config: { file: current, text: patchJsonc(current.text, { deepagent: undefined }, ["provider"]) }, settings, value: undefined }
    },
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const actual = yield* Effect.promise(() =>
      fsNode.realpath(Global.Path.config).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return path.resolve(Global.Path.config)
      }),
    )
    const domain = process.platform === "win32" ? actual.toLowerCase() : actual
    const generation = globalConfigGenerations.get(domain) ?? { value: 0 }
    globalConfigGenerations.set(domain, generation)
    const flock = yield* EffectFlock.Service
    const fileWrite = <A, E>(effect: Effect.Effect<A, E, FSUtil.Service | EffectFlock.Service>) =>
      effect.pipe(Effect.provideService(FSUtil.Service, fs), Effect.provideService(EffectFlock.Service, flock))
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
      options: { path: string; observed?: ConfigFileWrite.Observation } | { dir: string; source: string },
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
        data.$schema = "https://ai.deepagent.ltd/config.schema.json"
        const updated = patchJsonc(text, { $schema: "https://ai.deepagent.ltd/config.schema.json" })
        // Global metadata participates in the same journal and locks as settings;
        // a standalone edit would invalidate a just-completed settings receipt.
        const global = [CANONICAL_GLOBAL_CONFIG, ...LEGACY_GLOBAL_CONFIGS].some((name) =>
          path.resolve(options.path) === path.resolve(Global.Path.config, name),
        )
        yield* (global
          ? SettingsTransaction.apply({
            files: [options.path], request: { kind: "global_config_schema", path: options.path },
            prepare: (tx, settings) => {
              const current = tx.file(options.path)
              if (current.text !== text || (options.observed && !ConfigFileWrite.sameObservation(current, options.observed)))
                throw new ConfigFileWrite.Error({ reason: "changed" })
              return { config: { file: current, text: updated }, settings, value: undefined }
            },
          })
          : ConfigFileWrite.edit(
            options.path,
            (current) => {
              if (current.text !== text) throw new ConfigFileWrite.Error({ reason: "changed" })
              return { text: updated, value: undefined }
            },
            options.observed,
          )).pipe(
          fileWrite,
          Effect.catch(() => Effect.void),
        )
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      log.info("loading", { path: filepath })
      const observed = yield* ConfigFileWrite.read(filepath).pipe(Effect.orDie)
      if (!observed.text) return {} as Info
      return yield* loadConfig(observed.text, { path: filepath, observed }, env)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      // Keep provenance outside result: the legacy TOML migration serializes result.
      const origins: Record<string, string> = {}
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
      // Seed the default global config with the schema for editor completion, but avoid writing when config
      // is supplied directly through an explicit file or inline content.
      if (!Flag.DEEPAGENT_CODE_CONFIG && !Flag.DEEPAGENT_CODE_CONFIG_CONTENT) {
        yield* SettingsTransaction.requireSettledEffect.pipe(Effect.orDie)
        // Consolidate any legacy config.json / deepagent-code.json into the single canonical
        // deepagent-code.jsonc and remove the old files, so there is one config file to edit.
        // Best-effort: a failure here must not block config loading (we still merge all names below).
        yield* migrateGlobalConfigFiles().pipe(
          fileWrite,
          Effect.catch(() => Effect.void),
        )
        // Move any first-party runtime settings (provider.deepagent.options) out of the config file
        // into SettingsStore, so the config file stays third-party-only. Best-effort.
        yield* migrateFirstPartySettings().pipe(
          fileWrite,
          Effect.catch(() => Effect.void),
        )
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* ConfigFileWrite.edit(file, (current) => ({
            text:
              current.text === undefined
                ? JSON.stringify({ $schema: "https://ai.deepagent.ltd/config.schema.json" }, null, 2)
                : undefined,
            value: undefined,
          })).pipe(
            fileWrite,
            Effect.catch(() => Effect.void),
          )
        }
      }
      // Merge in precedence order: legacy names first, then the canonical config.jsonc last so it
      // wins. All names are still loaded for backward compatibility until migration removes the old
      // files; migrateGlobalConfigFiles() consolidates them into config.jsonc on startup.
      for (const name of ["config.json", "deepagent-code.json", "deepagent-code.jsonc", "config.jsonc"]) {
        const file = path.join(Global.Path.config, name)
        const next = yield* loadFileSafe(file)
        result = mergeConfig(result, next)
        Object.keys(next.mcp ?? {}).forEach((key) => { origins[key] = file })
      }

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        const destination = path.join(Global.Path.config, "config.json")
        yield* ConfigFileWrite.transaction([legacy, destination], (tx) =>
          Effect.gen(function* () {
            const original = tx.file(legacy)
            if (original.text === undefined) return
            const mod = yield* Effect.promise(() => import(pathToFileURL(legacy).href, { with: { type: "toml" } }))
            const { provider, model, ...rest } = mod.default
            const next = mergeConfig(result, rest)
            if (provider && model) next.model = `${provider}/${model}`
            next.$schema = "https://ai.deepagent.ltd/config.schema.json"
            const current = yield* ConfigFileWrite.read(legacy)
            if (!ConfigFileWrite.sameObservation(original, current))
              return yield* new ConfigFileWrite.Error({ reason: "changed" })
            yield* tx.write(tx.file(destination), JSON.stringify(next, null, 2))
            yield* tx.remove(original)
            result = next
            Object.keys(next.mcp ?? {}).forEach((key) => { origins[key] = destination })
          }),
        ).pipe(
          fileWrite,
          Effect.catch(() => Effect.void),
        )
      }

      return { config: { ...result, ...(Object.keys(origins).length ? { mcp_origins: origins } : {}) }, errors }
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      Effect.gen(function* () {
        // Capture before loading: an invalidation during I/O must never label old
        // bytes as belonging to the newly published generation.
        const observed = generation.value
        const result = yield* loadGlobal().pipe(
          Effect.tapError((error) =>
            Effect.sync(() => log.error("failed to load global config, using defaults", { error: String(error) })),
          ),
          Effect.orElseSucceed((): { config: Info; errors: ConfigError[] } => ({ config: {}, errors: [] })),
        )
        return { ...result, generation: observed }
      }),
      Duration.infinity,
    )

    const readGlobal = Effect.fn("Config.readGlobal")(function* () {
      while (true) {
        const observed = yield* cachedGlobal
        if (observed.generation === generation.value) return observed
        yield* invalidateGlobal
      }
    })

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      const base = (yield* readGlobal()).config
      // Frontend view: overlay first-party settings so the app renders current values. Official
      // transport is included here (getGlobal is only read by the app / global routes, never by the
      // provider loader), so the connect dialog can show/edit timeouts.
      const settings = yield* SettingsStore.readEffect.pipe(Effect.orDie)
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
        const observedGeneration = generation.value
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        const configErrors: ConfigError[] = []
        let activeOrgName: string | undefined
        const readonlyRemote: NonNullable<State["readonlyRemote"]> = { sources: [], unavailable: false }

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
          // Retain only already-loaded display data. This is a bounded projection,
          // not permission to refresh an account or discover remote skills on GET.
          if (/^https?:/.test(source) && (next.command || next.skills) && !readonlyRemote.unavailable) {
            const entry = { source, config: { command: next.command, skills: next.skills } }
            const candidates = [...readonlyRemote.sources, entry]
            const count = candidates.reduce(
              (total, item) =>
                total +
                1 +
                Object.keys(item.config.command ?? {}).length +
                (item.config.skills?.paths?.length ?? 0) +
                (item.config.skills?.urls?.length ?? 0),
              0,
            )
            if (count > 1000 || Buffer.byteLength(JSON.stringify(candidates)) > 262144) {
              readonlyRemote.sources.length = 0
              readonlyRemote.unavailable = true
            }
            if (!readonlyRemote.unavailable) readonlyRemote.sources.push(structuredClone(entry))
          }
          result = mergeConfigConcatArrays(result, next)
          if (next.mcp) {
            result.mcp_origins = {
              ...result.mcp_origins,
              ...Object.fromEntries(Object.keys(next.mcp).map((name) => [name, next.mcp_origins?.[name] ?? source])),
            }
          }
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
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://ai.deepagent.ltd/config.schema.json"
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
          const cached = yield* readGlobal()
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

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          if (dir.endsWith(".deepagent-code")) {
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

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.deepagent-code/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)

          // The @deepagent-code/plugin support package only needs to be resolvable from directories that
          // actually host file-based plugins; installing it into every config directory forces a registry
          // round-trip on every instance boot even where no plugin can ever resolve it.
          const hostsPlugins = (result.plugin_origins ?? []).some((origin) => {
            const spec = ConfigPlugin.pluginSpecifier(origin.spec)
            if (!spec.startsWith("file://")) return false
            const file = fileURLToPath(spec)
            return file === dir || file.startsWith(dir + path.sep)
          })
          if (!hostsPlugins) continue

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
              Effect.forkScoped,
            )
          deps.push(dep)
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
        const observed: { account?: Account.Source } = {}
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const before = yield* accountSvc.source()
            if (!before || before.id !== accountID || before.url !== url || before.orgID !== orgID)
              return yield* new Account.AccountServiceError({ message: "Account changed before configuration read" })
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            const after = yield* accountSvc.source()
            if (JSON.stringify(before) !== JSON.stringify(after))
              return yield* new Account.AccountServiceError({ message: "Account changed during configuration read" })
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
              observed.account = after
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

        if (Flag.DEEPAGENT_CODE_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        return {
          generation: observedGeneration,
          config: result,
          mcpAccountSource: observed.account,
          readonlyRemote,
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

    const currentState = Effect.fn("Config.currentState")(function* () {
      while (true) {
        const observed = yield* InstanceState.get(state)
        if (observed.generation === generation.value) return observed
        yield* InstanceState.invalidate(state)
      }
    })

    const observeConfig = Effect.fn("Config.observeConfig")(
      function* (ctx: { directory: string; worktree: string }, observedState?: State, full = false) {
        const cachedState = observedState?.generation === generation.value ? observedState : undefined
        const result: Info = {}
        const sources: [string, string][] = []
        const merge = (source: string, next: Info) => {
          const previous = result.mcp
          if (full) Object.assign(result, mergeConfigConcatArrays(result, next))
          if (!next.mcp) return
          result.mcp = mergeConfigConcatArrays({ mcp: previous }, { mcp: next.mcp }).mcp
          result.mcp_origins = {
            ...result.mcp_origins,
            ...Object.fromEntries(Object.keys(next.mcp).map((key) => [key, source])),
          }
        }
        const read = Effect.fnUntraced(function* (file: string, source = file) {
          const text = yield* readConfigFile(file)
          sources.push([file, text ?? ""])
          if (text) merge(source, yield* loadConfig(text, { dir: path.dirname(file), source: file }))
        })
        // Only an already observed remote configuration can appear here. This path
        // never fetches it, installs plugins, rewrites config or opens an MCP client.
        const currentAccount = yield* accountSvc.source()
        const accountCurrent = JSON.stringify(currentAccount) === JSON.stringify(cachedState?.mcpAccountSource)
        const cached = cachedState?.config
        const sourceCurrent = (source: string) => !source.endsWith("/api/config") || accountCurrent
        if (full && accountCurrent && cachedState?.readonlyRemote?.unavailable)
          return yield* Effect.die(new Error("Observed remote command metadata exceeds the readonly budget"))
        const readSources = (cachedState?.readonlyRemote?.sources ?? []).filter((entry) => sourceCurrent(entry.source))
        for (const entry of readSources)
          if (full && !entry.source.endsWith("/api/config")) merge(entry.source, entry.config)
        const remote = Object.entries(cached?.mcp ?? {}).filter(
          ([key]) => /^https?:/.test(cached?.mcp_origins?.[key] ?? "") && sourceCurrent(cached!.mcp_origins![key]),
        )
        for (const [key, value] of remote) merge(cached!.mcp_origins![key], { mcp: { [key]: value } })
        for (const file of ["config.json", "deepagent-code.json", "deepagent-code.jsonc", "config.jsonc"])
          yield* read(path.join(Global.Path.config, file))
        if (Flag.DEEPAGENT_CODE_CONFIG) yield* read(Flag.DEEPAGENT_CODE_CONFIG)
        if (!Flag.DEEPAGENT_CODE_DISABLE_PROJECT_CONFIG)
          for (const file of yield* ConfigPaths.files("deepagent-code", ctx.directory, ctx.worktree).pipe(Effect.orDie))
            yield* read(file)
        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)
        for (const dir of directories) {
          if (dir.endsWith(".deepagent-code"))
            for (const name of ["deepagent-code.json", "deepagent-code.jsonc"]) yield* read(path.join(dir, name))
          if (full)
            result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
        }
        if (process.env.DEEPAGENT_CODE_CONFIG_CONTENT) {
          sources.push(["DEEPAGENT_CODE_CONFIG_CONTENT", process.env.DEEPAGENT_CODE_CONFIG_CONTENT])
          merge(
            "DEEPAGENT_CODE_CONFIG_CONTENT",
            yield* loadConfig(process.env.DEEPAGENT_CODE_CONFIG_CONTENT, {
              dir: ctx.directory,
              source: "DEEPAGENT_CODE_CONFIG_CONTENT",
            }),
          )
        }
        // Account config is later than local layers in the production loader.
        for (const entry of readSources)
          if (full && entry.source.endsWith("/api/config")) merge(entry.source, entry.config)
        for (const [key, value] of remote)
          if (cached!.mcp_origins![key].endsWith("/api/config"))
            merge(cached!.mcp_origins![key], { mcp: { [key]: value } })
        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir))
          for (const name of ["deepagent-code.json", "deepagent-code.jsonc"]) yield* read(path.join(managedDir, name))
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          sources.push([managed.source, managed.text])
          merge(
            managed.source,
            yield* loadConfig(managed.text, { dir: path.dirname(managed.source), source: managed.source }),
          )
        }
        if (JSON.stringify(yield* accountSvc.source()) !== JSON.stringify(currentAccount))
          return yield* Effect.die(new Error("Account changed during readonly configuration observation"))
        return {
          config: result,
          remoteCurrent: accountCurrent,
          source: JSON.stringify({ sources, account: currentAccount, remote: readSources }),
          accountSource: accountCurrent ? cachedState?.mcpAccountSource : undefined,
          directories,
          directory: ctx.directory,
          worktree: ctx.worktree,
        }
      },
      Effect.provideService(FSUtil.Service, fs),
      Effect.orDie,
    )

    const mcpSnapshot = Effect.fn("Config.mcpSnapshot")(function* () {
      const context = yield* InstanceState.context
      return yield* observeConfig(context, Option.getOrUndefined(yield* ScopedCache.getSuccess(state.cache, context)))
    })

    const readonlySnapshot = Effect.fn("Config.readonlySnapshot")(function* (input: {
      directory: string
      worktree: string
      observed?: InstanceContext
    }) {
      const cached = input.observed
        ? Option.getOrUndefined(yield* ScopedCache.getSuccess(state.cache, input.observed))
        : undefined
      return yield* observeConfig(input, cached, true)
    })

    const get = Effect.fn("Config.get")(function* () {
      const base = (yield* currentState()).config
      // Backend view: overlay ONLY the deepagent runtime settings (gatewayConfig/intelligenceModel read them
      // from provider.deepagent.options). Official-provider transport is deliberately NOT overlaid
      // here — the provider loader reads transport straight from SettingsStore, and injecting an
      // official id into the config it sees would trip the official-conflict rejection.
      const settings = yield* SettingsStore.readEffect.pipe(Effect.orDie)
      return overlaySettings(base, settings, false)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return (yield* currentState()).directories
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return (yield* currentState()).consoleState
    })

    const getErrors = Effect.fn("Config.getErrors")(function* () {
      return (yield* currentState()).errors
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* Effect.forEach((yield* currentState()).deps, Fiber.join, { concurrency: 16 }).pipe(Effect.asVoid)
    })

    // Project-scoped writes must land in a file the loader actually merges: ConfigPaths.files
    // targets deepagent-code.json(c) at or above ctx.directory. A plain config.json next to the
    // working directory is never read back, so writes there silently vanish on the next load.
    const update = Effect.fn("Config.update")(function* (config: Info, expected?: ConfigFileWrite.Observation) {
      const file = path.join(yield* InstanceState.directory, "deepagent-code.json")
      yield* ConfigFileWrite.edit(
        file,
        (current) => {
          const text = current.text ?? "{}"
          ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(ConfigParse.jsonc(text, file), file), file)
          const updated = patchJsonc(text, writable(config))
          ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(ConfigParse.jsonc(updated, file), file), file)
          return { text: updated, value: undefined }
        },
        expected,
      ).pipe(fileWrite, Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      generation.value += 1
      yield* invalidateGlobal
      const instance = yield* InstanceRef
      if (instance) yield* InstanceState.invalidate(state)
    })

    const watchChanges = Effect.fn("Config.watch")(function* (
      changed: () => Effect.Effect<void>,
      options?: { readonly mcpOnly?: boolean },
    ) {
      const ctx = yield* InstanceState.context
      const dirs = options?.mcpOnly
        ? yield* ConfigPaths.directories(ctx.directory, ctx.worktree).pipe(
            Effect.provideService(FSUtil.Service, fs),
            Effect.orDie,
          )
        : yield* directories()
      const pluginFiles = options?.mcpOnly
        ? []
        : ((yield* get()).plugin_origins?.flatMap((origin) => {
            const spec = ConfigPlugin.pluginSpecifier(origin.spec)
            return spec.startsWith("file://") ? [fileURLToPath(spec)] : []
          }) ?? [])
      const files = yield* ConfigPaths.files("deepagent-code", ctx.directory, ctx.worktree).pipe(
        Effect.provideService(FSUtil.Service, fs),
        Effect.orDie,
      )
      const pluginDirectories = new Set(
        options?.mcpOnly ? [] : dirs.flatMap((dir) => [path.join(dir, "plugin"), path.join(dir, "plugins")]),
      )
      const targets = new Set([
        Global.Path.config,
        ctx.directory,
        ...dirs,
        ...files.map(path.dirname),
        ...(Flag.DEEPAGENT_CODE_CONFIG ? [path.dirname(Flag.DEEPAGENT_CODE_CONFIG)] : []),
        ...pluginFiles.map(path.dirname),
        ...pluginDirectories,
      ])
      const bridge = yield* EffectBridge.make()
      const semaphore = yield* Semaphore.make(1)
      let closed = false
      const watchers = new Map<string, ReturnType<typeof watch>>()
      const refresh = () => {
        void bridge.promise(
          semaphore
            .withPermit(
              Effect.gen(function* () {
                if (closed) return
                if (!options?.mcpOnly) yield* invalidate()
                yield* changed()
              }),
            )
            .pipe(Effect.provideService(InstanceRef, ctx)),
        ).catch((error) => log.warn("config live refresh failed", { directory: ctx.directory, error: String(error) }))
      }
      const attach = (dir: string) => {
        watchers.get(dir)?.close()
        watchers.delete(dir)
        if (!existsSync(dir)) return
        const pluginDirectory = pluginDirectories.has(dir)
        const fingerprint = (name: string) => {
          try {
            const stat = statSync(path.join(dir, name), { bigint: true })
            // A watched child owns content changes. Its parent only needs to notice when
            // that directory is deleted or replaced and its existing watcher becomes stale.
            if (stat.isDirectory() && targets.has(path.join(dir, name))) return `${stat.dev}:${stat.ino}`
            return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`
          } catch {
            return undefined
          }
        }
        const names = () => {
          if (pluginDirectory) {
            try {
              return readdirSync(dir).filter((name) => /\.[cm]?[jt]sx?$/.test(name))
            } catch {
              return []
            }
          }
          return [
            "config.json",
            "config.jsonc",
            "deepagent-code.json",
            "deepagent-code.jsonc",
            ".deepagent-code",
            "plugin",
            "plugins",
            ...pluginFiles.filter((file) => path.dirname(file) === dir).map((file) => path.basename(file)),
          ]
        }
        // Files can be created before watch() is attached but their queued rename notifications
        // can arrive afterward. They are already included in the first Config/Plugin load; treating
        // those stale notifications as edits would invalidate scoped state during that same load.
        try {
          const observed = new Map(names().map((name) => [name, fingerprint(name)]))
          const changedOnDisk = (name: string) => {
            const candidates = name ? [name] : [...new Set([...observed.keys(), ...names()])]
            const changes = candidates
              .map((candidate) => [candidate, fingerprint(candidate)] as const)
              .filter(([candidate, next]) => observed.get(candidate) !== next)
            changes.forEach(([candidate, next]) => observed.set(candidate, next))
            return changes.map(([candidate]) => candidate)
          }
          const onChange = (names: string[]) => {
            if (names.length === 0) return
            // fs.watch follows an inode on some platforms. Reattach descendants when a watched
            // directory is replaced so the next edit in the rebuilt tree is still observed.
            for (const name of names) {
              const child = path.join(dir, name)
              if (!targets.has(child)) continue
              for (const target of targets) {
                if (target === child || target.startsWith(child + path.sep)) attach(target)
              }
            }
            refresh()
          }
          const watcher = watch(dir, (_event, filename) => {
            const name = filename?.toString() ?? ""
            if (
              closed ||
              (name &&
                !/^(?:config|deepagent-code)\.jsonc?$|^\.deepagent-code$|^plugins?$/.test(name) &&
                !(pluginDirectory && /\.[cm]?[jt]sx?$/.test(name)) &&
                !pluginFiles.some((file) => path.dirname(file) === dir && path.basename(file) === name))
            )
              return
            onChange(changedOnDisk(name))
          })
          watchers.set(dir, watcher)
          // A write between the first snapshot and watch() may have no queued notification.
          // Compare once after subscription to close that gap.
          onChange(changedOnDisk(""))
        } catch (error) {
          log.warn("config watch unavailable", { directory: dir, error: String(error) })
        }
      }
      targets.forEach(attach)
      return () => {
        closed = true
        watchers.forEach((watcher) => watcher.close())
        watchers.clear()
      }
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (
      config: Info,
      expected?: ConfigFileWrite.Observation,
    ) {
      const { cleaned, patch } = extractSettingsPatch(config)
      const candidates = ["config.jsonc", ...LEGACY_GLOBAL_CONFIGS].map((name) => path.join(Global.Path.config, name))
      const patchGlobal = writableGlobal(cleaned)
      const written = yield* SettingsTransaction.apply({
        files: candidates, request: { kind: "global_settings", config },
        prepare: (tx, settings) => {
          const current = tx.file(globalConfigFile())
          if (expected && !ConfigFileWrite.sameObservation(current, expected))
            throw new ConfigFileWrite.Error({ reason: "changed" })
          const before = current.text ?? "{}"
          ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(ConfigParse.jsonc(before, current.path), current.path), current.path)
          const updated = patchJsonc(before, patchGlobal)
          const next = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(ConfigParse.jsonc(updated, current.path), current.path), current.path)
          return { config: { file: current, text: updated }, settings: SettingsStore.merge(settings, patch), value: next }
        },
      }).pipe(fileWrite, Effect.orDie)
      if (written.changed) yield* invalidate()
      return { info: overlaySettings(written.value, written.settings, true), changed: written.changed }
    })

    const removeGlobalMcp = Effect.fn("Config.removeGlobalMcp")(function* (name: string, original: McpSnapshot) {
      const observed = yield* mcpSnapshot()
      if (observed.source !== original.source) return yield* new McpRemovalError({ reason: "changed" })
      if (Object.hasOwn(observed.config.mcp ?? {}, name) && observed.config.mcp_origins?.[name] !== globalConfigFile())
        return yield* new McpRemovalError({ reason: "readonly" })
      const file = globalConfigFile()
      const expected = yield* ConfigFileWrite.read(file).pipe(fileWrite, Effect.orDie)
      yield* SettingsTransaction.apply({
        files: ["config.jsonc", ...LEGACY_GLOBAL_CONFIGS].map((name) => path.join(Global.Path.config, name)),
        request: { kind: "global_mcp_remove", name },
        prepare: (tx, settings) => {
          const current = tx.file(file)
          if (!ConfigFileWrite.sameObservation(current, expected)) throw new McpRemovalError({ reason: "changed" })
          const text = current.text ?? "{}"
          const parsed = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(ConfigParse.jsonc(text, file), file), file)
          if (Object.hasOwn(observed.config.mcp ?? {}, name) && !Object.hasOwn(parsed.mcp ?? {}, name))
            throw new McpRemovalError({ reason: "changed" })
          // A surviving legacy definition would reappear after removing the winning key.
          for (const nameOfFile of ["config.jsonc", ...LEGACY_GLOBAL_CONFIGS]) {
            const other = tx.file(path.join(Global.Path.config, nameOfFile))
            if (other.path === current.path || other.text === undefined) continue
            const value = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(ConfigParse.jsonc(other.text, other.path), other.path), other.path)
            if (Object.hasOwn(value.mcp ?? {}, name)) throw new McpRemovalError({ reason: "changed" })
          }
          const updated = applyEdits(text, modify(text, ["mcp", name], undefined, {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          }))
          ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(ConfigParse.jsonc(updated, file), file), file)
          return { config: current.text === undefined ? undefined : { file: current, text: updated }, settings, value: undefined }
        },
      }).pipe(fileWrite, Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        return error instanceof McpRemovalError ? Effect.fail(error) : Effect.die(error)
      }))
      yield* invalidate()
      // A lower remote/project layer may become visible after the local key is gone.
      // Report that current source rather than claiming the effective server was removed.
      if (Object.hasOwn((yield* get()).mcp ?? {}, name)) return yield* new McpRemovalError({ reason: "changed" })
    })

    return Service.of({
      mcpSnapshot,
      readonlySnapshot,
      get,
      getGlobal,
      getConsoleState,
      getErrors,
      update,
      updateGlobal,
      removeGlobalMcp,
      invalidate,
      directories,
      waitForDependencies,
      watch: watchChanges,
    })
  }),
).pipe(Layer.provide(EffectFlock.defaultLayer))

const withAuthorities = (account: Layer.Layer<Account.Service, unknown>) =>
  layer.pipe(
    Layer.provide(EffectFlock.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(account),
    Layer.provide(Npm.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
  )

export const defaultLayer = withAuthorities(Account.defaultLayer)

/**
 * DB-free boot variant for standalone server-listening commands (`serve`, `web`). The real
 * Account authority opens the Database (AccountRepo -> Database.defaultLayer: preflight,
 * migrate, lifetime runtime lock), and a process whose Server.listen must remain the SOLE
 * database owner cannot build it before listen. The Account surface is stubbed to "no active
 * account" (any other method defects via Layer.mock): that only skips the console
 * remote-config pull at THIS layer — the route graph Server.listen builds constructs the full
 * `defaultLayer` and performs it there.
 */
export const standaloneLayer = withAuthorities(
  Layer.mock(Account.Service, { active: () => Effect.succeed(Option.none()) }),
)

export * as Config from "./config"
