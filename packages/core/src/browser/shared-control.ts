export * as SharedBrowserControl from "./shared-control"

import { and, desc, eq, sql } from "drizzle-orm"
import { Effect, Exit, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionInputTable } from "../session/sql"
import { BrowserControl } from "./control"
import { BrowserControlTable, BrowserActionTable } from "./browser.sql"
import { BrowserSchema } from "./schema"
import { SharedBrowserSchema } from "./shared-schema"
import { SharedBrowserScriptPolicy } from "./shared-script-policy"
import { SharedBrowserPolicy } from "./shared-policy"
import { SharedBrowserFileExchange } from "./shared-file-exchange"
import { SharedBrowserCapacity } from "./shared-capacity"
import { SharedBrowserUserInput } from "./shared-user-input"
import {
  BrowserSharedResourceTable,
  BrowserSharedLeaseTable,
  BrowserSharedRequestTable,
  BrowserSharedActionTable,
} from "./shared.sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import type { V2ToolEffect } from "../session/runner/v2-tool-effect"

type Db = Database.Interface["db"]
type Reader = Pick<Db, "select">
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
export const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
export const failure = BrowserControl.failure
const transaction = <A, E>(db: Db, body: (tx: Tx) => Effect.Effect<A, E>) =>
  db
    .transaction(body, { behavior: "immediate" })
    .pipe(Effect.mapError((error) => (error instanceof BrowserSchema.Error ? error : failure("BROWSER_UNAVAILABLE"))))
const parse = <A>(schema: Schema.Decoder<A>, raw: unknown) => {
  const value = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(raw)
  return Option.isSome(value) ? Effect.succeed(value.value) : Effect.fail(failure("BROWSER_INVALID_RECORD"))
}

export const get = Effect.fn("SharedBrowserControl.get")(function* (db: Reader, resourceID: string) {
  const row = yield* db
    .select()
    .from(BrowserSharedResourceTable)
    .where(eq(BrowserSharedResourceTable.resource_id, resourceID))
    .get()
    .pipe(Effect.mapError(() => failure("BROWSER_UNAVAILABLE")))
  if (!row) return undefined
  const record = yield* parse(Schema.fromJsonString(SharedBrowserSchema.Resource), row.record)
  if (hash(record.policy) !== record.policyHash || hash(resourceColumns(record)) !== hash(row))
    return yield* failure("BROWSER_INVALID_RECORD")
  return record
})
export const lease = Effect.fn("SharedBrowserControl.lease")(function* (db: Reader, leaseID: string) {
  const row = yield* db
    .select()
    .from(BrowserSharedLeaseTable)
    .where(eq(BrowserSharedLeaseTable.lease_id, leaseID))
    .get()
    .pipe(Effect.mapError(() => failure("BROWSER_UNAVAILABLE")))
  if (!row) return undefined
  const record = yield* parse(Schema.fromJsonString(SharedBrowserSchema.Lease), row.record)
  if (hash(leaseColumns(record)) !== hash(row)) return yield* failure("BROWSER_INVALID_RECORD")
  return record
})
export const request = Effect.fn("SharedBrowserControl.request")(function* (
  db: Reader,
  resourceID: string,
  requestID: string,
) {
  const row = yield* db
    .select()
    .from(BrowserSharedRequestTable)
    .where(
      and(eq(BrowserSharedRequestTable.resource_id, resourceID), eq(BrowserSharedRequestTable.request_id, requestID)),
    )
    .get()
    .pipe(Effect.mapError(() => failure("BROWSER_UNAVAILABLE")))
  if (!row) return undefined
  const record = yield* parse(Schema.fromJsonString(SharedBrowserSchema.Receipt), row.record)
  if (hash(requestColumns(record)) !== hash(row)) return yield* failure("BROWSER_INVALID_RECORD")
  return record
})
export const status = (resource: SharedBrowserSchema.Resource): SharedBrowserSchema.Status => ({
  resourceID: resource.resourceID,
  state: resource.state,
  revision: resource.revision,
  manualEpoch: resource.manualEpoch,
  liveLeaseID: resource.liveLeaseID,
  resourceAlive: resource.resourceAlive,
  agentAccessFenced: resource.agentAccessFenced,
  manualEnabled: resource.manualEnabled,
})
export const list = Effect.fn("SharedBrowserControl.list")(function* (db: Reader, scope: BrowserSchema.Scope) {
  const rows = yield* db
    .select({ id: BrowserSharedResourceTable.resource_id })
    .from(BrowserSharedResourceTable)
    .where(
      and(
        eq(BrowserSharedResourceTable.principal, scope.principal),
        eq(BrowserSharedResourceTable.session_id, scope.sessionID),
      ),
    )
    .orderBy(desc(BrowserSharedResourceTable.created_at))
    .limit(BrowserSchema.MAX_CONTROLS)
  const records = yield* Effect.forEach(rows, (row) => get(db, row.id), { concurrency: 1 })
  return records.filter(
    (record): record is SharedBrowserSchema.Resource => !!record && hash(record.scope) === hash(scope),
  )
})

