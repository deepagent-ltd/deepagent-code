export * as McpAppInvocation from "./mcp-app-invocation"

import { and, asc, count, desc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { DatabaseMode } from "../database/mode"
import { EventV2 } from "../event"
import { Location } from "../location"
import { GoalChild } from "../deepagent/goal-child"
import { LocationIdentityTable, ProjectScopeIdentityTable, SecurityNamespaceTable } from "../context-federation/sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { SessionTable } from "./sql"
import { SessionSchema } from "./schema"
import { WorkSessionGuard } from "./work-session-guard"
import { McpAppInvocationSchema } from "./mcp-app-invocation.schema"
import { McpAppEffectTable, McpAppInvocationTable } from "./mcp-app-invocation.sql"
import { V2ProviderTurnReceiptTable } from "./runner/v2-provider-turn.sql"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "./runner/v2-tool-effect.sql"
import type { Tool } from "../tool/tool"
import { PermissionSavedEpochTable } from "../permission/sql"

type Db = Database.Interface["db"]
export type Reader = Db | Tx
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Invocation = typeof McpAppInvocationTable.$inferSelect
type EffectRow = typeof McpAppEffectTable.$inferSelect
export type Stored = { readonly invocation: Invocation; readonly effect: EffectRow }

/** Only an original, current App view may construct this private host port. It is never a DTO. */
export interface Native {
  readonly sessionID: SessionSchema.ID
  readonly viewID: string
  readonly generation: string
  readonly server: string
  readonly tool: string
  readonly registryID: string
  readonly definitionHash: string
  readonly configurationHash: string
  readonly expiresAt: number
  readonly current: () => boolean
  readonly prepare: () => Effect.Effect<void, McpAppInvocationSchema.Error>
  readonly execute: (args: Record<string, unknown>, context: Tool.AppContext) => Effect.Effect<unknown, Tool.Failure>
}
export interface Host {
  readonly capture: (input: {
    sessionID: SessionSchema.ID
    viewID: string
    name: string
  }) => Effect.Effect<Native, McpAppInvocationSchema.Error>
}
type HostEntry = { readonly host: Host; active: boolean }
type Live = {
  readonly native: Native
  readonly owner: HostEntry
  readonly agent: AgentV2.Snapshot
  readonly source: McpAppInvocationSchema.Source
}
const hosts = new Map<string, HostEntry[]>()
// Undefined reserves a preparing slot before the first asynchronous native capture. Admitted
// unknowns keep their original entry; closing the host cannot turn them into reusable capacity.
const live = new Map<string, Live | undefined>()
const key = (location: Location.Ref) =>
  CanonicalJson.stringify({ directory: location.directory, workspaceID: location.workspaceID ?? null })
export const failure = (code: McpAppInvocationSchema.Error["code"]) =>
  new McpAppInvocationSchema.Error({ code, message: `MCP App invocation ${code}` })
export const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
const pendingStates = ["queued", "awaiting_permission", "dispatching", "unknown"] as const
const knownStates = ["settled", "failed", "cancelled_before_dispatch"] as const
function storageError(error: unknown): McpAppInvocationSchema.Error {
  if (error instanceof McpAppInvocationSchema.Error) return error
  const pending = [error]
  for (let depth = 0; depth < 8 && pending.length; depth++) {
    const value = pending.pop()
    if (!value || typeof value !== "object") continue
    if ("message" in value && typeof value.message === "string" && value.message.includes("mcp_app_capacity_exceeded"))
      return failure("capacity")
    if ("cause" in value) pending.push(value.cause)
  }
  return failure("unavailable")
}
const query = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(storageError))
const transaction = <A, E>(db: Db, body: (tx: Tx) => Effect.Effect<A, E>) =>
  query(db.transaction(body, { behavior: "immediate" }))

/** Instance bridge registration is scoped; retirement cannot rebind an already-admitted source. */
export const registerHost = Effect.fn("McpAppInvocation.registerHost")(function* (location: Location.Ref, host: Host) {
  const name = key(location)
  if ((hosts.size >= 64 && !hosts.has(name)) || (hosts.get(name)?.length ?? 0) >= 32) return yield* failure("capacity")
  const entry: HostEntry = { host, active: true }
  hosts.set(name, [...(hosts.get(name) ?? []), entry])
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      entry.active = false
      const remaining = hosts.get(name)?.filter((value) => value !== entry) ?? []
      if (remaining.length) hosts.set(name, remaining)
      if (!remaining.length) hosts.delete(name)
    }),
  )
})

export function current(id: string) {
  const value = live.get(id)
  return Boolean(
    value?.owner.active &&
      value.native.current() &&
      value.native.expiresAt > Date.now() &&
      AgentV2.snapshotView(value.agent),
  )
}
export function native(id: string) {
  return current(id) ? live.get(id)?.native : undefined
}

