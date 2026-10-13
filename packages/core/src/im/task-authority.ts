export * as IMTaskAuthority from "./task-authority"

import { and, eq, or, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { LocationIdentityTable, ProjectScopeIdentityTable, SecurityNamespaceTable } from "../context-federation/sql"
import { DeepAgentEventTable } from "../deepagent/deepagent-event-sql"
import { WorkAuthority } from "../session/work-authority"
import { WorkAuthorityPolicy } from "../session/work-authority-policy"
import { WorkAuthoritySchema } from "../session/work-authority.schema"
import { WorkDispatchReservationTable, WorkExecutionTable } from "../session/work-authority.sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { GroupTable, MemberTable, MessageTable } from "./sql"
import { IMMentionIntentTable } from "./mention-intent.sql"
import { IMTaskAuthoritySchema } from "./task-authority.schema"
import { IMTaskGrantTable, IMTaskRequestTable, IMTaskSourceTable } from "./task-authority.sql"
import { KernelTaskSnapshot } from "./kernel-task-snapshot"
import { LocalOperator } from "./local-operator"
import { IMTaskStatusNoticeTable } from "./task-status-notice.sql"

type Db = Database.Interface["db"]
type Tx = WorkAuthority.Transaction
type Principal = IMTaskAuthoritySchema.Principal
type Target = IMTaskAuthoritySchema.Target
type Error = IMTaskAuthoritySchema.Error
export type Source = typeof IMTaskSourceTable.$inferSelect
export type Request = typeof IMTaskRequestTable.$inferSelect
export type Grant = typeof IMTaskGrantTable.$inferSelect

/** Host-authenticated internal services. No default implementation and no payload proof path.
 * Each method must read trusted local authority in this transaction; no network or model I/O.
 * verifyOperator is a durable identity check, independent of an interactive login's lifetime. */
export class Authority extends Context.Service<
  Authority,
  {
    readonly authenticateMutation: (
      tx: Tx,
      action: "propose" | "accept" | "revoke" | "read",
    ) => Effect.Effect<Principal, Error>
    readonly verifyOperator: (tx: Tx, principal: Principal) => Effect.Effect<Principal, Error>
    readonly verifySource: (tx: Tx, messageID: string) => Effect.Effect<IMTaskAuthoritySchema.SourceProof, Error>
    readonly authorizeTarget: (
      tx: Tx,
      principal: Principal,
      target: Target,
      source: Source,
    ) => Effect.Effect<IMTaskAuthoritySchema.TargetProof, Error>
  }
>()("@deepagent-code/IMTaskAuthority/Authority") {}

const DAY = 24 * 60 * 60 * 1_000
const digest = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
const service = Effect.gen(function* () {
  const value = yield* Effect.serviceOption(Authority)
  if (Option.isNone(value))
    return yield* failure("IM_TASK_AUTHORITY_UNAVAILABLE", "Trusted task identity authority is unavailable")
  return value.value
})

/** Proposing stores no Session/input/Work row and never creates an execution permission. */
export const propose = Effect.fn("IMTaskAuthority.propose")(function* (
  db: Db,
  input: {
    readonly clientRequestID: string
    readonly messageID: string
    readonly auditedText: string
    readonly target: unknown
    readonly expiresAt?: number
    readonly now?: number
  },
) {
  const candidate = yield* decode(IMTaskAuthoritySchema.Target, input.target)
  const endpoint = WorkAuthorityPolicy.normalizeEndpoint(candidate.provider.endpoint)
  if (!endpoint.ok) return yield* failure("IM_TASK_INVALID_REQUEST", "Task provider endpoint is invalid")
  const target = { ...candidate, provider: { ...candidate.provider, endpoint: endpoint.value } }
  if (
    !validID(input.clientRequestID) ||
    !validID(input.messageID) ||
    typeof input.auditedText !== "string" ||
    Buffer.byteLength(input.auditedText) > WorkAuthorityPolicy.TEXT_ONLY_PROFILE.maxAuditedTextBytes
  )
    return yield* failure("IM_TASK_INVALID_REQUEST", "Task proposal identity or audited text is invalid")
  const now = input.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const authority = yield* service
        const principal = yield* authenticated(tx, authority, "propose")
        const source = yield* captureSource(tx, authority, principal.instanceID, input.messageID, now)
        yield* targetProof(tx, authority, principal, source, target)
        const id = `imreq_${digest([principal.instanceID, principal.actorID, input.clientRequestID])}`
        const prior = yield* tx.select().from(IMTaskRequestTable).where(eq(IMTaskRequestTable.request_id, id)).get()
        const expiresAt = input.expiresAt ?? prior?.expires_at ?? now + DAY
        const hash = requestHash(
          {
            source_id: source.source_id,
            instance_id: principal.instanceID,
            actor_id: principal.actorID,
            audited_text: input.auditedText,
            target,
            expires_at: expiresAt,
            result_key: `imresult_${digest([id, 1])}`,
          },
          source,
        )
        if (prior) {
          if (prior.request_hash !== hash)
            return yield* failure(
              "IM_TASK_IDENTITY_CONFLICT",
              "Task request identity was reused with different review content",
            )
          if (prior.expires_at <= now && prior.state !== "accepted")
            return yield* failure("IM_TASK_EXPIRED", "Task proposal expired")
          return prior
        }
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + DAY)
          return yield* failure("IM_TASK_EXPIRED", "Task proposal expiry exceeds the fixed review window")
        const row = yield* tx
          .insert(IMTaskRequestTable)
          .values({
            request_id: id,
            client_request_id: input.clientRequestID,
            source_id: source.source_id,
            instance_id: principal.instanceID,
            actor_id: principal.actorID,
            request_hash: hash,
            audited_text: input.auditedText,
            audited_text_hash: Hash.sha256(input.auditedText),
            target,
            result_key: `imresult_${digest([id, 1])}`,
            state: "proposed",
            revision: 1,
            created_at: now,
            expires_at: expiresAt,
          })
          .returning()
          .get()
        if (!row) return yield* failure("IM_TASK_IDENTITY_CONFLICT", "Task proposal could not be reserved")
        return row
      }),
    { behavior: "immediate" },
  )
})

