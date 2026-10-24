import { dynamicTool, type Tool, type ToolExecutionOptions, jsonSchema, type JSONSchema7 } from "ai"
import path from "path"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import type { Transport } from "@modelcontextprotocol/client"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { ConfigFileWrite } from "@/config/file-write"
import { serviceUse } from "@deepagent-code/core/effect/service-use"
import { Client } from "@modelcontextprotocol/client"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { SSEClientTransport } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { UnauthorizedError } from "@modelcontextprotocol/client"
import { ListToolsResultSchema, ToolSchema } from "@modelcontextprotocol/core"
import { Config } from "@/config/config"
import { ConfigMCPV1 } from "@deepagent-code/core/v1/config/mcp"
import * as Log from "@deepagent-code/core/util/log"
import { NamedError } from "@deepagent-code/core/util/error"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import { withTimeout } from "@/util/timeout"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { McpOAuthState } from "./oauth-state"
import { McpOAuthProvider, currentEntry } from "./oauth-provider"
import { McpAuth } from "./auth"
import { McpAuthScope } from "./auth-scope"
import { McpAuthJournalSchema } from "./auth-journal-schema"
import { McpLocalOperator } from "./local-operator"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ToolProvenance } from "@/tool/provenance"
import { McpCatalog } from "./catalog"
import { SecretStore } from "./secret-store"
import { McpSecretMigration } from "./secret-migration"
import { SecretRefScope } from "./secret-ref-scope"
import { McpAppResource } from "./app-resource"
import { McpAppInvocationHost } from "./app-invocation"
import { McpAppInvocationSchema } from "@deepagent-code/core/session/mcp-app-invocation.schema"
import type { McpAppInvocation } from "@deepagent-code/core/session/mcp-app-invocation"
import { EventV2 } from "@deepagent-code/core/event"
import { TuiEvent } from "@/server/tui-event"
import open from "open"
import { Cause, Effect, Exit, Layer, Option, Context, Schema, ScopedCache, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { applyEdits, modify, parse } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"

const log = Log.create({ service: "mcp" })
const DEFAULT_TIMEOUT = 30_000
type MCPToolDef = typeof ToolSchema._output
const dispatch = new AsyncLocalStorage<{ sent: boolean; current: () => boolean; beforeSend?: () => Promise<void> }>()

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

// Replace one server entry in a jsonc config file in place, keeping comments and sibling keys
// intact. Returns false when the file is absent or no longer declares that server (raced removal
// or a shadowed origin) so the caller can surface that the plaintext may still live there.
// Filesystem (node:fs) rather than Bun.file: this module is also bundled into the desktop's
// Node sidecar, whose build fails on any Bun-only runtime API.
export async function rewriteMcpEntry(
  origin: string,
  server: string,
  entry: ConfigMCPV1.Info,
  expected?: ConfigFileWrite.Observation,
): Promise<boolean> {
  return ConfigFileWrite.run(
    ConfigFileWrite.edit(
      origin,
      (file) => {
        const text = file.text
        if (text === undefined) return { value: false }
        const parsed = parse(text) as { mcp?: Record<string, unknown> } | undefined
        if (!parsed || typeof parsed !== "object" || !parsed.mcp || !(server in parsed.mcp)) return { value: false }
        const edits = modify(text, ["mcp", server], structuredClone(entry), {
          formattingOptions: { tabSize: 2, insertSpaces: true },
        })
        return { text: applyEdits(text, edits), value: true }
      },
      expected,
    ),
  )
}

// Current MCP observations record the exact contributing file. Retain directory
// candidates for callers holding legacy global origins, in the original load order.
export function mcpConfigCandidates(origin: string): string[] {
  if (/\.(jsonc?)$/.test(origin)) return [origin]
  return ["config.json", "deepagent-code.json", "deepagent-code.jsonc", "config.jsonc"].map((name) =>
    path.join(origin, name),
  )
}

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = EventV2.define({
  type: "mcp.tools.changed",
  schema: {
    server: Schema.String,
  },
})

export const BrowserOpenFailed = EventV2.define({
  type: "mcp.browser.open.failed",
  schema: {
    mcpName: Schema.String,
    url: Schema.String,
  },
})

export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

export class OAuthFlowError extends Schema.TaggedErrorClass<OAuthFlowError>()("MCP.OAuthFlowError", {
  message: Schema.String,
}) {}

export class RemovalCloseError extends Schema.TaggedErrorClass<RemovalCloseError>()("MCP.RemovalCloseError", {}) {}
const REMOVAL_UNKNOWN = "MCP removal close is unconfirmed; close the original owner before reconnecting"

type MCPClient = Client

const StatusConnected = Schema.Struct({
  status: Schema.Literal("connected"),
  protocolEra: Schema.optional(Schema.Literals(["legacy", "modern"])),
  protocolVersion: Schema.optional(Schema.String),
}).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusDisconnected = Schema.Struct({
  status: Schema.Literal("disconnected"),
  authStatus: Schema.Literals(["authenticated", "expired", "not_authenticated", "legacy_unverified", "unknown"]),
  reason: Schema.Literals(["explicit_connect_required", "scope_changed", "unknown_outcome"]),
}).annotate({ identifier: "MCPStatusDisconnected" })
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusDisconnected,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

function connectedStatus(client: MCPClient): Status {
  return {
    status: "connected",
    ...(client.getProtocolEra?.() ? { protocolEra: client.getProtocolEra() } : {}),
    ...(client.getNegotiatedProtocolVersion?.() ? { protocolVersion: client.getNegotiatedProtocolVersion() } : {}),
  }
}

type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
interface OAuthFlow {
  scope: McpAuthScope.Flow
  version: number
  generation: number
  fingerprint: string
  oauthState: string
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
  valid: boolean
  phase: "starting" | "pending" | "finishing" | "connected"
  release: Effect.Effect<void>
  transport?: TransportWithAuth
  provider?: McpOAuthProvider
  client?: MCPClient
  callbackResponse?: Promise<URLSearchParams>
}

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCPV1.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

function remoteURL(key: string, value: string) {
  if (Schema.is(McpOAuthState.Uri)(value)) return new URL(value)
  log.warn("invalid remote mcp url", { key })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

function listTools(key: string, client: MCPClient, timeout: number) {
  return Effect.tryPromise({
    try: () => client.listTools(undefined, { timeout, cacheMode: "bypass" }),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    Effect.map((result) => result.tools),
    Effect.catch((error) => {
      if (!isOutputSchemaValidationError(error)) return Effect.fail(error)

      log.warn("failed to validate MCP tool output schemas, retrying without output schema validation", { key, error })
      return Effect.tryPromise({
        try: () =>
          client.request({ method: "tools/list" }, TolerantListToolsResultSchema, {
            timeout,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.map((result) =>
          result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            execution: tool.execution,
          })),
        ),
      )
    }),
  )
}

// Convert MCP tool definition to AI SDK Tool type
export class ToolBindingChangedError extends Error {
  constructor() {
    super("MCP client or tool list changed before dispatch; observe and approve the current tool")
    this.name = "MCP.ToolBindingChangedError"
  }
}

export class ToolNotDispatchedError extends Error {
  constructor(cause: unknown) {
    super("MCP SDK rejected the request before transport dispatch", { cause })
    this.name = "MCP.ToolNotDispatchedError"
  }
}

function observeDispatch(transport: Transport) {
  const send = transport.send.bind(transport)
  transport.send = async (message, options) => {
    if ("method" in message && message.method === "tools/call") {
      const attempt = dispatch.getStore()
      if (attempt) {
        if (attempt.beforeSend) await attempt.beforeSend()
        if (!attempt.current()) throw new ToolBindingChangedError()
        // Once transport.send begins, rejection alone cannot prove the server did nothing.
        attempt.sent = true
      }
    }
    return send(message, options)
  }
}

/** Original SDK transport with the same physical sent/unknown boundary as provider MCP calls. */
export function callAppTool(client: MCPClient, definition: MCPToolDef, args: Record<string, unknown>, guard: {
  readonly current: () => boolean; readonly beforeSend: () => Promise<void>; readonly signal: AbortSignal
}) {
  const attempt = { sent: false, current: () => !guard.signal.aborted && guard.current(), beforeSend: guard.beforeSend }
  if (!attempt.current()) return Promise.reject(new ToolBindingChangedError())
  return dispatch.run(attempt, () => client.callTool({ name: definition.name, arguments: args }, {
    toolDefinition: definition, resetTimeoutOnProgress: false, timeout: 60000, signal: guard.signal,
  })).catch((cause) => {
    if (!attempt.sent && !(cause instanceof ToolBindingChangedError)) throw new ToolNotDispatchedError(cause)
    throw cause
  })
}

function convertMcpTool(mcpTool: MCPToolDef, client: MCPClient, current: () => boolean, timeout?: number): Tool {
  const inputSchema = mcpTool.inputSchema

  // Spread first, then override type to ensure it's always "object"
  const schema: JSONSchema7 = {
    ...(inputSchema as JSONSchema7),
    type: "object",
    properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),
    // Forward the caller's abortSignal into the MCP request so cancelling the tool call (V2
    // settle-fiber interruption, or the V1 stream's abortSignal) cancels the remote call.
    execute: async (args: unknown, options: ToolExecutionOptions) => {
      if (!current()) throw new ToolBindingChangedError()
      const attempt = { sent: false, current }
      return dispatch
        .run(attempt, () =>
          client.callTool(
            {
              name: mcpTool.name,
              arguments: (args || {}) as Record<string, unknown>,
            },
            {
              // Use the approved definition and disable the SDK's automatic header-mismatch
              // refresh/retry. A remote protocol error does not prove a side effect was absent.
              toolDefinition: mcpTool,
              resetTimeoutOnProgress: true,
              timeout,
              ...(options.abortSignal ? { signal: options.abortSignal } : {}),
            },
          ),
        )
        .catch((cause) => {
          if (!attempt.sent && !(cause instanceof ToolBindingChangedError)) throw new ToolNotDispatchedError(cause)
          throw cause
        })
    },
  })
}

function defs(key: string, client: MCPClient, timeout?: number) {
  return listTools(key, client, timeout ?? DEFAULT_TIMEOUT).pipe(
    Effect.catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return Effect.succeed(undefined)
    }),
  )
}