/** Source capture is outside SQL. The subsequent short transaction consumes the original witness. */
const capture = Effect.fnUntraced(function* (
  db: Db,
  location: Location.Interface,
  agents: AgentV2.Interface,
  input: McpAppInvocationSchema.InvokeInput,
) {
  const owner = hosts.get(key(location))?.at(-1)
  if (!owner?.active || location.workspaceID !== undefined) return yield* failure("unavailable")
  const original = yield* owner.host.capture(input)
  yield* original.prepare()
  if (
    !owner.active ||
    !original.current() ||
    original.sessionID !== input.sessionID ||
    original.viewID !== input.viewID ||
    original.tool !== input.name
  )
    return yield* failure("changed")
  const session = yield* query(db.select().from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get())
  if (
    !session ||
    !session.v2_authority ||
    session.time_archived !== null ||
    session.directory !== location.directory ||
    session.workspace_id !== null ||
    session.project_id !== location.project.id
  )
    return yield* failure("changed")
  if (!agents.snapshot) return yield* failure("unavailable")
  const agent = yield* agents.snapshot(session.agent ?? undefined).pipe(Effect.mapError(() => failure("unavailable")))
  const view = AgentV2.snapshotView(agent)
  if (!view) return yield* failure("changed")
  const identity = yield* query(
    db
      .select({
        namespace: SecurityNamespaceTable,
        location: LocationIdentityTable,
        project: ProjectScopeIdentityTable,
      })
      .from(SecurityNamespaceTable)
      .innerJoin(LocationIdentityTable, eq(LocationIdentityTable.security_namespace_id, SecurityNamespaceTable.id))
      .innerJoin(
        ProjectScopeIdentityTable,
        and(
          eq(ProjectScopeIdentityTable.security_namespace_id, SecurityNamespaceTable.id),
          eq(ProjectScopeIdentityTable.project_scope_key, LocationIdentityTable.project_scope_key),
        ),
      )
      .where(
        and(
          eq(SecurityNamespaceTable.kind, "implicit_local"),
          eq(SecurityNamespaceTable.binding_hash, Hash.sha256("context-security-namespace/v1:implicit-local")),
          eq(LocationIdentityTable.canonical_root, location.directory),
          isNull(SecurityNamespaceTable.retired_at),
          isNull(LocationIdentityTable.retired_at),
          isNull(ProjectScopeIdentityTable.retired_at),
        ),
      )
      .get(),
  )
  if (
    !identity ||
    identity.location.workspace_binding !== null ||
    identity.location.observed_project_id !== identity.project.observed_project_id
  )
    return yield* failure("changed")
  const source: McpAppInvocationSchema.Source = {
    kind: "mcp_app",
    sessionID: input.sessionID,
    viewID: input.viewID,
    generation: original.generation,
    server: original.server,
    tool: original.tool,
    registryID: original.registryID,
    definitionHash: original.definitionHash,
    configurationHash: original.configurationHash,
    agentID: view.info.id,
    agentSelector: session.agent,
    mutationEpoch: session.mutation_epoch,
    expiresAt: original.expiresAt,
    placement: {
      directory: location.directory,
      workspaceID: null,
      projectID: session.project_id,
      securityNamespaceID: identity.namespace.id,
      namespaceBindingHash: identity.namespace.binding_hash,
      locationKey: identity.location.location_key,
      projectScopeKey: identity.project.project_scope_key,
    },
  }
  if (!McpAppInvocationSchema.bounded(source, 16384) || !Schema.is(McpAppInvocationSchema.Source)(source))
    return yield* failure("invalid")
  if (!owner.active || !original.current() || !AgentV2.snapshotView(agent)) return yield* failure("changed")
  return { native: original, owner, agent, source: Object.freeze(structuredClone(source)) } satisfies Live
})

/** No network/native preparation occurs here. Every durable transition rechecks real placement. */
export const requireSource = Effect.fn("McpAppInvocation.requireSource")(function* (
  db: Reader,
  source: McpAppInvocationSchema.Source,
  location: Location.Interface,
  invocationID?: string,
) {
  if (source.expiresAt <= Date.now()) return yield* failure("expired")
  if (
    location.directory !== source.placement.directory ||
    (location.workspaceID ?? null) !== source.placement.workspaceID ||
    location.project.id !== source.placement.projectID
  )
    return yield* failure("changed")
  const row = yield* query(
    db
      .select({
        session: SessionTable,
        namespace: SecurityNamespaceTable,
        location: LocationIdentityTable,
        project: ProjectScopeIdentityTable,
      })
      .from(SessionTable)
      .innerJoin(SecurityNamespaceTable, eq(SecurityNamespaceTable.id, source.placement.securityNamespaceID))
      .innerJoin(
        LocationIdentityTable,
        and(
          eq(LocationIdentityTable.security_namespace_id, SecurityNamespaceTable.id),
          eq(LocationIdentityTable.location_key, source.placement.locationKey),
        ),
      )
      .innerJoin(
        ProjectScopeIdentityTable,
        and(
          eq(ProjectScopeIdentityTable.security_namespace_id, SecurityNamespaceTable.id),
          eq(ProjectScopeIdentityTable.project_scope_key, source.placement.projectScopeKey),
        ),
      )
      .where(eq(SessionTable.id, source.sessionID))
      .get(),
  )
  if (
    !row ||
    !row.session.v2_authority ||
    row.session.time_archived !== null ||
    row.session.project_id !== source.placement.projectID ||
    row.session.directory !== source.placement.directory ||
    row.session.workspace_id !== source.placement.workspaceID ||
    row.session.mutation_epoch !== source.mutationEpoch ||
    row.session.agent !== source.agentSelector ||
    row.namespace.kind !== "implicit_local" ||
    row.namespace.binding_hash !== source.placement.namespaceBindingHash ||
    row.namespace.retired_at !== null ||
    row.location.retired_at !== null ||
    row.project.retired_at !== null ||
    row.location.canonical_root !== source.placement.directory ||
    row.location.workspace_binding !== null ||
    row.location.project_scope_key !== source.placement.projectScopeKey ||
    row.location.observed_project_id !== row.project.observed_project_id
  )
    return yield* failure("changed")
  yield* WorkSessionGuard.requireOrdinary(db, source.sessionID).pipe(Effect.mapError(() => failure("restricted")))
  if (yield* GoalChild.owner(db, source.sessionID).pipe(Effect.mapError(() => failure("unavailable"))))
    return yield* failure("restricted")
  if (source.expiresAt <= Date.now() || (invocationID !== undefined && !current(invocationID)))
    return yield* failure("changed")
  return row.session
})