/** Accept only authorizes one stable attempt. Work reservation/admission remains a separate
 * internal transaction sequence, and its independent route verifier is still required. */
export const accept = Effect.fn("IMTaskAuthority.accept")(function* (
  db: Db,
  input: {
    readonly requestID: string
    readonly operationID: string
    readonly expectedRevision: number
    readonly ordinal?: number
    readonly now?: number
  },
) {
  if ((input.ordinal ?? 1) !== 1)
    return yield* failure("IM_TASK_UNSUPPORTED_ATTEMPT", "Only the first explicitly accepted attempt is supported")
  if (!validID(input.operationID))
    return yield* failure("IM_TASK_INVALID_REQUEST", "Accept requires a stable operation identity")
  const now = input.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const authority = yield* service
        const principal = yield* authenticated(tx, authority, "accept")
        const request = yield* visibleRequest(tx, principal, input.requestID)
        if (request.state === "proposed" && (yield* tx.select({ id: IMTaskStatusNoticeTable.notice_id })
          .from(IMTaskStatusNoticeTable).where(and(eq(IMTaskStatusNoticeTable.request_id, request.request_id),
            eq(IMTaskStatusNoticeTable.kind, "refused"))).get()))
          return yield* failure("IM_TASK_REVISION_CONFLICT", "Task proposal was explicitly refused")
        const source = yield* requireSource(tx, authority, request.source_id, now)
        yield* verifyRequest(request, source)
        const target = yield* targetProof(tx, authority, principal, source, request.target)
        const prior = yield* tx
          .select()
          .from(IMTaskGrantTable)
          .where(eq(IMTaskGrantTable.request_id, request.request_id))
          .get()
        if (prior) {
          if (
            prior.accept_request_id !== input.operationID ||
            prior.accept_expected_revision !== input.expectedRevision
          )
            return yield* failure("IM_TASK_IDENTITY_CONFLICT", "Accept identity conflicts with the committed attempt")
          yield* validateGrant(tx, authority, prior, request, source, now)
          yield* rejectUnknownWork(tx, prior.work_id)
          return prior
        }
        if (request.revision !== input.expectedRevision || request.state !== "proposed")
          return yield* failure("IM_TASK_REVISION_CONFLICT", "Task proposal revision changed")
        if (request.expires_at <= now)
          return yield* failure("IM_TASK_EXPIRED", "Task proposal expired before acceptance")
        const expiry = now + request.target.durationMs
        if (expiry > source.proof.expiresAt)
          return yield* failure(
            "IM_TASK_SOURCE_UNAVAILABLE",
            "Current source proof does not cover the attempt deadline",
          )
        const id = `imgrant_${digest([request.request_id, 1])}`
        const binding = bindingFor(request, source, id, expiry)
        const validation = WorkAuthorityPolicy.validateBinding(binding)
        if (!validation.ok)
          return yield* failure(
            "IM_TASK_INVALID_REQUEST",
            "Task target does not satisfy the supported restricted profile",
          )
        const values = {
          grant_id: id,
          request_id: request.request_id,
          ordinal: 1,
          instance_id: principal.instanceID,
          actor_id: principal.actorID,
          principal,
          target_proof: target,
          source_proof_hash: source.proof_hash,
          source_snapshot_hash: source.snapshot_hash,
          request_hash: request.request_hash,
          binding: validation.value,
          work_id: binding.workID,
          session_id: binding.sessionID,
          input_id: binding.inputID,
          result_key: request.result_key,
          state: "active" as const,
          revision: 1,
          accept_request_id: input.operationID,
          accept_expected_revision: input.expectedRevision,
          created_at: now,
          expires_at: expiry,
        }
        const row = yield* tx
          .insert(IMTaskGrantTable)
          .values({ ...values, record_hash: grantHash(values) })
          .returning()
          .get()
        if (!row) return yield* failure("IM_TASK_IDENTITY_CONFLICT", "Task grant could not be committed")
        const changed = yield* tx
          .update(IMTaskRequestTable)
          .set({ state: "accepted", revision: request.revision + 1 })
          .where(
            and(
              eq(IMTaskRequestTable.request_id, request.request_id),
              eq(IMTaskRequestTable.revision, request.revision),
              eq(IMTaskRequestTable.state, "proposed"),
            ),
          )
          .returning()
          .get()
        if (!changed) return yield* failure("IM_TASK_REVISION_CONFLICT", "Task proposal changed during acceptance")
        return row
      }),
    { behavior: "immediate" },
  )
})

/** The production accept boundary commits the source grant and independently verified Work
 * reservation together. Session placement and event admission happen after this transaction. */
