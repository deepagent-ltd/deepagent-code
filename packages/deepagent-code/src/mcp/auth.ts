import path from "path"
import { serviceUse } from "@deepagent-code/core/effect/service-use"
import { Global } from "@deepagent-code/core/global"
import { Effect, Layer, Context, Option, Schema } from "effect"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { McpAuthStore } from "./auth-store"
import { McpOAuthState } from "./oauth-state"

const Secret = Schema.String.check(Schema.isMaxLength(16384))
const Timestamp = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

export const Tokens = Schema.Struct({
  accessToken: Schema.mutableKey(Secret),
  refreshToken: Schema.mutableKey(Schema.optional(Secret)),
  expiresAt: Schema.mutableKey(Schema.optional(Timestamp)),
  scope: Schema.mutableKey(Schema.optional(Schema.String.check(Schema.isMaxLength(4096)))),
  issuer: Schema.mutableKey(Schema.optional(McpOAuthState.Issuer)),
})
export type Tokens = Schema.Schema.Type<typeof Tokens>

export const ClientInfo = Schema.Struct({
  clientId: Schema.mutableKey(Secret),
  clientSecret: Schema.mutableKey(Schema.optional(Secret)),
  clientIdIssuedAt: Schema.mutableKey(Schema.optional(Timestamp)),
  clientSecretExpiresAt: Schema.mutableKey(Schema.optional(Timestamp)),
  issuer: Schema.mutableKey(Schema.optional(McpOAuthState.Issuer)),
  registeredRedirectUris: Schema.mutableKey(Schema.optional(McpOAuthState.RegisteredRedirectUris)),
})
export type ClientInfo = Schema.Schema.Type<typeof ClientInfo>

export const Entry = Schema.Struct({
  tokens: Schema.mutableKey(Schema.optional(Tokens)),
  clientInfo: Schema.mutableKey(Schema.optional(ClientInfo)),
  codeVerifier: Schema.mutableKey(Schema.optional(Schema.String.check(Schema.isMaxLength(128)))),
  oauthState: Schema.mutableKey(Schema.optional(Schema.String.check(Schema.isMaxLength(256)))),
  serverUrl: Schema.mutableKey(Schema.optional(Schema.String.check(Schema.isMaxLength(8192)))),
  discoveryState: Schema.mutableKey(Schema.optional(McpOAuthState.Discovery)),
  authorizationDiscoveryHash: Schema.mutableKey(
    Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  ),
  authorizationGeneration: Schema.mutableKey(Schema.optional(Schema.String.check(Schema.isMaxLength(256)))),
})
export type Entry = Schema.Schema.Type<typeof Entry>

const decodeAuthData = Schema.decodeUnknownOption(Schema.Record(Schema.String, Entry), { onExcessProperty: "error" })
type AuthData = Record<string, Entry>

const filepath = path.join(Global.Path.config, "mcp-auth.json")
const lockKey = `mcp-auth:${filepath}`