export const get = Effect.fn("McpAppInvocation.get")(function* (
  db: Reader,
  input: typeof McpAppInvocationSchema.StatusInput.Type,
) {
  const row = yield* query(
    db
      .select({ invocation: McpAppInvocationTable, effect: McpAppEffectTable })
      .from(McpAppInvocationTable)
      .innerJoin(McpAppEffectTable, eq(McpAppEffectTable.invocation_id, McpAppInvocationTable.invocation_id))
      .where(
        and(
          eq(McpAppInvocationTable.invocation_id, input.invocationID),
          eq(McpAppInvocationTable.session_id, input.sessionID),
        ),
      )
      .get(),
  )
  if (!row) return undefined
  if (
    !Schema.is(McpAppInvocationSchema.Source)(row.invocation.source) ||
    hash(row.invocation.source) !== row.invocation.source_hash ||
    (row.invocation.arguments !== null &&
      hash({ name: row.invocation.source.tool, arguments: decodeArguments(row.invocation.arguments) }) !==
        row.invocation.input_hash)
  )
    return yield* failure("invalid")
  return row
})
function decodeArguments(value: string) {
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value)
  if (
    Option.isNone(decoded) ||
    !McpAppInvocationSchema.bounded(
      decoded.value,
      McpAppInvocationSchema.LIMITS.argumentsBytes,
      McpAppInvocationSchema.LIMITS.argumentNodes,
      McpAppInvocationSchema.LIMITS.argumentDepth,
    )
  )
    throw failure("invalid")
  return Schema.decodeUnknownSync(McpAppInvocationSchema.Arguments)(decoded.value)
}
export function statusOf(row: Stored): McpAppInvocationSchema.Status {
  return {
    version: 1,
    invocationID: row.invocation.invocation_id,
    sessionID: SessionSchema.ID.make(row.invocation.session_id),
    viewID: row.invocation.view_id,
    rpcID: Schema.decodeUnknownSync(Schema.fromJsonString(McpAppInvocationSchema.RpcID))(row.invocation.rpc_id),
    admittedSeq: row.invocation.admitted_seq,
    state: row.effect.state,
    expiresAt: row.invocation.expires_at,
    ...(row.effect.error_code === null ? {} : { errorCode: row.effect.error_code }),
    ...(row.effect.result_hash === null ? {} : { resultHash: row.effect.result_hash }),
    resultAvailable: row.effect.result !== null,
  }
}
const requireHistory = Effect.fnUntraced(function* (db: Reader, location: Location.Interface, row: Stored) {
  const session = yield* query(
    db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionSchema.ID.make(row.invocation.session_id)))
      .get(),
  )
  if (
    !session ||
    !session.v2_authority ||
    session.directory !== location.directory ||
    (session.workspace_id ?? null) !== (location.workspaceID ?? null) ||
    session.project_id !== location.project.id ||
    row.invocation.source.placement.directory !== location.directory ||
    row.invocation.source.placement.projectID !== location.project.id
  )
    return yield* failure("changed")
})
const used = Effect.fnUntraced(function* (db: Reader) {
  const tables = [McpAppInvocationTable, McpAppEffectTable]
  const bytes = tables.map(
    (table, index) =>
      sql`(SELECT coalesce(sum(${sql.join(
        Object.values(getTableColumns(table)).map((column) =>
          column.dataType === "number"
            ? sql`CASE WHEN ${column} IS NULL THEN 0 ELSE 8 END`
            : sql`coalesce(length(CAST(${column} AS BLOB)),0)`,
        ),
        sql`+`,
      )}${index === 1 ? sql`+${McpAppEffectTable.reserved_bytes}` : sql``}),0) FROM ${table})`,
  )
  const value = yield* query(
    db
      .select({
        bytes: sql<number>`${bytes[0]}+${bytes[1]}`,
        receipts: count(),
        pending: sql<number>`coalesce(sum(CASE WHEN ${McpAppEffectTable.state} IN ('queued','awaiting_permission','dispatching','unknown') THEN 1 ELSE 0 END),0)`,
      })
      .from(McpAppInvocationTable)
      .innerJoin(McpAppEffectTable, eq(McpAppEffectTable.invocation_id, McpAppInvocationTable.invocation_id))
      .get(),
  )
  return value ?? { bytes: 0, receipts: 0, pending: 0 }
})

