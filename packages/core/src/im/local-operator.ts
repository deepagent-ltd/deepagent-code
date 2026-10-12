export * as LocalOperator from "./local-operator"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import type { WorkAuthority } from "../session/work-authority"
import { WorkAuthorityPolicy } from "../session/work-authority-policy"
import { SessionTable } from "../session/sql"
import { EventWorkDagPolicy } from "../deepagent/event-work-dag.policy"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { LocationIdentityTable, ProjectScopeIdentityTable, SecurityNamespaceTable } from "../context-federation/sql"
import { IMTaskAuthoritySchema } from "./task-authority.schema"
import { LocalOperatorSchema } from "./local-operator.schema"
import { LocalOperatorAuthorityTable, LocalOperatorCommandTable } from "./local-operator.sql"

type Db = Database.Interface["db"]
type Tx = WorkAuthority.Transaction
export type Record = typeof LocalOperatorAuthorityTable.$inferSelect
export class Runtime extends Context.Service<Runtime, LocalOperatorSchema.RuntimeBinding>()(
  "@deepagent-code/LocalOperator/Runtime",
) {}
export class Mutation extends Context.Service<Mutation, LocalOperatorSchema.MutationWitness>()(
  "@deepagent-code/LocalOperator/Mutation",
) {}

export const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
export const failure = (code: LocalOperatorSchema.Error["code"], message: string) =>
  Effect.fail(new LocalOperatorSchema.Error({ code, message }))
export function decode<A>(schema: Schema.Decoder<A>, value: unknown) {
  const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(value)
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : failure("LOCAL_OPERATOR_INVALID", "Invalid local task authority data")
}
export const runtime = Effect.gen(function* () {
  const current = yield* Effect.serviceOption(Runtime)
  if (Option.isNone(current)) return yield* failure("LOCAL_OPERATOR_UNAVAILABLE", "Local task identity is not enrolled")
  return yield* decode(LocalOperatorSchema.RuntimeBinding, current.value)
})

/** Internal CLI entry only. Runtime is supplied after exclusive DB ownership and private installation-key verification. */
export const enroll = Effect.fn("LocalOperator.enroll")(function* (
  db: Db,
  input: {
    operationID: string
    operatorID: string
    username: string
    credentialVerifier: string
    policy: unknown
    now?: number
  },
) {
  const installed = yield* runtime
  const policy = yield* decode(LocalOperatorSchema.Policy, input.policy)
  if (
    !validID(input.operationID) ||
    !validID(input.operatorID) ||
    !validID(input.username) ||
    !input.credentialVerifier.startsWith("$argon2id$")
  )
    return yield* failure("LOCAL_OPERATOR_INVALID", "Enrollment requires a valid identity and password verifier")
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        yield* validatePolicy(tx, policy, input.operatorID)
        const requestHash = hash({
          action: "enroll",
          ...installed,
          operatorID: input.operatorID,
          username: input.username,
          policy,
        })
        const retry = yield* command(tx, installed.instanceID, input.operationID, requestHash)
        if (retry) return yield* decode(LocalOperatorSchema.CommandReceipt, retry.receipt)
        const existing = yield* tx
          .select()
          .from(LocalOperatorAuthorityTable)
          .where(eq(LocalOperatorAuthorityTable.instance_id, installed.instanceID))
          .get()
          .pipe(Effect.orDie)
        if (
          existing &&
          (existing.state !== "revoked" ||
            existing.operator_id === input.operatorID ||
            existing.installation_key_hash !== installed.installationKeyHash)
        )
          return yield* failure(
            "LOCAL_OPERATOR_CONFLICT",
            "Active or differently bound operator identity cannot be replaced",
          )
        const now = input.now ?? Date.now()
        yield* requireFreshReceivers(policy, now)
        const record = {
          instance_id: installed.instanceID,
          operator_id: input.operatorID,
          username: input.username,
          credential_verifier: input.credentialVerifier,
          credential_binding: installed.credentialBinding,
          installation_key_hash: installed.installationKeyHash,
          state: "active" as const,
          revision: (existing?.revision ?? 0) + 1,
          credential_generation: (existing?.credential_generation ?? 0) + 1,
          policy_revision: (existing?.policy_revision ?? 0) + 1,
          policy,
          policy_hash: hash(policy),
          created_at: now,
          updated_at: now,
        }
        const stored = { ...record, identity_hash: identityHash(record) }
        if (existing)
          yield* tx
            .update(LocalOperatorAuthorityTable)
            .set(stored)
            .where(
              and(
                eq(LocalOperatorAuthorityTable.instance_id, installed.instanceID),
                eq(LocalOperatorAuthorityTable.revision, existing.revision),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        if (!existing) yield* tx.insert(LocalOperatorAuthorityTable).values(stored).run().pipe(Effect.orDie)
        const result = receipt(stored)
        yield* saveCommand(tx, {
          instanceID: installed.instanceID,
          operationID: input.operationID,
          action: "enroll",
          requestHash,
          expectedRevision: null,
          result,
          now,
        })
        return result
      }),
    { behavior: "immediate" },
  )
})