export const acceptAndReserve = Effect.fn("IMTaskAuthority.acceptAndReserve")(function* (
  db: Db,
  input: Parameters<typeof accept>[1],
) {
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const request = yield* visibleRequest(tx, yield* authenticated(tx, yield* service, "accept"), input.requestID)
        const prior = yield* tx
          .select()
          .from(IMTaskGrantTable)
          .where(eq(IMTaskGrantTable.request_id, request.request_id))
          .get()
        if (prior) {
          if (
            prior.accept_request_id !== input.operationID ||
            prior.accept_expected_revision !== input.expectedRevision
          )
            return yield* failure("IM_TASK_IDENTITY_CONFLICT", "Accept identity conflicts with the committed attempt")
          const work = yield* WorkAuthority.get(db, prior.work_id)
          if (work?.admission_state === "ready") {
            if (
              prior.record_hash !== grantHash(prior) ||
              prior.request_hash !== request.request_hash ||
              prior.result_key !== request.result_key ||
              prior.actor_id !== request.actor_id ||
              prior.instance_id !== request.instance_id ||
              work.binding_hash !== WorkAuthorityPolicy.fingerprint(prior.binding) ||
              work.session_id !== prior.session_id ||
              work.input_id !== prior.input_id
            )
              return yield* failure("IM_TASK_IDENTITY_CONFLICT", "Historical task admission identity changed")
            // A historical ready receipt is observation only, including failed/unknown attempts.
            // No current route resolution, source renewal, quota change or wake occurs here.
            return { grant: prior, work }
          }
        }
        const grant = yield* accept(db, input)
        const work = yield* WorkAuthority.reserve(db, { binding: grant.binding, now: input.now })
        return { grant, work }
      }),
    { behavior: "immediate" },
  )
})

/** Read-only projection of the durable admission stages under the current authenticated principal.
 * Reading a reserved/ready row never completes admission, wakes a Session or checks a provider. */
export const readAdmission = Effect.fn("IMTaskAuthority.readAdmission")(function* (db: Db, requestID: string) {
  return yield* db.transaction((tx) =>
    Effect.gen(function* () {
      const request = yield* visibleRequest(tx, yield* authenticated(tx, yield* service, "read"), requestID)
      const grant = yield* tx.select().from(IMTaskGrantTable).where(eq(IMTaskGrantTable.request_id, requestID)).get()
      const work = grant ? yield* WorkAuthority.get(db, grant.work_id) : undefined
      if (
        grant &&
        (grant.instance_id !== request.instance_id ||
          grant.actor_id !== request.actor_id ||
          grant.request_hash !== request.request_hash ||
          grant.result_key !== request.result_key)
      )
        return yield* failure("IM_TASK_IDENTITY_CONFLICT", "Task admission identity changed")
      return { request, grant, work }
    }),
  )
})

export const revoke = Effect.fn("IMTaskAuthority.revoke")(function* (
  db: Db,
  input: {
    readonly grantID: string
    readonly operationID: string
    readonly expectedRevision: number
    readonly now?: number
  },
) {
  if (!validID(input.operationID))
    return yield* failure("IM_TASK_INVALID_REQUEST", "Revoke requires a stable operation identity")
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const authority = yield* service
        const principal = yield* authenticated(tx, authority, "revoke")
        const grant = yield* tx
          .select()
          .from(IMTaskGrantTable)
          .where(eq(IMTaskGrantTable.grant_id, input.grantID))
          .get()
        if (!grant || grant.instance_id !== principal.instanceID || grant.actor_id !== principal.actorID)
          return yield* failure("IM_TASK_NOT_VISIBLE", "Task grant is not visible to this operator")
        if (grant.state === "revoked") {
          if (
            grant.revoke_request_id === input.operationID &&
            grant.revoke_expected_revision === input.expectedRevision
          )
            return grant
          return yield* failure("IM_TASK_REVISION_CONFLICT", "Task grant was already revoked")
        }
        if (grant.revision !== input.expectedRevision)
          return yield* failure("IM_TASK_REVISION_CONFLICT", "Task grant revision changed")
        const row = yield* tx
          .update(IMTaskGrantTable)
          .set({
            state: "revoked",
            revision: grant.revision + 1,
            revoke_request_id: input.operationID,
            revoke_expected_revision: input.expectedRevision,
            revoked_at: input.now ?? Date.now(),
          })
          .where(
            and(
              eq(IMTaskGrantTable.grant_id, grant.grant_id),
              eq(IMTaskGrantTable.revision, input.expectedRevision),
              eq(IMTaskGrantTable.state, "active"),
            ),
          )
          .returning()
          .get()
        if (!row) return yield* failure("IM_TASK_REVISION_CONFLICT", "Task grant changed during revocation")
        // Does not release Work escrow or pretend that an already-issued physical permit stopped.
        return row
      }),
    { behavior: "immediate" },
  )
})

/** Management only: current operator ownership can revoke an accepted attempt even when its
 * execution source is offline or expired. Both durable fences commit before the host interrupts
 * the exact Session; cancellation never changes outcome, releases escrow or proves physical stop. */