export const create = Effect.fn("SharedBrowserControl.create")(function* (
  db: Db,
  input: {
    request: SharedBrowserSchema.Create
    scope: BrowserSchema.Scope
    mainIncarnation: string
    sidecarIncarnation: string
  },
) {
  yield* parse(SharedBrowserSchema.Create, input.request)
  return yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      yield* BrowserControl.requireScope(tx, input.scope)
      if (input.request.sessionID !== input.scope.sessionID) return yield* failure("BROWSER_SCOPE_DENIED")
      const old = yield* tx
        .select({ id: BrowserSharedResourceTable.resource_id })
        .from(BrowserSharedResourceTable)
        .where(
          and(
            eq(BrowserSharedResourceTable.principal, input.scope.principal),
            eq(BrowserSharedResourceTable.session_id, input.scope.sessionID),
            eq(BrowserSharedResourceTable.request_id, input.request.requestID),
          ),
        )
        .get()
      if (old) {
        const resource = yield* get(tx, old.id)
        if (!resource || resource.requestDigest !== hash(input.request) || hash(resource.scope) !== hash(input.scope))
          return yield* failure("BROWSER_CONFLICT")
        const initial = yield* tx
          .select({ id: BrowserSharedLeaseTable.lease_id })
          .from(BrowserSharedLeaseTable)
          .where(
            and(
              eq(BrowserSharedLeaseTable.resource_id, resource.resourceID),
              eq(BrowserSharedLeaseTable.lease_epoch, 1),
            ),
          )
          .get()
        const initialLease = initial ? yield* lease(tx, initial.id) : undefined
        if (!initialLease) return yield* failure("BROWSER_INVALID_RECORD")
        return { resource, lease: initialLease, created: false }
      }
      const active = yield* tx
        .select({ n: sql<number>`count(*)` })
        .from(BrowserSharedResourceTable)
        .where(
          and(
            eq(BrowserSharedResourceTable.main_incarnation, input.mainIncarnation),
            sql`${BrowserSharedResourceTable.state} NOT IN ('closed','resource_lost')`,
          ),
        )
        .get()
      const legacy = yield* tx
        .select({ n: sql<number>`count(*)` })
        .from(BrowserControlTable)
        .where(
          and(
            eq(BrowserControlTable.host_incarnation, input.sidecarIncarnation),
            sql`${BrowserControlTable.state} IN ('creating','active','cancel_requested','unknown')`,
          ),
        )
        .get()
      if ((active?.n ?? 0) + (legacy?.n ?? 0) >= BrowserSchema.MAX_ACTIVE_CONTROLS)
        return yield* failure("BROWSER_CAPACITY")
      const now = Date.now()
      if (input.request.expiresAt <= now || input.request.expiresAt > now + 3_600_000)
        return yield* failure("BROWSER_EXPIRED")
      yield* SharedBrowserCapacity.reserve(tx, "resource")
      const leaseID = crypto.randomUUID()
      const resource: SharedBrowserSchema.Resource = {
        version: 2,
        profile: SharedBrowserSchema.PROFILE,
        inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
        resourceID: crypto.randomUUID(),
        requestID: input.request.requestID,
        requestDigest: hash(input.request),
        rootSessionID: input.scope.sessionID,
        scope: input.scope,
        mainIncarnation: input.mainIncarnation,
        policy: input.request.policy,
        policyHash: hash(input.request.policy),
        policyRevision: 1,
        state: "creating",
        revision: 1,
        manualEpoch: 0,
        barrierOrder: 0,
        coreCutoff: -1,
        liveLeaseID: leaseID,
        agentAccessFenced: true,
        resourceAlive: false,
        manualEnabled: false,
        createdAt: now,
        updatedAt: now,
        expiresAt: input.request.expiresAt,
      }
      const initialLease: SharedBrowserSchema.Lease = {
        version: 2,
        leaseID,
        controlID: leaseID,
        resourceID: resource.resourceID,
        mainIncarnation: resource.mainIncarnation,
        sidecarIncarnation: input.sidecarIncarnation,
        scope: input.scope,
        policyHash: resource.policyHash,
        leaseEpoch: 1,
        manualEpoch: 0,
        state: "pending",
        originInputID: null,
        requestID: input.request.requestID,
        createdAt: now,
        updatedAt: now,
        expiresAt: resource.expiresAt,
      }
      yield* tx.insert(BrowserSharedResourceTable).values(resourceColumns(resource)).run()
      yield* SharedBrowserCapacity.reserve(tx, "lease")
      yield* tx.insert(BrowserSharedLeaseTable).values(leaseColumns(initialLease)).run()
      return { resource, lease: initialLease, created: true }
    }),
  )
})

export const observeCreated = Effect.fn("SharedBrowserControl.observeCreated")(function* (
  db: Db,
  original: SharedBrowserSchema.Resource,
  observation: SharedBrowserSchema.Observation,
) {
  return yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      const resource = yield* current(tx, original)
      if (resource.state !== "creating" || !resource.liveLeaseID) return yield* failure("BROWSER_CONFLICT")
      const pending = yield* lease(tx, resource.liveLeaseID)
      if (
        !pending ||
        !observationMatches(resource, observation) ||
        observation.leaseID !== pending.leaseID ||
        observation.leaseEpoch !== pending.leaseEpoch ||
        !observation.resourceAlive ||
        observation.agentAccessFenced ||
        observation.manualEnabled
      )
        return yield* failure("BROWSER_AUTHORITY_REQUIRED")
      yield* writeLease(tx, { ...pending, state: "active", updatedAt: Date.now() })
      const record: SharedBrowserSchema.Resource = {
        ...resource,
        state: "agent_owned",
        revision: resource.revision + 1,
        resourceAlive: true,
        agentAccessFenced: false,
        updatedAt: Date.now(),
      }
      yield* writeResource(tx, resource, record)
      return record
    }),
  )
})

