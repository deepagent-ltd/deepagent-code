export * as WorkRouteApproval from "./work-route-approval"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { LocalOperator } from "../im/local-operator"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import type { WorkAuthority } from "./work-authority"
import { WorkRouteApprovalSchema } from "./work-route-approval.schema"
import { WorkRouteApprovalTable } from "./work-route-approval.sql"
import { WorkAuthorityPolicy } from "./work-authority-policy"

type Db = Database.Interface["db"]
type Tx = WorkAuthority.Transaction
type Reader = Pick<Db, "select">
/** No default implementation. The host resolves an opaque live capture, never HTTP proof JSON.
 * These fixed-purpose record operations must keep installation keys outside core. */
export class Authority extends Context.Service<
  Authority,
  {
    readonly captured: (
      handle: object,
    ) => Effect.Effect<WorkRouteApprovalSchema.Evidence, WorkRouteApprovalSchema.Error>
    readonly authenticate: (
      record: WorkRouteApprovalSchema.Record,
    ) => Effect.Effect<string, WorkRouteApprovalSchema.Error>
    readonly verify: (
      record: WorkRouteApprovalSchema.Record,
      mac: string,
    ) => Effect.Effect<void, WorkRouteApprovalSchema.Error>
  }
>()("@deepagent-code/WorkRouteApproval/Authority") {}

export const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
export const failure = (code: WorkRouteApprovalSchema.Error["code"]) =>
  new WorkRouteApprovalSchema.Error({ code, message: "Native route approval is unavailable or changed" })
export const authority = Effect.gen(function* () {
  const value = yield* Effect.serviceOption(Authority)
  if (Option.isNone(value)) return yield* failure("ROUTE_PROOF_UNAVAILABLE")
  return value.value
})
export function decode<A>(schema: Schema.Decoder<A>, input: unknown) {
  const value = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(input)
  return Option.isSome(value) ? Effect.succeed(value.value) : Effect.fail(failure("ROUTE_INVALID_RECORD"))
}

/** Authentication and mirror checks apply even to revoked/expired historical reads. No writes. */
export const get = Effect.fn("WorkRouteApproval.get")(function* (db: Reader, approvalID: string) {
  const size = yield* query(() =>
    db
      .select({ bytes: sql<number>`length(CAST(${WorkRouteApprovalTable.record} AS BLOB))` })
      .from(WorkRouteApprovalTable)
      .where(eq(WorkRouteApprovalTable.approval_id, approvalID))
      .get(),
  )
  if (!size) return undefined
  if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || size.bytes > WorkRouteApprovalSchema.MAX_RECORD_BYTES)
    return yield* failure("ROUTE_INVALID_RECORD")
  const row = yield* query(() =>
    db
      .select()
      .from(WorkRouteApprovalTable)
      .where(
        and(
          eq(WorkRouteApprovalTable.approval_id, approvalID),
          sql`length(CAST(${WorkRouteApprovalTable.record} AS BLOB)) BETWEEN 1 AND ${WorkRouteApprovalSchema.MAX_RECORD_BYTES}`,
        ),
      )
      .get(),
  )
  if (!row) return yield* failure("ROUTE_INVALID_RECORD")
  const record = yield* decode(Schema.fromJsonString(WorkRouteApprovalSchema.Record), row.record)
  if (hash(columns(record, row.record_mac)) !== hash(row)) return yield* failure("ROUTE_INVALID_RECORD")
  if (invalidRecord(record)) return yield* failure("ROUTE_INVALID_RECORD")
  yield* (yield* authority).verify(record, row.record_mac)
  return record
})

export const requireCurrent = Effect.fn("WorkRouteApproval.requireCurrent")(function* (
  tx: Tx,
  approvalID: string,
  now = Date.now(),
) {
  const record = yield* get(tx, approvalID)
  if (!record) return yield* failure("ROUTE_PROOF_UNAVAILABLE")
  if (record.state !== "active") return yield* failure("ROUTE_REVOKED")
  if (record.evidence.expiresAt <= now) return yield* failure("ROUTE_EXPIRED")
  const operator = yield* LocalOperator.requireCurrent(tx)
  const target = operator.policy.targets.find((entry) => entry.id === record.evidence.targetID)
  if (
    operator.instance_id !== record.evidence.instanceID ||
    operator.operator_id !== record.evidence.operatorID ||
    operator.revision !== record.operatorRevision ||
    operator.policy_revision !== record.policyRevision ||
    operator.policy_hash !== record.policyHash ||
    !target ||
    target.target.provider.evidenceID !== record.approvalID ||
    target.target.provider.evidenceHash !== record.evidenceHash ||
    target.target.provider.configurationHash !== record.evidence.configurationStamp ||
    !matches(record.evidence, target)
  )
    return yield* failure("ROUTE_REVISION_CONFLICT")
  yield* LocalOperator.validatePolicy(tx, operator.policy, operator.operator_id)
  return record
})