export const cancelAndControl = Effect.fn("IMTaskAuthority.cancelAndControl")(function* (
  db: Db,
  input: {
    readonly requestID: string
    readonly operationID: string
    readonly expectedGrantRevision: number
    readonly expectedControlRevision: number | null
    readonly directory: string
    readonly now?: number
  },
) {
  if (!validID(input.operationID) || !Number.isSafeInteger(input.expectedGrantRevision) ||
    input.expectedGrantRevision < 1 || (input.expectedControlRevision !== null &&
      (!Number.isSafeInteger(input.expectedControlRevision) || input.expectedControlRevision < 1)))
    return yield* failure("IM_TASK_INVALID_REQUEST", "Cancellation requires original grant and control revisions")
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const principal = yield* authenticated(tx, yield* service, "revoke")
    const managed = yield* management(tx, principal, input)
    if (!managed.grant) return yield* failure("IM_TASK_REVISION_CONFLICT", "Task has no accepted attempt to cancel")
    if ((managed.work === undefined) !== (input.expectedControlRevision === null))
      return yield* failure("IM_TASK_REVISION_CONFLICT", "Task admission changed before cancellation")
    const revoked = yield* revoke(db, {
      grantID: managed.grant.grant_id, operationID: input.operationID,
      expectedRevision: input.expectedGrantRevision, now: input.now,
    })
    const controlled = managed.work && input.expectedControlRevision !== null ? yield* WorkAuthority.control(db, {
      workID: managed.work.work_id, requestID: `im-task-cancel:${input.operationID}`,
      expectedRevision: input.expectedControlRevision, action: "cancel", now: input.now,
    }) : null
    return { request: managed.request, grant: revoked, work: controlled?.work, receipt: {
      operationID: input.operationID, requestID: managed.request.request_id,
      grantID: revoked.grant_id, expectedGrantRevision: input.expectedGrantRevision,
      grantRevision: revoked.revision, workID: controlled?.work.work_id ?? null,
      sessionID: controlled?.work.session_id ?? null,
      expectedControlRevision: input.expectedControlRevision,
      controlRevision: controlled?.receipt.revision ?? null,
      controlState: controlled?.receipt.state ?? null,
    } }
  }), { behavior: "immediate" })
})

/** A durable management read is independent of the current execution source or native host. */
export const readManagement = Effect.fn("IMTaskAuthority.readManagement")(function* (
  db: Db,
  input: { readonly requestID: string; readonly directory: string },
) {
  return yield* db.transaction((tx) => readManagementInTransaction(tx, input))
})

export const readManagementInTransaction = Effect.fn("IMTaskAuthority.readManagementInTransaction")(function* (
  tx: Tx,
  input: { readonly requestID: string; readonly directory: string },
) {
  return yield* management(tx, yield* authenticated(tx, yield* service, "read"), input)
})

/** Reduction uses the same current operator mutation proof as cancellation, without a live source probe. */
export const readReductionInTransaction = Effect.fn("IMTaskAuthority.readReductionInTransaction")(function* (
  tx: Tx,
  input: { readonly requestID: string; readonly directory: string },
) {
  return yield* management(tx, yield* authenticated(tx, yield* service, "revoke"), input)
})

/** The caller already read the original durable CurrentOperator; this exports no identity factory. */
export const readOwnedManagementInTransaction = (tx: Tx, principal: Principal,
  input: { readonly requestID: string; readonly directory: string }) => management(tx, principal, input)

/** Status disclosure is independent of an execution grant's active state. Source, operator and
 * target remain current, using the exact original source snapshot and target verifier. */
export const authorizeStatusSourceInTransaction = Effect.fn("IMTaskAuthority.authorizeStatusSourceInTransaction")(function* (
  tx: Tx,
  input: { readonly requestID: string; readonly directory: string },
) {
  const authority = yield* service
  const principal = LocalOperator.principal(yield* LocalOperator.requireCurrent(tx))
  yield* authority.verifyOperator(tx, principal)
  const managed = yield* management(tx, principal, input)
  const source = yield* requireSource(tx, authority, managed.request.source_id, Date.now())
  yield* verifyRequest(managed.request, source)
  yield* targetProof(tx, authority, principal, source, managed.request.target)
  return { ...managed, source, principal }
})

function management(tx: Tx, principal: Principal, input: { readonly requestID: string; readonly directory: string }) {
  return Effect.gen(function* () {
    const request = yield* visibleRequest(tx, principal, input.requestID)
    if (request.target.location.directory !== input.directory)
      return yield* failure("IM_TASK_FORBIDDEN", "Task management is outside this project")
    const grant = yield* tx.select().from(IMTaskGrantTable)
      .where(eq(IMTaskGrantTable.request_id, request.request_id)).get().pipe(Effect.orDie)
    if (!grant) {
      const source = yield* tx.select().from(IMTaskSourceTable)
        .where(eq(IMTaskSourceTable.source_id, request.source_id)).get().pipe(Effect.orDie)
      if (request.state !== "proposed" || !source || source.instance_id !== request.instance_id ||
        source.proof_hash !== digest(source.proof) || source.snapshot_hash !== digest(source.snapshot))
        return yield* failure("IM_TASK_IDENTITY_CONFLICT", "Original task proposal identity changed")
      yield* verifyRequest(request, source)
      return { request, grant: undefined, work: undefined }
    }
    if (request.state !== "accepted" || request.revision !== grant.accept_expected_revision + 1 ||
      grant.instance_id !== request.instance_id || grant.actor_id !== request.actor_id ||
      grant.principal.instanceID !== request.instance_id || grant.principal.actorID !== request.actor_id ||
      grant.record_hash !== grantHash(grant) || grant.request_hash !== request.request_hash ||
      grant.result_key !== request.result_key || request.audited_text_hash !== Hash.sha256(request.audited_text) ||
      request.request_hash !== requestHash(request, {
        proof_hash: grant.source_proof_hash, snapshot_hash: grant.source_snapshot_hash,
      }) || digest(grant.binding) !== digest(bindingFor(request, { source_id: request.source_id },
        grant.grant_id, grant.expires_at)) || grant.work_id !== grant.binding.workID ||
      grant.session_id !== grant.binding.sessionID || grant.input_id !== grant.binding.inputID)
      return yield* failure("IM_TASK_IDENTITY_CONFLICT", "Accepted task management identity changed")
    const work = yield* WorkAuthority.get(tx, grant.work_id)
    if (work && (work.binding_hash !== WorkAuthorityPolicy.fingerprint(grant.binding) ||
      digest(work.binding) !== digest(grant.binding) || work.binding_version !==
        (grant.binding.schemaVersion === "work-execution.v2" ? 2 : 1) ||
      work.session_id !== grant.session_id || work.input_id !== grant.input_id ||
      work.root_work_id !== grant.binding.rootWorkID || work.parent_work_id !== null ||
      work.security_namespace_id !== grant.binding.scope.securityNamespaceID ||
      work.agent_id !== grant.binding.agentID || work.source_kind !== "server_operator" ||
      work.authority_id !== grant.grant_id || work.source_revision !== grant.binding.source.authorityRevision ||
      work.source_record_hash !== grant.record_hash || work.source_request_id !== request.request_id))
      return yield* failure("IM_TASK_IDENTITY_CONFLICT", "Task Work differs from the accepted attempt")
    return { request, grant, work }
  })
}