/** Main has already fenced. Even a full receipt budget must retain the reducing frontier. */
export const recordBarrier = Effect.fn("SharedBrowserControl.recordBarrier")(function* (
  db: Db,
  ticket: SharedBrowserSchema.BarrierTicket,
) {
  yield* parse(SharedBrowserSchema.BarrierTicket, ticket)
  return yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      const resource = yield* get(tx, ticket.resourceID)
      if (
        !resource ||
        resource.rootSessionID !== ticket.rootSessionID ||
        resource.mainIncarnation !== ticket.mainIncarnation
      )
        return yield* failure("BROWSER_SCOPE_DENIED")
      const prior = yield* request(tx, resource.resourceID, ticket.requestID)
      if (prior) {
        if (prior.kind !== "takeover" || prior.requestDigest !== hash(ticket)) return yield* failure("BROWSER_CONFLICT")
        return { resource, receipt: prior, changed: false }
      }
      if (ticket.manualEpoch === resource.manualEpoch && ticket.barrierOrder === resource.barrierOrder)
        return { resource, receipt: undefined, changed: false }
      // SQL may have committed the last observation before Main received its projection ACK.
      // A trusted reducing ticket may fence that same generation despite this metadata lag;
      // acquire and ordinary actions still require their exact current resource/lease CAS.
      if (
        ticket.expectedRevision > resource.revision ||
        ticket.manualEpoch !== resource.manualEpoch + 1 ||
        ticket.barrierOrder <= resource.barrierOrder ||
        ["closed", "resource_lost"].includes(resource.state)
      )
        return yield* failure("BROWSER_CONFLICT")
      const cutoff = yield* tx
        .select({ n: sql<number | null>`max(${SessionInputTable.admitted_seq})` })
        .from(SessionInputTable)
        .where(sql`${SessionInputTable.session_id}=${resource.rootSessionID}`)
        .get()
      yield* revoke(tx, resource)
      const now = Date.now()
      const budget = yield* SharedBrowserCapacity.reserve(tx, "request").pipe(Effect.exit)
      const record: SharedBrowserSchema.Resource = {
        ...resource,
        state: Exit.isSuccess(budget) ? "takeover_pending" : "recovery_required",
        revision: resource.revision + 1,
        manualEpoch: ticket.manualEpoch,
        barrierOrder: ticket.barrierOrder,
        coreCutoff: cutoff?.n ?? -1,
        liveLeaseID: null,
        agentAccessFenced: true,
        manualEnabled: false,
        updatedAt: now,
      }
      yield* writeResource(tx, resource, record)
      const receipt: SharedBrowserSchema.Receipt | undefined = Exit.isSuccess(budget)
        ? {
            resourceID: resource.resourceID,
            requestID: ticket.requestID,
            kind: "takeover",
            requestDigest: hash(ticket),
            manualEpoch: ticket.manualEpoch,
            state: "pending",
            leaseID: null,
            ticket,
            observation: null,
            createdAt: now,
            updatedAt: now,
          }
        : undefined
      if (receipt) yield* tx.insert(BrowserSharedRequestTable).values(requestColumns(receipt)).run()
      return { resource: record, receipt, changed: true }
    }),
  )
})
export const observeBarrier = Effect.fn("SharedBrowserControl.observeBarrier")(function* (
  db: Db,
  ticket: SharedBrowserSchema.BarrierTicket,
  observation: SharedBrowserSchema.Observation,
) {
  return yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      const resource = yield* get(tx, ticket.resourceID)
      if (
        !resource ||
        resource.manualEpoch !== ticket.manualEpoch ||
        resource.barrierOrder !== ticket.barrierOrder ||
        !observationMatches(resource, observation) ||
        !observation.agentAccessFenced ||
        !observation.leaseRevoked
      )
        return yield* failure("BROWSER_STALE_TARGET")
      const prior = yield* request(tx, resource.resourceID, ticket.requestID)
      if (prior?.state === "completed") {
        if (hash(prior.observation) !== hash(observation)) return yield* failure("BROWSER_CONFLICT")
        return resource
      }
      const safe = observation.inputIsolated && observation.heldReleased && observation.transportStopped
      const record: SharedBrowserSchema.Resource = {
        ...resource,
        revision: resource.revision + 1,
        state: !observation.resourceAlive
          ? "resource_lost"
          : safe && observation.manualEnabled
            ? "human_owned"
            : "fenced_blocked",
        resourceAlive: observation.resourceAlive,
        manualEnabled: observation.resourceAlive && safe && observation.manualEnabled,
        agentAccessFenced: true,
        liveLeaseID: null,
        updatedAt: Date.now(),
      }
      yield* writeResource(tx, resource, record)
      if (prior)
        yield* writeRequest(tx, {
          ...prior,
          state: !observation.resourceAlive || (safe && observation.manualEnabled) ? "completed" : "unknown",
          observation,
          updatedAt: Date.now(),
        })
      return record
    }),
  )
})

