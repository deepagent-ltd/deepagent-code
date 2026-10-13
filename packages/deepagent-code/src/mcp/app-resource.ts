export * as McpAppResource from "./app-resource"

import { randomUUID } from "node:crypto"
import type { Client } from "@modelcontextprotocol/client"
import { Effect, Option, Schema } from "effect"
import { SessionSchema } from "@deepagent-code/core/session/schema"

export const MIME_TYPE = "text/html;profile=mcp-app"
export const LIMITS = Object.freeze({
  htmlBytes: 262144,
  metadataBytes: 16384,
  views: 64,
  lifetimeMs: 300000,
  readMs: 10000,
})
// The first profile grants no network, nested frames, devices, clipboard or host navigation.
// A trusted sandbox proxy must enforce this policy before any returned HTML can execute.
export const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'"

const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const ID = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/))
export const Descriptor = Schema.Struct({
  server: Label,
  tool: Label,
  toolName: Label,
  generation: ID,
  resourceUri: Schema.String.check(Schema.isMinLength(6), Schema.isMaxLength(8192)),
  mimeType: Schema.Literal(MIME_TYPE),
})
export type Descriptor = typeof Descriptor.Type
export const ReadInput = Schema.Struct({
  server: Label,
  tool: Label,
  generation: ID,
  resourceUri: Descriptor.fields.resourceUri,
  consent: Schema.Literal(true),
  sessionID: Schema.optional(SessionSchema.ID),
})
export type ReadInput = typeof ReadInput.Type
export const ViewInput = Schema.Struct({ viewID: ID })
export type ViewInput = typeof ViewInput.Type
export const ViewToolsInput = Schema.Struct({ ...ViewInput.fields, sessionID: SessionSchema.ID })
export const ViewTools = Schema.Struct({ ...ViewToolsInput.fields, generation: ID,
  tools: Schema.Array(Schema.Struct({ name: Label, description: Schema.optional(Schema.String), inputSchema: Schema.Record(Schema.String, Schema.Json),
    outputSchema: Schema.optional(Schema.Record(Schema.String, Schema.Json)), annotations: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    _meta: Schema.optional(Schema.Record(Schema.String, Schema.Json)), execution: Schema.optional(Schema.Record(Schema.String, Schema.Json)) })) })
export type ViewTools = typeof ViewTools.Type
export const View = Schema.Struct({
  viewID: ID,
  descriptor: Descriptor,
  html: Schema.String,
  csp: Schema.Literal(CSP),
  prefersBorder: Schema.Boolean,
  expiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  sessionID: Schema.optional(SessionSchema.ID),
})
export type View = typeof View.Type
export class Error extends Schema.TaggedErrorClass<Error>()("McpAppResourceError", {
  reason: Schema.Literals([
    "invalid",
    "consent_required",
    "changed",
    "expired",
    "capacity",
    "unavailable",
    "unsupported",
  ]),
}) {}

type ToolDefinition = Awaited<ReturnType<Client["listTools"]>>["tools"][number]
export type Binding = {
  readonly scope: object
  readonly client: Client
  readonly server: string
  readonly tools: readonly ToolDefinition[]
  readonly version: number
  readonly source: string
  readonly resourceMetadata?: ReadonlyArray<{ readonly uri: string; readonly _meta?: Record<string, unknown> }>
}
type Snapshot = Binding & { readonly generation: string }
type OpenView = {
  readonly snapshot: Snapshot
  readonly descriptor: Descriptor
  readonly expiresAt: number
  readonly deadline: number
  readonly abort: AbortController
  ready: boolean
  readonly sessionID?: SessionSchema.ID
}

function ui(tool: ToolDefinition) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(tool._meta?.ui))
}

export function visibility(tool: ToolDefinition): readonly ("model" | "app")[] {
  const values = ui(tool)?.visibility
  if (values === undefined) return ["model", "app"]
  if (!Array.isArray(values) || !values.length || values.some((value) => value !== "model" && value !== "app"))
    return []
  return values
}

function resourceUri(tool: ToolDefinition) {
  const uri = ui(tool)?.resourceUri ?? tool._meta?.["ui/resourceUri"]
  if (
    typeof uri !== "string" ||
    Buffer.byteLength(uri) > 8192 ||
    !uri.startsWith("ui://") ||
    !URL.canParse(uri) ||
    /[\u0000-\u0020\u007f]/.test(uri)
  )
    return undefined
  const url = new URL(uri)
  return url.hostname && !url.username && !url.password && !url.hash ? uri : undefined
}