export const readRequest = Effect.fn("IMTaskAuthority.readRequest")(function* (db: Db, requestID: string) {
  return yield* db.transaction((tx) =>
    Effect.gen(function* () {
      return yield* visibleRequest(tx, yield* authenticated(tx, yield* service, "read"), requestID)
    }),
  )
})

/** This is the source half of WorkAuthority.Verifier only. Never install it as a route proof. */
export const authorizeWorkSource: WorkAuthority.Verification["authorizeSource"] = (tx, binding) =>
  Effect.gen(function* () {
    const authority = yield* service
    const grant = yield* tx
      .select()
      .from(IMTaskGrantTable)
      .where(eq(IMTaskGrantTable.grant_id, binding.source.authorityID))
      .get()
      .pipe(Effect.orDie)
    if (!grant) return yield* failure("IM_TASK_NOT_VISIBLE", "No task grant exists for this work")
    const diagnostic = (stage: "task-request" | "task-source" | "task-grant") => (error: IMTaskAuthoritySchema.Error) =>
      Effect.logWarning("Task source current check refused", { stage, code: error.code })
    const request = yield* visibleRequest(tx, grant.principal, grant.request_id).pipe(Effect.tapError(diagnostic("task-request")))
    const source = yield* requireSource(tx, authority, request.source_id, Date.now()).pipe(Effect.tapError(diagnostic("task-source")))
    yield* validateGrant(tx, authority, grant, request, source, Date.now()).pipe(Effect.tapError(diagnostic("task-grant")))
    if (WorkAuthorityPolicy.fingerprint(binding) !== WorkAuthorityPolicy.fingerprint(grant.binding))
      return yield* failure("IM_TASK_IDENTITY_CONFLICT", "Work does not match the explicitly accepted task")
    return { authorityID: grant.grant_id, revision: grant.revision, recordHash: grant.record_hash }
  }).pipe(
    Effect.mapError(
      (error) =>
        new WorkAuthoritySchema.Error({
          code: error.code === "IM_TASK_AUTHORITY_UNAVAILABLE" ? "PROFILE_UNAVAILABLE" : "WORK_REVOKED",
          message: "Task source authority is unavailable, changed or revoked",
        }),
    ),
  )

const authenticated = Effect.fn("IMTaskAuthority.authenticated")(function* (
  tx: Tx,
  authority: Authority["Service"],
  action: Parameters<Authority["Service"]["authenticateMutation"]>[1],
) {
  const principal = yield* decode(IMTaskAuthoritySchema.Principal, yield* authority.authenticateMutation(tx, action))
  const current = yield* decode(IMTaskAuthoritySchema.Principal, yield* authority.verifyOperator(tx, principal))
  if (digest(current) !== digest(principal)) return yield* failure("IM_TASK_FORBIDDEN", "Operator identity changed")
  return principal
})

const captureSource = Effect.fn("IMTaskAuthority.captureSource")(function* (
  tx: Tx,
  authority: Authority["Service"],
  instanceID: string,
  messageID: string,
  now: number,
) {
  const proof = yield* decode(IMTaskAuthoritySchema.SourceProof, yield* authority.verifySource(tx, messageID))
  if (proof.instanceID !== instanceID || !["local", "kernel_live"].includes(proof.origin) || proof.expiresAt <= now)
    return yield* failure(
      "IM_TASK_SOURCE_UNAVAILABLE",
      "Task source is not currently verified live input for this instance",
    )
  const snapshot = yield* sourceSnapshot(tx, messageID, proof)
  const proofHash = digest(proof)
  const snapshotHash = digest(snapshot)
  const id = `imsource_${digest([instanceID, messageID, proofHash])}`
  const prior = yield* tx
    .select()
    .from(IMTaskSourceTable)
    .where(eq(IMTaskSourceTable.source_id, id))
    .get()
    .pipe(Effect.orDie)
  if (prior) {
    if (prior.snapshot_hash !== snapshotHash || prior.proof_hash !== proofHash)
      return yield* failure("IM_TASK_SOURCE_CHANGED", "Task source changed under the same proof identity")
    return prior
  }
  const row = yield* tx
    .insert(IMTaskSourceTable)
    .values({
      source_id: id,
      message_id: messageID,
      instance_id: instanceID,
      proof,
      proof_hash: proofHash,
      snapshot,
      snapshot_hash: snapshotHash,
      created_at: now,
    })
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* failure("IM_TASK_SOURCE_UNAVAILABLE", "Task source could not be persisted")
  return row
})