export const approveOrigin = Effect.fn("SharedBrowserControl.approveOrigin")(function* (
  db: Db,
  original: SharedBrowserSchema.Resource,
  input: SharedBrowserSchema.ApproveOrigin,
  check: () => Effect.Effect<void, BrowserSchema.Error>,
) {
  yield* parse(SharedBrowserSchema.ApproveOrigin, input)
  return yield* transaction(db, (tx) => Effect.gen(function* () {
    yield* BrowserControl.requireScope(tx, original.scope)
    const resource = yield* get(tx, input.resourceID)
    if (!resource || hash(resource.scope) !== hash(original.scope)) return yield* failure("BROWSER_SCOPE_DENIED")
    const prior = resource.policyApprovals?.find((receipt) => receipt.requestID === input.requestID)
    if (prior) {
      if (prior.requestHash !== hash(input) || resource.manualEpoch !== input.expectedManualEpoch)
        return yield* failure("BROWSER_CONFLICT")
      return resource
    }
    if (hash(resource) !== hash(original) || resource.revision !== input.expectedRevision ||
      resource.policyHash !== input.expectedPolicyHash || resource.manualEpoch !== input.expectedManualEpoch ||
      resource.state !== "human_owned" || !resource.resourceAlive || !resource.manualEnabled ||
      !resource.agentAccessFenced || resource.liveLeaseID || resource.expiresAt <= Date.now() ||
      resource.policy.manualApprovedOrigins.includes(input.origin)) return yield* failure("BROWSER_CONFLICT")
    yield* check()
    const policy = yield* parse(SharedBrowserSchema.Policy, { ...resource.policy,
      manualApprovedOrigins: [...resource.policy.manualApprovedOrigins, input.origin] })
    const revision = resource.revision + 1
    const policyRevision = (resource.policyRevision ?? 1) + 1
    const record: SharedBrowserSchema.Resource = { ...resource, policy, policyHash: hash(policy), policyRevision,
      revision, updatedAt: Date.now(), policyApprovals: [...(resource.policyApprovals ?? []), {
        requestID: input.requestID, requestHash: hash(input), manualEpoch: resource.manualEpoch,
        baseRevision: resource.revision, revision, policyRevision, policyHash: hash(policy),
      }] }
    if (new TextEncoder().encode(CanonicalJson.stringify(record)).byteLength > BrowserSchema.MAX_CONTROL_BYTES)
      return yield* failure("BROWSER_CAPACITY")
    yield* writeResource(tx, resource, record)
    return record
  }))
})