function fetchFromClient<T extends { name: string }>(
  clientName: string,
  client: Client,
  listFn: (c: Client) => Promise<T[]>,
  label: string,
) {
  return Effect.tryPromise({
    try: () => listFn(client),
    catch: (e: any) => {
      log.warn(`failed to get ${label}`, { clientName, error: e.message })
      return e
    },
  }).pipe(
    Effect.map((items) => {
      const out: Record<string, T & { client: string }> = {}
      const sanitizedClient = sanitize(clientName)
      for (const item of items) {
        out[sanitizedClient + ":" + sanitize(item.name)] = { ...item, client: clientName }
      }
      return out
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  client?: MCPClient
}

// --- Effect Service ---

interface State {
  config: Record<string, ConfigMCPV1.Info>
  configured: NonNullable<ConfigV1.Info["mcp"]>
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
  observed: Record<
    string,
    {
      client: MCPClient
      version: number
      source: string
      unavailable?: boolean
      prompts: Record<string, PromptInfo & { client: string }>
      resources: Record<string, ResourceInfo & { client: string }>
    }
  >
  versions: Record<string, number>
  oauth: Map<string, OAuthFlow>
  oauthGenerations: Record<string, number>
  disposed: boolean
}

function removalUnknown(state: State, name: string) {
  const status = state.status[name]
  return status?.status === "failed" && status.error === REMOVAL_UNKNOWN
}

export interface Interface {
  readonly appViewTools?: (input: typeof McpAppResource.ViewToolsInput.Type) => Effect.Effect<McpAppResource.ViewTools, McpAppInvocationSchema.Error>
  readonly appResourceCapture?: (input: { sessionID: McpAppInvocationSchema.InvokeInput["sessionID"]; viewID: string; name: string }) => Effect.Effect<McpAppInvocation.Native, McpAppInvocationSchema.Error>
  readonly appInvoke?: (input: McpAppInvocationSchema.InvokeInput) => Effect.Effect<McpAppInvocationSchema.Status, McpAppInvocationSchema.Error>
  readonly appInvocationStatus?: (input: typeof McpAppInvocationSchema.StatusInput.Type) => Effect.Effect<McpAppInvocationSchema.Status, McpAppInvocationSchema.Error>
  readonly appInvocationResult?: (input: typeof McpAppInvocationSchema.ResultInput.Type) => Effect.Effect<McpAppInvocationSchema.InvokeResult, McpAppInvocationSchema.Error>
  readonly appInvocationList?: (input: typeof McpAppInvocationSchema.ListInput.Type) => Effect.Effect<readonly McpAppInvocationSchema.Status[], McpAppInvocationSchema.Error>
  readonly appResources?: () => Effect.Effect<readonly McpAppResource.Descriptor[], McpAppResource.Error>
  readonly appResourceRead?: (input: McpAppResource.ReadInput) => Effect.Effect<McpAppResource.View, McpAppResource.Error>
  readonly appResourceCheck?: (input: McpAppResource.ViewInput) => Effect.Effect<McpAppResource.Descriptor, McpAppResource.Error>
  readonly appResourceClose?: (input: McpAppResource.ViewInput) => Effect.Effect<void>
  readonly secretMigration?: McpSecretMigration.Interface
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly tools: () => Effect.Effect<Record<string, Tool>>
  readonly reconcileConfig?: () => Effect.Effect<void>
  readonly watchConfig?: () => Effect.Effect<() => void>
  readonly observedMetadata?: () => Effect.Effect<{
    prompts: Record<string, PromptInfo & { client: string }>
    resources: Record<string, ResourceInfo & { client: string }>
  }>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: () => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly add: (name: string, mcp: ConfigMCPV1.Info) => Effect.Effect<{ status: Record<string, Status> | Status }, OAuthFlowError>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError | OAuthFlowError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnectForRemoval?: (name: string) => Effect.Effect<void, NotFoundError | RemovalCloseError>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, NotFoundError | OAuthFlowError>
  readonly authenticate: (mcpName: string) => Effect.Effect<Status, NotFoundError | OAuthFlowError>
  readonly finishAuth: (
    mcpName: string,
    authorizationCode: string,
    oauthState: string,
    iss?: string,
  ) => Effect.Effect<Status, NotFoundError | OAuthFlowError>
  readonly cancelLocalAuth?: (mcpName: string, oauthState: string) => Effect.Effect<void>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void, OAuthFlowError>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
  // M1 (S1-v3.4): preset catalog. `catalog()` lists vetted entries (metadata only — nothing is
  // connected). `enableCatalogEntry()` instantiates an entry + the user's filled params/credential
  // references into a normal cfg.mcp entry and connects it, exactly as a hand-written server would.
  readonly catalog: () => Effect.Effect<readonly McpCatalog.McpCatalogEntry[]>
  readonly enableCatalogEntry: (
    id: string,
    filled: McpCatalog.FilledEntry,
  ) => Effect.Effect<
    { status: Record<string, Status> | Status; name: string; config: ConfigMCPV1.Info },
    NotFoundError | McpCatalog.CatalogInstantiateError | OAuthFlowError
  >
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/MCP") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const authScope = yield* Effect.serviceOption(McpAuthScope.Service)
    const events = yield* EventV2Bridge.Service
    // M-CRED (S1-v3.5): connect-time secret resolver. `${VAR}` env refs and `secret://`
    // keychain handles in env/headers are resolved HERE, just before the transport is
    // built — the real value never returns to `cfg.mcp`, logs, or snapshots.
    const secrets = yield* SecretStore.Service
    const secretMigration = yield* Effect.serviceOption(McpSecretMigration.Service)
    const resolveSecret = (name: string, field: SecretRefScope.Field, key: string, value: string) =>
      Option.isSome(secretMigration)
        ? secretMigration.value.resolveValue(name, field, key, value).pipe(Effect.orDie)
        : SecretStore.resolveValue(value, secrets)
    const resolveSecrets = (name: string, field: "environment" | "headers", record?: Record<string, string>) =>
      Option.isSome(secretMigration)
        ? secretMigration.value.resolveRecord(name, field, record).pipe(Effect.orDie)
        : SecretStore.resolveRecord(record, secrets)
    const localCurrent = McpLocalOperator.current.pipe(Effect.orDie)
    const localTransports = new WeakMap<Transport, { current: () => Promise<void>; handedOff: boolean }>()

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = (transport: Transport, timeout: number, protocol?: ConfigMCPV1.Protocol) =>
      localCurrent.pipe(
        Effect.andThen(
          Effect.acquireUseRelease(
            Effect.succeed(transport),
            (t) =>
              Effect.tryPromise({
                try: () => {
                  observeDispatch(t)
                  const client = new Client(
                    { name: "deepagent-code", version: InstallationVersion },
                    {
                      capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [McpAppResource.MIME_TYPE] } } },
                      versionNegotiation: {
                        mode: protocol === "2026-07-28" ? { pin: protocol } : (protocol ?? "legacy"),
                        probe: { timeoutMs: timeout, maxRetries: 0 },
                      },
                    },
                  )
                  return withTimeout(client.connect(t), timeout).then(() => client)
                },
                catch: (e) => (e instanceof Error ? e : new Error(String(e))),
              }),
            (t, exit) => (Exit.isFailure(exit) ? Effect.tryPromise(() => t.close()).pipe(Effect.ignore) : Effect.void),
          ),
        ),
      )

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      s: State,
      key: string,
      mcp: ConfigMCPV1.Info & { type: "remote" },
    ) {
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      const configurationError = McpOAuthState.configurationError(oauthConfig)
      if (configurationError)
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: configurationError },
        }
      const url = remoteURL(key, mcp.url)
      if (!url) {
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: `Invalid MCP URL for "${key}"` },
        }
      }
      const acquired = oauthDisabled
        ? undefined
        : yield* beginOAuth(s, key, mcp).pipe(
            Effect.match({ onFailure: (error) => ({ error }), onSuccess: (flow) => ({ flow }) }),
          )
      if (acquired && "error" in acquired)
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: acquired.error.message },
        }
      const flow = acquired && "flow" in acquired ? acquired.flow : undefined
      return yield* Effect.gen(function* () {
        let authProvider: McpOAuthProvider | undefined

        if (flow) {
          authProvider = new McpOAuthProvider(
            key,
            mcp.url,
            {
              clientId: oauthConfig?.clientId,
              clientSecret: oauthConfig?.clientSecret === undefined ? undefined : yield* resolveSecret(key, "oauth", "clientSecret", oauthConfig.clientSecret),
              expectedIssuer: oauthConfig?.expectedIssuer,
              scope: oauthConfig?.scope,
              redirectUri: flow.scope.redirectUri,
            },
            {
              onRedirect: async () => {},
              currentEntry: yield* oauthEntry(s, key, flow, mcp.url),
              currentLocal: () => oauthLocalCurrent(s, key, flow),
              authorizationGeneration: flow.oauthState,
              interactive: false,
            },
            flow.scope.auth,
          )
          flow.provider = authProvider
        }

        // M-CRED (S1-v3.5): resolve `${VAR}` / `secret://` references in headers to real values
        // for the live request only — the persisted config keeps the reference. Missing env vars
        // warn (by name) but don't block; unresolvable handles drop the header.
        const headersStarted = performance.now()
        const endpointHash = createHash("sha256").update(url.href).digest("hex")
        log.debug("MCP remote phase", {
          stage: "headers.begin", endpointHash, headersProvided: mcp.headers !== undefined,
        })
        const resolvedHeaders = mcp.headers ? yield* resolveSecrets(key, "headers", mcp.headers) : undefined
        const headersElapsedMs = Math.round(performance.now() - headersStarted)
        if (headersElapsedMs >= 1000)
          log.warn("MCP remote phase", {
            stage: "headers.end", endpointHash, headersProvided: resolvedHeaders !== undefined,
            elapsedMs: headersElapsedMs,
          })
        log.debug("MCP remote phase", {
          stage: "headers.end", endpointHash, headersProvided: resolvedHeaders !== undefined,
          elapsedMs: headersElapsedMs,
        })
        const requestInit =
          resolvedHeaders && Object.keys(resolvedHeaders).length > 0 ? { headers: resolvedHeaders } : undefined

        const local = yield* McpLocalOperator.capture.pipe(Effect.orDie)
        const owned = local ? { current: local.check, handedOff: false } : undefined
        const guardedFetch = owned
          ? async (input: string | URL | Request, init?: RequestInit) => {
              if (!owned.handedOff) await owned.current()
              return fetch(input, init)
            }
          : undefined
        const transports: Array<{ name: string; transport: TransportWithAuth }> = [
          {
            name: "StreamableHTTP",
            transport: new StreamableHTTPClientTransport(url, {
              authProvider,
              ...(flow ? { fetch: yield* oauthFetch(s, key, flow) } : guardedFetch ? { fetch: guardedFetch } : {}),
              requestInit,
            }),
          },
          ...(!mcp.protocol || mcp.protocol === "legacy"
            ? [
                {
                  name: "SSE",
                  transport: new SSEClientTransport(url, {
                    authProvider,
                    ...(flow
                      ? { fetch: yield* oauthFetch(s, key, flow) }
                      : guardedFetch
                        ? { fetch: guardedFetch }
                        : {}),
                    requestInit,
                  }),
                },
              ]
            : []),
        ]

        const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
        let lastStatus: Status | undefined
        let credentialPolicyError = false

        for (const { name, transport } of transports) {
          if (owned) localTransports.set(transport, owned)
          yield* localCurrent
          if (flow) flow.transport = transport
          const connectStarted = performance.now()
          const result = yield* connectTransport(transport, connectTimeout, mcp.protocol).pipe(
            Effect.map((client) => ({ client, transportName: name })),
            Effect.catch((error) => {
              // connectTransport has already closed this failed transport.
              if (flow) flow.transport = undefined
              const lastError = error instanceof Error ? error : new Error(String(error))
              log.warn("MCP remote phase", {
                stage: "connect.failed", endpointHash, transport: name,
                elapsedMs: Math.round(performance.now() - connectStarted),
              })
              if (lastError instanceof McpOAuthState.IssuerError) {
                credentialPolicyError = true
                lastStatus = { status: "failed", error: lastError.message }
                return Effect.succeed(undefined)
              }
              const isAuthError =
                error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

              if (isAuthError) {
                log.info("mcp server requires authentication", { key, transport: name })

                if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                  lastStatus = {
                    status: "needs_client_registration" as const,
                    error: "Server does not support dynamic client registration. Please provide clientId in config.",
                  }
                  return events
                    .publish(TuiEvent.ToastShow, {
                      title: "MCP Authentication Required",
                      message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                      variant: "warning",
                      duration: 8000,
                    })
                    .pipe(Effect.ignore, Effect.as(undefined))
                } else {
                  lastStatus = { status: "needs_auth" as const }
                  return events
                    .publish(TuiEvent.ToastShow, {
                      title: "MCP Authentication Required",
                      message: `Server "${key}" requires authentication. Run: deepagent-code mcp auth ${key}`,
                      variant: "warning",
                      duration: 8000,
                    })
                    .pipe(Effect.ignore, Effect.as(undefined))
                }
              }

              log.debug("transport connection failed", {
                key,
                transport: name,
                url: mcp.url,
                error: lastError.message,
              })
              lastStatus = { status: "failed" as const, error: lastError.message }
              return Effect.succeed(undefined)
            }),
          )
          if (result) {
            if (flow) {
              flow.phase = "connected"
              clearTimeout(flow.timer)
              flow.client = result.client
              yield* Effect.promise(flow.scope.connected)
            }
            log.info("connected", { key, transport: result.transportName })
            return { client: result.client as MCPClient | undefined, status: connectedStatus(result.client) }
          }
          // If this was an auth error, stop trying other transports
          if (
            credentialPolicyError ||
            lastStatus?.status === "needs_auth" ||
            lastStatus?.status === "needs_client_registration"
          )
            break
        }

        if (flow) yield* closeOAuth(s, key, flow)
        return {
          client: undefined as MCPClient | undefined,
          status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
        }
      }).pipe(Effect.onError(() => (flow ? closeOAuth(s, key, flow) : Effect.void)))
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      key: string,
      mcp: ConfigMCPV1.Info & { type: "local" },
    ) {
      const [cmd, ...args] = mcp.command
      const cwd = yield* InstanceState.directory
      // M-CRED (S1-v3.5): resolve `${VAR}` / `secret://` references in env to real values for the
      // spawned process only. The persisted config keeps the reference; the real value never
      // returns to cfg.mcp/logs. Missing env var → warn (by name), don't block.
      const resolvedEnv = yield* resolveSecrets(key, "environment", mcp.environment)
      yield* localCurrent
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: {
          ...process.env,
          ...(cmd === "deepagent-code" ? { BUN_BE_BUN: "1" } : {}),
          ...resolvedEnv,
        },
      })
      transport.stderr?.on("data", (chunk: Buffer) => {
        log.info(`mcp stderr: ${chunk.toString()}`, { key })
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      return yield* connectTransport(transport, connectTimeout, mcp.protocol).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status } => ({
          client,
          status: connectedStatus(client),
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status }> => {
          const msg = error instanceof Error ? error.message : String(error)
          log.error("local mcp startup failed", { key, command: mcp.command, cwd, error: msg })
          return Effect.succeed({ client: undefined, status: { status: "failed", error: msg } })
        }),
      )
    })

    const create = Effect.fn("MCP.create")(
      function* (s: State, key: string, mcp: ConfigMCPV1.Info) {
        yield* McpLocalOperator.requireTarget(key).pipe(Effect.orDie)
        if (mcp.enabled === false) {
          log.info("mcp server disabled", { key })
          return DISABLED_RESULT
        }

        log.info("found", { key, type: mcp.type })

        const { client: mcpClient, status } =
          mcp.type === "remote"
            ? yield* connectRemote(s, key, mcp as ConfigMCPV1.Info & { type: "remote" })
            : yield* connectLocal(key, mcp as ConfigMCPV1.Info & { type: "local" })

        if (!mcpClient) {
          return { status } satisfies CreateResult
        }

        const listed = mcpClient.getServerCapabilities()?.tools ? yield* defs(key, mcpClient, mcp.timeout) : []
        if (!listed) {
          yield* Effect.tryPromise(() => mcpClient.close()).pipe(Effect.ignore)
          return { status: { status: "failed", error: "Failed to get tools" } } satisfies CreateResult
        }

        log.info("create() successfully created client", { key, toolCount: listed.length })
        return { mcpClient, status, defs: listed } satisfies CreateResult
      },
      Effect.catchCause((cause): Effect.Effect<CreateResult> => {
        const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined
        return reason && Cause.isDieReason(reason) && (reason.defect instanceof SecretStore.FileError || reason.defect instanceof SecretRefScope.Error || reason.defect instanceof McpSecretMigration.Error)
          ? Effect.succeed({ status: { status: "failed", error: reason.defect.message } })
          : Effect.failCause(cause)
      }),
    )
    const cfgSvc = yield* Config.Service
    const appResourcesByState = new WeakMap<State, ReturnType<typeof McpAppResource.make>>()

    // Reading or connecting never rewrites old plaintext secret configuration.
    // A scoped, recoverable migration is a separate explicit operation.
    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        while (queue.length > 0) {
          const current = queue.shift()!
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )

    function watch(s: State, name: string, client: MCPClient, bridge: EffectBridge.Shape, timeout?: number) {
      let refreshRevision = 0
      const previousClose = client.onclose
      client.onclose = () => {
        previousClose?.()
        if (s.clients[name] !== client || removalUnknown(s, name)) return
        delete s.clients[name]
        delete s.defs[name]
        s.status[name] = { status: "failed", error: "MCP transport closed" }
        void bridge.promise(events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      }
      if (!client.getServerCapabilities()?.tools) return Effect.void
      client.setNotificationHandler("notifications/tools/list_changed", async () => {
        log.info("tools list changed notification received", { server: name })
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return
        const revision = ++refreshRevision
        // Invalidate old closures before the async list refresh, including refresh failure.
        delete s.defs[name]
        await bridge.promise(events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
        const listed = await bridge.promise(defs(name, client, timeout))
        if (!listed || revision !== refreshRevision) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        await bridge.promise(events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
      if (client.getProtocolEra?.() !== "modern" || !client.getServerCapabilities()?.tools?.listChanged)
        return Effect.void
      return Effect.tryPromise(() =>
        client.listen({ toolsListChanged: true }, { timeout: timeout ?? DEFAULT_TIMEOUT }),
      ).pipe(
        Effect.tap((subscription) =>
          Effect.sync(() => {
            void subscription.closed.then(() => {
              if (s.clients[name] !== client) return
              delete s.defs[name]
              void bridge.promise(events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
            })
          }),
        ),
        Effect.catch(() =>
          Effect.gen(function* () {
            if (s.clients[name] !== client) return
            yield* closeClient(s, name)
            s.status[name] = { status: "failed", error: "MCP tool-list subscription could not be established" }
            yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
          }),
        ),
        Effect.asVoid,
      )
    }

    const disconnected = Effect.fnUntraced(function* (
      name: string,
      config: ConfigMCPV1.Info,
      reason: "explicit_connect_required" | "scope_changed" = "explicit_connect_required",
    ) {
      const value =
        config.type === "remote" && config.oauth !== false && Option.isSome(authScope)
          ? yield* authScope.value.metadata(name, config).pipe(Effect.result)
          : undefined
      if (value?._tag === "Failure")
        return { status: "failed", error: value.failure instanceof McpAuthJournalSchema.Error &&
          value.failure.reason === "legacy_unverified" ? value.failure.message : "MCP authentication storage or scope is unavailable" } satisfies Status
      const metadata = value?.success
      return {
        status: "disconnected",
        authStatus: metadata?.unknown
          ? "unknown"
          : metadata?.tokens
            ? metadata.expired
              ? "expired"
              : "authenticated"
            : metadata?.legacy
              ? "legacy_unverified"
              : "not_authenticated",
        reason: metadata?.unknown ? "unknown_outcome" : reason,
      } satisfies Status
    })

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* (instance) {
        // ScopedCache owns a Root context, so this deny-only observation must be
        // captured before asynchronous initialization can outlive its caller.
        const privateInitialization = McpLocalOperator.startupBlocked(instance.directory)
        const cfg = cfgSvc.mcpSnapshot ? (yield* cfgSvc.mcpSnapshot()).config : yield* cfgSvc.get()
        const bridge = yield* EffectBridge.make()
        // Registry initialization can be reached by a GET. It must not move a
        // secret or begin OAuth discovery, registration, exchange or refresh.
        const config = cfg.mcp ?? {}
        const s: State = {
          config: {},
          configured: { ...config },
          status: {},
          clients: {},
          defs: {},
          observed: {},
          versions: {},
          oauth: new Map(),
          oauthGenerations: {},
          disposed: false,
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            s.disposed = true
            appResourcesByState.get(s)?.dispose()
            yield* Effect.forEach([...s.oauth], ([name, flow]) => closeOAuth(s, name, flow), { concurrency: 16 })
          }),
        )
        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (!isMcpConfigured(mcp)) {
                log.error("Ignoring MCP config entry without type", { key })
                return
              }

              if (mcp.enabled === false) {
                s.status[key] = { status: "disabled" }
                return
              }

              if (privateInitialization || (mcp.type === "remote" && mcp.oauth !== false)) {
                s.status[key] = yield* disconnected(key, mcp)
                return
              }

              const result = yield* create(s, key, mcp).pipe(Effect.catch(() => Effect.void))
              if (!result) return

              s.status[key] = result.status
              if (result.mcpClient) {
                s.clients[key] = result.mcpClient
                s.defs[key] = result.defs!
                yield* watch(s, key, result.mcpClient, bridge, mcp.timeout)
              }
            }),
          { concurrency: 16 },
        )

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            s.disposed = true
            yield* Effect.forEach([...s.oauth], ([name, flow]) => closeOAuth(s, name, flow), { concurrency: 16 })
            yield* Effect.forEach(
              Object.values(s.clients),
              (client) =>
                Effect.gen(function* () {
                  const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
                  if (typeof pid === "number") {
                    const pids = yield* descendants(pid)
                    for (const dpid of pids) {
                      try {
                        process.kill(dpid, "SIGTERM")
                      } catch {}
                    }
                  }
                  yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
                }),
              { concurrency: 16 },
            )
          }),
        )

        return s
      }),
    )

    function closeClient(s: State, name: string, preserve?: OAuthFlow) {
      if (removalUnknown(s, name)) return Effect.die(new RemovalCloseError())
      s.versions[name] = (s.versions[name] ?? 0) + 1
      const flow = s.oauth.get(name)
      const close = flow && flow !== preserve ? closeOAuth(s, name, flow) : Effect.void
      if (flow && flow === preserve) flow.version = s.versions[name]
      const client = s.clients[name]
      delete s.clients[name]
      delete s.defs[name]
      delete s.observed[name]
      return Effect.gen(function* () {
        yield* close
        if (client) yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
      })
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      timeout?: number,
      version?: number,
    ) {
      const bridge = yield* EffectBridge.make()
      yield* localCurrent.pipe(Effect.onError(() => Effect.promise(() => client.close())))
      if (s.disposed || (version !== undefined && s.versions[name] !== version)) {
        yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
        return s.status[name] ?? { status: "disabled" }
      }
      const close = closeClient(s, name, s.oauth.get(name))
      s.status[name] = connectedStatus(client)
      s.clients[name] = client
      s.defs[name] = listed
      yield* watch(s, name, client, bridge, timeout)
      yield* close
      // Only this explicit connection path gathers display metadata. HTTP reads
      // consume the captured projection and cannot trigger SDK OAuth refresh.
      const source = cfgSvc.mcpSnapshot ? (yield* cfgSvc.mcpSnapshot()).source : undefined
      const generation = s.versions[name]
      if (source !== undefined) {
        const capabilities = client.getServerCapabilities()
        const prompts = capabilities?.prompts
          ? yield* fetchFromClient(
              name,
              client,
              (value) =>
                value
                  .listPrompts(undefined, { timeout: Math.min(timeout ?? 5000, 5000) })
                  .then((result) => result.prompts),
              "prompts",
            )
          : {}
        const resources = capabilities?.resources
          ? yield* fetchFromClient(
              name,
              client,
              (value) =>
                value
                  .listResources(undefined, { timeout: Math.min(timeout ?? 5000, 5000) })
                  .then((result) => result.resources),
              "resources",
            )
          : {}
        const observed = { prompts: prompts ?? {}, resources: resources ?? {} }
        const unavailable =
          prompts === undefined ||
          resources === undefined ||
          Object.keys(observed.prompts).length + Object.keys(observed.resources).length > 1000 ||
          Buffer.byteLength(JSON.stringify(observed)) > 262144
        if (
          !s.disposed &&
          s.clients[name] === client &&
          s.versions[name] === generation &&
          (yield* cfgSvc.mcpSnapshot!()).source === source
        )
          s.observed[name] = {
            ...(unavailable ? { prompts: {}, resources: {} } : observed),
            unavailable,
            client,
            version: generation,
            source,
          }
      }
      yield* localCurrent.pipe(
        Effect.onError(() => {
          if (s.clients[name] !== client) return Effect.void
          return closeClient(s, name)
        }),
      )
      if (s.clients[name] !== client) return { status: "failed", error: "MCP connection was replaced" } as Status
      const flow = s.oauth.get(name)
      if (flow) yield* Effect.promise(flow.scope.handoffLocal)
      const local = client.transport ? localTransports.get(client.transport) : undefined
      if (local) local.handedOff = true
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = Option.getOrUndefined(yield* ScopedCache.getSuccess(state.cache, yield* InstanceState.context))
      const snapshot = cfgSvc.mcpSnapshot ? yield* cfgSvc.mcpSnapshot() : undefined
      const cfg = snapshot?.config ?? (yield* cfgSvc.get())
      const result: Record<string, Status> = {}
      for (const [key, mcp] of Object.entries({ ...cfg.mcp, ...s?.config })) {
        if (!isMcpConfigured(mcp)) continue
        if (mcp.enabled === false) {
          result[key] = { status: "disabled" }
          continue
        }
        const flow = s?.oauth.get(key)
        if (
          s?.clients[key] &&
          snapshot &&
          (s.observed[key]
            ? s.observed[key].source !== snapshot.source
            : JSON.stringify(s.configured[key]) !== JSON.stringify(snapshot.config.mcp?.[key]))
        ) {
          result[key] = yield* disconnected(key, mcp, "scope_changed")
          continue
        }
        if (flow && !(yield* oauthCurrent(s!, key, flow))) {
          result[key] = yield* disconnected(key, mcp, "scope_changed")
          continue
        }
        const observed = yield* disconnected(key, mcp)
        result[key] =
          observed.status === "disconnected" && observed.authStatus === "unknown"
            ? observed
            : s?.status[key]?.status === "connected"
              ? s.status[key]
              : s?.status[key] && s.status[key].status !== "disconnected"
                ? s.status[key]
                : s?.status[key]?.status === "disconnected" && s.status[key].reason === "scope_changed"
                  ? observed.status === "disconnected"
                    ? { ...observed, reason: "scope_changed" }
                    : yield* disconnected(key, mcp, "scope_changed")
                  : observed
      }
      return result
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      if (!(yield* InstanceState.has(state))) return {}
      const s = yield* InstanceState.get(state)
      return Object.fromEntries(Object.entries(s.clients).filter(([name]) => !removalUnknown(s, name)))
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (name: string, mcp: ConfigMCPV1.Info) {
      const s = yield* InstanceState.get(state)
      // Reconfiguration revokes the old binding before a replacement's async handshake.
      const close = closeClient(s, name)
      const version = s.versions[name]
      yield* close
      const result = yield* create(s, name, mcp)
      yield* localCurrent.pipe(
        Effect.onError(() => (result.mcpClient ? Effect.promise(() => result.mcpClient!.close()) : Effect.void)),
      )
      if (s.disposed || s.versions[name] !== version) {
        if (result.mcpClient) yield* Effect.tryPromise(() => result.mcpClient!.close()).pipe(Effect.ignore)
        return s.status[name] ?? { status: "disabled" }
      }

      s.status[name] = result.status
      if (!result.mcpClient) {
        yield* closeClient(s, name)
        delete s.clients[name]
        yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
        return result.status
      }

      const status = yield* storeClient(s, name, result.mcpClient, result.defs!, mcp.timeout, version)
      yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
      return status
    })

    const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCPV1.Info) {
      const s = yield* InstanceState.get(state)
      if (Option.isSome(authScope)) yield* authScope.value.configure(name, mcp).pipe(
        Effect.mapError((error) => new OAuthFlowError({ message: error.message })),
      )
      s.config[name] = mcp
      yield* createAndStore(name, mcp)
      return { status: s.status }
    })

    const reconcileConfig = Effect.fn("MCP.reconcileConfig")(function* () {
      const s = yield* InstanceState.get(state)
      const configured = (cfgSvc.mcpSnapshot ? (yield* cfgSvc.mcpSnapshot()).config : yield* cfgSvc.get()).mcp ?? {}
      for (const name of new Set([...Object.keys(s.configured), ...Object.keys(configured)])) {
        const previous = s.configured[name]
        const next = configured[name]
        if (JSON.stringify(previous) === JSON.stringify(next)) continue
        const flow = s.oauth.get(name)
        if (flow) yield* closeOAuth(s, name, flow, false)
        yield* closeClient(s, name)
        if (Option.isSome(authScope)) yield* authScope.value.retire(name)
        delete s.config[name]
        if (!next || !isMcpConfigured(next) || next.enabled === false) {
          yield* closeClient(s, name)
          delete s.clients[name]
          delete s.defs[name]
          if (next) s.status[name] = { status: "disabled" }
          else delete s.status[name]
          yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
          continue
        }
        s.status[name] = yield* disconnected(name, next, "scope_changed")
      }
      s.configured = { ...configured }
    })

    const watchConfig = Effect.fn("MCP.watchConfig")(function* () {
      return cfgSvc.watch ? yield* cfgSvc.watch(() => reconcileConfig(), { mcpOnly: true }) : () => {}
    })

    // M1 (S1-v3.4): the preset catalog is static metadata — listing it connects nothing.
    const catalog = Effect.fn("MCP.catalog")(function* () {
      return McpCatalog.list()
    })

    // M1 (S1-v3.4): enabling a catalog entry instantiates it into a cfg.mcp entry (with the user's
    // filled params + secure-storage credential references) and connects it via the same `add` path
    // a hand-written server uses. Provenance is correct (M2) because the connected server's tools go
    // through `tools()`, which stamps {source:"mcp", mcpServer}. Unknown id → NotFoundError; missing
    // required param/credential or unresolved placeholder → CatalogInstantiateError (fail-closed).
    const enableCatalogEntry = Effect.fn("MCP.enableCatalogEntry")(function* (
      id: string,
      filled: McpCatalog.FilledEntry,
    ) {
      const entry = McpCatalog.find(id)
      if (!entry) return yield* Effect.fail(new NotFoundError({ name: id }))
      const instantiated = yield* Effect.try({
        try: () => McpCatalog.instantiate(entry, filled),
        catch: (error) =>
          error instanceof McpCatalog.CatalogInstantiateError
            ? error
            : new McpCatalog.CatalogInstantiateError(String(error)),
      })
      const result = yield* add(instantiated.name, instantiated.config)
      // Return the instantiated config so the caller (frontend sync) can PERSIST it to cfg.mcp the
      // same way a manual add does — `add` only connects + stores in-memory, like the manual backend
      // path; durable persistence lives in the config layer above.
      return { ...result, name: instantiated.name, config: instantiated.config }
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      yield* localCurrent
      const mcp = yield* requireMcpConfig(name)
      if (mcp.type === "remote" && mcp.oauth !== false && Option.isSome(authScope)) {
        const metadata = yield* authScope.value
          .metadata(name, mcp)
          .pipe(Effect.mapError((error) => new OAuthFlowError({ message: error.message })))
        if (metadata.unknown)
          return yield* new OAuthFlowError({
            message:
              "OAuth operation outcome is unknown; inspect it and authenticate explicitly instead of reconnecting",
          })
      }
      if (mcp.enabled === false) {
        const enabled = { ...mcp, enabled: true }
        const s = yield* InstanceState.get(state)
        if (Option.isSome(authScope)) yield* authScope.value.configure(name, enabled).pipe(
          Effect.mapError((error) => new OAuthFlowError({ message: error.message })),
        )
        s.config[name] = enabled
        yield* createAndStore(name, enabled)
        return
      }
      yield* createAndStore(name, mcp)
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      yield* localCurrent
      yield* requireMcpConfig(name)
      const s = yield* InstanceState.get(state)
      yield* localCurrent
      yield* closeClient(s, name)
      delete s.clients[name]
      s.status[name] = { status: "disabled" }
      yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
    })

    const disconnectForRemoval = Effect.fn("MCP.disconnectForRemoval")(function* (name: string) {
      yield* localCurrent
      yield* requireMcpConfig(name)
      const s = yield* InstanceState.get(state)
      yield* localCurrent
      // Revoke use first, while retaining the original strong client until close confirms.
      s.versions[name] = (s.versions[name] ?? 0) + 1
      s.status[name] = { status: "failed", error: REMOVAL_UNKNOWN }
      delete s.defs[name]
      delete s.observed[name]
      yield* Effect.gen(function* () {
        const flow = s.oauth.get(name)
        if (flow) yield* closeOAuth(s, name, flow)
        const client = s.clients[name]
        if (client) yield* Effect.tryPromise(() => client.close())
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.catchCause(() => Effect.fail(new RemovalCloseError())),
      )
      delete s.clients[name]
      delete s.config[name]
      s.status[name] = { status: "disabled" }
      yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
    })

    const tools = Effect.fn("MCP.tools")(function* () {
      const result: Record<string, Tool> = {}
      const collisions = new Set<string>()
      const s = yield* InstanceState.get(state)

      const cfg = cfgSvc.mcpSnapshot ? (yield* cfgSvc.mcpSnapshot()).config : yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const defaultTimeout = cfg.experimental?.mcp_timeout

      const connectedClients = Object.entries(s.clients).filter(
        ([clientName]) => s.status[clientName]?.status === "connected",
      )

      yield* Effect.forEach(
        connectedClients,
        ([clientName, client]) =>
          Effect.gen(function* () {
            const mcpConfig = config[clientName]
            const entry = mcpConfig && isMcpConfigured(mcpConfig) ? mcpConfig : s.config[clientName]

            const listed = s.defs[clientName]
            if (!listed) {
              log.warn("missing cached tools for connected server", { clientName })
              return
            }

            const timeout = entry?.timeout ?? defaultTimeout
            // M7 (S1-v3.4) SECURITY: derive the risk tier by STRUCTURALLY MATCHING the live config
            // against the catalog templates — NOT by reading the persisted `riskTier` flag, which is
            // attacker-writable (add endpoint forwards client config verbatim; project-local config is
            // auto-merged + not gitignored). A forged `riskTier:"read_only"` on a non-matching command
            // derives to `undefined` here → the session gate fails closed to `ask`. Only a config whose
            // command genuinely matches the vetted read-only template earns auto-allow.
            const derivedTier = entry && isMcpConfigured(entry) ? McpCatalog.deriveTier(entry) : undefined
            for (const mcpTool of listed) {
              if (mcpTool.execution?.taskSupport === "required") {
                log.warn("MCP task-required tool is unavailable without a task adapter", {
                  clientName,
                  tool: mcpTool.name,
                })
                continue
              }
              // Apps-only tools must never become model tools. Ordinary legacy tools keep
              // the default model/app visibility and follow the existing permission path.
              if (!McpAppResource.visibility(mcpTool).includes("model")) continue
              const key = sanitize(clientName) + "_" + sanitize(mcpTool.name)
              const converted = convertMcpTool(
                mcpTool,
                client,
                () =>
                  s.clients[clientName] === client &&
                  s.status[clientName]?.status === "connected" &&
                  s.defs[clientName] === listed &&
                  Object.entries(s.defs)
                    .filter(([name]) => s.clients[name] && s.status[name]?.status === "connected")
                    .flatMap(([name, tools]) =>
                      tools.filter(
                        (tool) =>
                          tool.execution?.taskSupport !== "required" &&
                          McpAppResource.visibility(tool).includes("model") &&
                          sanitize(name) + "_" + sanitize(tool.name) === key,
                      ),
                    ).length === 1,
                timeout,
              )
              // M2 (S1-v3.4): carry explicit provenance on the converted AI SDK tool
              // instead of letting downstream guess from the `_`-joined name. The tool
              // is a `convertMcpTool` AI SDK `Tool` (not a `Tool.Def`), so provenance
              // rides as an extra runtime property — the AI SDK ignores it, but
              // session/tools.ts forwards the same object reference to request.ts.
              ToolProvenance.set(converted, {
                source: "mcp",
                mcpServer: clientName,
                mcpToolName: mcpTool.name,
                configSource: cfg.mcp_origins?.[clientName] ?? "runtime",
                // M7 (S1-v3.4): tier is the catalog-DERIVED tier (see above), so the session tool gate
                // derives read_only→allow / else→ask from a source the model/config cannot forge. A
                // non-matching (hand-added or tampered) server derives undefined → gate fails closed.
                ...(derivedTier ? { riskTier: derivedTier } : {}),
              })
              if (result[key] || collisions.has(key)) {
                delete result[key]
                collisions.add(key)
                log.error("MCP tool names collide; ambiguous tools are unavailable", { key })
                continue
              }
              result[key] = converted
            }
          }),
        { concurrency: 16 },
      )
      return result
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client) => Promise<T[]>,
      label: string,
    ) {
      return Effect.forEach(
        Object.entries(s.clients).filter(([name]) => s.status[name]?.status === "connected"),
        ([clientName, client]) =>
          fetchFromClient(clientName, client, listFn, label).pipe(Effect.map((items) => Object.entries(items ?? {}))),
        { concurrency: 16 },
      ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
    }

    const observedMetadata = Effect.fn("MCP.observedMetadata")(function* () {
      const result: {
        prompts: Record<string, PromptInfo & { client: string }>
        resources: Record<string, ResourceInfo & { client: string }>
      } = { prompts: {}, resources: {} }
      if (!cfgSvc.mcpSnapshot) return result
      const s = Option.getOrUndefined(yield* ScopedCache.getSuccess(state.cache, yield* InstanceState.context))
      if (!s) return result
      const snapshot = yield* cfgSvc.mcpSnapshot()
      // Missing display observation omits that server; a readonly view never fetches it.
      for (const [name, observed] of Object.entries(s.observed)) {
        if (
          s.disposed ||
          observed.client !== s.clients[name] ||
          observed.version !== s.versions[name] ||
          observed.source !== snapshot.source ||
          s.status[name]?.status !== "connected"
        )
          continue
        const flow = s.oauth.get(name)
        if (flow && !(yield* oauthCurrent(s, name, flow))) continue
        const config = s.config[name] ?? snapshot.config.mcp?.[name]
        if (!config || !isMcpConfigured(config) || config.enabled === false) continue
        if (config.type === "remote" && config.oauth !== false && Option.isSome(authScope)) {
          const metadata = yield* authScope.value.metadata(name, config).pipe(Effect.orDie)
          if (metadata.unknown || metadata.expired) continue
        }
        if (observed.unavailable)
          return yield* Effect.die(new Error("MCP display metadata unavailable; explicitly reconnect to refresh"))
        Object.assign(result.prompts, observed.prompts)
        Object.assign(result.resources, observed.resources)
      }
      return structuredClone(result)
    })

    const prompts = Effect.fn("MCP.prompts")(function* () {
      if (!(yield* InstanceState.has(state))) return {}
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(
        s,
        (c) => (c.getServerCapabilities()?.prompts ? c.listPrompts().then((r) => r.prompts) : Promise.resolve([])),
        "prompts",
      )
    })

    const resources = Effect.fn("MCP.resources")(function* () {
      if (!(yield* InstanceState.has(state))) return {}
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(
        s,
        (c) =>
          c.getServerCapabilities()?.resources ? c.listResources().then((r) => r.resources) : Promise.resolve([]),
        "resources",
      )
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      if (!(yield* InstanceState.has(state))) return undefined
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        log.warn(`client not found for ${label}`, { clientName })
        return undefined
      }
      const snapshot = cfgSvc.mcpSnapshot ? yield* cfgSvc.mcpSnapshot() : undefined
      if (
        s.disposed ||
        s.status[clientName]?.status !== "connected" ||
        (snapshot &&
          (s.observed[clientName]
            ? s.observed[clientName].source !== snapshot.source
            : JSON.stringify(s.configured[clientName]) !== JSON.stringify(snapshot.config.mcp?.[clientName])))
      )
        return yield* Effect.die(new ToolBindingChangedError())
      const flow = s.oauth.get(clientName)
      if (flow && !(yield* oauthCurrent(s, clientName, flow))) return yield* Effect.die(new ToolBindingChangedError())
      return yield* Effect.tryPromise({
        try: () => fn(client),
        catch: (e: any) => {
          log.error(`failed to ${label}`, { clientName, ...meta, error: e?.message })
          return e
        },
      }).pipe(Effect.orElseSucceed(() => undefined))
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(clientName, (client) => client.getPrompt({ name, arguments: args }), "getPrompt", {
        promptName: name,
      })
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(clientName, (client) => client.readResource({ uri: resourceUri }), "readResource", {
        resourceUri,
      })
    })

    const getAppResource = Effect.fnUntraced(function* () {
      const s = Option.getOrUndefined(yield* ScopedCache.getSuccess(state.cache, yield* InstanceState.context))
      if (!s || s.disposed) return undefined
      const existing = appResourcesByState.get(s)
      if (existing) return existing
      const appResource = McpAppResource.make(
        Effect.gen(function* () {
          if (s.disposed || s !== Option.getOrUndefined(yield* ScopedCache.getSuccess(state.cache, yield* InstanceState.context))) return []
          const snapshot = cfgSvc.mcpSnapshot ? yield* cfgSvc.mcpSnapshot() : undefined
          const cfg = snapshot?.config ?? (yield* cfgSvc.get())
          return yield* Effect.forEach(Object.entries(s.clients), ([server, client]) => Effect.gen(function* () {
            const config = s.config[server] ?? cfg.mcp?.[server]
            const tools = s.defs[server]
            const version = s.versions[server] ?? 0
            if (!config || !isMcpConfigured(config) || config.enabled === false || !tools || s.status[server]?.status !== "connected") return []
            const observation = s.observed[server]
            if (snapshot && (observation ? observation.source !== snapshot.source : JSON.stringify(s.configured[server]) !== JSON.stringify(snapshot.config.mcp?.[server]))) return []
            const flow = s.oauth.get(server)
            if (flow && !(yield* oauthCurrent(s, server, flow))) return []
            if (config.type === "remote" && config.oauth !== false && Option.isSome(authScope)) {
              const metadata = yield* authScope.value.metadata(server, config).pipe(Effect.orDie)
              if (metadata.unknown || metadata.expired) return []
            }
            // Account/config observations can await I/O. A retired snapshot cannot be
            // resurrected by a late authorization read or become a new Apps generation.
            if (snapshot && (yield* cfgSvc.mcpSnapshot!()).source !== snapshot.source) return []
            if (s.disposed || s.clients[server] !== client || s.defs[server] !== tools || (s.versions[server] ?? 0) !== version || s.status[server]?.status !== "connected") return []
            return [{ scope: s, server, client, tools, version, source: snapshot?.source ?? JSON.stringify(config), resourceMetadata: observation ? Object.values(observation.resources) : undefined } satisfies McpAppResource.Binding]
          }), { concurrency: 16 }).pipe(Effect.map((bindings) => bindings.flat()))
        }).pipe(Effect.catchCause(() => Effect.fail(new McpAppResource.Error({ reason: "unavailable" })))),
      )
      appResourcesByState.set(s, appResource)
      return appResource
    })
    const appResources = Effect.fn("MCP.appResources")(function* () {
      const appResource = yield* getAppResource()
      return appResource ? yield* appResource.list() : []
    })
    const appResourceRead = Effect.fn("MCP.appResourceRead")(function* (input: McpAppResource.ReadInput) {
      if (input.sessionID) yield* McpAppInvocationHost.validateSession(input.sessionID).pipe(Effect.mapError(() => new McpAppResource.Error({ reason: "unavailable" })))
      const appResource = yield* getAppResource()
      if (!appResource) return yield* new McpAppResource.Error({ reason: "changed" })
      return yield* appResource.read(input)
    })
    const appResourceCheck = Effect.fn("MCP.appResourceCheck")(function* (input: McpAppResource.ViewInput) {
      const appResource = yield* getAppResource()
      if (!appResource) return yield* new McpAppResource.Error({ reason: "changed" })
      return yield* appResource.check(input)
    })
    const appResourceClose = Effect.fn("MCP.appResourceClose")(function* (input: McpAppResource.ViewInput) {
      const appResource = yield* getAppResource()
      if (appResource) yield* appResource.close(input)
    })
    const appResourceCapture = Effect.fn("MCP.appResourceCapture")(function* (input: { sessionID: McpAppInvocationSchema.InvokeInput["sessionID"]; viewID: string; name: string }) {
      const resource = yield* getAppResource()
      if (!resource) return yield* new McpAppInvocationSchema.Error({ code: "changed", message: "MCP App view changed" })
      const captured = yield* resource.capture(input).pipe(Effect.mapError((error) => new McpAppInvocationSchema.Error({ code: error.reason === "expired" ? "expired" : "changed", message: "MCP App view changed" })))
      return yield* McpAppInvocationHost.native(captured)
    })
    const appViewTools = Effect.fn("MCP.appViewTools")(function* (input: typeof McpAppResource.ViewToolsInput.Type) {
      yield* McpAppInvocationHost.validateSession(input.sessionID)
      const resource = yield* getAppResource()
      if (!resource) return yield* new McpAppInvocationSchema.Error({ code: "changed", message: "MCP App view changed" })
      return yield* resource.viewTools(input).pipe(Effect.mapError((error) => new McpAppInvocationSchema.Error({ code: error.reason === "expired" ? "expired" : "changed", message: "MCP App view changed" })))
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const s = (yield* InstanceState.has(state)) ? yield* InstanceState.get(state) : undefined
      if (s?.config[mcpName]) return s.config[mcpName]
      const cfg = cfgSvc.mcpSnapshot ? (yield* cfgSvc.mcpSnapshot()).config : yield* cfgSvc.get()
      const mcpConfig = cfg.mcp?.[mcpName]
      return mcpConfig && isMcpConfigured(mcpConfig) ? mcpConfig : undefined
    })

    const requireMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      yield* McpLocalOperator.requireTarget(mcpName).pipe(Effect.orDie)
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return yield* new NotFoundError({ name: mcpName })
      return mcpConfig
    })

    function closeOAuth(s: State, name: string, flow: OAuthFlow, persist = true) {
      // Revoke synchronously, before any close or filesystem operation can yield.
      flow.valid = false
      clearTimeout(flow.timer)
      if (s.oauth.get(name) === flow) s.oauth.delete(name)
      flow.scope.callback?.cancel()
      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => flow.transport?.close() ?? Promise.resolve()).pipe(Effect.ignore)
        if (persist) yield* flow.release
        else {
          flow.scope.close()
          yield* Effect.promise(() => flow.scope.callback?.close() ?? Promise.resolve())
        }
      })
    }

    function oauthLocalCurrent(s: State, name: string, flow: OAuthFlow) {
      return (
        flow.valid &&
        !s.disposed &&
        s.oauth.get(name) === flow &&
        (s.versions[name] ?? 0) === flow.version &&
        (flow.phase === "connected" || Date.now() < flow.expiresAt)
      )
    }

    const oauthCurrent = Effect.fnUntraced(function* (s: State, name: string, flow: OAuthFlow) {
      if (!flow.valid || s.disposed || s.oauth.get(name) !== flow || (s.versions[name] ?? 0) !== flow.version)
        return false
      const current = yield* Effect.promise(flow.scope.current)
      return (
        current &&
        flow.valid &&
        !s.disposed &&
        s.oauth.get(name) === flow &&
        (s.versions[name] ?? 0) === flow.version &&
        (flow.phase === "connected" || Date.now() < flow.expiresAt)
      )
    })

    const oauthEntry = Effect.fnUntraced(function* (s: State, name: string, flow: OAuthFlow, url: string) {
      const bridge = yield* EffectBridge.make()
      return currentEntry(
        () => bridge.promise(flow.scope.auth.getForUrl(name, url)),
        () =>
          flow.valid &&
          !s.disposed &&
          s.oauth.get(name) === flow &&
          (s.versions[name] ?? 0) === flow.version &&
          (flow.phase === "connected" || Date.now() < flow.expiresAt),
      )
    })

    const oauthFetch = (s: State, name: string, flow: OAuthFlow) => Effect.sync(() => {
      const beforeSend = () => {
        if (
          !flow.valid ||
          s.disposed ||
          s.oauth.get(name) !== flow ||
          (s.versions[name] ?? 0) !== flow.version ||
          (flow.phase !== "connected" && Date.now() >= flow.expiresAt)
        ) throw new Error("MCP OAuth flow was revoked before HTTP dispatch")
        return undefined
      }
      return async (url: string | URL, init?: RequestInit) => {
        beforeSend()
        return flow.scope.fetch(url, init, beforeSend)
      }
    })

    const beginOAuth = Effect.fnUntraced(function* (
      s: State,
      name: string,
      config: ConfigMCPV1.Info,
      explicit = false,
    ) {
      const previous = s.oauth.get(name)
      if (previous) yield* closeOAuth(s, name, previous)
      if (s.disposed || Option.isNone(authScope))
        return yield* new OAuthFlowError({ message: "Scoped MCP authentication is unavailable" })
      const scope = yield* authScope.value
        .begin(name, config, explicit, explicit)
        .pipe(Effect.mapError((error) => new OAuthFlowError({ message: error.message })))
      s.oauthGenerations[name] = (s.oauthGenerations[name] ?? 0) + 1
      const flow: OAuthFlow = {
        scope,
        generation: s.oauthGenerations[name],
        version: s.versions[name] ?? 0,
        fingerprint: JSON.stringify(config),
        oauthState: scope.state,
        expiresAt: Date.now() + 5 * 60 * 1000,
        valid: true,
        phase: "starting",
        release: Effect.void,
      }
      // The private database owns hard arbitration. This closure owns only its
      // exact process-local transport and never clears another instance's flow.
      flow.release = yield* Effect.cached(
        Effect.gen(function* () {
          yield* Effect.tryPromise(() => scope.revoke()).pipe(Effect.ignore)
        }).pipe(
          Effect.ensuring(
            Effect.promise(async () => {
              scope.close()
              await scope.callback?.close()
            }),
          ),
        ),
      )
      s.oauth.set(name, flow)
      const bridge = yield* EffectBridge.make()
      flow.timer = setTimeout(
        () => {
          if (flow.phase !== "connected")
            void bridge.promise(closeOAuth(s, name, flow)).catch(() => {
              log.warn("OAuth expiry cleanup failed", { name })
            })
        },
        5 * 60 * 1000,
      )
      flow.timer.unref?.()
      return flow
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      yield* localCurrent
      const mcpConfig = yield* requireMcpConfig(mcpName)
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
      const configurationError = McpOAuthState.configurationError(
        typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined,
      )
      if (configurationError) return yield* new OAuthFlowError({ message: configurationError })
      const url = remoteURL(mcpName, mcpConfig.url)
      if (!url) throw new Error(`Invalid MCP URL for "${mcpName}"`)
      const s = yield* InstanceState.get(state)
      const flow = yield* beginOAuth(s, mcpName, mcpConfig, true)
      return yield* Effect.gen(function* () {
        const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined
        let capturedUrl: URL | undefined
        flow.provider = new McpOAuthProvider(
          mcpName,
          mcpConfig.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret === undefined ? undefined : yield* resolveSecret(mcpName, "oauth", "clientSecret", oauthConfig.clientSecret),
            expectedIssuer: oauthConfig?.expectedIssuer,
            scope: oauthConfig?.scope,
            redirectUri: flow.scope.redirectUri,
          },
          {
            onRedirect: async (url) => {
              capturedUrl = url
            },
            currentEntry: yield* oauthEntry(s, mcpName, flow, mcpConfig.url),
            currentLocal: () => oauthLocalCurrent(s, mcpName, flow),
            authorizationGeneration: flow.oauthState,
            interactive: true,
          },
          flow.scope.auth,
        )
        // Install the exact waiter before the SDK can hand its authorization URL to a caller.
        if (flow.scope.callback?.automatic) {
          flow.callbackResponse = flow.scope.callback.waitForResponse(flow.oauthState, async (params) => {
            if (!flow.provider) throw new Error("OAuth provider is unavailable")
            await flow.provider.validateCallback(params.get("iss") ?? undefined)
          })
          void flow.callbackResponse.catch(() => {})
        }
        const resolvedHeaders = mcpConfig.headers
          ? yield* resolveSecrets(mcpName, "headers", mcpConfig.headers).pipe(
              Effect.catchCause((cause) => {
                const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined
                return reason && Cause.isDieReason(reason) && (reason.defect instanceof SecretStore.FileError || reason.defect instanceof SecretRefScope.Error || reason.defect instanceof McpSecretMigration.Error)
                  ? Effect.fail(new OAuthFlowError({ message: reason.defect.message }))
                  : Effect.failCause(cause)
              }),
            )
          : undefined
        const transport = new StreamableHTTPClientTransport(url, {
          authProvider: flow.provider,
          fetch: yield* oauthFetch(s, mcpName, flow),
          ...(resolvedHeaders ? { requestInit: { headers: resolvedHeaders } } : {}),
        })
        flow.transport = transport
        const connected = yield* Effect.tryPromise({
          try: () => {
            observeDispatch(transport)
            const client = new Client(
              { name: "deepagent-code", version: InstallationVersion },
              {
                versionNegotiation: {
                  mode:
                    mcpConfig.protocol === "2026-07-28"
                      ? { pin: mcpConfig.protocol }
                      : (mcpConfig.protocol ?? "legacy"),
                  probe: { timeoutMs: mcpConfig.timeout ?? DEFAULT_TIMEOUT, maxRetries: 0 },
                },
              },
            )
            flow.client = client
            return withTimeout(client.connect(transport), mcpConfig.timeout ?? DEFAULT_TIMEOUT).then(() => true)
          },
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            error instanceof UnauthorizedError && capturedUrl ? Effect.succeed(false) : Effect.die(error),
          ),
        )
        if (!(yield* oauthCurrent(s, mcpName, flow)))
          return yield* new OAuthFlowError({ message: "MCP OAuth configuration changed; restart authentication" })
        flow.phase = connected ? "connected" : "pending"
        // Keep successful clients owned until authenticate adopts them or the instance closes.
        if (connected) {
          clearTimeout(flow.timer)
          yield* Effect.promise(flow.scope.connected)
          yield* Effect.promise(async () => {
            await flow.scope.callback?.close()
          })
        }
        return {
          authorizationUrl: connected ? "" : capturedUrl!.toString(),
          oauthState: flow.oauthState,
          ...(connected ? { client: flow.client } : {}),
        } satisfies AuthResult
      }).pipe(Effect.onError(() => closeOAuth(s, mcpName, flow)))
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (mcpName: string) {
      yield* localCurrent
      const configured = yield* requireMcpConfig(mcpName)
      const redirect =
        configured.type === "remote" && typeof configured.oauth === "object" ? configured.oauth.redirectUri : undefined
      if (redirect) {
        const uri = McpOAuthState.callbackUri(redirect)
        if (uri.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(uri.hostname))
          return yield* new OAuthFlowError({
            message: "This OAuth callback URI requires explicit manual start and callback completion",
          })
      }
      const result = yield* startAuth(mcpName)
      const s = yield* InstanceState.get(state)
      const flow = s.oauth.get(mcpName)
      if (!flow || flow.oauthState !== result.oauthState)
        return yield* new OAuthFlowError({ message: "MCP OAuth flow was replaced; restart authentication" })
      return yield* Effect.gen(function* () {
        if (!result.authorizationUrl) {
          const client = result.client
          const mcpConfig = yield* requireMcpConfig(mcpName)
          const listed = client
            ? client.getServerCapabilities()?.tools
              ? yield* defs(mcpName, client, mcpConfig.timeout)
              : []
            : undefined
          if (!client || !listed || !(yield* oauthCurrent(s, mcpName, flow))) {
            yield* closeOAuth(s, mcpName, flow)
            return { status: "failed", error: "MCP OAuth connection is no longer current" } as Status
          }
          return yield* storeClient(s, mcpName, client, listed, mcpConfig.timeout, flow.version)
        }

        yield* McpLocalOperator.requireTarget(mcpName).pipe(Effect.orDie)
        if (!(yield* oauthCurrent(s, mcpName, flow)))
          return yield* new OAuthFlowError({ message: "MCP OAuth interaction changed before browser launch" })
        log.info("opening browser for oauth", { mcpName })
        // Exact state owns this callback; a same-name instance cannot cancel it.
        const callbackPromise = flow.callbackResponse
        if (!callbackPromise)
          return yield* new OAuthFlowError({ message: "This OAuth flow requires manual callback completion" })
        void callbackPromise.catch(() => {})
        yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
          Effect.flatMap((subprocess) =>
            Effect.callback<void, Error>((resume) => {
              const timer = setTimeout(() => resume(Effect.void), 500)
              subprocess.on("error", (err) => {
                clearTimeout(timer)
                resume(Effect.fail(err))
              })
              subprocess.on("exit", (code) => {
                if (code !== null && code !== 0) {
                  clearTimeout(timer)
                  resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
                }
              })
            }),
          ),
          Effect.catch(() =>
            events.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore),
          ),
        )
        const callback = yield* Effect.promise(() => callbackPromise)
        if (
          !(yield* oauthCurrent(s, mcpName, flow)) ||
          (yield* flow.scope.auth.getOAuthState(mcpName)) !== flow.oauthState
        )
          throw new Error("OAuth state is no longer current")
        return yield* finishAuth(mcpName, callback.get("code")!, result.oauthState, callback.get("iss") ?? undefined)
      }).pipe(Effect.onError(() => closeOAuth(s, mcpName, flow)))
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (
      mcpName: string,
      authorizationCode: string,
      oauthState: string,
      iss?: string,
    ) {
      yield* localCurrent
      yield* requireMcpConfig(mcpName)
      if (!(yield* InstanceState.has(state)))
        return yield* new OAuthFlowError({
          message: "No live OAuth callback owner; inspect status and authenticate explicitly",
        })
      const s = yield* InstanceState.get(state)
      const flow = s.oauth.get(mcpName)
      if (!flow || flow.phase !== "pending" || !flow.transport || !oauthState || oauthState !== flow.oauthState)
        return yield* new OAuthFlowError({
          message: "OAuth callback does not match the current pending flow; restart authentication",
        })
      if (
        !authorizationCode ||
        Buffer.byteLength(authorizationCode, "utf8") > 8192 ||
        /[\u0000-\u001f\u007f]/.test(authorizationCode) ||
        (iss !== undefined && (!iss || Buffer.byteLength(iss, "utf8") > 8192)) ||
        !(yield* oauthCurrent(s, mcpName, flow)) ||
        !flow.provider
      )
        return yield* new OAuthFlowError({ message: "OAuth callback does not match the current flow" })
      yield* Effect.tryPromise({
        try: () => flow.provider!.validateCallback(iss),
        catch: () =>
          new OAuthFlowError({ message: "OAuth authorization-server response does not match the current flow" }),
      })
      // Issuer rejection leaves the pending flow intact; only a validated callback consumes it.
      if (!(yield* oauthCurrent(s, mcpName, flow)) || flow.phase !== "pending")
        return yield* new OAuthFlowError({ message: "OAuth callback is no longer current" })
      const transport = flow.transport
      flow.phase = "finishing"
      return yield* Effect.gen(function* () {
        if (!(yield* oauthCurrent(s, mcpName, flow)))
          return yield* new OAuthFlowError({ message: "MCP OAuth configuration changed; restart authentication" })
        const mcpConfig = yield* requireMcpConfig(mcpName)
        const result = yield* Effect.tryPromise(() =>
          withTimeout(transport.finishAuth(authorizationCode, iss), mcpConfig.timeout ?? DEFAULT_TIMEOUT),
        ).pipe(Effect.option)
        if (Option.isNone(result) || !(yield* oauthCurrent(s, mcpName, flow))) {
          yield* closeOAuth(s, mcpName, flow)
          return { status: "failed", error: "OAuth completion failed or was revoked" } as Status
        }
        yield* closeOAuth(s, mcpName, flow)
        // Closing the old transport can yield; do not admit a connection after a replacement.
        const current = yield* getMcpConfig(mcpName)
        if (
          s.disposed ||
          (s.versions[mcpName] ?? 0) !== flow.version ||
          s.oauthGenerations[mcpName] !== flow.generation ||
          JSON.stringify(current) !== flow.fingerprint
        )
          return { status: "failed", error: "MCP OAuth configuration changed" } as Status
        return yield* createAndStore(mcpName, mcpConfig)
      }).pipe(Effect.onError(() => closeOAuth(s, mcpName, flow)))
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* localCurrent
      if (Option.isNone(authScope))
        return yield* new OAuthFlowError({ message: "Scoped MCP authentication is unavailable" })
      const config = yield* getMcpConfig(mcpName)
      if (!config) return yield* new OAuthFlowError({ message: "MCP configuration is unavailable" })
      if (config.type !== "remote" || config.oauth === false) return
      const s = (yield* InstanceState.has(state)) ? yield* InstanceState.get(state) : undefined
      if (s) yield* closeClient(s, mcpName)
      yield* authScope.value
        .remove(mcpName, config)
        .pipe(Effect.mapError((error) => new OAuthFlowError({ message: error.message })))
      if (s) s.status[mcpName] = { status: "needs_auth" }
    })

    const cancelLocalAuth = Effect.fn("MCP.cancelLocalAuth")(function* (name: string, oauthState: string) {
      if (!(yield* InstanceState.has(state))) return
      const s = yield* InstanceState.get(state)
      const flow = s.oauth.get(name)
      if (flow?.oauthState !== oauthState || flow.phase === "connected") return
      yield* closeOAuth(s, name, flow)
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const storedMetadata = Effect.fnUntraced(function* (mcpName: string) {
      const config = yield* getMcpConfig(mcpName)
      if (!config || config.type !== "remote" || Option.isNone(authScope)) return undefined
      return yield* authScope.value.metadata(mcpName, config).pipe(Effect.orDie)
    })
    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const value = yield* storedMetadata(mcpName)
      return !!value?.tokens && !value.unknown
    })
    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const value = yield* storedMetadata(mcpName)
      if (value?.unknown) return "unknown" as AuthStatus
      if (!value?.tokens) return (value?.legacy ? "legacy_unverified" : "not_authenticated") as AuthStatus
      return (value.expired ? "expired" : "authenticated") as AuthStatus
    })

    return Service.of({
      secretMigration: Option.getOrUndefined(secretMigration),
      status,
      clients,
      tools,
      reconcileConfig,
      watchConfig,
      observedMetadata,
      prompts,
      resources,
      add,
      catalog,
      enableCatalogEntry,
      connect,
      disconnect,
      disconnectForRemoval,
      getPrompt,
      readResource,
      appResources,
      appResourceRead,
      appResourceCheck,
      appResourceClose,
      appResourceCapture,
      appViewTools,
      appInvoke: McpAppInvocationHost.invoke,
      appInvocationStatus: McpAppInvocationHost.status,
      appInvocationResult: McpAppInvocationHost.result,
      appInvocationList: McpAppInvocationHost.list,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      cancelLocalAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated" | "unknown" | "legacy_unverified"

// --- Per-service runtime ---

export const defaultLayer = layer.pipe(
  Layer.provide(McpSecretMigration.defaultLayer),
  Layer.provide(McpAuth.defaultLayer),
  Layer.provide(McpAuthScope.defaultLayer),
  Layer.provide(SecretStore.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
)

export * as MCP from "."