/** Read-only reconciliation authenticates the current principal and original durable record.
 * It never resolves a live capture or interprets a historical active receipt as current authority. */
export const reconcile = Effect.fn("WorkRouteApproval.reconcile")(function* (
  db: Db,
  input: { requestID: string; identity: WorkRouteApprovalSchema.CommandIdentity },
) {
  yield* decode(WorkRouteApprovalSchema.Text, input.requestID)
  const identity = yield* decode(WorkRouteApprovalSchema.CommandIdentity, input.identity)
  return yield* db.transaction((tx) =>
    Effect.gen(function* () {
      const operator = yield* LocalOperator.requireMutation(tx)
      if (identity.instanceID !== operator.instance_id || identity.operatorID !== operator.operator_id)
        return yield* failure("ROUTE_BINDING_CONFLICT")
      const record = yield* get(tx, commandApprovalID(identity))
      return yield* reconcileCommand(record, input.requestID, identity)
    }),
  )
})

/** Legacy commands can be inspected, but unavailable identity is never inferred from latest evidence. */
export const history = Effect.fn("WorkRouteApproval.history")(function* (
  db: Db,
  input: { targetID: string; requestID: string },
) {
  yield* decode(WorkRouteApprovalSchema.Text, input.targetID)
  yield* decode(WorkRouteApprovalSchema.Text, input.requestID)
  return yield* db.transaction((tx) =>
    Effect.gen(function* () {
      const operator = yield* LocalOperator.requireMutation(tx)
      const record = yield* get(
        tx,
        commandApprovalID({
          instanceID: operator.instance_id,
          operatorID: operator.operator_id,
          targetID: input.targetID,
        }),
      )
      if (!record) return undefined
      const command = record.commands.find((entry) => entry.requestID === input.requestID)
      return {
        currentRecord: toReceipt(record),
        commandReceipt: command?.receipt ?? null,
        commandIdentity: command && identified(command) ? command.identity : null,
        identityAvailability: !command
          ? ("missing" as const)
          : identified(command)
            ? ("available" as const)
            : ("legacy_unavailable" as const),
        authorization: "not_checked" as const,
      }
    }),
  )
})

function commandApprovalID(identity: { instanceID: string; operatorID: string; targetID: string }) {
  return `route_${hash([identity.instanceID, identity.operatorID, identity.targetID])}`
}
function identified(
  command: typeof WorkRouteApprovalSchema.Command.Type,
): command is typeof WorkRouteApprovalSchema.IdentifiedCommand.Type {
  return "identity" in command && "identityHash" in command
}
function reconcileCommand(
  record: WorkRouteApprovalSchema.Record | undefined,
  requestID: string,
  identity: WorkRouteApprovalSchema.CommandIdentity,
) {
  const prior = record?.commands.find((command) => command.requestID === requestID)
  if (!prior) return Effect.succeed(undefined)
  if (!identified(prior)) return Effect.fail(failure("ROUTE_COMMAND_IDENTITY_UNAVAILABLE"))
  return prior.identityHash === hash(identity)
    ? Effect.succeed(prior.receipt)
    : Effect.fail(failure("ROUTE_BINDING_CONFLICT"))
}