export interface Interface {
  readonly all: () => Effect.Effect<Record<string, Entry>>
  readonly get: (mcpName: string) => Effect.Effect<Entry | undefined>
  readonly getForUrl: (mcpName: string, serverUrl: string) => Effect.Effect<Entry | undefined>
  readonly set: (mcpName: string, entry: Entry, serverUrl?: string, expectedGeneration?: string) => Effect.Effect<void>
  readonly remove: (mcpName: string, expectedGeneration?: string) => Effect.Effect<void>
  readonly updateTokens: (
    mcpName: string,
    tokens: Tokens,
    serverUrl?: string,
    expectedGeneration?: string,
  ) => Effect.Effect<void>
  readonly updateClientInfo: (
    mcpName: string,
    clientInfo: ClientInfo,
    serverUrl?: string,
    expectedGeneration?: string,
  ) => Effect.Effect<void>
  readonly updateCodeVerifier: (
    mcpName: string,
    codeVerifier: string,
    serverUrl?: string,
    expectedGeneration?: string,
  ) => Effect.Effect<void>
  readonly clearCodeVerifier: (mcpName: string, expectedGeneration?: string) => Effect.Effect<void>
  readonly updateOAuthState: (
    mcpName: string,
    oauthState: string,
    serverUrl?: string,
    expectedGeneration?: string,
  ) => Effect.Effect<void>
  readonly getOAuthState: (mcpName: string) => Effect.Effect<string | undefined>
  readonly clearOAuthState: (mcpName: string, expectedGeneration?: string) => Effect.Effect<void>
  readonly updateDiscoveryState: (
    mcpName: string,
    state: McpOAuthState.Discovery,
    serverUrl: string,
    expectedGeneration?: string,
  ) => Effect.Effect<void>
  readonly clearDiscoveryState: (mcpName: string, expectedGeneration?: string) => Effect.Effect<void>
  readonly clearTokens: (mcpName: string, expectedGeneration?: string) => Effect.Effect<void>
  readonly clearClientInfo: (mcpName: string, expectedGeneration?: string) => Effect.Effect<void>
  readonly startFlow: (mcpName: string, oauthState: string, serverUrl: string) => Effect.Effect<void>
  readonly clearCredentials: (mcpName: string, expectedGeneration?: string) => Effect.Effect<void>
  readonly freezeDiscovery: (mcpName: string, expectedGeneration: string) => Effect.Effect<void>
  readonly clearFlow: (mcpName: string, expectedState: string) => Effect.Effect<void>
  readonly isTokenExpired: (mcpName: string) => Effect.Effect<boolean | null>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/McpAuth") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flock = yield* EffectFlock.Service

    const read = Effect.fn("McpAuth.read")(function* () {
      const file = yield* Effect.promise(() => McpAuthStore.read(filepath))
      if (!file) return { data: {} as AuthData, stamp: undefined }
      const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(file.text)
      if (Option.isNone(parsed)) return yield* Effect.die(new McpAuthStore.Error("invalid"))
      return { data: requireData(parsed.value), stamp: file.stamp }
    })

    const all = Effect.fn("McpAuth.all")(function* () {
      // Atomic publication and FD verification let reads stay independent of a crashed writer's
      // lease. A concurrent replacement is an explicit changed failure, never a truncated store.
      return yield* read().pipe(Effect.map((value) => value.data))
    })

    const mutate = Effect.fn("McpAuth.mutate")(function* (update: (data: AuthData) => AuthData | undefined) {
      yield* Effect.gen(function* () {
        const before = yield* read()
        const next = update(before.data)
        if (!next) return
        const text = JSON.stringify(requireData(next), null, 2)
        if (Buffer.byteLength(text, "utf8") > McpAuthStore.MAX_BYTES)
          return yield* Effect.die(new McpAuthStore.Error("capacity"))
        yield* Effect.promise(() => McpAuthStore.write(filepath, text, before.stamp))
      }).pipe(flock.withLock(lockKey), Effect.orDie)
    })

    const get = Effect.fn("McpAuth.get")(function* (mcpName: string) {
      const data = yield* all()
      return Object.hasOwn(data, mcpName) ? data[mcpName] : undefined
    })

    const getForUrl = Effect.fn("McpAuth.getForUrl")(function* (mcpName: string, serverUrl: string) {
      const entry = yield* get(mcpName)
      if (!entry) return undefined
      if (!entry.serverUrl) return undefined
      if (entry.serverUrl !== serverUrl) return undefined
      return entry
    })

    const set = Effect.fn("McpAuth.set")(function* (
      mcpName: string,
      entry: Entry,
      serverUrl?: string,
      expectedGeneration?: string,
    ) {
      yield* mutate((data) => {
        requireGeneration(data, mcpName, expectedGeneration)
        return { ...data, [mcpName]: serverUrl ? { ...entry, serverUrl } : entry }
      })
    })

    const remove = Effect.fn("McpAuth.remove")(function* (mcpName: string, expectedGeneration?: string) {
      yield* mutate((data) => {
        requireGeneration(data, mcpName, expectedGeneration)
        const next = { ...data }
        delete next[mcpName]
        return next
      })
    })