export const prepareAcquire = Effect.fn("SharedBrowserControl.prepareAcquire")(function* (
  db: Db,
  input: {
    request: SharedBrowserSchema.Acquire
    scope: BrowserSchema.Scope
    sidecarIncarnation: string
    witness: SharedBrowserSchema.UserWitness
    expiresAt?: number
    policy?: { expectedHash: string; approvedOrigins: readonly string[] }
  },
  check?: (tx: Tx) => Effect.Effect<void, BrowserSchema.Error>,
) {
  return yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      if (check) yield* check(tx)
      yield* BrowserControl.requireScope(tx, input.scope)
      const resource = yield* get(tx, input.request.resourceID)
      if (!resource || hash(resource.scope) !== hash(input.scope)) return yield* failure("BROWSER_SCOPE_DENIED")
      const digest = hash({
        request: input.request,
        scope: input.scope,
        witness: input.witness,
        sidecarIncarnation: input.sidecarIncarnation,
      })
      const prior = yield* request(tx, resource.resourceID, input.request.requestID)
      if (prior) {
        if (prior.kind !== "acquire" || prior.requestDigest !== digest || !prior.leaseID)
          return yield* failure("BROWSER_CONFLICT")
        const existing = yield* lease(tx, prior.leaseID)
        if (!existing) return yield* failure("BROWSER_INVALID_RECORD")
        return { resource, lease: existing, receipt: prior, created: false }
      }
      if (
        resource.state !== "human_owned" ||
        resource.manualEpoch !== input.request.expectedManualEpoch ||
        !resource.agentAccessFenced ||
        !resource.manualEnabled ||
        !resource.resourceAlive ||
        resource.liveLeaseID
      )
        return yield* failure("BROWSER_CONFLICT")
      const witness = yield* SharedBrowserUserInput.witness(tx, input.witness.providerReceiptID)
      if (
        !witness ||
        hash(witness) !== hash(input.witness) ||
        witness.rootSessionID !== resource.rootSessionID ||
        witness.mainIncarnation !== resource.mainIncarnation ||
        witness.submissionOrder <= resource.barrierOrder ||
        witness.admittedSeq <= resource.coreCutoff
      )
        return yield* failure("BROWSER_AUTHORITY_REQUIRED")
      const consumed = yield* tx
        .select({ id: BrowserSharedLeaseTable.lease_id })
        .from(BrowserSharedLeaseTable)
        .where(
          and(
            eq(BrowserSharedLeaseTable.resource_id, resource.resourceID),
            eq(BrowserSharedLeaseTable.origin_input_id, witness.inputID),
          ),
        )
        .get()
      if (consumed) return yield* failure("BROWSER_CONFLICT")
      const now = Date.now()
      const policy = input.policy ? SharedBrowserPolicy.agent(resource.policy, input.policy.approvedOrigins) : resource.policy
      if (!policy || input.policy && input.policy.expectedHash !== resource.policyHash)
        return yield* failure("BROWSER_SCOPE_DENIED")
      const policyChanged = !SharedBrowserPolicy.same(policy, resource.policy)
      const expiry = Math.min(input.expiresAt ?? resource.expiresAt, resource.expiresAt)
      if (expiry <= now) return yield* failure("BROWSER_EXPIRED")
      const latest = yield* tx
        .select({ n: sql<number>`max(${BrowserSharedLeaseTable.lease_epoch})` })
        .from(BrowserSharedLeaseTable)
        .where(eq(BrowserSharedLeaseTable.resource_id, resource.resourceID))
        .get()
      const leaseID = crypto.randomUUID()
      const next: SharedBrowserSchema.Lease = {
        version: 2,
        leaseID,
        controlID: leaseID,
        resourceID: resource.resourceID,
        mainIncarnation: resource.mainIncarnation,
        sidecarIncarnation: input.sidecarIncarnation,
        scope: resource.scope,
        policyHash: hash(policy),
        leaseEpoch: (latest?.n ?? 0) + 1,
        manualEpoch: resource.manualEpoch,
        state: "pending",
        originInputID: witness.inputID,
        requestID: input.request.requestID,
        createdAt: now,
        updatedAt: now,
        expiresAt: expiry,
      }
      yield* SharedBrowserCapacity.reserve(tx, "lease")
      yield* tx.insert(BrowserSharedLeaseTable).values(leaseColumns(next)).run()
      yield* SharedBrowserCapacity.reserve(tx, "request")
      const receipt: SharedBrowserSchema.Receipt = {
        resourceID: resource.resourceID,
        requestID: input.request.requestID,
        kind: "acquire",
        requestDigest: digest,
        manualEpoch: resource.manualEpoch,
        state: "pending",
        leaseID,
        ticket: null,
        observation: null,
        createdAt: now,
        updatedAt: now,
      }
      yield* tx.insert(BrowserSharedRequestTable).values(requestColumns(receipt)).run()
      const record: SharedBrowserSchema.Resource = {
        ...resource,
        policy,
        policyHash: hash(policy),
        ...(policyChanged ? { policyRevision: (resource.policyRevision ?? 1) + 1 } : {}),
        state: "acquire_pending",
        revision: resource.revision + 1,
        liveLeaseID: leaseID,
        manualEnabled: false,
        updatedAt: now,
      }
      yield* writeResource(tx, resource, record)
      return { resource: record, lease: next, receipt, created: true }
    }),
  )
})
export const observeAcquire = Effect.fn("SharedBrowserControl.observeAcquire")(function* (
  db: Db,
  original: SharedBrowserSchema.Resource,
  pending: SharedBrowserSchema.Lease,
  observation: SharedBrowserSchema.Observation,
) {
  return yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      const resource = yield* current(tx, original)
      const existing = yield* lease(tx, pending.leaseID)
      if (
        !existing ||
        hash(existing) !== hash(pending) ||
        resource.state !== "acquire_pending" ||
        resource.liveLeaseID !== pending.leaseID ||
        !observationMatches(resource, observation)
      )
        return yield* failure("BROWSER_STALE_TARGET")
      const active =
        observation.resourceAlive &&
        !observation.agentAccessFenced &&
        !observation.manualEnabled &&
        observation.leaseID === pending.leaseID &&
        observation.leaseEpoch === pending.leaseEpoch
      yield* writeLease(tx, { ...existing, state: active ? "active" : "unknown", updatedAt: Date.now() })
      const record: SharedBrowserSchema.Resource = {
        ...resource,
        revision: resource.revision + 1,
        state: active
          ? "agent_owned"
          : observation.inputIsolated && observation.manualEnabled
            ? "human_owned"
            : "fenced_blocked",
        liveLeaseID: active ? pending.leaseID : null,
        agentAccessFenced: !active,
        resourceAlive: observation.resourceAlive,
        manualEnabled: !active && observation.inputIsolated && observation.manualEnabled,
        updatedAt: Date.now(),
      }
      yield* writeResource(tx, resource, record)
      const prior = yield* request(tx, resource.resourceID, pending.requestID)
      if (!prior) return yield* failure("BROWSER_INVALID_RECORD")
      yield* writeRequest(tx, { ...prior, state: active ? "completed" : "unknown", observation, updatedAt: Date.now() })
      return record
    }),
  )
})