export interface Interface {
  readonly invoke: (
    input: McpAppInvocationSchema.InvokeInput,
  ) => Effect.Effect<McpAppInvocationSchema.Status, McpAppInvocationSchema.Error>
  readonly status: (
    input: typeof McpAppInvocationSchema.StatusInput.Type,
  ) => Effect.Effect<McpAppInvocationSchema.Status, McpAppInvocationSchema.Error>
  readonly result: (
    input: typeof McpAppInvocationSchema.ResultInput.Type,
  ) => Effect.Effect<McpAppInvocationSchema.InvokeResult, McpAppInvocationSchema.Error>
  readonly list: (
    input: typeof McpAppInvocationSchema.ListInput.Type,
  ) => Effect.Effect<readonly McpAppInvocationSchema.Status[], McpAppInvocationSchema.Error>
}
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/McpAppInvocation") {}
export const make = Effect.fn("McpAppInvocation.make")(function* () {
  const database = yield* Database.Service
  const db = database.db
  const events = yield* EventV2.Service
  const location = yield* Location.Service
  const agents = yield* AgentV2.Service
  return Service.of({
    invoke: Effect.fn("McpAppInvocation.invoke")(function* (input) {
      if (database.mode) DatabaseMode.assertWritable(DatabaseMode.snapshotOf(database.mode))
      if (
        !McpAppInvocationSchema.bounded(input, 65536, 160, 10) ||
        !Schema.is(McpAppInvocationSchema.InvokeInput)(input)
      )
        return yield* failure("invalid")
      const frozen = Schema.decodeUnknownSync(McpAppInvocationSchema.InvokeInput, { onExcessProperty: "error" })(
        structuredClone(input),
      )
      const invocationID = `mcpapp_${hash({ viewID: frozen.viewID, rpcID: frozen.rpcID })}`
      const inputHash = hash({ name: frozen.name, arguments: frozen.arguments })
      const previous = yield* get(db, { sessionID: frozen.sessionID, invocationID })
      if (previous) {
        yield* requireHistory(db, location, previous)
        if (previous.invocation.input_hash !== inputHash || previous.invocation.view_id !== frozen.viewID)
          return yield* failure("conflict")
        return statusOf(previous)
      }
      // Reclaim only known terminal bodies before admitting new custody. Exact retries remain reads.
      yield* retire(db)
      if (live.has(invocationID)) return yield* failure("conflict")
      if (live.size >= McpAppInvocationSchema.LIMITS.pendingGlobal) return yield* failure("capacity")
      live.set(invocationID, undefined)
      const original = yield* capture(db, location, agents, frozen).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? Effect.sync(() => {
                if (live.has(invocationID) && live.get(invocationID) === undefined) live.delete(invocationID)
              })
            : Effect.void,
        ),
      )
      const argumentBody = CanonicalJson.stringify(frozen.arguments)
      live.set(invocationID, original)
      const admitted = yield* events
        .publishChecked(
          McpAppInvocationSchema.Admitted,
          {
            sessionID: frozen.sessionID,
            invocationID,
            sourceHash: hash(original.source),
            inputHash,
            timestamp: Date.now(),
          },
          {
            commit: (seq) =>
              Effect.gen(function* () {
                yield* requireSource(db, original.source, location)
                if (!original.owner.active || !original.native.current() || !AgentV2.snapshotView(original.agent))
                  return yield* failure("changed")
                const existing = yield* get(db, { sessionID: frozen.sessionID, invocationID })
                if (existing) return yield* failure("conflict")
                const quota = yield* used(db)
                const sessionPending = yield* query(
                  db
                    .select({ count: count() })
                    .from(McpAppInvocationTable)
                    .innerJoin(
                      McpAppEffectTable,
                      eq(McpAppEffectTable.invocation_id, McpAppInvocationTable.invocation_id),
                    )
                    .where(
                      and(
                        eq(McpAppInvocationTable.session_id, frozen.sessionID),
                        inArray(McpAppEffectTable.state, pendingStates),
                      ),
                    )
                    .get(),
                )
                if (
                  quota.receipts >= McpAppInvocationSchema.LIMITS.receiptsGlobal ||
                  quota.pending >= McpAppInvocationSchema.LIMITS.pendingGlobal ||
                  (sessionPending?.count ?? 0) >= McpAppInvocationSchema.LIMITS.pendingSession ||
                  quota.bytes + Buffer.byteLength(argumentBody) > McpAppInvocationSchema.LIMITS.retainedBytes
                )
                  return yield* failure("capacity")
                const now = Date.now()
                const expiry = Math.min(original.source.expiresAt, now + McpAppInvocationSchema.LIMITS.invocationMs)
                if (expiry <= now) return yield* failure("expired")
                yield* query(
                  db
                    .insert(McpAppInvocationTable)
                    .values({
                      invocation_id: invocationID,
                      session_id: frozen.sessionID,
                      view_id: frozen.viewID,
                      rpc_id: CanonicalJson.stringify(frozen.rpcID),
                      admitted_seq: seq,
                      source_kind: "mcp_app",
                      source: original.source,
                      source_hash: hash(original.source),
                      input_hash: inputHash,
                      arguments: argumentBody,
                      arguments_bytes: Buffer.byteLength(argumentBody),
                      created_at: now,
                      expires_at: expiry,
                    }),
                )
                yield* query(
                  db.insert(McpAppEffectTable).values({ invocation_id: invocationID, state: "queued", revision: 1 }),
                )
                if (!original.owner.active || !original.native.current() || !AgentV2.snapshotView(original.agent))
                  return yield* failure("changed")
              }),
          },
        )
        .pipe(
          Effect.mapError((error) =>
            error.cause instanceof McpAppInvocationSchema.Error ? error.cause : failure("unavailable"),
          ),
          Effect.onExit((exit) =>
            exit._tag === "Success"
              ? Effect.void
              : get(db, { sessionID: frozen.sessionID, invocationID }).pipe(
                  Effect.result,
                  Effect.tap((saved) =>
                    Effect.sync(() => {
                      if (saved._tag === "Success" && !saved.success && live.get(invocationID) === original)
                        live.delete(invocationID)
                    }),
                  ),
                  Effect.asVoid,
                ),
          ),
        )
      if (admitted.seq === undefined) return yield* failure("unavailable")
      const row = yield* get(db, { sessionID: frozen.sessionID, invocationID })
      if (!row) return yield* failure("unknown")
      return statusOf(row)
    }),
    status: Effect.fn("McpAppInvocation.status")(function* (input) {
      const row = yield* get(db, input)
      if (!row) return yield* failure("not_found")
      yield* requireHistory(db, location, row)
      return statusOf(row)
    }),
    result: Effect.fn("McpAppInvocation.result")(function* (input) {
      const row = yield* get(db, input)
      if (!row) return yield* failure("not_found")
      yield* requireHistory(db, location, row)
      if (row.invocation.view_id !== input.viewID) return yield* failure("changed")
      const owner = hosts.get(key(location))?.at(-1)
      if (!owner?.active) return yield* failure("changed")
      const binding = yield* owner.host.capture({
        sessionID: input.sessionID,
        viewID: input.viewID,
        name: row.invocation.source.tool,
      })
      yield* binding.prepare()
      if (
        !binding.current() ||
        binding.generation !== row.invocation.source.generation ||
        binding.configurationHash !== row.invocation.source.configurationHash ||
        binding.definitionHash !== row.invocation.source.definitionHash
      )
        return yield* failure("changed")
      yield* requireSource(db, row.invocation.source, location)
      const permission = Schema.decodeUnknownOption(McpAppInvocationSchema.PermissionReceipt)(row.effect.permission)
      if (
        Option.isNone(permission) ||
        permission.value.source.invocationID !== input.invocationID ||
        permission.value.source.viewID !== input.viewID ||
        permission.value.source.generation !== row.invocation.source.generation ||
        permission.value.source.server !== row.invocation.source.server ||
        permission.value.source.tool !== row.invocation.source.tool
      )
        return yield* failure("permission_denied")
      const agent = agents.snapshot
        ? yield* agents
            .snapshot(row.invocation.source.agentID)
            .pipe(Effect.mapError(() => failure("permission_denied")))
        : undefined
      const actor = agent ? AgentV2.snapshotView(agent) : undefined
      const saved = yield* query(
        db
          .select({
            permission: sql<string | null>`${SessionTable.permission}`,
            epoch: PermissionSavedEpochTable.epoch,
          })
          .from(SessionTable)
          .innerJoin(PermissionSavedEpochTable, eq(PermissionSavedEpochTable.project_id, SessionTable.project_id))
          .where(eq(SessionTable.id, input.sessionID))
          .get(),
      )
      if (
        !actor ||
        !saved ||
        saved.epoch !== permission.value.savedEpoch ||
        Hash.sha256(saved.permission ?? "null") !== permission.value.sessionPermissionHash ||
        hash(actor.info.permissions) !== permission.value.agentPermissionsHash ||
        actor.instanceID !== permission.value.agentInstanceID ||
        actor.generation !== permission.value.agentGeneration ||
        !AgentV2.snapshotView(agent!)
      )
        return yield* failure("permission_denied")
      if (row.effect.result === null)
        return yield* failure(row.effect.result_retired_at === null ? "unavailable" : "result_retired")
      if (
        Buffer.byteLength(row.effect.result) !== row.effect.result_bytes ||
        Hash.sha256(row.effect.result) !== row.effect.result_hash
      )
        return yield* failure("invalid")
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
        row.effect.result,
      )
      if (Option.isNone(decoded)) return yield* failure("invalid")
      // The final source, permission epoch and body custody probes share one short writer fence.
      // A Session/archive/rule change cannot interleave the individual SQL awaits.
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          yield* requireSource(tx, row.invocation.source, location)
          const currentPermission = yield* query(
            tx
              .select({
                permission: sql<string | null>`${SessionTable.permission}`,
                epoch: PermissionSavedEpochTable.epoch,
              })
              .from(SessionTable)
              .innerJoin(PermissionSavedEpochTable, eq(PermissionSavedEpochTable.project_id, SessionTable.project_id))
              .where(eq(SessionTable.id, input.sessionID))
              .get(),
          )
          const custody = yield* query(
            tx
              .select({ hash: McpAppEffectTable.result_hash, retired: McpAppEffectTable.result_retired_at })
              .from(McpAppEffectTable)
              .where(eq(McpAppEffectTable.invocation_id, input.invocationID))
              .get(),
          )
          if (custody?.retired !== null) return yield* failure("result_retired")
          if (
            !currentPermission ||
            currentPermission.epoch !== permission.value.savedEpoch ||
            Hash.sha256(currentPermission.permission ?? "null") !== permission.value.sessionPermissionHash ||
            custody?.hash !== row.effect.result_hash
          )
            return yield* failure("permission_denied")
          if (!binding.current() || !AgentV2.snapshotView(agent!)) return yield* failure("changed")
          return { ...statusOf(row), result: decoded.value }
        }),
      )
    }),
    list: Effect.fn("McpAppInvocation.list")(function* (input) {
      const rows = yield* query(
        db
          .select({ invocation: McpAppInvocationTable, effect: McpAppEffectTable })
          .from(McpAppInvocationTable)
          .innerJoin(McpAppEffectTable, eq(McpAppEffectTable.invocation_id, McpAppInvocationTable.invocation_id))
          .where(
            and(
              eq(McpAppInvocationTable.session_id, input.sessionID),
              sql`${McpAppInvocationTable.admitted_seq}>${input.after ?? -1}`,
            ),
          )
          .orderBy(
            input.after === undefined
              ? desc(McpAppInvocationTable.admitted_seq)
              : asc(McpAppInvocationTable.admitted_seq),
          )
          .limit(input.limit ?? 32)
          .all(),
      )
      yield* Effect.forEach(rows, (row) => requireHistory(db, location, row), { discard: true })
      return (input.after === undefined ? rows.reverse() : rows).map(statusOf)
    }),
  })
})
export const layer = Layer.effect(Service, make())