/** One SQL owner updates approval and operator policy together. No transport or counter call. */
export const approve = Effect.fn("WorkRouteApproval.approve")(function* (
  db: Db,
  input: {
    capture: object
    identity?: WorkRouteApprovalSchema.CommandIdentity
    requestID: string
    expectedRevision: number
    expectedOperatorRevision: number
    now?: number
  },
) {
  if (input.identity) {
    if (
      input.identity.action !== "approve" ||
      input.identity.expectedRevision !== input.expectedRevision ||
      input.identity.expectedOperatorRevision !== input.expectedOperatorRevision
    )
      return yield* failure("ROUTE_BINDING_CONFLICT")
    const prior = yield* reconcile(db, { requestID: input.requestID, identity: input.identity })
    if (prior) return prior
  }
  const service = yield* authority
  const evidence = yield* decode(WorkRouteApprovalSchema.Evidence, yield* service.captured(input.capture))
  yield* decode(WorkRouteApprovalSchema.Text, input.requestID)
  yield* decode(WorkRouteApprovalSchema.Count, input.expectedRevision)
  yield* decode(WorkRouteApprovalSchema.Revision, input.expectedOperatorRevision)
  const now = input.now ?? Date.now()
  const normalized = WorkAuthorityPolicy.normalizeEndpoint(evidence.endpoint)
  const counter = "counterSemantics" in evidence ? undefined : WorkAuthorityPolicy.normalizeEndpoint(evidence.counterEndpoint)
  if (
    !normalized.ok ||
    normalized.value !== evidence.endpoint ||
    (!("counterSemantics" in evidence) && (!counter?.ok || counter.value !== evidence.counterEndpoint ||
      new URL(evidence.endpoint).origin !== new URL(evidence.counterEndpoint).origin)) ||
    evidence.completionLimit < 16
  )
    return yield* failure("ROUTE_PROOF_UNAVAILABLE")
  const approvalID = commandApprovalID(evidence)
  if (
    input.identity &&
    (commandApprovalID(input.identity) !== approvalID ||
      input.identity.snapshot !== evidence.modelID ||
      input.identity.expiresAt !== evidence.expiresAt)
  )
    return yield* failure("ROUTE_BINDING_CONFLICT")
  const requestHash = hash({
    action: "approve",
    evidence,
    expectedRevision: input.expectedRevision,
    expectedOperatorRevision: input.expectedOperatorRevision,
  })
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const operator = yield* LocalOperator.requireMutation(tx)
        const previous = yield* get(tx, approvalID)
        if (input.identity) {
          if (input.identity.instanceID !== operator.instance_id || input.identity.operatorID !== operator.operator_id)
            return yield* failure("ROUTE_BINDING_CONFLICT")
          const prior = yield* reconcileCommand(previous, input.requestID, input.identity)
          if (prior) return prior
        } else {
          const prior = previous?.commands.find((command) => command.requestID === input.requestID)
          if (prior) {
            if (identified(prior) || prior.requestHash !== requestHash) return yield* failure("ROUTE_BINDING_CONFLICT")
            return prior.receipt
          }
        }
        if (previous?.version === 2 && !input.identity) return yield* failure("ROUTE_COMMAND_IDENTITY_UNAVAILABLE")
        if (evidence.expiresAt <= now) return yield* failure("ROUTE_PROOF_UNAVAILABLE")
        if (
          (previous?.revision ?? 0) !== input.expectedRevision ||
          operator.revision !== input.expectedOperatorRevision
        )
          return yield* failure("ROUTE_REVISION_CONFLICT")
        // Keep the final durable command slot available for revocation.
        if ((previous?.commands.length ?? 0) >= 127) return yield* failure("ROUTE_COMMAND_CAPACITY")
        const target = operator.policy.targets.find((entry) => entry.id === evidence.targetID)
        if (
          !target ||
          operator.instance_id !== evidence.instanceID ||
          operator.operator_id !== evidence.operatorID ||
          !matches(evidence, target) ||
          target.target.provider.providerID !== evidence.providerID ||
          target.target.provider.modelID !== evidence.modelID ||
          evidence.configuredTargetStamp !==
            (previous && target.target.provider.evidenceID === previous.approvalID
              ? previous.evidence.configuredTargetStamp
              : target.target.provider.configurationHash)
        )
          return yield* failure("ROUTE_BINDING_CONFLICT")
        // A second live check is inside the same write transaction; a captured object is no lease.
        if (hash(yield* service.captured(input.capture)) !== hash(evidence)) return yield* failure("CREDENTIAL_DRIFT")
        const evidenceHash = hash(evidence)
        const policy = {
          ...operator.policy,
          targets: operator.policy.targets.map((entry) =>
            entry.id !== evidence.targetID
              ? entry
              : {
                  ...entry,
                  target: {
                    ...entry.target,
                    provider: {
                      providerID: evidence.providerID,
                      modelID: evidence.modelID,
                      routeID: evidence.routeID,
                      protocol: evidence.protocol,
                      configurationHash: evidence.configurationStamp,
                      endpoint: evidence.endpoint,
                      evidenceID: approvalID,
                      evidenceHash,
                      endpointPinned: true,
                      redirectsDenied: true,
                      transportRetriesDenied: true,
                      completion: {
                        parameter: "max_output_tokens",
                        hardLimit: true,
                        includesReasoning: true,
                        maxTokens: evidence.completionLimit,
                      },
                    },
                  },
                },
          ),
        }
        const updated = yield* LocalOperator.updatePolicyInTransaction(tx, {
          expectedRevision: input.expectedOperatorRevision,
          policy,
          now,
        })
        const receipt: WorkRouteApprovalSchema.Receipt = {
          approvalID,
          revision: (previous?.revision ?? 0) + 1,
          state: "active",
          evidenceHash,
          operatorRevision: updated.revision,
          policyRevision: updated.policy_revision,
          credentialGeneration: (previous?.credentialGeneration ?? 0) + 1,
          invalidatedTargetIDs: policy.targets
            .filter((entry) => entry.id !== evidence.targetID)
            .map((entry) => entry.id),
        }
        const record: WorkRouteApprovalSchema.Record = {
          version: input.identity || previous?.version === 2 ? 2 : 1,
          ...receipt,
          evidence,
          policyHash: updated.policy_hash,
          commands: [
            ...(previous?.commands ?? []),
            {
              requestID: input.requestID,
              requestHash,
              action: "approve",
              expectedRevision: input.expectedRevision,
              receipt,
              ...(input.identity ? { identity: input.identity, identityHash: hash(input.identity) } : {}),
            },
          ],
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        }
        if (
          !hasRevocationCapacity(
            record,
            policy.targets.map((entry) => entry.id),
          )
        )
          return yield* failure("ROUTE_COMMAND_CAPACITY")
        yield* save(tx, record, previous)
        return receipt
      }),
    { behavior: "immediate" },
  )
})