export const prepareClose = Effect.fn("SharedBrowserControl.prepareClose")(function* (
  db: Db,
  original: SharedBrowserSchema.Resource,
  input: SharedBrowserSchema.Close,
) {
  return yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      const resource = yield* current(tx, original)
      const prior = yield* request(tx, resource.resourceID, input.requestID)
      if (prior) {
        if (prior.kind !== "close" || prior.requestDigest !== hash(input)) return yield* failure("BROWSER_CONFLICT")
        // A failed reducing cleanup may be retried under the original close identity. It does
        // not repeat a webpage action, mint another lease or consume a new request slot.
        if (prior.state === "unknown" && ["recovery_required", "fenced_blocked"].includes(resource.state)) {
          const retry: SharedBrowserSchema.Resource = { ...resource, state: "closing", liveLeaseID: null,
            agentAccessFenced: true, manualEnabled: false, revision: resource.revision + 1, updatedAt: Date.now() }
          const receipt: SharedBrowserSchema.Receipt = { ...prior, manualEpoch: resource.manualEpoch,
            state: "pending", updatedAt: retry.updatedAt }
          yield* revoke(tx, resource)
          yield* writeResource(tx, resource, retry)
          yield* writeRequest(tx, receipt)
          return { resource: retry, receipt, changed: true }
        }
        return { resource, receipt: prior, changed: false }
      }
      if (resource.revision !== input.expectedRevision) return yield* failure("BROWSER_CONFLICT")
      yield* revoke(tx, resource)
      const now = Date.now()
      const budget = yield* SharedBrowserCapacity.reserve(tx, "request").pipe(Effect.exit)
      const record: SharedBrowserSchema.Resource = {
        ...resource,
        state: "closing",
        liveLeaseID: null,
        agentAccessFenced: true,
        manualEnabled: false,
        revision: resource.revision + 1,
        updatedAt: now,
      }
      yield* writeResource(tx, resource, record)
      const receipt: SharedBrowserSchema.Receipt | undefined = Exit.isSuccess(budget)
        ? {
            resourceID: resource.resourceID,
            requestID: input.requestID,
            kind: "close",
            requestDigest: hash(input),
            manualEpoch: resource.manualEpoch,
            state: "pending",
            leaseID: null,
            ticket: null,
            observation: null,
            createdAt: now,
            updatedAt: now,
          }
        : undefined
      if (receipt) yield* tx.insert(BrowserSharedRequestTable).values(requestColumns(receipt)).run()
      return { resource: record, receipt, changed: true }
    }),
  )
})
export const observeClose = Effect.fn("SharedBrowserControl.observeClose")(function* (
  db: Db,
  original: SharedBrowserSchema.Resource,
  requestID: string,
  observation: SharedBrowserSchema.Observation,
) {
  return yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      const resource = yield* current(tx, original)
      const prior = yield* request(tx, resource.resourceID, requestID)
      // Only the reducing close path may adopt a newer Main barrier: lease expiry can fence
      // before Core receives its ticket. The exact current closing row and private Host reply
      // still own this settlement; ordinary reads/actions retain observationMatches equality.
      const sameFrontier = observation.manualEpoch === resource.manualEpoch &&
        observation.barrierOrder === resource.barrierOrder
      const newerFrontier = observation.manualEpoch > resource.manualEpoch &&
        observation.barrierOrder > resource.barrierOrder
      if (resource.state !== "closing" || observation.resourceID !== resource.resourceID ||
        observation.mainIncarnation !== resource.mainIncarnation || (!sameFrontier && !newerFrontier) ||
        !observation.agentAccessFenced || observation.manualEnabled ||
        (prior && (prior.kind !== "close" || prior.manualEpoch !== resource.manualEpoch)))
        return yield* failure("BROWSER_CONFLICT")
      const closed = !observation.resourceAlive && observation.leaseRevoked && observation.leaseID === null &&
        observation.inputIsolated && observation.heldReleased && observation.transportStopped
      const record: SharedBrowserSchema.Resource = {
        ...resource,
        state: closed ? "closed" : "recovery_required",
        manualEpoch: observation.manualEpoch,
        barrierOrder: observation.barrierOrder,
        liveLeaseID: null,
        resourceAlive: observation.resourceAlive,
        manualEnabled: false,
        agentAccessFenced: true,
        revision: resource.revision + 1,
        updatedAt: Date.now(),
      }
      yield* writeResource(tx, resource, record)
      if (prior)
        yield* writeRequest(tx, {
          ...prior,
          observation,
          manualEpoch: observation.manualEpoch,
          state: closed ? "completed" : "unknown",
          updatedAt: Date.now(),
        })
      return record
    }),
  )
})
export const requireActive = Effect.fn("SharedBrowserControl.requireActive")(function* (
  db: Reader,
  resourceID: string,
  scope: BrowserSchema.Scope,
) {
  const resource = yield* get(db, resourceID)
  if (!resource || hash(resource.scope) !== hash(scope)) return yield* failure("BROWSER_SCOPE_DENIED")
  if (
    resource.state !== "agent_owned" ||
    resource.agentAccessFenced ||
    resource.manualEnabled ||
    !resource.resourceAlive ||
    !resource.liveLeaseID
  )
    return yield* failure("BROWSER_CANCELLED")
  const active = yield* lease(db, resource.liveLeaseID)
  if (
    !active ||
    active.state !== "active" ||
    active.manualEpoch !== resource.manualEpoch ||
    active.mainIncarnation !== resource.mainIncarnation ||
    active.policyHash !== resource.policyHash ||
    hash(active.scope) !== hash(scope)
  )
    return yield* failure("BROWSER_AUTHORITY_REQUIRED")
  if (active.expiresAt <= Date.now()) return yield* failure("BROWSER_EXPIRED")
  return { resource, lease: active }
})

