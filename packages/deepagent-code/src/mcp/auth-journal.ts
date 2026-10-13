import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { McpAuthJournalSchema } from "./auth-journal-schema"
import { McpAuthJournalStore } from "./auth-journal-store"

export type Handle = Readonly<{ slot: string; generation: string; flow: string; owner: string }>
export type Receipt = Readonly<Handle & { operation: string }>
export type Snapshot = ReturnType<typeof McpAuthJournalSchema.decodeSlot>

/** Storage boundary only. Production callers must obtain their binding and current
 * identity from McpAuthScope; strings submitted by an HTTP client are not authority. */
export async function open(file: string, installationTag: string, mode: "read" | "write") {
  const store = await McpAuthJournalStore.open(file, installationTag, mode)
  if (!store) return undefined

  const read = (slot: string) => store.read((db) => select(db, slot))
  const begin = (input: {
    slot: string
    binding: McpAuthJournalSchema.Binding
    flow: McpAuthJournalSchema.Flow
    explicit: boolean
    expected?: { revision: number; generation: string } | null
  }): Handle =>
    store.transaction((db) => {
      const binding = encode(McpAuthJournalSchema.Binding, input.binding, McpAuthJournalSchema.LIMITS.bindingBytes)
      const flow = encode(McpAuthJournalSchema.Flow, input.flow, McpAuthJournalSchema.LIMITS.flowBytes)
      requireTag(input.slot)
      requireNewFlow(input.flow)
      const before = select(db, input.slot)
      if (
        input.expected !== undefined &&
        (input.expected === null
          ? before !== undefined
          : before?.row.revision !== input.expected.revision || before?.row.generation !== input.expected.generation)
      )
        throw new McpAuthJournalSchema.Error("changed")
      if (before && before.row.binding !== binding) throw new McpAuthJournalSchema.Error("changed")
      if (before?.flow && before.flow.id === input.flow.id && before.flow.owner === input.flow.owner) {
        requireFlow(db, before, handle(before), Date.now())
        return handle(before)
      }
      const unresolved = db
        .query(
          "SELECT operation_id FROM mcp_oauth_operation WHERE slot_key=? AND generation=? AND phase IN ('dispatched','unknown') LIMIT 1",
        )
        .get(input.slot, before?.row.generation ?? "")
      if (unresolved && !input.explicit) throw new McpAuthJournalSchema.Error("unknown")
      if (
        before?.flow &&
        ["preparing", "awaiting_callback"].includes(before.flow.phase) &&
        before.flow.expiresAt > Date.now()
      )
        throw new McpAuthJournalSchema.Error("conflict")
      const generation = randomBytes(32).toString("hex")
      const credentials = input.explicit
        ? { ...(before?.credentials.clientInfo ? { clientInfo: before.credentials.clientInfo } : {}) }
        : (before?.credentials ?? {})
      const now = Date.now()
      if (before) {
        db.query(
          "UPDATE mcp_auth_slot SET generation=?,revision=?,credential_revision=?,credentials=?,flow=?,updated_at=? WHERE slot_key=? AND revision=?",
        ).run(
          generation,
          increment(before.row.revision),
          input.explicit ? increment(before.row.credential_revision) : before.row.credential_revision,
          encode(McpAuthJournalSchema.Credentials, credentials, McpAuthJournalSchema.LIMITS.credentialBytes),
          flow,
          now,
          input.slot,
          before.row.revision,
        )
      } else {
        db.query(
          "INSERT INTO mcp_auth_slot(slot_key,binding,generation,revision,credential_revision,credentials,flow,created_at,updated_at) VALUES(?,?,?,1,0,?,?,?,?)",
        ).run(input.slot, binding, generation, "{}", flow, now, now)
      }
      const after = select(db, input.slot)
      if (!after || after.row.generation !== generation || after.flow?.id !== input.flow.id)
        throw new McpAuthJournalSchema.Error("changed")
      return handle(after)
    })

  const current = (input: Handle, permit?: Receipt) =>
    store.read((db) => {
      if (permit) {
        const operation = requireOperation(db, permit)
        if (operation.row.phase !== "dispatched" || operation.row.deadline_at <= Date.now())
          throw new McpAuthJournalSchema.Error("unknown")
      }
      const row = requireSlot(db, input)
      requireFlow(db, row, input, Date.now(), permit?.operation)
      return row
    })

  const updateFlow = (
    input: Handle,
    patch: Partial<Pick<McpAuthJournalSchema.Flow, "phase" | "verifier" | "discovery" | "discoveryTag">>,
  ) =>
    store.transaction((db) => {
      const row = requireSlot(db, input)
      requireFlow(db, row, input, Date.now())
      const flow = { ...row.flow!, ...patch }
      const text = encode(McpAuthJournalSchema.Flow, flow, McpAuthJournalSchema.LIMITS.flowBytes)
      if (flow.phase === "awaiting_callback" && (!flow.verifier || !flow.discovery || !flow.discoveryTag))
        throw new McpAuthJournalSchema.Error("invalid")
      db.query("UPDATE mcp_auth_slot SET flow=?,revision=?,updated_at=? WHERE slot_key=? AND revision=?").run(
        text,
        increment(row.row.revision),
        Date.now(),
        input.slot,
        row.row.revision,
      )
      return requireSlot(db, input)
    })

  const clientInformation = (input: Handle, clientInfo: NonNullable<McpAuthJournalSchema.Credentials["clientInfo"]>) =>
    store.transaction((db) => {
      const row = requireSlot(db, input)
      requireFlow(db, row, input, Date.now())
      // Static/CIMD issuer binding is local state, not a fabricated DCR receipt.
      saveCredentials(db, row, { ...row.credentials, clientInfo }, false)
    })

  const dispatch = (
    input: Handle,
    request: {
      kind: McpAuthJournalSchema.Kind
      requestTag: string
      endpointTag: string
    },
  ): Receipt =>
    store.transaction((db) => {
      const row = requireSlot(db, input)
      const now = Date.now()
      requireFlow(db, row, input, now)
      requireTag(request.requestTag)
      requireTag(request.endpointTag)
      if (!Schema.is(McpAuthJournalSchema.Kind)(request.kind)) throw new McpAuthJournalSchema.Error("invalid")
      if (!row.flow?.discovery) throw new McpAuthJournalSchema.Error("invalid")
      if (
        request.kind === "exchange" &&
        (!row.flow.verifier || !row.flow.discoveryTag || row.flow.phase !== "awaiting_callback")
      )
        throw new McpAuthJournalSchema.Error("invalid")
      if (request.kind === "refresh" && (!row.credentials.tokens?.refreshToken || row.row.credential_revision === 0))
        throw new McpAuthJournalSchema.Error("invalid")
      const existing =
        request.kind === "refresh"
          ? db
              .query("SELECT * FROM mcp_oauth_operation WHERE slot_key=? AND kind='refresh' AND source_revision=?")
              .get(input.slot, row.row.credential_revision)
          : db
              .query("SELECT * FROM mcp_oauth_operation WHERE slot_key=? AND flow_id=? AND kind=?")
              .get(input.slot, input.flow, request.kind)
      if (existing) {
        const operation = McpAuthJournalSchema.decodeOperation(existing)
        throw new McpAuthJournalSchema.Error(operation.row.phase === "committed" ? "conflict" : "unknown")
      }
      const operation = randomBytes(32).toString("hex")
      db.query(
        `INSERT INTO mcp_oauth_operation(operation_id,slot_key,flow_id,owner_id,generation,source_revision,kind,phase,
      request_tag,endpoint_tag,created_at,deadline_at,dispatched_at,settled_at,outcome)
      VALUES(?,?,?,?,?,?,?,'dispatched',?,?,?,?,?,NULL,'{}')`,
      ).run(
        operation,
        input.slot,
        input.flow,
        input.owner,
        input.generation,
        request.kind === "refresh" ? row.row.credential_revision : null,
        request.kind,
        request.requestTag,
        request.endpointTag,
        now,
        row.flow.phase === "connected" ? now + McpAuthJournalSchema.LIMITS.lifetimeMs : row.flow.expiresAt,
        now,
      )
      return Object.freeze({ ...input, operation })
    })

  const settle = (
    input: Receipt,
    result: {
      credentials?: McpAuthJournalSchema.Credentials
      outcome: McpAuthJournalSchema.Outcome
      phase: "committed" | "rejected" | "unknown"
    },
  ) =>
    store.transaction((db) => {
      const operation = requireOperation(db, input)
      if (operation.row.phase !== "dispatched") throw new McpAuthJournalSchema.Error("changed")
      const now = Date.now()
      if (result.phase === "committed") {
        if (operation.row.deadline_at <= now) throw new McpAuthJournalSchema.Error("unknown")
        const row = requireSlot(db, input)
        requireFlow(db, row, input, now, input.operation)
        if (
          !result.credentials ||
          (operation.row.kind === "registration" ? !result.credentials.clientInfo : !result.credentials.tokens)
        )
          throw new McpAuthJournalSchema.Error("invalid")
        if (operation.row.kind === "refresh" && operation.row.source_revision !== row.row.credential_revision)
          throw new McpAuthJournalSchema.Error("changed")
        saveCredentials(db, row, { ...row.credentials, ...result.credentials }, operation.row.kind !== "registration")
      }
      db.query(
        "UPDATE mcp_oauth_operation SET phase=?,settled_at=?,outcome=? WHERE operation_id=? AND phase='dispatched'",
      ).run(
        result.phase,
        now,
        encode(McpAuthJournalSchema.Outcome, result.outcome, McpAuthJournalSchema.LIMITS.outcomeBytes),
        input.operation,
      )
      return requireOperation(db, input)
    })

  const revoke = (input: Handle, clearCredentials: boolean) =>
    store.transaction((db) => {
      const row = requireSlot(db, input)
      const now = Date.now()
      const operations = db
        .query(
          "SELECT * FROM mcp_oauth_operation WHERE slot_key=? AND flow_id=? AND phase IN ('prepared','dispatched')",
        )
        .all(input.slot, input.flow)
      operations.forEach((value) => {
        const operation = McpAuthJournalSchema.decodeOperation(value)
        db.query("UPDATE mcp_oauth_operation SET phase=?,settled_at=?,outcome=? WHERE operation_id=?").run(
          operation.row.dispatched_at === null ? "revoked" : "unknown",
          now,
          '{"code":"revoked"}',
          operation.row.operation_id,
        )
      })
      db.query(
        "UPDATE mcp_auth_slot SET flow=?,credentials=?,credential_revision=?,revision=?,updated_at=? WHERE slot_key=? AND revision=?",
      ).run(
        row.flow
          ? encode(McpAuthJournalSchema.Flow, { ...row.flow, phase: "revoked" }, McpAuthJournalSchema.LIMITS.flowBytes)
          : "null",
        clearCredentials ? "{}" : row.row.credentials,
        clearCredentials ? increment(row.row.credential_revision) : row.row.credential_revision,
        increment(row.row.revision),
        now,
        input.slot,
        row.row.revision,
      )
    })

  const credentials = (
    input: Handle,
    update: (value: McpAuthJournalSchema.Credentials) => McpAuthJournalSchema.Credentials,
  ) =>
    store.transaction((db) => {
      const row = requireSlot(db, input)
      requireFlow(db, row, input, Date.now())
      saveCredentials(db, row, update(row.credentials), true)
    })

  const unresolved = (slot: string) =>
    store.read((db) => {
      requireTag(slot)
      return !!db
        .query(
          "SELECT o.operation_id FROM mcp_oauth_operation o JOIN mcp_auth_slot s ON s.slot_key=o.slot_key AND s.generation=o.generation WHERE o.slot_key=? AND o.phase IN ('dispatched','unknown') LIMIT 1",
        )
        .get(slot)
    })

  return {
    read,
    begin,
    current,
    updateFlow,
    clientInformation,
    credentials,
    unresolved,
    dispatch,
    settle,
    revoke,
    close: store.close,
  }
}

