import { createHash, createHmac, randomBytes } from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"
import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import { Global } from "@deepagent-code/core/global"
import { projectIdForWorkspace } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { ConfigMCPV1 } from "@deepagent-code/core/v1/config/mcp"
import { Account } from "@/account/account"
import { AccountRepo } from "@/account/repo"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { registerInstanceStateDisposer } from "@/effect/instance-registry"
import { InstanceRef } from "@/effect/instance-ref"
import { LocalAuthority } from "@/installation/local-authority"
import { McpAuth } from "./auth"
import { McpAuthJournal } from "./auth-journal"
import { McpAuthJournalSchema } from "./auth-journal-schema"
import { McpOAuthState } from "./oauth-state"
import { SecretStore } from "./secret-store"
import { McpSecretMigration } from "./secret-migration"
import { SecretRefScope } from "./secret-ref-scope"
import { McpOAuthCallback } from "./oauth-callback"
import { McpLocalOperator } from "./local-operator"

export type Flow = {
  readonly state: string
  readonly redirectUri: string
  readonly callback?: McpOAuthCallback.Lease
  readonly auth: McpAuth.Interface
  readonly current: () => Promise<boolean>
  readonly fetch: (url: string | URL, init?: RequestInit) => Promise<Response>
  readonly connected: () => Promise<void>
  readonly handoffLocal: () => Promise<void>
  readonly revoke: (credentials?: boolean) => Promise<void>
  readonly close: () => void
}
export type Metadata = {
  readonly tokens: boolean
  readonly expired: boolean
  readonly unknown: boolean
  readonly legacy: boolean
}
export type ReadInput = Readonly<{
  directory: string
  projectID?: string
  projectVcs?: "git"
  workspaceID?: string
  snapshot: Config.McpSnapshot
}>