export const getAction = Effect.fn("SharedBrowserControl.getAction")(function* (db: Reader, actionID: string) {
  const row = yield* db
    .select()
    .from(BrowserSharedActionTable)
    .where(eq(BrowserSharedActionTable.action_id, actionID))
    .get()
  if (!row) return undefined
  const record = yield* parse(Schema.fromJsonString(SharedBrowserSchema.ActionRecord), row.record)
  if (hash(actionColumns(record)) !== hash(row)) return yield* failure("BROWSER_INVALID_RECORD")
  return record
})
export const prepareAction = Effect.fn("SharedBrowserControl.prepareAction")(function* (
  db: Db,
  input: {
    resource: SharedBrowserSchema.Resource
    lease: SharedBrowserSchema.Lease
    command: BrowserSchema.Command
    admission: V2ToolEffect.ToolEffectAdmission
    timeoutMs: number
  },
  check: (tx: Tx) => Effect.Effect<void, BrowserSchema.Error>,
) {
  yield* parse(BrowserSchema.Command, input.command)
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > BrowserSchema.MAX_TIMEOUT_MS)
    return yield* failure("BROWSER_INVALID_RECORD")
  return yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      yield* check(tx)
      const active = yield* requireActive(tx, input.resource.resourceID, input.resource.scope)
      if (
        hash(active.resource) !== hash(input.resource) ||
        hash(active.lease) !== hash(input.lease) ||
        input.admission.sessionId !== active.resource.rootSessionID ||
        input.admission.toolName !== "browser"
      )
        return yield* failure("BROWSER_STALE_TARGET")
      if (input.command.type === "api.post" || input.command.type.startsWith("clipboard."))
        return yield* failure("BROWSER_SCOPE_DENIED")
      if (input.command.type === "evaluate") {
        const command = input.command
        if (!SharedBrowserScriptPolicy.allowsScript(active.resource.policy, command))
          return yield* failure("BROWSER_SCOPE_DENIED")
      }
      if (input.command.type === "program") {
        const command = input.command
        if (!SharedBrowserScriptPolicy.allowsProgram(active.resource.policy, command))
          return yield* failure("BROWSER_SCOPE_DENIED")
      }
      if (input.command.type.startsWith("file.") && !active.resource.policy.filePolicy)
        return yield* failure("BROWSER_SCOPE_DENIED")
      if (
        "url" in input.command &&
        input.command.url &&
        (!URL.canParse(input.command.url) ||
          !active.resource.policy.approvedOrigins.includes(new URL(input.command.url).origin))
      )
        return yield* failure("BROWSER_NETWORK_DENIED")
      const prior = yield* tx
        .select({ id: BrowserSharedActionTable.action_id })
        .from(BrowserSharedActionTable)
        .where(eq(BrowserSharedActionTable.admission_id, input.admission.admissionId))
        .get()
      if (prior) return yield* failure("BROWSER_UNKNOWN")
      const waiting = yield* tx
        .select({ n: sql<number>`count(*)` })
        .from(BrowserSharedActionTable)
        .where(eq(BrowserSharedActionTable.outcome, "pending"))
        .get()
      const oldWaiting = yield* tx
        .select({ n: sql<number>`count(*)` })
        .from(BrowserActionTable)
        .where(eq(BrowserActionTable.outcome, "pending"))
        .get()
      if ((waiting?.n ?? 0) + (oldWaiting?.n ?? 0) >= BrowserSchema.MAX_WAITING + 1)
        return yield* failure("BROWSER_CAPACITY")
      yield* SharedBrowserCapacity.reserve(tx, "shared_action")
      const now = Date.now()
      const action: SharedBrowserSchema.ActionRecord = {
        actionID: crypto.randomUUID(),
        resourceID: active.resource.resourceID,
        leaseID: active.lease.leaseID,
        leaseEpoch: active.lease.leaseEpoch,
        manualEpoch: active.resource.manualEpoch,
        admissionID: input.admission.admissionId,
        providerReceiptID: input.admission.receiptId,
        providerAttemptID: input.admission.providerAttemptId,
        toolCallID: input.admission.toolCallId,
        rootSessionID: active.resource.rootSessionID,
        command: input.command,
        commandHash: hash(input.command),
        deadline: Math.min(active.lease.expiresAt, now + input.timeoutMs),
        outcome: "pending",
        result: null,
        errorCode: null,
        createdAt: now,
        updatedAt: now,
      }
      yield* tx.insert(BrowserSharedActionTable).values(actionColumns(action)).run()
      if (input.command.type === "file.upload" || input.command.type === "file.download")
        yield* SharedBrowserFileExchange.reserveArtifactsInTransaction(tx, { resource: active.resource, lease: active.lease, action,
          grantIDs: input.command.type === "file.upload" ? input.command.grantIDs : [input.command.grantID] }).pipe(
            Effect.mapError((error) => failure(error.code === "BROWSER_FILE_CAPACITY" ? "BROWSER_CAPACITY" : "BROWSER_SCOPE_DENIED")))
      return action
    }),
  )
})
export const observeAction = Effect.fn("SharedBrowserControl.observeAction")(function* (
  db: Db,
  original: SharedBrowserSchema.ActionRecord,
  observation: {
    outcome: "completed" | "cancelled" | "unknown"
    result?: BrowserSchema.Result
    errorCode?: BrowserSchema.Error["code"]
  },
) {
  return yield* transaction(db, (tx) =>
    Effect.gen(function* () {
      const prior = yield* getAction(tx, original.actionID)
      if (
        !prior ||
        hash(prior) !== hash(original) ||
        prior.outcome !== "pending" ||
        (observation.outcome === "completed") !== (observation.result !== undefined)
      )
        return yield* failure("BROWSER_CONFLICT")
      const record: SharedBrowserSchema.ActionRecord = {
        ...prior,
        outcome: observation.outcome,
        result: observation.result ?? null,
        errorCode: observation.errorCode ?? null,
        updatedAt: Date.now(),
      }
      const changed = yield* tx
        .update(BrowserSharedActionTable)
        .set(actionColumns(record))
        .where(
          and(
            eq(BrowserSharedActionTable.action_id, prior.actionID),
            eq(BrowserSharedActionTable.record_hash, hash(prior)),
          ),
        )
        .returning()
      if (changed.length !== 1) return yield* failure("BROWSER_CONFLICT")
      return record
    }),
  )
})