const requireSource = Effect.fn("IMTaskAuthority.requireSource")(function* (
  tx: Tx,
  authority: Authority["Service"],
  id: string,
  now: number,
) {
  const source = yield* tx
    .select()
    .from(IMTaskSourceTable)
    .where(eq(IMTaskSourceTable.source_id, id))
    .get()
    .pipe(Effect.orDie)
  if (!source || digest(source.proof) !== source.proof_hash || digest(source.snapshot) !== source.snapshot_hash)
    return yield* failure("IM_TASK_SOURCE_UNAVAILABLE", "Task source snapshot is unavailable or inconsistent")
  const current = yield* decode(IMTaskAuthoritySchema.SourceProof, yield* authority.verifySource(tx, source.message_id))
  if (
    current.expiresAt <= now ||
    !["local", "kernel_live"].includes(current.origin) ||
    digest(current) !== source.proof_hash ||
    digest(yield* sourceSnapshot(tx, source.message_id, current)) !== source.snapshot_hash
  )
    return yield* failure(
      "IM_TASK_SOURCE_CHANGED",
      "Current source identity, generation, membership proof or raw input changed",
    )
  return source
})

const sourceSnapshot = Effect.fn("IMTaskAuthority.sourceSnapshot")(function* (
  tx: Tx,
  messageID: string,
  proof: IMTaskAuthoritySchema.SourceProof,
) {
  const message = yield* tx
    .select()
    .from(MessageTable)
    .where(sql`${MessageTable.id} = ${messageID}`)
    .get()
    .pipe(Effect.orDie)
  if (
    !message ||
    message.deleted_at !== null ||
    message.sender_type !== "user" ||
    message.type !== "text" ||
    message.sender_id !== proof.senderID ||
    message.reply_to_id !== null
  )
    return yield* failure(
      "IM_TASK_SOURCE_UNAVAILABLE",
      "Only a verified, undeleted user text source is eligible in this slice",
    )
  const group = yield* tx.select().from(GroupTable).where(eq(GroupTable.id, message.group_id)).get().pipe(Effect.orDie)
  const namespace = yield* tx
    .select()
    .from(SecurityNamespaceTable)
    .where(sql`${SecurityNamespaceTable.id} = ${proof.securityNamespaceID}`)
    .get()
    .pipe(Effect.orDie)
  if (
    !group ||
    group.deleted_at !== null ||
    !namespace ||
    namespace.retired_at !== null ||
    namespace.binding_hash !== proof.namespaceBindingHash
  )
    return yield* failure("IM_TASK_SOURCE_UNAVAILABLE", "Source conversation or security namespace is unavailable")
  if (proof.reader) return yield* KernelTaskSnapshot.read(tx, message, group, proof)
  if (
    proof.origin === "kernel_live" &&
    (!proof.realmID ||
      !proof.appkeyID ||
      !proof.orgID ||
      !proof.kernelMessageID ||
      proof.kernelMessageID !== message.kernel_msg_id ||
      proof.conversationType === "local" ||
      group.kernel_conv_id !== `k:${proof.conversationType}:${proof.conversationID}`)
  )
    return yield* failure(
      "IM_TASK_SOURCE_UNAVAILABLE",
      "Kernel source identity does not match its persisted conversation and message",
    )
  if (
    proof.origin === "local" &&
    (proof.conversationType !== "local" ||
      proof.conversationID !== group.id ||
      proof.kernelMessageID !== null ||
      proof.realmID !== null ||
      proof.appkeyID !== null ||
      proof.orgID !== null)
  )
    return yield* failure("IM_TASK_SOURCE_UNAVAILABLE", "Local source cannot invent a platform realm or org identity")
  const members = yield* tx
    .select()
    .from(MemberTable)
    .where(
      and(
        eq(MemberTable.group_id, group.id),
        eq(MemberTable.member_type, "user"),
        or(eq(MemberTable.member_id, proof.senderID), eq(MemberTable.member_id, proof.receiverID)),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const sender = members.find((row) => row.member_id === proof.senderID)
  const receiver = members.find((row) => row.member_id === proof.receiverID)
  if (!sender || !receiver)
    return yield* failure(
      "IM_TASK_SOURCE_UNAVAILABLE",
      "Current sender and receiver conversation membership is unavailable",
    )
  const intent = proof.intentID
    ? yield* tx
        .select()
        .from(IMMentionIntentTable)
        .where(eq(IMMentionIntentTable.id, proof.intentID))
        .get()
        .pipe(Effect.orDie)
    : undefined
  if (
    proof.intentID &&
    (!intent ||
      intent.message_id !== messageID ||
      intent.origin !== proof.origin ||
      intent.user_id !== proof.senderID ||
      (proof.origin === "kernel_live" &&
        (intent.receiver_id !== proof.receiverID ||
          String(intent.conversation_type) !== proof.conversationType ||
          intent.conversation_id !== proof.conversationID)))
  )
    return yield* failure("IM_TASK_SOURCE_CHANGED", "Mention source receipt differs from its verified origin")
  const event = message.event_id
    ? yield* tx
        .select()
        .from(DeepAgentEventTable)
        .where(sql`${DeepAgentEventTable.id} = ${message.event_id}`)
        .get()
        .pipe(Effect.orDie)
    : undefined
  if (message.event_id && (!event || event.type !== "im.message.created" || event.actor_id !== proof.senderID))
    return yield* failure(
      "IM_TASK_SOURCE_UNAVAILABLE",
      "Message event snapshot is unavailable or is a generated result",
    )
  return {
    message: {
      id: message.id,
      groupID: message.group_id,
      senderID: message.sender_id,
      senderType: message.sender_type,
      type: message.type,
      content: message.content,
      mentions: message.mentions,
      metadata: message.metadata,
      kernelMessageID: message.kernel_msg_id,
      eventID: message.event_id,
      createdAt: message.created_at,
    },
    group: {
      id: group.id,
      workspaceID: group.workspace_id,
      projectID: group.project_id,
      type: group.type,
      kernelConversationID: group.kernel_conv_id,
    },
    membership: [sender, receiver].map((row) => ({
      memberID: row.member_id,
      memberType: row.member_type,
      role: row.role,
      joinedAt: row.joined_at,
    })),
    intent: intent
      ? {
          id: intent.id,
          messageID: intent.message_id,
          userID: intent.user_id,
          origin: intent.origin,
          receiverID: intent.receiver_id,
          conversationType: intent.conversation_type,
          conversationID: intent.conversation_id,
        }
      : null,
    event: event
      ? {
          id: event.id,
          type: event.type,
          source: event.source,
          workspaceID: event.workspace_id,
          actorID: event.actor_id,
          payload: event.payload,
          createdAt: event.created_at,
        }
      : null,
  }
})

const targetProof = Effect.fn("IMTaskAuthority.targetProof")(function* (
  tx: Tx,
  authority: Authority["Service"],
  principal: Principal,
  source: Source,
  target: Target,
) {
  if (
    principal.instanceID !== source.instance_id ||
    target.scope.actorID !== principal.actorID ||
    target.scope.securityNamespaceID !== source.proof.securityNamespaceID ||
    target.durationMs > target.budget.maxDurationMs
  )
    return yield* failure("IM_TASK_FORBIDDEN", "Task target exceeds the receiving operator scope")
  const location = yield* tx
    .select()
    .from(LocationIdentityTable)
    .where(
      and(
        sql`${LocationIdentityTable.security_namespace_id} = ${target.scope.securityNamespaceID}`,
        sql`${LocationIdentityTable.project_scope_key} = ${target.scope.projectScopeKey}`,
        eq(LocationIdentityTable.canonical_root, target.location.directory),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  const project = yield* tx
    .select()
    .from(ProjectScopeIdentityTable)
    .where(
      and(
        sql`${ProjectScopeIdentityTable.security_namespace_id} = ${target.scope.securityNamespaceID}`,
        sql`${ProjectScopeIdentityTable.project_scope_key} = ${target.scope.projectScopeKey}`,
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (
    !location ||
    location.retired_at !== null ||
    !project ||
    project.retired_at !== null ||
    target.location.workspaceID !== undefined ||
    location.workspace_binding !== null
  )
    return yield* failure(
      "IM_TASK_AUTHORITY_UNAVAILABLE",
      "Only a currently registered implicit-local target is supported",
    )
  const proof = yield* decode(
    IMTaskAuthoritySchema.TargetProof,
    yield* authority.authorizeTarget(tx, principal, target, source),
  )
  if (proof.targetHash !== digest(target))
    return yield* failure("IM_TASK_FORBIDDEN", "Target permission proof does not match the reviewed target")
  return proof
})

const visibleRequest = Effect.fn("IMTaskAuthority.visibleRequest")(function* (
  tx: Tx,
  principal: Principal,
  id: string,
) {
  const request = yield* tx
    .select()
    .from(IMTaskRequestTable)
    .where(eq(IMTaskRequestTable.request_id, id))
    .get()
    .pipe(Effect.orDie)
  if (!request || request.instance_id !== principal.instanceID || request.actor_id !== principal.actorID)
    return yield* failure("IM_TASK_NOT_VISIBLE", "Task request is not visible to this operator")
  return request
})

const validateGrant = Effect.fn("IMTaskAuthority.validateGrant")(function* (
  tx: Tx,
  authority: Authority["Service"],
  grant: Grant,
  request: Request,
  source: Source,
  now: number,
) {
  if (grant.state !== "active" || grant.revision !== 1)
    return yield* failure("IM_TASK_REVOKED", "Task grant is revoked")
  if (grant.expires_at <= now) return yield* failure("IM_TASK_EXPIRED", "Task attempt deadline expired")
  if (
    request.state !== "accepted" ||
    request.revision !== grant.accept_expected_revision + 1 ||
    grant.instance_id !== request.instance_id ||
    grant.actor_id !== request.actor_id ||
    grant.instance_id !== grant.principal.instanceID ||
    grant.actor_id !== grant.principal.actorID
  )
    return yield* failure("IM_TASK_SOURCE_CHANGED", "Grant owner and accepted request authority disagree")
  yield* verifyRequest(request, source)
  const operator = yield* decode(IMTaskAuthoritySchema.Principal, yield* authority.verifyOperator(tx, grant.principal))
  const target = yield* targetProof(tx, authority, operator, source, request.target)
  if (
    digest(operator) !== digest(grant.principal) ||
    digest(target) !== digest(grant.target_proof) ||
    grant.record_hash !== grantHash(grant) ||
    grant.source_proof_hash !== source.proof_hash ||
    grant.source_snapshot_hash !== source.snapshot_hash ||
    grant.request_hash !== request.request_hash ||
    digest(grant.binding) !== digest(bindingFor(request, source, grant.grant_id, grant.expires_at)) ||
    grant.work_id !== grant.binding.workID ||
    grant.session_id !== grant.binding.sessionID ||
    grant.input_id !== grant.binding.inputID ||
    grant.result_key !== request.result_key
  )
    return yield* failure("IM_TASK_SOURCE_CHANGED", "Grant, operator, source or target authority changed")
})

const rejectUnknownWork = Effect.fn("IMTaskAuthority.rejectUnknownWork")(function* (tx: Tx, workID: string) {
  const work = yield* tx
    .select()
    .from(WorkExecutionTable)
    .where(eq(WorkExecutionTable.work_id, workID))
    .get()
    .pipe(Effect.orDie)
  const reservations = yield* tx
    .select({ state: WorkDispatchReservationTable.state })
    .from(WorkDispatchReservationTable)
    .where(eq(WorkDispatchReservationTable.work_id, workID))
    .all()
    .pipe(Effect.orDie)
  if (work?.outcome === "unknown" || reservations.some((row) => row.state === "unknown" || row.state === "dispatching"))
    return yield* failure(
      "IM_TASK_RESULT_UNKNOWN",
      "The accepted attempt has an unsettled physical dispatch; a new attempt is unavailable",
    )
})

function bindingFor(request: Request, source: Pick<Source, "source_id">, grantID: string, deadline: number): WorkAuthoritySchema.Binding {
  const stable = digest([request.instance_id, request.request_id, 1])
  return {
    ...("version" in request.target
      ? {
          schemaVersion: "work-execution.v2" as const,
          profile: request.target.profile,
          projectScope: request.target.projectScope,
          contextPolicy: request.target.contextPolicy,
          toolPolicy: request.target.toolPolicy,
          childPolicy: request.target.childPolicy,
        }
      : {
          schemaVersion: "work-execution.v1" as const,
          profile: request.target.profile,
          contextPolicy: "static_instructions_and_audited_text" as const,
          toolPolicy: "deny_all" as const,
          childPolicy: "deny_all" as const,
        }),
    workID: `imwork_${stable}`,
    rootWorkID: `imwork_${stable}`,
    attemptKey: `imattempt_${stable}`,
    source: {
      kind: "server_operator",
      authorityID: grantID,
      authorityRevision: 1,
      sourceID: source.source_id,
      requestID: request.request_id,
      requestHash: request.request_hash,
    },
    envelopeHash: request.request_hash,
    scope: request.target.scope,
    location: request.target.location,
    agentID: request.target.agentID,
    sessionID: `ses_imtask_${stable}`,
    inputID: `msg_imtask_${stable}`,
    auditedText: {
      hash: request.audited_text_hash,
      utf8Bytes: Buffer.byteLength(request.audited_text),
      snapshotRef: `im-task-request:${request.request_id}`,
    },
    provider: request.target.provider,
    budget: request.target.budget,
    deadline,
  }
}

function requestHash(
  request: Pick<
    Request,
    "source_id" | "instance_id" | "actor_id" | "audited_text" | "target" | "expires_at" | "result_key"
  >,
  source: Pick<Source, "proof_hash" | "snapshot_hash">,
) {
  return digest({
    sourceID: request.source_id,
    sourceProofHash: source.proof_hash,
    sourceSnapshotHash: source.snapshot_hash,
    instanceID: request.instance_id,
    actorID: request.actor_id,
    auditedText: request.audited_text,
    target: request.target,
    expiresAt: request.expires_at,
    resultKey: request.result_key,
  })
}

function grantHash(
  grant: Pick<
    Grant,
    | "grant_id"
    | "request_id"
    | "principal"
    | "target_proof"
    | "source_proof_hash"
    | "source_snapshot_hash"
    | "request_hash"
    | "binding"
    | "accept_request_id"
    | "accept_expected_revision"
    | "created_at"
    | "expires_at"
  >,
) {
  return digest({
    grantID: grant.grant_id,
    requestID: grant.request_id,
    principal: grant.principal,
    targetProof: grant.target_proof,
    sourceProofHash: grant.source_proof_hash,
    sourceSnapshotHash: grant.source_snapshot_hash,
    requestHash: grant.request_hash,
    binding: grant.binding,
    acceptRequestID: grant.accept_request_id,
    acceptExpectedRevision: grant.accept_expected_revision,
    createdAt: grant.created_at,
    expiresAt: grant.expires_at,
  })
}

function verifyRequest(request: Request, source: Source) {
  return request.request_hash === requestHash(request, source) &&
    request.audited_text_hash === Hash.sha256(request.audited_text)
    ? Effect.void
    : failure("IM_TASK_IDENTITY_CONFLICT", "Stored task review content failed its immutable hash check")
}

function decode<A>(schema: Schema.Decoder<A>, value: unknown) {
  const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(value)
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : failure("IM_TASK_INVALID_REQUEST", "Task authority data is invalid")
}

function validID(value: string) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
}
function failure(code: IMTaskAuthoritySchema.ErrorCode, message: string) {
  return Effect.fail(new IMTaskAuthoritySchema.Error({ code, message }))
}