    const updateField = <K extends keyof Entry>(field: K, spanName: string) =>
      Effect.fn(`McpAuth.${spanName}`)(function* (
        mcpName: string,
        value: NonNullable<Entry[K]>,
        serverUrl?: string,
        expectedGeneration?: string,
      ) {
        yield* mutate((data) => {
          requireGeneration(data, mcpName, expectedGeneration)
          const old = Object.hasOwn(data, mcpName) ? data[mcpName] : undefined
          if (expectedGeneration !== undefined && serverUrl !== undefined && old?.serverUrl !== serverUrl)
            throw new McpAuthStore.Error("changed")
          const entry = serverUrl && old?.serverUrl !== serverUrl ? {} : (old ?? {})
          if (
            field === "discoveryState" &&
            entry.authorizationDiscoveryHash !== undefined &&
            (!Schema.is(McpOAuthState.Discovery)(value) ||
              McpOAuthState.digest(value) !== entry.authorizationDiscoveryHash)
          )
            throw new McpAuthStore.Error("changed")
          return { ...data, [mcpName]: { ...entry, [field]: value, ...(serverUrl ? { serverUrl } : {}) } }
        })
      })

    const clearField = (field: keyof Entry, spanName: string) =>
      Effect.fn(`McpAuth.${spanName}`)(function* (mcpName: string, expectedGeneration?: string) {
        yield* mutate((data) => {
          requireGeneration(data, mcpName, expectedGeneration)
          const old = Object.hasOwn(data, mcpName) ? data[mcpName] : undefined
          if (!old) return undefined
          const entry = { ...old }
          delete entry[field]
          return { ...data, [mcpName]: entry }
        })
      })

    const updateTokens = updateField("tokens", "updateTokens")
    const updateClientInfo = updateField("clientInfo", "updateClientInfo")
    const updateCodeVerifier = updateField("codeVerifier", "updateCodeVerifier")
    const updateOAuthState = updateField("oauthState", "updateOAuthState")
    const clearCodeVerifier = clearField("codeVerifier", "clearCodeVerifier")
    const clearOAuthState = clearField("oauthState", "clearOAuthState")
    const clearTokens = clearField("tokens", "clearTokens")
    const clearClientInfo = clearField("clientInfo", "clearClientInfo")
    const clearDiscoveryState = clearField("discoveryState", "clearDiscoveryState")
    const updateDiscoveryState = updateField("discoveryState", "updateDiscoveryState")
    const startFlow = Effect.fn("McpAuth.startFlow")(function* (
      mcpName: string,
      oauthState: string,
      serverUrl: string,
    ) {
      yield* mutate((data) => {
        const old = Object.hasOwn(data, mcpName) ? data[mcpName] : undefined
        const entry = old?.serverUrl === serverUrl ? { ...old } : {}
        delete entry.codeVerifier
        delete entry.discoveryState
        delete entry.authorizationDiscoveryHash
        return { ...data, [mcpName]: { ...entry, oauthState, authorizationGeneration: oauthState, serverUrl } }
      })
    })
    const clearCredentials = Effect.fn("McpAuth.clearCredentials")(function* (
      mcpName: string,
      expectedGeneration?: string,
    ) {
      yield* mutate((data) => {
        requireGeneration(data, mcpName, expectedGeneration)
        if (!Object.hasOwn(data, mcpName)) return undefined
        const entry = { ...data[mcpName] }
        delete entry.tokens
        delete entry.clientInfo
        delete entry.codeVerifier
        delete entry.discoveryState
        return { ...data, [mcpName]: entry }
      })
    })
    const freezeDiscovery = Effect.fn("McpAuth.freezeDiscovery")(function* (
      mcpName: string,
      expectedGeneration: string,
    ) {
      yield* mutate((data) => {
        requireGeneration(data, mcpName, expectedGeneration)
        const entry = data[mcpName]
        if (entry.oauthState !== expectedGeneration || !entry.discoveryState) throw new McpAuthStore.Error("changed")
        const hash = McpOAuthState.digest(entry.discoveryState)
        if (entry.authorizationDiscoveryHash !== undefined && entry.authorizationDiscoveryHash !== hash)
          throw new McpAuthStore.Error("changed")
        if (entry.authorizationDiscoveryHash === hash) return undefined
        return { ...data, [mcpName]: { ...entry, authorizationDiscoveryHash: hash } }
      })
    })
    const clearFlow = Effect.fn("McpAuth.clearFlow")(function* (mcpName: string, expectedState: string) {
      yield* mutate((data) => {
        if (
          !Object.hasOwn(data, mcpName) ||
          data[mcpName].oauthState !== expectedState ||
          data[mcpName].authorizationGeneration !== expectedState
        )
          return undefined
        const entry = { ...data[mcpName] }
        delete entry.oauthState
        delete entry.codeVerifier
        delete entry.discoveryState
        delete entry.authorizationDiscoveryHash
        return { ...data, [mcpName]: entry }
      })
    })