/** A successful KDF check outside the transaction supplies Mutation; its generation is rechecked here. */
export const rotate = Effect.fn("LocalOperator.rotate")(function* (
  db: Db,
  input: {
    operationID: string
    expectedRevision: number
    username: string
    credentialVerifier: string
    policy?: unknown
    now?: number
  },
) {
  const installed = yield* runtime
  if (!validID(input.operationID) || !validID(input.username) || !input.credentialVerifier.startsWith("$argon2id$"))
    return yield* failure("LOCAL_OPERATOR_INVALID", "Rotation requires a valid password verifier")
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const current = yield* requireCurrent(tx, false)
        const policy =
          input.policy === undefined ? current.policy : yield* decode(LocalOperatorSchema.Policy, input.policy)
        yield* validatePolicy(tx, policy, current.operator_id)
        const requestHash = hash({
          action: "rotate",
          instanceID: installed.instanceID,
          expectedRevision: input.expectedRevision,
          username: input.username,
          credentialBinding: installed.credentialBinding,
          policy,
        })
        const retry = yield* command(tx, installed.instanceID, input.operationID, requestHash)
        if (retry) return yield* decode(LocalOperatorSchema.CommandReceipt, retry.receipt)
        yield* requireMutation(tx, false)
        if (current.revision !== input.expectedRevision)
          return yield* failure("LOCAL_OPERATOR_REVISION_CONFLICT", "Operator revision changed")
        const now = input.now ?? Date.now()
        if (input.policy !== undefined) yield* requireFreshReceivers(policy, now)
        const next = {
          ...current,
          username: input.username,
          credential_verifier: input.credentialVerifier,
          credential_binding: installed.credentialBinding,
          revision: current.revision + 1,
          credential_generation: current.credential_generation + 1,
          policy_revision: current.policy_revision + 1,
          policy,
          policy_hash: hash(policy),
          updated_at: now,
        }
        const stored = { ...next, identity_hash: identityHash(next) }
        const updated = yield* tx
          .update(LocalOperatorAuthorityTable)
          .set(stored)
          .where(
            and(
              eq(LocalOperatorAuthorityTable.instance_id, installed.instanceID),
              eq(LocalOperatorAuthorityTable.revision, input.expectedRevision),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!updated) return yield* failure("LOCAL_OPERATOR_REVISION_CONFLICT", "Operator revision changed")
        const result = receipt(updated)
        yield* saveCommand(tx, {
          instanceID: installed.instanceID,
          operationID: input.operationID,
          action: "rotate",
          requestHash,
          expectedRevision: input.expectedRevision,
          result,
          now,
        })
        return result
      }),
    { behavior: "immediate" },
  )
})