export const revoke = Effect.fn("WorkRouteApproval.revoke")(function* (
  db: Db,
  input: {
    approvalID: string
    identity?: WorkRouteApprovalSchema.CommandIdentity
    requestID: string
    expectedRevision: number
    expectedOperatorRevision: number
    now?: number
  },
) {
  if (input.identity) {
    yield* decode(WorkRouteApprovalSchema.CommandIdentity, input.identity)
    if (
      input.identity.action !== "revoke" ||
      commandApprovalID(input.identity) !== input.approvalID ||
      input.identity.expectedRevision !== input.expectedRevision ||
      input.identity.expectedOperatorRevision !== input.expectedOperatorRevision
    )
      return yield* failure("ROUTE_BINDING_CONFLICT")
  }
  const requestHash = hash({
    action: "revoke",
    approvalID: input.approvalID,
    expectedRevision: input.expectedRevision,
    expectedOperatorRevision: input.expectedOperatorRevision,
  })
  yield* decode(WorkRouteApprovalSchema.Text, input.requestID)
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const operator = yield* LocalOperator.requireMutation(tx)
        const previous = yield* get(tx, input.approvalID)
        if (
          !previous ||
          previous.evidence.instanceID !== operator.instance_id ||
          previous.evidence.operatorID !== operator.operator_id
        )
          return yield* failure("ROUTE_PROOF_UNAVAILABLE")
        if (input.identity) {
          if (input.identity.instanceID !== operator.instance_id || input.identity.operatorID !== operator.operator_id)
            return yield* failure("ROUTE_BINDING_CONFLICT")
          const prior = yield* reconcileCommand(previous, input.requestID, input.identity)
          if (prior) return prior
        } else {
          const prior = previous.commands.find((command) => command.requestID === input.requestID)
          if (prior) {
            if (identified(prior) || prior.requestHash !== requestHash) return yield* failure("ROUTE_BINDING_CONFLICT")
            return prior.receipt
          }
        }
        if (previous.version === 2 && !input.identity) return yield* failure("ROUTE_COMMAND_IDENTITY_UNAVAILABLE")
        if (previous.revision !== input.expectedRevision || operator.revision !== input.expectedOperatorRevision)
          return yield* failure("ROUTE_REVISION_CONFLICT")
        if (previous.commands.length >= 128) return yield* failure("ROUTE_COMMAND_CAPACITY")
        const now = input.now ?? Date.now()
        const policy = {
          ...operator.policy,
          targets: operator.policy.targets.map((entry) =>
            entry.id !== previous.evidence.targetID
              ? entry
              : {
                  ...entry,
                  target: {
                    ...entry.target,
                    provider: {
                      ...entry.target.provider,
                      routeID: `configured_${previous.evidence.configuredTargetStamp}`,
                      configurationHash: previous.evidence.configuredTargetStamp,
                      evidenceID: "execution-unavailable",
                      evidenceHash: hash("revoked-native-route"),
                      endpointPinned: false,
                      redirectsDenied: false,
                      transportRetriesDenied: false,
                    },
                  },
                },
          ),
        }
        const updated = yield* LocalOperator.updatePolicyInTransaction(tx, {
          expectedRevision: input.expectedOperatorRevision,
          policy,
          now,
        })
        const receipt: WorkRouteApprovalSchema.Receipt = {
          ...toReceipt(previous),
          state: "revoked",
          revision: previous.revision + 1,
          operatorRevision: updated.revision,
          policyRevision: updated.policy_revision,
          invalidatedTargetIDs: policy.targets.map((entry) => entry.id),
        }
        yield* save(
          tx,
          {
            ...previous,
            ...receipt,
            version: input.identity || previous.version === 2 ? 2 : 1,
            policyHash: updated.policy_hash,
            updatedAt: now,
            commands: [
              ...previous.commands,
              {
                requestID: input.requestID,
                requestHash,
                action: "revoke",
                expectedRevision: input.expectedRevision,
                receipt,
                ...(input.identity ? { identity: input.identity, identityHash: hash(input.identity) } : {}),
              },
            ],
          },
          previous,
        )
        return receipt
      }),
    { behavior: "immediate" },
  )
})