function select(db: McpAuthJournalStore.Database, key: string): Snapshot | undefined {
  requireTag(key)
  const row = db.query("SELECT * FROM mcp_auth_slot WHERE slot_key=?").get(key)
  return row ? McpAuthJournalSchema.decodeSlot(row) : undefined
}

function handle(row: Snapshot): Handle {
  if (!row.flow) throw new McpAuthJournalSchema.Error("changed")
  return Object.freeze({
    slot: row.row.slot_key,
    generation: row.row.generation,
    flow: row.flow.id,
    owner: row.flow.owner,
  })
}

function requireSlot(db: McpAuthJournalStore.Database, input: Handle) {
  const row = select(db, input.slot)
  if (!row || row.row.generation !== input.generation || row.flow?.id !== input.flow || row.flow.owner !== input.owner)
    throw new McpAuthJournalSchema.Error("changed")
  return row
}

function requireFlow(db: McpAuthJournalStore.Database, row: Snapshot, input: Handle, now: number, settling?: string) {
  if (
    !row.flow ||
    row.flow.id !== input.flow ||
    row.flow.owner !== input.owner ||
    row.row.generation !== input.generation
  )
    throw new McpAuthJournalSchema.Error("changed")
  if (row.flow.phase === "revoked" || row.flow.phase === "expired") throw new McpAuthJournalSchema.Error("changed")
  if (row.flow.phase === "unknown") throw new McpAuthJournalSchema.Error("unknown")
  if (row.flow.phase !== "connected" && now >= row.flow.expiresAt) throw new McpAuthJournalSchema.Error("expired")
  const unresolved = db
    .query(
      "SELECT operation_id FROM mcp_oauth_operation WHERE slot_key=? AND flow_id=? AND phase IN ('dispatched','unknown') AND operation_id<>? LIMIT 1",
    )
    .get(input.slot, input.flow, settling ?? "")
  if (unresolved) throw new McpAuthJournalSchema.Error("unknown")
}