export interface Interface {
  readonly configure: (name: string, config: ConfigMCPV1.Info) => Effect.Effect<void, McpAuthJournalSchema.Error>
  readonly retire: (name: string) => Effect.Effect<void>
  readonly begin: (
    name: string,
    config: ConfigMCPV1.Info,
    explicit: boolean,
    interactive?: boolean,
  ) => Effect.Effect<Flow, McpAuthJournalSchema.Error>
  readonly metadataAt: (
    name: string,
    config: ConfigMCPV1.Info,
    input: ReadInput,
  ) => Effect.Effect<Metadata, McpAuthJournalSchema.Error>
  readonly metadata: (name: string, config: ConfigMCPV1.Info) => Effect.Effect<Metadata, McpAuthJournalSchema.Error>
  readonly remove: (name: string, config: ConfigMCPV1.Info) => Effect.Effect<void, McpAuthJournalSchema.Error>
}
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/McpAuthScope") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const accounts = yield* AccountRepo.Service
    const account = yield* Account.Service
    const identities = yield* LocationIdentity.Service
    const configuration = yield* Config.Service
    const secrets = yield* SecretStore.Service
    const migration = yield* Effect.serviceOption(McpSecretMigration.Service)
    const legacy = yield* McpAuth.Service
    const runtime = new WeakMap<object, Map<string, { configuration: string; incarnation: string }>>()
    const configure = Effect.fn("McpAuthScope.configure")(function* (name: string, config: ConfigMCPV1.Info) {
      const instance = yield* InstanceState.context
      if (!name || name.length > 512) return yield* Effect.fail(new McpAuthJournalSchema.Error("invalid"))
      const snapshot = configuration.mcpSnapshot ? yield* configuration.mcpSnapshot() : undefined
      // Snapshot reads may yield. Select and mutate the one original map only
      // afterwards, so concurrent first adds cannot replace each other's owner.
      const existing = runtime.get(instance)
      const entries = existing ?? new Map<string, { configuration: string; incarnation: string }>()
      // Persisted configuration already has its original source binding. Retire its
      // transient witness; never evict another live configuration to make room.
      for (const [key, value] of entries) {
        const durable = snapshot?.config.mcp?.[key]
        if (durable && configurationDigest(durable) === value.configuration) entries.delete(key)
      }
      const digest = configurationDigest(config)
      const durable = snapshot?.config.mcp?.[name]
      if (durable && configurationDigest(durable) === digest) {
        entries.delete(name)
        return
      }
      if (!entries.has(name) && entries.size >= McpAuthJournalSchema.LIMITS.slots)
        return yield* Effect.fail(new McpAuthJournalSchema.Error("capacity"))
      // Only the opaque original Instance owns this digest. It observes config
      // equality and cannot replace the installation-key MAC or journal receipt.
      entries.set(name, { configuration: digest, incarnation: randomBytes(32).toString("hex") })
      if (!existing) {
        runtime.set(instance, entries)
        registerInstanceStateDisposer(instance, async () => {
          entries.clear()
          runtime.delete(instance)
        })
      }
    })
    const retire = Effect.fn("McpAuthScope.retire")(function* (name: string) {
      runtime.get(yield* InstanceState.context)?.delete(name)
    })

    const capture = Effect.fnUntraced(function* (
      name: string,
      config: ConfigMCPV1.Info,
      initialize: boolean,
      verify: boolean,
      observed?: ReadInput,
    ) {
      if (config.type !== "remote" || config.oauth === false || !configuration.mcpSnapshot)
        return yield* Effect.fail(new McpAuthJournalSchema.Error("unavailable"))
      if (observed ? observed.workspaceID : yield* InstanceState.workspaceID)
        return yield* Effect.fail(new McpAuthJournalSchema.Error("unavailable"))
      if (observed && initialize) return yield* Effect.fail(new McpAuthJournalSchema.Error("unavailable"))
      const instance = observed ? undefined : yield* InstanceState.context
      const installation = yield* initialize
        ? LocalAuthority.ensurePrivateInstallation()
        : LocalAuthority.readInstallation
      const authority = yield* verify ? account.verifyAuthority() : accounts.authority()
      const binding = {
        boundary: { kind: "implicit_local" as const },
        directory: AbsolutePath.make(observed?.directory ?? instance!.directory),
        project:
          (observed ? observed.projectVcs : instance!.project.vcs) === "git"
            ? { kind: "git" as const, observedProjectId: observed?.projectID ?? instance!.project.id }
            : {
                kind: "registered_root" as const,
                observedProjectId: projectIdForWorkspace(observed?.directory ?? instance!.directory),
              },
      }
      if (initialize) yield* identities.resolve(binding)
      // Resolve can return an existing Location. Its original binding must still
      // match; an old MCP-only binding is not adopted or rewritten here.
      const identity = yield* identities.lookup(binding)
      const snapshot = observed?.snapshot ?? (yield* configuration.mcpSnapshot())
      const actual = snapshot.config.mcp?.[name]
      const transient = instance ? runtime.get(instance)?.get(name) : undefined
      const durable = CanonicalJson.stringify(actual ?? null) === CanonicalJson.stringify(config)
      if (!durable && (!transient || transient.configuration !== configurationDigest(config)))
        return yield* Effect.fail(new McpAuthJournalSchema.Error("changed"))
      if (durable && snapshot.config.mcp_origins?.[name]?.endsWith("/api/config")) {
        const source = snapshot.accountSource
        if (
          !source ||
          !authority.account ||
          source.id !== authority.account.id ||
          source.url !== authority.account.url ||
          source.orgID !== authority.orgID ||
          source.generation !== authority.account.identity_generation ||
          source.selectionRevision !== authority.selectionRevision
        )
          return yield* Effect.fail(new McpAuthJournalSchema.Error("changed"))
      }
      if (authority.account && !authority.account.identity_generation)
        return yield* Effect.fail(new McpAuthJournalSchema.Error("unavailable"))
      const headers = config.headers
        ? yield* (Option.isSome(migration) ? migration.value.resolveRecord(name, "headers", config.headers).pipe(Effect.orDie) : SecretStore.resolveRecord(config.headers, secrets)).pipe(
            Effect.catchCause((cause) => {
              const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined
              return reason && Cause.isDieReason(reason) && (reason.defect instanceof SecretStore.FileError || reason.defect instanceof SecretRefScope.Error || reason.defect instanceof McpSecretMigration.Error)
                ? Effect.fail(new McpAuthJournalSchema.Error("unavailable"))
                : Effect.failCause(cause)
            }),
          )
        : {}
      const clientSecret = config.oauth && typeof config.oauth === "object" ? config.oauth.clientSecret : undefined
      const resolvedClientSecret = clientSecret && SecretStore.isScoped(clientSecret)
        ? yield* (Option.isSome(migration) ? migration.value.resolveValue(name, "oauth", "clientSecret", clientSecret) : Effect.fail(new McpSecretMigration.Error({ reason: "unavailable" }))).pipe(Effect.mapError(safeError))
        : undefined
      const tag = (domain: string, value: unknown) =>
        createHmac("sha256", Buffer.from(installation.secret, "hex"))
          .update(`dac.mcp.oauth.${domain}.v1\0`)
          .update(CanonicalJson.stringify(value))
          .digest("hex")
      const principal = authority.account
        ? {
            kind: "account" as const,
            id: authority.account.id,
            issuer: authority.account.url,
            orgID: authority.orgID,
            identityGeneration: authority.account.identity_generation!,
            selectionRevision: authority.selectionRevision,
          }
        : { kind: "local" as const, selectionRevision: authority.selectionRevision }
      const scope = Schema.decodeUnknownSync(McpAuthJournalSchema.Binding)({
        version: 1,
        installationID: installation.instanceID,
        namespace: identity.securityNamespaceId,
        location: identity.locationKey,
        project: identity.projectScopeKey,
        rootTag: tag("root", identity.canonicalRoot),
        principal,
        name,
        resource: config.url,
        sourceTag: tag("source", {
          source: durable ? snapshot.config.mcp_origins?.[name] : `runtime:${transient!.incarnation}`,
          observed: snapshot.source,
        }),
        configurationTag: tag("configuration", config),
        credentialTag: tag("headers", resolvedClientSecret === undefined ? headers : { headers, clientSecret: resolvedClientSecret }),
      })
      return {
        scope,
        slot: tag("slot", scope),
        installationTag: tag("installation", installation.instanceID),
        tag,
        file: path.join(Global.Path.config, "mcp-oauth", "journal.sqlite"),
      }
    })

    const metadataRead = Effect.fn("McpAuthScope.metadataRead")(function* (
      name: string,
      config: ConfigMCPV1.Info,
      observed?: ReadInput,
    ) {
      const old = !!(yield* legacy.get(name))
      const empty = { tokens: false, expired: false, unknown: false, legacy: old }
      const installed = yield* safePromise(() =>
        fs.lstat(LocalAuthority.installationPath()).then(
          () => true,
          (error: unknown) => {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
            throw new McpAuthJournalSchema.Error("unavailable")
          },
        ),
      )
      if (!installed || (observed && !observed.projectID)) return empty
      const captured = yield* capture(name, config, false, false, observed).pipe(
        Effect.catchTag("LocationIdentity.NotFoundError", () => Effect.succeed(undefined)),
        Effect.mapError(safeError),
      )
      if (!captured) return empty
      const store = yield* safePromise(() => McpAuthJournal.open(captured.file, captured.installationTag, "read"))
      if (!store) return { tokens: false, expired: false, unknown: false, legacy: old }
      return yield* Effect.try({
        try: () => {
          const value = store.read(captured.slot)
          return {
            tokens: !!value?.credentials.tokens,
            expired:
              value?.credentials.tokens?.expiresAt !== undefined &&
              value.credentials.tokens.expiresAt <= Date.now() / 1000,
            unknown: store.unresolved(captured.slot),
            legacy: old,
          }
        },
        catch: safeError,
      }).pipe(Effect.ensuring(Effect.sync(store.close)))
    })

    const metadata = (name: string, config: ConfigMCPV1.Info) => metadataRead(name, config)
    const metadataAt = (name: string, config: ConfigMCPV1.Info, input: ReadInput) => metadataRead(name, config, input)

    const begin = Effect.fn("McpAuthScope.begin")(function* (
      name: string,
      config: ConfigMCPV1.Info,
      explicit: boolean,
      interactive = false,
    ) {
      yield* McpLocalOperator.requireTarget(name).pipe(Effect.mapError(safeError))
      const local = yield* McpLocalOperator.capture.pipe(Effect.mapError(safeError))
      const operator = { handedOff: false }
      const localCurrent = () => (local && !operator.handedOff ? safePromise(local.check) : Effect.void)
      yield* localCurrent()
      const captured = yield* capture(name, config, true, true).pipe(Effect.mapError(safeError))
      const bridge = yield* EffectBridge.make()
      const instance = yield* InstanceState.context
      yield* localCurrent()
      const store = yield* safePromise(() => McpAuthJournal.open(captured.file, captured.installationTag, "write"))
      if (!store || config.type !== "remote") return yield* Effect.fail(new McpAuthJournalSchema.Error("unavailable"))
      const oauth = typeof config.oauth === "object" ? config.oauth : undefined
      const before = yield* Effect.try({ try: () => store.read(captured.slot), catch: safeError }).pipe(
        Effect.onError(() => Effect.sync(store.close)),
      )
      if (interactive && store.unresolved(captured.slot)) {
        store.close()
        return yield* Effect.fail(new McpAuthJournalSchema.Error("unknown"))
      }
      const configured =
        oauth?.redirectUri ??
        (oauth?.callbackPort ? `http://127.0.0.1:${oauth.callbackPort}/mcp/oauth/callback` : undefined)
      const registered = before?.credentials.clientInfo?.registeredRedirectUris
      if (
        interactive &&
        !oauth?.clientId &&
        before?.credentials.clientInfo &&
        (!registered || (configured !== undefined && !registered.includes(configured)))
      ) {
        store.close()
        return yield* Effect.fail(new McpAuthJournalSchema.Error("unavailable"))
      }
      const selected =
        configured ??
        (oauth?.clientId
          ? "http://127.0.0.1:19876/mcp/oauth/callback"
          : registered?.includes(before?.flow?.redirectUri ?? "")
            ? before!.flow!.redirectUri
            : registered?.[0])
      const callback = interactive
        ? yield* safePromise(() => McpOAuthCallback.acquire(selected)).pipe(
            Effect.onError(() => Effect.sync(store.close)),
          )
        : undefined
      const redirectUri =
        callback?.redirectUri ?? selected ?? before?.flow?.redirectUri ?? "http://127.0.0.1:19876/mcp/oauth/callback"
      const current = yield* capture(name, config, false, true).pipe(
        Effect.mapError(safeError),
        Effect.onError(() =>
          Effect.promise(async () => {
            await callback?.close()
            store.close()
          }),
        ),
      )
      if (current.slot !== captured.slot || current.installationTag !== captured.installationTag) {
        yield* Effect.promise(async () => {
          await callback?.close()
          store.close()
        })
        return yield* Effect.fail(new McpAuthJournalSchema.Error("changed"))
      }
      yield* localCurrent().pipe(
        Effect.onError(() =>
          Effect.promise(async () => {
            await callback?.close()
            store.close()
          }),
        ),
      )
      const now = Date.now()
      const state = randomBytes(32).toString("hex")
      const handle = yield* Effect.try({
        try: () =>
          store.begin({
            slot: captured.slot,
            binding: captured.scope,
            explicit,
            expected: before ? { revision: before.row.revision, generation: before.row.generation } : null,
            flow: {
              version: 1,
              id: randomBytes(32).toString("hex"),
              owner: randomBytes(32).toString("hex"),
              state,
              phase: "preparing",
              createdAt: now,
              expiresAt: now + McpAuthJournalSchema.LIMITS.lifetimeMs,
              redirectUri,
            },
          }),
        catch: safeError,
      }).pipe(
        Effect.onError(() =>
          Effect.promise(async () => {
            await callback?.close()
            store.close()
          }),
        ),
      )
      const operation: { current?: McpAuthJournal.Receipt; kind?: McpAuthJournalSchema.Kind; closed: boolean } = {
        closed: false,
      }
      const check = (verify = false) =>
        localCurrent().pipe(
          Effect.andThen(capture(name, config, false, verify)),
          Effect.flatMap((current) =>
            localCurrent().pipe(
              Effect.andThen(
                Effect.try({
                  try: () => {
                    if (
                      operation.closed ||
                      current.slot !== captured.slot ||
                      current.installationTag !== captured.installationTag
                    )
                      throw new McpAuthJournalSchema.Error("changed")
                    return store.current(handle, operation.current)
                  },
                  catch: safeError,
                }),
              ),
            ),
          ),
          Effect.mapError(safeError),
          Effect.provideService(InstanceRef, instance),
        )
      const read = () =>
        check().pipe(
          Effect.map(
            (value): McpAuth.Entry => ({
              ...value.credentials,
              serverUrl: config.url,
              oauthState: value.flow!.state,
              authorizationGeneration: value.flow!.state,
              codeVerifier: value.flow!.verifier,
              discoveryState: value.flow!.discovery,
              authorizationDiscoveryHash: value.flow!.discoveryTag,
            }),
          ),
        )
      const mutate = (body: () => void) =>
        check().pipe(
          Effect.flatMap(() => Effect.try({ try: body, catch: safeError })),
          Effect.orDie,
        )
      const requireName = (key: string, generation?: string, url?: string) => {
        if (
          key !== name ||
          (generation !== undefined && generation !== state) ||
          (url !== undefined && url !== config.url)
        )
          throw new McpAuthJournalSchema.Error("changed")
      }
      const persist = (credentials: McpAuthJournalSchema.Credentials) => {
        if (!operation.current || !operation.kind) throw new McpAuthJournalSchema.Error("unknown")
        store.settle(operation.current, { phase: "committed", credentials, outcome: { code: "committed" } })
        operation.current = undefined
        operation.kind = undefined
      }
      const unsupported = () => Effect.die(new McpAuthJournalSchema.Error("unavailable"))
      const auth: McpAuth.Interface = {
        all: () =>
          read().pipe(
            Effect.map((entry) => ({ [name]: entry })),
            Effect.orDie,
          ),
        get: (key) =>
          read().pipe(
            Effect.tap(() => Effect.sync(() => requireName(key))),
            Effect.orDie,
          ),
        getForUrl: (key, url) =>
          read().pipe(
            Effect.tap(() => Effect.sync(() => requireName(key, undefined, url))),
            Effect.orDie,
          ),
        set: unsupported,
        remove: () => mutate(() => store.revoke(handle, true)),
        startFlow: unsupported,
        updateTokens: (key, tokens, url, generation) =>
          mutate(() => {
            requireName(key, generation, url)
            persist({ tokens })
          }),
        updateClientInfo: (key, clientInfo, url, generation) =>
          mutate(() => {
            requireName(key, generation, url)
            if (operation.kind === "registration") return persist({ clientInfo })
            if (!oauth?.clientId || clientInfo.clientId !== oauth.clientId)
              throw new McpAuthJournalSchema.Error("invalid")
            store.clientInformation(handle, clientInfo)
          }),
        updateCodeVerifier: (key, verifier, url, generation) =>
          mutate(() => {
            requireName(key, generation, url)
            store.updateFlow(handle, { verifier })
          }),
        updateOAuthState: (key, value, url, generation) =>
          mutate(() => {
            requireName(key, generation, url)
            if (value !== state) throw new McpAuthJournalSchema.Error("changed")
          }),
        getOAuthState: (key) =>
          read().pipe(
            Effect.map((entry) => {
              requireName(key)
              return entry.oauthState
            }),
            Effect.orDie,
          ),
        updateDiscoveryState: (key, discovery, url, generation) =>
          mutate(() => {
            requireName(key, generation, url)
            const before = store.current(handle)
            if (before.flow?.discoveryTag && McpOAuthState.digest(discovery) !== before.flow.discoveryTag)
              throw new McpAuthJournalSchema.Error("changed")
            store.updateFlow(handle, { discovery })
          }),
        freezeDiscovery: (key, generation) =>
          mutate(() => {
            requireName(key, generation)
            const discovery = store.current(handle).flow?.discovery
            if (!discovery) throw new McpAuthJournalSchema.Error("invalid")
            store.updateFlow(handle, { phase: "awaiting_callback", discoveryTag: McpOAuthState.digest(discovery) })
          }),
        clearCodeVerifier: () => mutate(() => store.updateFlow(handle, { verifier: undefined })),
        clearOAuthState: unsupported,
        clearDiscoveryState: unsupported,
        clearTokens: () => mutate(() => store.credentials(handle, (value) => ({ clientInfo: value.clientInfo }))),
        clearClientInfo: () => mutate(() => store.credentials(handle, (value) => ({ tokens: value.tokens }))),
        clearCredentials: () => mutate(() => store.credentials(handle, () => ({}))),
        clearFlow: () => mutate(() => store.updateFlow(handle, { phase: "connected" })),
        isTokenExpired: () =>
          read().pipe(
            Effect.map((entry) =>
              entry.tokens?.expiresAt === undefined ? null : entry.tokens.expiresAt <= Date.now() / 1000,
            ),
            Effect.orDie,
          ),
      }

      const fetch: Flow["fetch"] = async (url, init) => {
        const snapshot = await bridge.promise(check())
        const endpoint = new URL(url).href
        const discovery = snapshot.flow?.discovery
        const metadata = discovery?.authorizationServerMetadata
        const token =
          metadata?.token_endpoint ?? (discovery ? new URL("/token", discovery.authorizationServerUrl).href : undefined)
        const registration =
          metadata?.registration_endpoint ??
          (discovery ? new URL("/register", discovery.authorizationServerUrl).href : undefined)
        const mutation =
          (init?.method ?? "GET").toUpperCase() === "POST" && (endpoint === token || endpoint === registration)
        if (!mutation) {
          // The transport also uses this fetch for ordinary MCP requests. The same
          // real scope is rechecked, but JSON-RPC POST is not an OAuth token operation.
          await bridge.promise(check())
          return globalThis.fetch(url, init)
        }
        const kind =
          endpoint === registration
            ? "registration"
            : (typeof init?.body === "string" || init?.body instanceof URLSearchParams) &&
                new URLSearchParams(init.body).get("grant_type") === "refresh_token"
              ? "refresh"
              : "exchange"
        if (kind === "registration" && !interactive) throw new Error("OAuth authorization must be started explicitly")
        if (
          !(typeof init?.body === "string" || init?.body instanceof URLSearchParams) ||
          Buffer.byteLength(String(init.body), "utf8") > 65536
        )
          throw new McpAuthJournalSchema.Error("invalid")
        const body = String(init.body)
        const headers = Object.fromEntries(new Headers(init.headers).entries())
        await bridge.promise(check(true))
        // Account selection and this synchronous request admission share one Root's
        // identity gate. SQLite provides the independent cross-process hard CAS.
        const started = await bridge.promise(
          accounts.withIdentityGate(
            check().pipe(
              Effect.flatMap(() =>
                Effect.try({
                  try: () => {
                    operation.current = store.dispatch(handle, {
                      kind,
                      requestTag: captured.tag("request", { endpoint, body, headers }),
                      endpointTag: captured.tag("endpoint", endpoint),
                    })
                    operation.kind = kind
                    return { response: globalThis.fetch(endpoint, { ...init, body, headers, redirect: "error" }) }
                  },
                  catch: safeError,
                }),
              ),
            ),
          ),
        )
        try {
          const response = await started.response
          const reader = response.body?.getReader()
          const chunks: Uint8Array[] = []
          const budget = { bytes: 0 }
          if (reader) {
            try {
              for (;;) {
                const next = await reader.read()
                if (next.done) break
                if (next.value.byteLength > 65536 - budget.bytes) {
                  await reader.cancel()
                  throw new McpAuthJournalSchema.Error("capacity")
                }
                chunks.push(next.value)
                budget.bytes += next.value.byteLength
              }
            } finally {
              reader.releaseLock()
            }
          }
          await bridge.promise(check())
          if (!response.ok) {
            // A proxy/AS error does not prove that an exchange or refresh was not
            // consumed. Preserve the dispatched fact and never let SDK fallback
            // turn a lost result into a second authorization attempt.
            store.settle(operation.current!, {
              phase: "unknown",
              outcome: { code: "invalid_response", status: response.status },
            })
            throw new McpAuthJournalSchema.Error("unknown")
          }
          return new Response(Buffer.concat(chunks, budget.bytes), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        } catch {
          if (operation.current) {
            try {
              store.settle(operation.current, { phase: "unknown", outcome: { code: "network" } })
            } catch {}
          }
          throw new McpAuthJournalSchema.Error("unknown")
        }
      }
      return {
        state,
        redirectUri,
        callback,
        auth,
        fetch,
        current: () =>
          bridge.promise(
            check().pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            ),
          ),
        connected: () => bridge.promise(mutate(() => store.updateFlow(handle, { phase: "connected" }))),
        handoffLocal: () =>
          bridge.promise(
            check().pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  operator.handedOff = true
                }),
              ),
              Effect.asVoid,
            ),
          ),
        revoke: async (credentials = false) => {
          if (!operation.closed) store.revoke(handle, credentials)
        },
        close: () => {
          operation.closed = true
          store.close()
          void callback?.close()
        },
      } satisfies Flow
    })

    const remove = Effect.fn("McpAuthScope.remove")(function* (name: string, config: ConfigMCPV1.Info) {
      // An authenticated explicit operation may create the private local identity;
      // it does not adopt or delete any legacy file credential.
      const flow = yield* begin(name, config, true)
      yield* safePromise(() => flow.revoke(true)).pipe(Effect.ensuring(Effect.sync(flow.close)))
    })
    return Service.of({ configure, retire, begin, metadata, metadataAt, remove })
  }),
)

function configurationDigest(config: unknown) {
  return createHash("sha256").update(CanonicalJson.stringify(config)).digest("hex")
}

function safeError(error: unknown) {
  return error instanceof McpAuthJournalSchema.Error ? error : new McpAuthJournalSchema.Error("unavailable")
}
function safePromise<A>(body: () => Promise<A>) {
  return Effect.tryPromise({ try: body, catch: safeError })
}

export const defaultLayer = layer.pipe(
  Layer.provide(McpSecretMigration.defaultLayer),
  Layer.provide(AccountRepo.defaultLayer),
  Layer.provide(Account.defaultLayer),
  Layer.provide(LocationIdentity.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(SecretStore.defaultLayer),
  Layer.provide(McpAuth.defaultLayer),
)
export * as McpAuthScope from "./auth-scope"