const canonicalName = (server: string, tool: string) =>
  `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, "_")}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`
const readResult = Schema.Struct({
  contents: Schema.Array(
    Schema.Struct({
      uri: Schema.String,
      mimeType: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
      blob: Schema.optional(Schema.String),
      _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
})
const decodeRead = Schema.decodeUnknownOption(readResult)
const decodeInput = Schema.decodeUnknownOption(ReadInput, { onExcessProperty: "error" })

export function make(observe: Effect.Effect<readonly Binding[], Error>) {
  const snapshots = new Map<string, Snapshot>()
  const views = new Map<string, OpenView>()
  const observed = Effect.fn("McpAppResource.observe")(function* () {
    const bindings = yield* observe
    const current = bindings.map((binding) => {
      const previous = snapshots.get(binding.server)
      if (
        previous &&
        previous.scope === binding.scope &&
        previous.client === binding.client &&
        previous.tools === binding.tools &&
        previous.version === binding.version &&
        previous.source === binding.source
      )
        return previous
      return { ...binding, generation: randomUUID() }
    })
    snapshots.clear()
    current.forEach((binding) => snapshots.set(binding.server, binding))
    // Revocation is checked on every operation, including after an asynchronous read.
    // Abort pending reads when their exact connection/tool/source snapshot has retired.
    views.forEach((view, id) => {
      if (view.expiresAt > Date.now() && view.deadline > performance.now() && current.includes(view.snapshot)) return
      view.abort.abort()
      views.delete(id)
    })
    return current
  })
  const descriptors = (bindings: readonly Snapshot[]) => {
    const names = bindings.flatMap((binding) => binding.tools.map((tool) => canonicalName(binding.server, tool.name)))
    return bindings.flatMap((binding) =>
      binding.tools.flatMap((tool) => {
        const uri = resourceUri(tool)
        if (!uri || !visibility(tool).length || tool.execution?.taskSupport === "required") return []
        const toolName = canonicalName(binding.server, tool.name)
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(toolName)) return []
        if (names.filter((name) => name === toolName).length !== 1) return []
        return [
          {
            server: binding.server,
            tool: tool.name,
            toolName,
            generation: binding.generation,
            resourceUri: uri,
            mimeType: MIME_TYPE,
          } satisfies Descriptor,
        ]
      }),
    )
  }
  const requireView = Effect.fnUntraced(function* (input: ViewInput) {
    const previous = views.get(input.viewID)
    if (!previous) return yield* new Error({ reason: "changed" })
    if (previous.expiresAt <= Date.now() || previous.deadline <= performance.now()) {
      previous.abort.abort()
      views.delete(input.viewID)
      return yield* new Error({ reason: "expired" })
    }
    yield* observed()
    if (views.get(input.viewID) !== previous || !previous.ready) return yield* new Error({ reason: "changed" })
    return previous
  })
  return {
    list: Effect.fn("McpAppResource.list")(function* () {
      return descriptors(yield* observed())
    }),
    read: Effect.fn("McpAppResource.read")(function* (input: ReadInput) {
      if (input.consent !== true) return yield* new Error({ reason: "consent_required" })
      if (Option.isNone(decodeInput(input))) return yield* new Error({ reason: "invalid" })
      const bindings = yield* observed()
      const descriptor = descriptors(bindings).find(
        (item) =>
          item.server === input.server &&
          item.tool === input.tool &&
          item.generation === input.generation &&
          item.resourceUri === input.resourceUri,
      )
      const snapshot = bindings.find(
        (binding) => binding.server === input.server && binding.generation === input.generation,
      )
      if (!descriptor || !snapshot) return yield* new Error({ reason: "changed" })
      if (views.size >= LIMITS.views) return yield* new Error({ reason: "capacity" })
      const viewID = randomUUID()
      const view: OpenView = {
        snapshot,
        descriptor,
        expiresAt: Date.now() + LIMITS.lifetimeMs,
        deadline: performance.now() + LIMITS.lifetimeMs,
        abort: new AbortController(),
        ready: false,
        sessionID: input.sessionID,
      }
      views.set(viewID, view)
      const timer = setTimeout(() => view.abort.abort(), LIMITS.readMs)
      return yield* Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () =>
            snapshot.client.readResource(
              { uri: descriptor.resourceUri },
              { signal: view.abort.signal, timeout: LIMITS.readMs },
            ),
          catch: () => new Error({ reason: "unavailable" }),
        })
        yield* observed()
        if (views.get(viewID) !== view || view.abort.signal.aborted) return yield* new Error({ reason: "changed" })
        const decoded = decodeRead(result)
        if (Option.isNone(decoded) || decoded.value.contents.length !== 1)
          return yield* new Error({ reason: "invalid" })
        const content = decoded.value.contents[0]!
        if (
          content.uri !== descriptor.resourceUri ||
          content.mimeType !== MIME_TYPE ||
          typeof content.text !== "string" ||
          content.blob !== undefined ||
          Buffer.byteLength(content.text) > LIMITS.htmlBytes
        )
          return yield* new Error({ reason: "invalid" })
        const metadata =
          content._meta && "ui" in content._meta
            ? content._meta.ui
            : snapshot.resourceMetadata?.find((item) => item.uri === descriptor.resourceUri)?._meta?.ui
        if (
          metadata !== undefined &&
          (typeof metadata !== "object" ||
            metadata === null ||
            Array.isArray(metadata) ||
            Buffer.byteLength(JSON.stringify(metadata)) > LIMITS.metadataBytes)
        )
          return yield* new Error({ reason: "invalid" })
        view.ready = true
        return {
          viewID,
          descriptor: structuredClone(descriptor),
          html: content.text,
          csp: CSP,
          prefersBorder:
            typeof metadata === "object" &&
            metadata !== null &&
            "prefersBorder" in metadata &&
            metadata.prefersBorder === true,
          expiresAt: view.expiresAt,
          ...(view.sessionID ? { sessionID: view.sessionID } : {}),
        } satisfies View
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            clearTimeout(timer)
            if (exit._tag === "Failure") {
              view.abort.abort()
              views.delete(viewID)
            }
          }),
        ),
      )
    }),
    check: Effect.fn("McpAppResource.check")(function* (input: ViewInput) {
      return structuredClone((yield* requireView(input)).descriptor)
    }),
    /** The original connection, view and tool are returned only through this private host port. */
    capture: Effect.fn("McpAppResource.capture")(function* (input: { sessionID: SessionSchema.ID; viewID: string; name: string }) {
      const view = yield* requireView(input)
      if (view.sessionID !== input.sessionID) return yield* new Error({ reason: "changed" })
      const candidates = view.snapshot.tools.filter((tool) => tool.name === input.name && visibility(tool).includes("app") && tool.execution?.taskSupport !== "required")
      if (candidates.length !== 1) return yield* new Error({ reason: "changed" })
      const tool = candidates[0]!
      return Object.freeze({ sessionID: input.sessionID, viewID: input.viewID, snapshot: view.snapshot, tool, expiresAt: view.expiresAt,
        current: () => views.get(input.viewID) === view && view.ready && view.expiresAt > Date.now() && view.deadline > performance.now() && !view.abort.signal.aborted &&
          snapshots.get(view.snapshot.server) === view.snapshot && view.snapshot.tools.includes(tool),
        prepare: () => requireView(input).pipe(Effect.asVoid) })
    }),
    viewTools: Effect.fn("McpAppResource.viewTools")(function* (input: typeof ViewToolsInput.Type) {
      const view = yield* requireView(input)
      if (view.sessionID !== input.sessionID) return yield* new Error({ reason: "changed" })
      const tools = view.snapshot.tools.filter((tool) => visibility(tool).includes("app") && tool.execution?.taskSupport !== "required" &&
        view.snapshot.tools.filter((candidate) => candidate.name === tool.name).length === 1)
        .map((tool) => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description.slice(0, 4096) }), inputSchema: structuredClone(tool.inputSchema),
          ...(tool.outputSchema === undefined ? {} : { outputSchema: structuredClone(tool.outputSchema) }),
          ...(tool.annotations === undefined ? {} : { annotations: structuredClone(tool.annotations) }),
          ...(tool._meta === undefined ? {} : { _meta: structuredClone(tool._meta) }),
          ...(tool.execution === undefined ? {} : { execution: structuredClone(tool.execution) }) }))
      const value = { viewID: input.viewID, sessionID: input.sessionID, generation: view.snapshot.generation, tools }
      if (tools.length > 256 || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024 || !Schema.is(ViewTools)(value)) return yield* new Error({ reason: "invalid" })
      return value
    }),
    close: Effect.fn("McpAppResource.close")(function* (input: ViewInput) {
      views.get(input.viewID)?.abort.abort()
      views.delete(input.viewID)
    }),
    dispose: () => {
      views.forEach((view) => view.abort.abort())
      views.clear()
      snapshots.clear()
    },
  }
}