export const pending = Effect.fn("McpAppInvocation.pending")(function* (db: Reader, sessionID: SessionSchema.ID) {
  return yield* query(
    db
      .select({ invocation: McpAppInvocationTable, effect: McpAppEffectTable })
      .from(McpAppInvocationTable)
      .innerJoin(McpAppEffectTable, eq(McpAppEffectTable.invocation_id, McpAppInvocationTable.invocation_id))
      .where(and(eq(McpAppInvocationTable.session_id, sessionID), inArray(McpAppEffectTable.state, pendingStates)))
      .orderBy(asc(McpAppInvocationTable.admitted_seq))
      .all(),
  )
})
export const requireAppResolved = Effect.fn("McpAppInvocation.requireAppResolved")(function* (
  db: Reader,
  sessionID: SessionSchema.ID,
) {
  if (
    (yield* pending(db, sessionID)).some((row) => row.effect.state === "unknown" || row.effect.state === "dispatching")
  )
    return yield* failure("unknown")
})
export const requireSafe = Effect.fn("McpAppInvocation.requireSafe")(function* (
  db: Reader,
  sessionID: SessionSchema.ID,
) {
  const apps = yield* pending(db, sessionID)
  if (apps.some((row) => row.effect.state === "unknown" || row.effect.state === "dispatching"))
    return yield* failure("unknown")
  const provider = yield* query(
    db
      .select({ id: V2ProviderTurnReceiptTable.receipt_id })
      .from(V2ProviderTurnReceiptTable)
      .where(
        and(
          eq(V2ProviderTurnReceiptTable.session_id, sessionID),
          inArray(V2ProviderTurnReceiptTable.state, [
            "preparing",
            "dispatching",
            "streaming",
            "indeterminate_after_crash",
          ]),
        ),
      )
      .get(),
  )
  const tool = yield* query(
    db
      .select({ id: V2ToolEffectAdmissionTable.admission_id })
      .from(V2ToolEffectAdmissionTable)
      .leftJoin(
        V2ToolEffectTable,
        and(
          eq(V2ToolEffectTable.tool_call_id, V2ToolEffectAdmissionTable.tool_call_id),
          eq(V2ToolEffectTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id),
          eq(V2ToolEffectTable.session_id, V2ToolEffectAdmissionTable.session_id),
          eq(V2ToolEffectTable.provider_attempt_id, V2ToolEffectAdmissionTable.provider_attempt_id),
        ),
      )
      .where(
        and(
          eq(V2ToolEffectAdmissionTable.session_id, sessionID),
          sql`(${V2ToolEffectTable.effect_id} IS NULL OR ${V2ToolEffectTable.grant_state} IS NULL OR ${V2ToolEffectTable.grant_state}<>'settled')`,
        ),
      )
      .get(),
  )
  if (provider || tool) return yield* failure("unknown")
})
const publishState = (events: EventV2.Interface, row: Stored) =>
  events
    .publish(McpAppInvocationSchema.Changed, {
      sessionID: SessionSchema.ID.make(row.invocation.session_id),
      invocationID: row.invocation.invocation_id,
      status: statusOf(row),
      timestamp: Date.now(),
    })
    .pipe(Effect.asVoid)