function matches(
  evidence: WorkRouteApprovalSchema.Evidence,
  target: import("../im/local-operator.schema").LocalOperatorSchema.RegisteredTarget,
) {
  return (
    evidence.securityNamespaceID === target.target.scope.securityNamespaceID &&
    evidence.projectScopeKey === target.target.scope.projectScopeKey &&
    evidence.locationKey === target.locationKey &&
    evidence.canonicalRoot === target.target.location.directory &&
    evidence.namespaceBindingHash === target.namespaceBindingHash
  )
}
function toReceipt(record: WorkRouteApprovalSchema.Record): WorkRouteApprovalSchema.Receipt {
  return {
    approvalID: record.approvalID,
    revision: record.revision,
    state: record.state,
    evidenceHash: record.evidenceHash,
    operatorRevision: record.operatorRevision,
    policyRevision: record.policyRevision,
    credentialGeneration: record.credentialGeneration,
    invalidatedTargetIDs: record.invalidatedTargetIDs,
  }
}
function columns(record: WorkRouteApprovalSchema.Record, mac: string) {
  return {
    approval_id: record.approvalID,
    instance_id: record.evidence.instanceID,
    operator_id: record.evidence.operatorID,
    target_id: record.evidence.targetID,
    security_namespace_id: record.evidence.securityNamespaceID,
    project_scope_key: record.evidence.projectScopeKey,
    location_key: record.evidence.locationKey,
    canonical_root: record.evidence.canonicalRoot,
    namespace_binding_hash: record.evidence.namespaceBindingHash,
    state: record.state,
    revision: record.revision,
    operator_revision: record.operatorRevision,
    policy_revision: record.policyRevision,
    credential_generation: record.credentialGeneration,
    evidence_hash: record.evidenceHash,
    configuration_stamp: record.evidence.configurationStamp,
    credential_fingerprint: record.evidence.credentialFingerprint,
    expires_at: record.evidence.expiresAt,
    record: CanonicalJson.stringify(record),
    record_hash: hash(record),
    record_mac: mac,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  }
}
/** A Text request ID has at most 512 UTF-8 bytes. Every one-byte control code can
 * occupy six JSON bytes, so 512 NULs bound every legal encoded ID without narrowing old IDs.
 * The actual targets/receipts/history are retained; safe-integer timestamps use their longest
 * decimal form. This reserves both the 128th slot and the full next revocation record. */