    const getOAuthState = Effect.fn("McpAuth.getOAuthState")(function* (mcpName: string) {
      const entry = yield* get(mcpName)
      return entry?.oauthState
    })

    const isTokenExpired = Effect.fn("McpAuth.isTokenExpired")(function* (mcpName: string) {
      const entry = yield* get(mcpName)
      if (!entry?.tokens) return null
      if (entry.tokens.expiresAt === undefined) return false
      return entry.tokens.expiresAt <= Date.now() / 1000
    })

    return Service.of({
      all,
      get,
      getForUrl,
      set,
      remove,
      updateTokens,
      updateClientInfo,
      updateCodeVerifier,
      clearCodeVerifier,
      updateOAuthState,
      getOAuthState,
      clearOAuthState,
      updateDiscoveryState,
      clearDiscoveryState,
      clearTokens,
      clearClientInfo,
      startFlow,
      clearCredentials,
      freezeDiscovery,
      clearFlow,
      isTokenExpired,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EffectFlock.defaultLayer))

function requireGeneration(data: AuthData, name: string, expected?: string) {
  if (expected !== undefined && (!Object.hasOwn(data, name) || data[name].authorizationGeneration !== expected))
    throw new McpAuthStore.Error("changed")
}

function requireData(input: unknown): AuthData {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new McpAuthStore.Error("invalid")
  const keys = Object.keys(input)
  if (keys.length > 256) throw new McpAuthStore.Error("capacity")
  if (keys.some((key) => key.length === 0 || key.length > 512 || /[\u0000-\u001f\u007f]/.test(key)))
    throw new McpAuthStore.Error("invalid")
  const decoded = decodeAuthData(input)
  if (Option.isNone(decoded)) throw new McpAuthStore.Error("invalid")
  if (
    Object.values(decoded.value).some(
      (entry) =>
        [
          entry.tokens?.accessToken,
          entry.tokens?.refreshToken,
          entry.clientInfo?.clientId,
          entry.clientInfo?.clientSecret,
        ].some((value) => value !== undefined && Buffer.byteLength(value, "utf8") > 16384) ||
        (entry.tokens?.scope !== undefined && Buffer.byteLength(entry.tokens.scope, "utf8") > 4096) ||
        (entry.serverUrl !== undefined && Buffer.byteLength(entry.serverUrl, "utf8") > 8192) ||
        (entry.codeVerifier !== undefined && Buffer.byteLength(entry.codeVerifier, "utf8") > 128) ||
        (entry.oauthState !== undefined && Buffer.byteLength(entry.oauthState, "utf8") > 256) ||
        (entry.authorizationGeneration !== undefined && Buffer.byteLength(entry.authorizationGeneration, "utf8") > 256),
    )
  )
    throw new McpAuthStore.Error("capacity")
  if (Object.values(decoded.value).some((value) => Buffer.byteLength(JSON.stringify(value), "utf8") > 65536))
    throw new McpAuthStore.Error("capacity")
  if (
    Object.values(decoded.value).some(
      (value) =>
        value.discoveryState !== undefined && Buffer.byteLength(JSON.stringify(value.discoveryState), "utf8") > 32768,
    )
  )
    throw new McpAuthStore.Error("capacity")
  return decoded.value
}

export * as McpAuth from "./auth"