export const awaiting = (db: Db, invocationID: string) =>
  query(
    db
      .update(McpAppEffectTable)
      .set({ state: "awaiting_permission", revision: sql`${McpAppEffectTable.revision}+1` })
      .where(and(eq(McpAppEffectTable.invocation_id, invocationID), eq(McpAppEffectTable.state, "queued")))
      .run(),
  ).pipe(Effect.asVoid)
export const claim = Effect.fn("McpAppInvocation.claim")(function* (
  db: Db,
  location: Location.Interface,
  row: Stored,
  consumePermission: Effect.Effect<void, McpAppInvocationSchema.Error>,
  permissionReceipt: () => typeof McpAppInvocationSchema.PermissionReceipt.Type | undefined,
) {
  return yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make(row.invocation.session_id)
      const latest = yield* get(tx, { sessionID, invocationID: row.invocation.invocation_id })
      if (
        !latest ||
        !["queued", "awaiting_permission"].includes(latest.effect.state) ||
        latest.effect.revision < row.effect.revision ||
        latest.invocation.input_hash !== row.invocation.input_hash
      )
        return yield* failure("changed")
      const session = yield* requireSource(tx, latest.invocation.source, location, latest.invocation.invocation_id)
      if (
        latest.invocation.expires_at <= Date.now() ||
        !session.execution_claim_token ||
        (session.interrupt_seq ?? -1) >= latest.invocation.admitted_seq
      )
        return yield* failure("interrupted")
      yield* requireSafe(tx, sessionID)
      yield* consumePermission
      const receipt = permissionReceipt()
      if (
        !receipt ||
        receipt.source.invocationID !== latest.invocation.invocation_id ||
        receipt.source.generation !== latest.invocation.source.generation
      )
        return yield* failure("permission_denied")
      const quota = yield* used(tx)
      if (quota.bytes + McpAppInvocationSchema.LIMITS.resultBytes > McpAppInvocationSchema.LIMITS.retainedBytes)
        return yield* failure("capacity")
      const owner = randomUUID()
      const changed = yield* query(
        tx
          .update(McpAppEffectTable)
          .set({
            state: "dispatching",
            revision: latest.effect.revision + 1,
            owner_nonce: owner,
            session_claim_token: session.execution_claim_token,
            dispatched_at: Date.now(),
            reserved_bytes: McpAppInvocationSchema.LIMITS.resultBytes,
            permission: receipt,
          })
          .where(
            and(
              eq(McpAppEffectTable.invocation_id, latest.invocation.invocation_id),
              eq(McpAppEffectTable.revision, latest.effect.revision),
            ),
          )
          .returning()
          .get(),
      )
      if (!changed || !current(latest.invocation.invocation_id)) return yield* failure("changed")
      return { invocation: latest.invocation, effect: changed } satisfies Stored
    }),
  )
})
export const dispatchCurrent = Effect.fn("McpAppInvocation.dispatchCurrent")(function* (
  db: Db,
  location: Location.Interface,
  original: Stored,
  consumePermission: Effect.Effect<void, McpAppInvocationSchema.Error>,
) {
  return yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      const session = yield* requireSource(tx, original.invocation.source, location, original.invocation.invocation_id)
      const latest = yield* get(tx, {
        sessionID: SessionSchema.ID.make(original.invocation.session_id),
        invocationID: original.invocation.invocation_id,
      })
      if (
        !latest ||
        latest.effect.state !== "dispatching" ||
        latest.effect.owner_nonce !== original.effect.owner_nonce ||
        latest.effect.session_claim_token !== session.execution_claim_token ||
        latest.invocation.expires_at <= Date.now() ||
        (session.interrupt_seq ?? -1) >= latest.invocation.admitted_seq
      )
        return yield* failure("changed")
      yield* consumePermission
      if (!current(original.invocation.invocation_id)) return yield* failure("changed")
    }),
  )
})
export const settle = Effect.fn("McpAppInvocation.settle")(function* (
  db: Db,
  events: EventV2.Interface,
  row: Stored,
  outcome: {
    state: "settled" | "failed" | "unknown"
    result?: Record<string, unknown>
    errorCode?: McpAppInvocationSchema.Error["code"]
  },
) {
  const body = outcome.result === undefined ? null : CanonicalJson.stringify(outcome.result)
  if (
    body !== null &&
    (!McpAppInvocationSchema.bounded(outcome.result, McpAppInvocationSchema.LIMITS.resultBytes) ||
      Buffer.byteLength(body) > row.effect.reserved_bytes)
  )
    return yield* failure("unknown")
  const saved = yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      const latest = yield* get(tx, {
        sessionID: SessionSchema.ID.make(row.invocation.session_id),
        invocationID: row.invocation.invocation_id,
      })
      if (
        !latest ||
        latest.effect.state !== "dispatching" ||
        latest.effect.owner_nonce !== row.effect.owner_nonce ||
        latest.effect.session_claim_token !== row.effect.session_claim_token
      )
        return yield* failure("unknown")
      const effect = yield* query(
        tx
          .update(McpAppEffectTable)
          .set({
            state: outcome.state,
            revision: latest.effect.revision + 1,
            terminal_at: Date.now(),
            result: body,
            result_hash: body === null ? null : Hash.sha256(body),
            result_bytes: body === null ? 0 : Buffer.byteLength(body),
            reserved_bytes: outcome.state === "unknown" ? latest.effect.reserved_bytes : 0,
            error_code: outcome.errorCode ?? null,
          })
          .where(
            and(
              eq(McpAppEffectTable.invocation_id, row.invocation.invocation_id),
              eq(McpAppEffectTable.revision, latest.effect.revision),
            ),
          )
          .returning()
          .get(),
      )
      if (!effect) return yield* failure("unknown")
      return { invocation: latest.invocation, effect }
    }),
  )
  if (outcome.state !== "unknown") live.delete(row.invocation.invocation_id)
  yield* publishState(events, saved)
  return statusOf(saved)
})
export const cancel = Effect.fn("McpAppInvocation.cancel")(function* (
  db: Db,
  events: EventV2.Interface,
  row: Stored,
  code: McpAppInvocationSchema.Error["code"],
) {
  const effect = yield* query(
    db
      .update(McpAppEffectTable)
      .set({
        state: "cancelled_before_dispatch",
        revision: sql`${McpAppEffectTable.revision}+1`,
        terminal_at: Date.now(),
        error_code: code,
      })
      .where(
        and(
          eq(McpAppEffectTable.invocation_id, row.invocation.invocation_id),
          inArray(McpAppEffectTable.state, ["queued", "awaiting_permission"]),
        ),
      )
      .returning()
      .get(),
  )
  if (!effect) return
  live.delete(row.invocation.invocation_id)
  yield* publishState(events, { invocation: row.invocation, effect })
})
/** Cold state is never executable authority. This classifier performs no physical dispatch. */
export function classify(row: Stored) {
  if (pendingStates.includes(row.effect.state as (typeof pendingStates)[number]))
    return row.effect.state === "queued" || row.effect.state === "awaiting_permission"
      ? "safe_before_dispatch"
      : "recovery"
  return knownStates.includes(row.effect.state as (typeof knownStates)[number]) ? "resolved" : "unclassified"
}
export const retire = Effect.fn("McpAppInvocation.retire")(function* (db: Db, now = Date.now()) {
  return yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      const rows = yield* query(
        tx
          .select({
            id: McpAppInvocationTable.invocation_id,
            arguments: sql<number>`${McpAppInvocationTable.arguments} IS NOT NULL`,
            result: sql<number>`${McpAppEffectTable.result} IS NOT NULL`,
          })
          .from(McpAppInvocationTable)
          .innerJoin(McpAppEffectTable, eq(McpAppEffectTable.invocation_id, McpAppInvocationTable.invocation_id))
          .where(
            and(
              inArray(McpAppEffectTable.state, knownStates),
              sql`${McpAppEffectTable.terminal_at}<=${now - McpAppInvocationSchema.LIMITS.resultLifetimeMs}`,
              sql`(${McpAppInvocationTable.arguments} IS NOT NULL OR ${McpAppEffectTable.result} IS NOT NULL)`,
            ),
          )
          .orderBy(asc(McpAppEffectTable.terminal_at), asc(McpAppInvocationTable.invocation_id))
          .limit(16)
          .all(),
      )
      for (const row of rows) {
        if (row.result)
          yield* query(
            tx
              .update(McpAppEffectTable)
              .set({ result: null, result_bytes: 0, result_retired_at: now })
              .where(eq(McpAppEffectTable.invocation_id, row.id))
              .run(),
          )
        if (row.arguments)
          yield* query(
            tx
              .update(McpAppInvocationTable)
              .set({ arguments: null, arguments_bytes: 0, arguments_retired_at: now })
              .where(eq(McpAppInvocationTable.invocation_id, row.id))
              .run(),
          )
      }
      return rows.length
    }),
  )
})
export function argumentsOf(row: Stored) {
  return row.invocation.arguments === null ? undefined : decodeArguments(row.invocation.arguments)
}