export const revoke = Effect.fn("LocalOperator.revoke")(function* (
  db: Db,
  input: { operationID: string; expectedRevision: number; now?: number },
) {
  const installed = yield* runtime
  if (!validID(input.operationID)) return yield* failure("LOCAL_OPERATOR_INVALID", "Invalid operation identity")
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const requestHash = hash({
          action: "revoke",
          instanceID: installed.instanceID,
          expectedRevision: input.expectedRevision,
        })
        const retry = yield* command(tx, installed.instanceID, input.operationID, requestHash)
        if (retry) return yield* decode(LocalOperatorSchema.CommandReceipt, retry.receipt)
        const current = yield* requireMutation(tx)
        if (current.revision !== input.expectedRevision)
          return yield* failure("LOCAL_OPERATOR_REVISION_CONFLICT", "Operator revision changed")
        const now = input.now ?? Date.now()
        const next = {
          ...current,
          state: "revoked" as const,
          revision: current.revision + 1,
          credential_generation: current.credential_generation + 1,
          updated_at: now,
        }
        const updated = yield* tx
          .update(LocalOperatorAuthorityTable)
          .set({ ...next, identity_hash: identityHash(next) })
          .where(
            and(
              eq(LocalOperatorAuthorityTable.instance_id, installed.instanceID),
              eq(LocalOperatorAuthorityTable.revision, input.expectedRevision),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!updated) return yield* failure("LOCAL_OPERATOR_REVISION_CONFLICT", "Operator revision changed")
        const result = receipt(updated)
        yield* saveCommand(tx, {
          instanceID: installed.instanceID,
          operationID: input.operationID,
          action: "revoke",
          requestHash,
          expectedRevision: input.expectedRevision,
          result,
          now,
        })
        return result
      }),
    { behavior: "immediate" },
  )
})

/** Credentials are private host data. Never return this record from an HTTP handler. */
export const requireCurrent = Effect.fn("LocalOperator.requireCurrent")(function* (
  tx: Tx,
  requireConfiguration = true,
) {
  const installed = yield* runtime
  const current = yield* tx
    .select()
    .from(LocalOperatorAuthorityTable)
    .where(eq(LocalOperatorAuthorityTable.instance_id, installed.instanceID))
    .get()
    .pipe(Effect.orDie)
  if (!current) return yield* failure("LOCAL_OPERATOR_UNAVAILABLE", "Local task identity is not enrolled")
  if (current.installation_key_hash !== installed.installationKeyHash)
    return yield* failure("LOCAL_OPERATOR_INSTALLATION_MISMATCH", "Installation identity does not match enrollment")
  if (current.state !== "active") return yield* failure("LOCAL_OPERATOR_REVOKED", "Local operator is revoked")
  if (requireConfiguration && current.credential_binding !== installed.credentialBinding)
    return yield* failure("LOCAL_OPERATOR_CONFIG_MISMATCH", "Configured credentials do not match enrollment")
  const policy = yield* decode(LocalOperatorSchema.Policy, current.policy)
  if (hash(policy) !== current.policy_hash || identityHash(current) !== current.identity_hash)
    return yield* failure("LOCAL_OPERATOR_UNAVAILABLE", "Stored operator authority is inconsistent")
  return current
})

export const requireMutation = Effect.fn("LocalOperator.requireMutation")(function* (
  tx: Tx,
  requireConfiguration = true,
) {
  const witness = yield* Effect.serviceOption(Mutation)
  if (Option.isNone(witness))
    return yield* failure("LOCAL_OPERATOR_AUTH_REQUIRED", "Explicit authenticated mutation is required")
  const current = yield* requireCurrent(tx, requireConfiguration)
  if (hash(witness.value) !== hash(mutationWitness(current)))
    return yield* failure("LOCAL_OPERATOR_AUTH_REQUIRED", "Authenticated mutation identity changed")
  return current
})