function hasRevocationCapacity(record: WorkRouteApprovalSchema.Record, invalidatedTargetIDs: readonly string[]) {
  const receipt: WorkRouteApprovalSchema.Receipt = {
    ...toReceipt(record),
    state: "revoked",
    revision: record.revision + 1,
    operatorRevision: Number.MAX_SAFE_INTEGER,
    policyRevision: Number.MAX_SAFE_INTEGER,
    invalidatedTargetIDs: [...invalidatedTargetIDs],
  }
  const identity: WorkRouteApprovalSchema.CommandIdentity = {
    version: 1,
    instanceID: record.evidence.instanceID,
    operatorID: record.evidence.operatorID,
    targetID: record.evidence.targetID,
    action: "revoke",
    snapshot: null,
    expiresAt: null,
    expectedRevision: record.revision,
    expectedOperatorRevision: Number.MAX_SAFE_INTEGER - 1,
  }
  const revoked = {
    ...record,
    ...receipt,
    version: 2,
    updatedAt: Number.MAX_SAFE_INTEGER,
    commands: [
      ...record.commands,
      {
        requestID: "\0".repeat(512),
        requestHash: "0".repeat(64),
        action: "revoke",
        expectedRevision: record.revision,
        receipt,
        identity,
        identityHash: hash(identity),
      },
    ],
  }
  return (
    Option.isSome(Schema.decodeUnknownOption(WorkRouteApprovalSchema.Record)(revoked)) &&
    Buffer.byteLength(CanonicalJson.stringify(revoked), "utf8") <= WorkRouteApprovalSchema.MAX_RECORD_BYTES
  )
}

function invalidRecord(record: WorkRouteApprovalSchema.Record) {
  return (
    record.approvalID !==
      `route_${hash([record.evidence.instanceID, record.evidence.operatorID, record.evidence.targetID])}` ||
    record.evidenceHash !== hash(record.evidence) ||
    record.updatedAt < record.createdAt ||
    new Set(record.commands.map((command) => command.requestID)).size !== record.commands.length ||
    hash(record.commands.at(-1)?.receipt) !== hash(toReceipt(record)) ||
    record.commands.some(
      (command, index) =>
        command.receipt.approvalID !== record.approvalID ||
        command.receipt.revision !== index + 1 ||
        command.expectedRevision !== index ||
        command.receipt.state !== (command.action === "approve" ? "active" : "revoked") ||
        (identified(command) &&
          (command.identityHash !== hash(command.identity) ||
            commandApprovalID(command.identity) !== record.approvalID ||
            command.identity.action !== command.action ||
            command.identity.expectedRevision !== command.expectedRevision ||
            command.identity.expectedOperatorRevision + 1 !== command.receipt.operatorRevision)),
    )
  )
}
const save = Effect.fn("WorkRouteApproval.save")(function* (
  tx: Tx,
  record: WorkRouteApprovalSchema.Record,
  previous?: WorkRouteApprovalSchema.Record,
) {
  yield* decode(WorkRouteApprovalSchema.Record, record)
  if (invalidRecord(record) || (previous && record.updatedAt < previous.updatedAt))
    return yield* failure("ROUTE_INVALID_RECORD")
  if (Buffer.byteLength(CanonicalJson.stringify(record), "utf8") > WorkRouteApprovalSchema.MAX_RECORD_BYTES)
    return yield* failure("ROUTE_COMMAND_CAPACITY")
  const mac = yield* (yield* authority).authenticate(record)
  yield* decode(WorkRouteApprovalSchema.Digest, mac)
  if (!previous) {
    yield* query(() => tx.insert(WorkRouteApprovalTable).values(columns(record, mac)).run())
    return
  }
  const row = yield* query(() =>
    tx
      .update(WorkRouteApprovalTable)
      .set(columns(record, mac))
      .where(
        and(
          eq(WorkRouteApprovalTable.approval_id, previous.approvalID),
          eq(WorkRouteApprovalTable.revision, previous.revision),
        ),
      )
      .returning()
      .get(),
  )
  if (!row) return yield* failure("ROUTE_REVISION_CONFLICT")
})

// Drizzle can throw while preparing a native SQLite statement before returning its Effect.
// Capture both preparation and execution errors at the database boundary only.
function query<A, E, R>(execute: () => Effect.Effect<A, E, R>) {
  return Effect.try({ try: execute, catch: () => failure("ROUTE_PROOF_UNAVAILABLE") }).pipe(
    Effect.flatten,
    Effect.mapError(() => failure("ROUTE_PROOF_UNAVAILABLE")),
    Effect.catchDefect(() => Effect.fail(failure("ROUTE_PROOF_UNAVAILABLE"))),
  )
}