function requireOperation(db: McpAuthJournalStore.Database, input: Receipt) {
  const value = db.query("SELECT * FROM mcp_oauth_operation WHERE operation_id=?").get(input.operation)
  if (!value) throw new McpAuthJournalSchema.Error("changed")
  const operation = McpAuthJournalSchema.decodeOperation(value)
  if (
    operation.row.slot_key !== input.slot ||
    operation.row.flow_id !== input.flow ||
    operation.row.owner_id !== input.owner ||
    operation.row.generation !== input.generation
  )
    throw new McpAuthJournalSchema.Error("changed")
  return operation
}

function saveCredentials(
  db: McpAuthJournalStore.Database,
  row: Snapshot,
  credentials: McpAuthJournalSchema.Credentials,
  tokens: boolean,
) {
  if ((credentials.tokens && !credentials.tokens.issuer) || (credentials.clientInfo && !credentials.clientInfo.issuer))
    throw new McpAuthJournalSchema.Error("invalid")
  db.query(
    "UPDATE mcp_auth_slot SET credentials=?,credential_revision=?,revision=?,updated_at=? WHERE slot_key=? AND revision=?",
  ).run(
    encode(McpAuthJournalSchema.Credentials, credentials, McpAuthJournalSchema.LIMITS.credentialBytes),
    tokens ? increment(row.row.credential_revision) : row.row.credential_revision,
    increment(row.row.revision),
    Date.now(),
    row.row.slot_key,
    row.row.revision,
  )
}

function requireNewFlow(flow: McpAuthJournalSchema.Flow) {
  const now = Date.now()
  if (
    flow.phase !== "preparing" ||
    flow.createdAt > now ||
    flow.expiresAt <= now ||
    flow.expiresAt - flow.createdAt > McpAuthJournalSchema.LIMITS.lifetimeMs ||
    flow.verifier ||
    flow.discovery ||
    flow.discoveryTag
  )
    throw new McpAuthJournalSchema.Error("invalid")
}

function increment(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER)
    throw new McpAuthJournalSchema.Error("capacity")
  return value + 1
}

function requireTag(value: string) {
  if (!Schema.is(McpAuthJournalSchema.Tag)(value)) throw new McpAuthJournalSchema.Error("invalid")
}

function encode<A>(schema: Schema.Decoder<A>, value: A, maximum: number) {
  const parsed = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value)
  const text = CanonicalJson.stringify(parsed)
  if (Buffer.byteLength(text, "utf8") > maximum) throw new McpAuthJournalSchema.Error("capacity")
  return text
}

export * as McpAuthJournal from "./auth-journal"