/** Offline route approval owns the outer transaction. This only changes policy authority;
 * the Basic credential generation/binding/verifier are deliberately preserved. */
export const updatePolicyInTransaction = Effect.fn("LocalOperator.updatePolicyInTransaction")(function* (
  tx: Tx,
  input: { expectedRevision: number; policy: unknown; now: number },
) {
  const current = yield* requireMutation(tx)
  if (current.revision !== input.expectedRevision)
    return yield* failure("LOCAL_OPERATOR_REVISION_CONFLICT", "Operator policy changed")
  const policy = yield* decode(LocalOperatorSchema.Policy, input.policy)
  yield* validatePolicy(tx, policy, current.operator_id)
  // Route changes preserve an existing receiver lifetime; they never renew it.
  const next = {
    ...current,
    revision: current.revision + 1,
    policy_revision: current.policy_revision + 1,
    policy,
    policy_hash: hash(policy),
    updated_at: input.now,
  }
  const updated = yield* tx
    .update(LocalOperatorAuthorityTable)
    .set({ ...next, identity_hash: identityHash(next) })
    .where(
      and(
        eq(LocalOperatorAuthorityTable.instance_id, current.instance_id),
        eq(LocalOperatorAuthorityTable.revision, current.revision),
        eq(LocalOperatorAuthorityTable.identity_hash, current.identity_hash),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* failure("LOCAL_OPERATOR_REVISION_CONFLICT", "Operator policy changed")
  return updated
})

export const verifyOperator = Effect.fn("LocalOperator.verifyOperator")(function* (
  tx: Tx,
  input: IMTaskAuthoritySchema.Principal,
) {
  const current = yield* requireCurrent(tx)
  if (hash(input) !== hash(principal(current)))
    return yield* failure("LOCAL_OPERATOR_REVOKED", "Operator authority changed")
  return principal(current)
})
export function principal(record: Record): IMTaskAuthoritySchema.Principal {
  return {
    instanceID: record.instance_id,
    actorID: record.operator_id,
    revision: record.revision,
    identityHash: record.identity_hash,
  }
}
export function mutationWitness(record: Record): LocalOperatorSchema.MutationWitness {
  return {
    ...principal(record),
    credentialGeneration: record.credential_generation,
    credentialBinding: record.credential_binding,
    installationKeyHash: record.installation_key_hash,
  }
}
export const command = Effect.fn("LocalOperator.command")(function* (
  tx: Tx,
  instanceID: string,
  operationID: string,
  requestHash: string,
) {
  const prior = yield* tx
    .select()
    .from(LocalOperatorCommandTable)
    .where(
      and(
        eq(LocalOperatorCommandTable.instance_id, instanceID),
        eq(LocalOperatorCommandTable.operation_id, operationID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (prior && prior.request_hash !== requestHash)
    return yield* failure("LOCAL_OPERATOR_CONFLICT", "Operation identity was reused with different content")
  return prior
})
export const saveCommand = Effect.fn("LocalOperator.saveCommand")(function* (
  tx: Tx,
  input: {
    instanceID: string
    operationID: string
    action: (typeof LocalOperatorCommandTable.$inferSelect)["action"]
    requestHash: string
    expectedRevision: number | null
    result: (typeof LocalOperatorCommandTable.$inferSelect)["receipt"]
    now: number
  },
) {
  yield* tx
    .insert(LocalOperatorCommandTable)
    .values({
      command_id: `locmd_${hash([input.instanceID, input.operationID])}`,
      instance_id: input.instanceID,
      operation_id: input.operationID,
      action: input.action,
      request_hash: input.requestHash,
      expected_revision: input.expectedRevision,
      receipt: input.result,
      created_at: input.now,
    })
    .run()
    .pipe(Effect.orDie)
})
export const validatePolicy = Effect.fn("LocalOperator.validatePolicy")(function* (
  tx: Tx,
  policy: LocalOperatorSchema.Policy,
  operatorID: string,
) {
  const receivers = policy.kernelReceivers ?? []
  if (new Set(receivers.map((receiver) => receiver.id)).size !== receivers.length)
    return yield* failure("LOCAL_OPERATOR_INVALID", "Kernel receiver mapping identifiers must be unique")
  const scopes = new Set<string>()
  for (const receiver of receivers) {
    const target = policy.targets.find((entry) => entry.id === receiver.targetID)
    if (!target) return yield* failure("LOCAL_TASK_SCOPE_DENIED", "Kernel receiver mapping requires an enrolled target")
    const scope = hash([receiver.realmID, receiver.appkeyID, receiver.orgID, receiver.receiverID, receiver.localUserID, target.target.scope.workspaceID])
    if (scopes.has(scope)) return yield* failure("LOCAL_OPERATOR_INVALID", "Kernel receiver mapping is ambiguous in this workspace")
    scopes.add(scope)
  }
  if (new Set(policy.targets.map((target) => target.id)).size !== policy.targets.length)
    return yield* failure("LOCAL_OPERATOR_INVALID", "Policy target identifiers must be unique")
  for (const entry of policy.targets) {
    const projectTarget = "version" in entry.target
    if (projectTarget && policy.version === 1) return yield* failure("LOCAL_TASK_SCOPE_DENIED", "Project target requires explicit project enrollment")
    const profile = WorkAuthorityPolicy.profileFor(entry.target.profile)
    const endpoint = WorkAuthorityPolicy.normalizeEndpoint(entry.target.provider.endpoint)
    if (
      !profile || projectTarget === (profile.id === WorkAuthorityPolicy.TEXT_ONLY_PROFILE.id) ||
      (projectTarget && !WorkAuthorityPolicy.checkInvestigationPolicy(entry.target).ok) ||
      !WorkAuthorityPolicy.checkBudgetCeiling(profile.budget, entry.target.budget).ok ||
      entry.target.durationMs > entry.target.budget.maxDurationMs ||
      !endpoint.ok ||
      endpoint.value !== entry.target.provider.endpoint
    )
      return yield* failure(
        "LOCAL_TASK_SCOPE_DENIED",
        "Only explicit bounded targets with canonical provider endpoints can be enrolled",
      )
    if (
      entry.target.scope.actorID !== operatorID ||
      entry.target.location.workspaceID !== undefined ||
      entry.target.scope.workspaceID !== entry.target.location.directory
    )
      return yield* failure("LOCAL_TASK_SCOPE_DENIED", "Only registered implicit-local operator targets are supported")
    const namespace = yield* tx
      .select()
      .from(SecurityNamespaceTable)
      .where(eq(SecurityNamespaceTable.id, entry.target.scope.securityNamespaceID))
      .get()
      .pipe(Effect.orDie)
    const location = yield* tx
      .select()
      .from(LocationIdentityTable)
      .where(
        and(
          eq(LocationIdentityTable.security_namespace_id, entry.target.scope.securityNamespaceID),
          eq(LocationIdentityTable.location_key, entry.locationKey),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    const project = yield* tx
      .select()
      .from(ProjectScopeIdentityTable)
      .where(
        and(
          eq(ProjectScopeIdentityTable.security_namespace_id, entry.target.scope.securityNamespaceID),
          eq(ProjectScopeIdentityTable.project_scope_key, entry.target.scope.projectScopeKey),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (
      !namespace ||
      namespace.kind !== "implicit_local" ||
      namespace.retired_at !== null ||
      namespace.binding_hash !== entry.namespaceBindingHash ||
      !location ||
      location.retired_at !== null ||
      location.workspace_binding !== null ||
      location.canonical_root !== entry.target.location.directory ||
      location.project_scope_key !== entry.target.scope.projectScopeKey ||
      !project ||
      project.retired_at !== null
    )
      return yield* failure("LOCAL_TASK_SCOPE_DENIED", "Registered target placement is unavailable or changed")
  }
  if (policy.version === 3 || policy.version === 4) {
    if (new Set(policy.eventOrigins.map((origin) => origin.id)).size !== policy.eventOrigins.length)
      return yield* failure("LOCAL_OPERATOR_INVALID", "Event origins must have unique identities")
    for (const origin of policy.eventOrigins) {
      const target = policy.targets.find((entry) => entry.id === origin.targetID)?.target
      if (!target || !("version" in target))
        return yield* failure("LOCAL_TASK_SCOPE_DENIED", "Event origin requires an explicit project target")
      if ("execution" in origin) {
        if (policy.version !== 4 || target.childPolicy === "deny_all" || target.childPolicy.kind !== "event_dag_v1" ||
          !EventWorkDagPolicy.validatePlan(origin.execution.plan, target).ok ||
          origin.execution.plan.nodes.some((node) => target.childPolicy === "deny_all" || target.childPolicy.kind !== "event_dag_v1" ||
            !target.childPolicy.agents.includes(node.agentID) ||
            node.toolIDs.some((id) => target.childPolicy === "deny_all" || target.childPolicy.kind !== "event_dag_v1" || !target.childPolicy.toolIDs.includes(id)) ||
            !WorkAuthorityPolicy.checkBudgetCeiling(target.childPolicy.budget, node.budget).ok))
          return yield* failure("LOCAL_TASK_SCOPE_DENIED", "Event DAG plan differs from its explicit shared-root target")
      } else if (target.childPolicy !== "deny_all" ||
        target.toolPolicy.capabilities.some((entry) => entry.toolID !== "read") || target.toolPolicy.fileScope.write.length !== 0 ||
        target.budget.maxChildren !== 0 || target.profile.id === WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.id)
        return yield* failure("LOCAL_TASK_SCOPE_DENIED", "Event origin requires an explicit non-delegating read-only project target")
      const source = yield* tx.get<{ id: string }>(sql`SELECT id FROM session WHERE id=${origin.sourceSessionID}
        AND parent_id IS NULL AND workspace_id IS NULL AND directory=${SessionTable.directory.mapToDriverValue(target.location.directory)}
        AND project_id=${target.projectScope.projectID}
        AND NOT EXISTS(SELECT 1 FROM work_execution w WHERE w.session_id=session.id)`).pipe(Effect.mapError(() =>
          new LocalOperatorSchema.Error({ code: "LOCAL_OPERATOR_UNAVAILABLE", message: "Current event origin storage is unavailable" })))
      if (!source) return yield* failure("LOCAL_TASK_SCOPE_DENIED", "Event origin is not the original ordinary root Session at this project")
    }
  }
})

function requireFreshReceivers(policy: LocalOperatorSchema.Policy, now: number) {
  return policy.kernelReceivers?.some((receiver) => receiver.issuedAt > now || receiver.expiresAt <= now)
    ? failure("LOCAL_OPERATOR_INVALID", "New kernel receiver mapping must have a current fixed seven-day lifetime")
    : Effect.void
}

function identityHash(record: Omit<Record, "identity_hash">) {
  return hash({
    instanceID: record.instance_id,
    operatorID: record.operator_id,
    username: record.username,
    credentialBinding: record.credential_binding,
    credentialVerifierHash: hash(record.credential_verifier),
    installationKeyHash: record.installation_key_hash,
    state: record.state,
    revision: record.revision,
    credentialGeneration: record.credential_generation,
    policyRevision: record.policy_revision,
    policyHash: record.policy_hash,
  })
}
function receipt(record: Record): LocalOperatorSchema.CommandReceipt {
  return {
    instanceID: record.instance_id,
    operatorID: record.operator_id,
    revision: record.revision,
    credentialGeneration: record.credential_generation,
    policyRevision: record.policy_revision,
    state: record.state,
  }
}
function validID(value: string) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
}