function current(db: Reader, expected: SharedBrowserSchema.Resource) {
  return get(db, expected.resourceID).pipe(
    Effect.flatMap((value) =>
      value && hash(value) === hash(expected) ? Effect.succeed(value) : Effect.fail(failure("BROWSER_CONFLICT")),
    ),
  )
}
function observationMatches(resource: SharedBrowserSchema.Resource, observation: SharedBrowserSchema.Observation) {
  return (
    observation.resourceID === resource.resourceID &&
    observation.mainIncarnation === resource.mainIncarnation &&
    observation.manualEpoch === resource.manualEpoch &&
    observation.barrierOrder === resource.barrierOrder
  )
}
function writeResource(tx: Tx, previous: SharedBrowserSchema.Resource, record: SharedBrowserSchema.Resource) {
  return Effect.gen(function* () {
    yield* parse(SharedBrowserSchema.Resource, record)
    const changed = yield* tx
      .update(BrowserSharedResourceTable)
      .set(resourceColumns(record))
      .where(
        and(
          eq(BrowserSharedResourceTable.resource_id, previous.resourceID),
          eq(BrowserSharedResourceTable.revision, previous.revision),
          eq(BrowserSharedResourceTable.record_hash, hash(previous)),
        ),
      )
      .returning()
    if (changed.length !== 1) return yield* failure("BROWSER_CONFLICT")
  })
}
function writeLease(tx: Tx, record: SharedBrowserSchema.Lease) {
  return tx
    .update(BrowserSharedLeaseTable)
    .set(leaseColumns(record))
    .where(eq(BrowserSharedLeaseTable.lease_id, record.leaseID))
    .run()
}
function writeRequest(tx: Tx, record: SharedBrowserSchema.Receipt) {
  return tx
    .update(BrowserSharedRequestTable)
    .set(requestColumns(record))
    .where(
      and(
        eq(BrowserSharedRequestTable.resource_id, record.resourceID),
        eq(BrowserSharedRequestTable.request_id, record.requestID),
      ),
    )
    .run()
}
function revoke(tx: Tx, resource: SharedBrowserSchema.Resource) {
  return Effect.gen(function* () {
    if (!resource.liveLeaseID) return
    const existing = yield* lease(tx, resource.liveLeaseID)
    if (existing && ["pending", "active"].includes(existing.state))
      yield* writeLease(tx, { ...existing, state: "revoked", updatedAt: Date.now() })
  })
}
function resourceColumns(r: SharedBrowserSchema.Resource) {
  return {
    resource_id: r.resourceID,
    request_id: r.requestID,
    request_digest: r.requestDigest,
    principal: r.scope.principal,
    session_id: r.rootSessionID,
    main_incarnation: r.mainIncarnation,
    state: r.state,
    revision: r.revision,
    manual_epoch: r.manualEpoch,
    barrier_order: r.barrierOrder,
    core_cutoff: r.coreCutoff,
    live_lease_id: r.liveLeaseID,
    record: CanonicalJson.stringify(r),
    record_hash: hash(r),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }
}
function leaseColumns(r: SharedBrowserSchema.Lease) {
  return {
    lease_id: r.leaseID,
    resource_id: r.resourceID,
    request_id: r.requestID,
    session_id: r.scope.sessionID,
    main_incarnation: r.mainIncarnation,
    sidecar_incarnation: r.sidecarIncarnation,
    lease_epoch: r.leaseEpoch,
    manual_epoch: r.manualEpoch,
    state: r.state,
    origin_input_id: r.originInputID,
    record: CanonicalJson.stringify(r),
    record_hash: hash(r),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }
}
function requestColumns(r: SharedBrowserSchema.Receipt) {
  return {
    resource_id: r.resourceID,
    request_id: r.requestID,
    kind: r.kind,
    request_digest: r.requestDigest,
    manual_epoch: r.manualEpoch,
    state: r.state,
    lease_id: r.leaseID,
    record: CanonicalJson.stringify(r),
    record_hash: hash(r),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }
}
function actionColumns(r: SharedBrowserSchema.ActionRecord) {
  const record = CanonicalJson.stringify(r)
  return {
    action_id: r.actionID,
    admission_id: r.admissionID,
    resource_id: r.resourceID,
    lease_id: r.leaseID,
    outcome: r.outcome,
    record,
    record_hash: hash(r),
  }
}
