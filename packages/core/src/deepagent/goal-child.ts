export * as GoalChild from "./goal-child"

import { eq, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import type { SessionV2 } from "../session"
import { AgentV2 } from "../agent"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { AbsolutePath } from "../schema"
import { SessionSchema } from "../session/schema"
import { SessionMessage } from "../session/message"
import { SessionInputTable, SessionTable } from "../session/sql"
import { fromRow } from "../session/info"
import { Prompt } from "../session/prompt"
import { WorkspaceV2 } from "../workspace"
import { GoalControl } from "./goal-control"
import { GoalTickPermitTable } from "./goal-control.sql"
import { GoalChildSchema } from "./goal-child.schema"
import { GoalChildUnitTable } from "./goal-child.sql"
import { GoalChildResult } from "./goal-child-result"
import { GoalChildPolicy } from "./goal-child-policy"
import { GoalTickCheckpoint } from "./goal-tick-checkpoint"
import { GoalTickCheckpointV2 } from "./goal-tick-checkpoint-v2"

type Db = Database.Interface["db"]
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Db | Transaction
export type Row = typeof GoalChildUnitTable.$inferSelect
type Creation = Parameters<SessionV2.Interface["create"]>[0]
type Input = Parameters<SessionV2.Interface["prompt"]>[0]
export type Admission = {
  permitID: string
  permitToken: string
  roleKey: string
  agent: string
  mode: "plain" | "structured"
  steeringHash: string
  promptPolicyHash: string
  stage: GoalChildSchema.Stage
  text: string
  policy?: GoalChildPolicy.Snapshot
}

// Neither reference nor issuer is exported. A witness authorizes exactly one unit/stage/operation,
// expires when that call exits, and cannot be reconstructed from a serialized object or metadata.
const Current = Context.Reference<object | undefined>("GoalChild.private-admission", { defaultValue: () => undefined })
const witnesses = new WeakMap<
  object,
  { unitID: string; stage: GoalChildSchema.Stage; operation: "create" | "prompt" }
>()
const failure = (code: GoalChildSchema.Error["code"], message: string) => new GoalChildSchema.Error({ code, message })
const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.fail(
        error instanceof GoalChildSchema.Error
          ? error
          : failure("GOAL_CHILD_UNAVAILABLE", "Goal child admission is unavailable"),
      ),
    ),
    Effect.catchDefect(() => Effect.fail(failure("GOAL_CHILD_UNAVAILABLE", "Goal child authority could not be read"))),
  )

export const owner = (db: Reader, sessionID: string) =>
  storage(
    Effect.gen(function* () {
      // Reserved child IDs are fenced before a Session exists. Real ancestry also fences descendants;
      // descriptive Session metadata never participates in ownership lookup.
      const rows = yield* db.all<{ unit_id: string }>(sql`
    WITH RECURSIVE lineage(id,parent_id) AS (
      SELECT id,parent_id FROM session WHERE id=${sessionID}
      UNION SELECT s.id,s.parent_id FROM session s JOIN lineage p ON s.id=p.parent_id
    )
    SELECT unit_id FROM goal_child_unit WHERE child_session_id=${sessionID}
      OR child_session_id IN (SELECT id FROM lineage) LIMIT 1
  `)
      if (!rows[0]) return undefined
      return yield* read(db, rows[0].unit_id)
    }),
  )

export const requireOrdinary = (db: Reader, sessionID: string) =>
  storage(
    Effect.gen(function* () {
      if (yield* owner(db, sessionID))
        return yield* failure(
          "GOAL_CHILD_MANAGED",
          "This Goal child is managed; public mutation and ordinary execution are unavailable",
        )
    }),
  )

/** The ordinary/no-witness path stays closed. Durable JSON and admission witnesses grant no execution. */
export const requireExecution = (db: Reader, sessionID: string) =>
  storage(
    Effect.gen(function* () {
      if (yield* owner(db, sessionID))
        return yield* failure(
          "GOAL_CHILD_RECOVERY_REQUIRED",
          "Managed Goal child execution requires the unavailable owned-drain capability",
        )
    }),
  )

export const requireCreate = (db: Reader, input: Creation) =>
  storage(
    Effect.gen(function* () {
      if (input.parentID) yield* requireOrdinary(db, input.parentID)
      if (!input.id) return
      const row = yield* owner(db, input.id)
      if (!row) return
      yield* witness(db, row, "create")
      if (
        row.child_session_id !== input.id ||
        GoalControl.fingerprint(creationBinding(input)) !== GoalControl.fingerprint(expectedCreation(row.binding))
      )
        return yield* failure(
          "GOAL_CHILD_CONFLICT",
          "Goal child creation does not match its reserved parent, model, agent, permissions and placement",
        )
      const existing = yield* db.select().from(SessionTable).where(eq(SessionTable.id, input.id)).get()
      if (!existing) return
      yield* matchSession(row, existing)
      if (!row.creation_receipt)
        return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Existing Goal child lacks its atomic creation receipt")
    }),
  )

/** Runs in the actual Session.Created event transaction, after projection. */
export const recordCreation = (db: Reader, input: Creation, seq: number) =>
  storage(
    Effect.gen(function* () {
      if (!input.id) return
      const row = yield* owner(db, input.id)
      if (!row) return
      yield* witness(db, row, "create")
      const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, input.id)).get()
      if (!session) return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal child projection is missing")
      yield* matchSession(row, session)
      const receipt = { seq, sessionHash: GoalControl.fingerprint(expectedCreation(row.binding)) }
      if (row.creation_receipt && GoalControl.fingerprint(row.creation_receipt) !== GoalControl.fingerprint(receipt))
        return yield* failure("GOAL_CHILD_CONFLICT", "Goal child creation receipt changed")
      yield* db
        .update(GoalChildUnitTable)
        .set({ creation_receipt: receipt, updated_at: Date.now() })
        .where(eq(GoalChildUnitTable.unit_id, row.unit_id))
        .run()
    }),
  )

/** True only for the exact private prompt call; public methods cannot borrow its witness. */
export const requirePrompt = (db: Reader, input: Input) =>
  storage(
    Effect.gen(function* () {
      const row = yield* owner(db, input.sessionID)
      if (!row) return false
      const proof = yield* witness(db, row, "prompt")
      const receipt = row.inputs.find((item) => item.stage === proof.stage)
      if (
        !receipt ||
        input.sessionID !== row.child_session_id ||
        input.id !== receipt.inputID ||
        input.resume !== false ||
        input.delivery !== "queue" ||
        input.revertEpoch !== undefined ||
        GoalControl.fingerprint(input.prompt) !== receipt.promptHash
      )
        return yield* failure(
          "GOAL_CHILD_CONFLICT",
          "Goal prompt does not match its stable input, stage, text and delivery",
        )
      const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get()
      if (!session || !row.creation_receipt)
        return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal child creation is not proven")
      yield* matchSession(row, session)
      return true
    }),
  )

/** Used both by SessionInput's event commit hook and the exact-retry transaction. */
export const recordInput = (db: Reader, input: Input, seq: number) =>
  storage(
    Effect.gen(function* () {
      if (!(yield* requirePrompt(db, input))) return
      const row = (yield* owner(db, input.sessionID))!
      const proof = yield* witness(db, row, "prompt")
      const recorded = yield* db.get<{ session_id: string; admitted_seq: number; prompt: string; delivery: string }>(
        sql`SELECT session_id,admitted_seq,prompt,delivery FROM session_input WHERE id=${input.id}`,
      )
      if (
        !recorded ||
        recorded.session_id !== row.child_session_id ||
        recorded.admitted_seq !== seq ||
        recorded.delivery !== "queue"
      )
        return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal input has no matching durable admission")
      const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(recorded.prompt)
      const receipt = row.inputs.find((item) => item.stage === proof.stage)!
      if (
        Option.isNone(parsed) ||
        GoalControl.fingerprint(parsed.value) !== receipt.promptHash ||
        (receipt.admittedSeq !== null && receipt.admittedSeq !== seq)
      )
        return yield* failure("GOAL_CHILD_CONFLICT", "Goal input admission receipt conflicts with the persisted prompt")
      if (receipt.admittedSeq === seq && row.state === "admitted") return
      yield* db
        .update(GoalChildUnitTable)
        .set({
          state: "admitted",
          inputs: row.inputs.map((item) => (item.stage === proof.stage ? { ...item, admittedSeq: seq } : item)),
          updated_at: Date.now(),
        })
        .where(eq(GoalChildUnitTable.unit_id, row.unit_id))
        .run()
    }),
  )

/** Exact retries may bypass the event hook, but must reconcile its same durable receipt atomically. */
export const reconcileInput = (db: Db, input: Input, seq: number) =>
  storage(db.transaction((tx) => recordInput(tx, input, seq), { behavior: "immediate" }))

export const admit = (db: Db, sessions: Pick<SessionV2.Interface, "create" | "prompt">, input: Admission) =>
  storage(
    Effect.gen(function* () {
      const row = yield* db.transaction((tx) => reserve(tx, input), { behavior: "immediate" })
      yield* withWitness(
        row.unit_id,
        input.stage,
        "create",
        sessions.create({
          id: SessionSchema.ID.make(row.child_session_id),
          parentID: SessionSchema.ID.make(row.parent_session_id),
          title: `Goal ${row.role_key}`,
          agent: AgentV2.ID.make(row.binding.agent),
          model: {
            providerID: ProviderV2.ID.make(row.binding.model.providerID),
            id: ModelV2.ID.make(row.binding.model.id),
            variant: ModelV2.VariantID.make(row.binding.model.variant),
          },
          permissions: [...row.binding.permissions],
          location: {
            directory: AbsolutePath.make(row.binding.directory),
            ...(row.binding.workspaceID ? { workspaceID: WorkspaceV2.ID.make(row.binding.workspaceID) } : {}),
          },
        }),
      )
      const receipt = row.inputs.find((item) => item.stage === input.stage)!
      const admitted = yield* withWitness(
        row.unit_id,
        input.stage,
        "prompt",
        sessions.prompt({
          id: SessionMessage.ID.make(receipt.inputID),
          sessionID: SessionSchema.ID.make(row.child_session_id),
          prompt: new Prompt({ text: receipt.text }),
          delivery: "queue",
          resume: false,
        }),
      )
      const unit = (yield* read(db, row.unit_id))!
      if (
        !unit.creation_receipt ||
        unit.inputs.find((item) => item.stage === input.stage)?.admittedSeq !== admitted.admittedSeq
      )
        return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Session admission did not commit matching Goal receipts")
      return { unit, admitted }
    }),
  ).pipe(GoalChildResult.withRuntimeIdentity(db))

export const admitV2 = (
  db: Db,
  sessions: Pick<SessionV2.Interface, "create" | "prompt">,
  input: Omit<Admission, "agent"> & { policy: GoalChildPolicy.Snapshot },
) =>
  Effect.gen(function* () {
    const proof = GoalChildPolicy.inspect(input.policy)
    if (!proof) return yield* failure("GOAL_CHILD_CONFLICT", "Goal policy snapshot is not current")
    return yield* admit(db, sessions, {
      ...input,
      agent: proof.agent,
      steeringHash: proof.steeringHash,
      promptPolicyHash: proof.promptPolicyHash,
    })
  })

/** Internal read-only evidence, not a witness. Only the owned execution issuer may use it. */
export const executionSource = (db: Reader, unitID: string) =>
  storage(
    Effect.gen(function* () {
      const row = yield* read(db, unitID)
      if (!row || row.state !== "admitted" || !row.creation_receipt)
        return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal child has no complete admitted binding")
      const source = yield* currentPermit(db, row.permit_id, row.binding.permitToken)
      yield* GoalChildPolicy.requireCurrent(db, row.binding)
      if (
        source.goal.initialization_hash !== row.binding.initializationHash ||
        source.goal.initialization.planHash !== row.binding.planHash ||
        parentFingerprint(source.parent) !== row.binding.parentHash
      )
        return yield* failure("GOAL_CHILD_CONFLICT", "Goal source or parent changed")
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionSchema.ID.make(row.child_session_id)))
        .get()
      if (!session) return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal child Session is missing")
      yield* matchSession(row, session)
      // Later-stage/result admission remains closed. Exactly one real inbox item belongs to this unit.
      const input = row.binding.version !== 1 ? row.inputs.at(-1) : row.inputs[0]
      if (
        (row.binding.version === 1 && row.inputs.length !== 1) ||
        !input ||
        (row.binding.version === 1 && !["plain", "research"].includes(input.stage)) ||
        input.admittedSeq === null ||
        input.resultRef !== null ||
        input.resultHash !== null
      )
        return yield* failure(
          "GOAL_CHILD_RECOVERY_REQUIRED",
          "Goal stage or result is not eligible for owned execution",
        )
      const inbox = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, session.id)).all()
      if (
        inbox.length !== row.inputs.length ||
        row.inputs.some((item) => {
          const actual = inbox.find((entry) => entry.id === item.inputID)
          return (
            !actual ||
            actual.admitted_seq !== item.admittedSeq ||
            actual.delivery !== item.delivery ||
            actual.revert_epoch !== null ||
            GoalControl.fingerprint(actual.prompt) !== item.promptHash
          )
        }) ||
        row.inputs
          .slice(0, -1)
          .some((item) => item.resultRef === null || item.resultHash === null || item.execution?.state !== "settled")
      )
        return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal input does not match its sole durable admission")
      return { row, input, session, inbox: inbox.find((entry) => entry.id === input.inputID)!, permit: source.permit }
    }),
  )

function withWitness<A, E, R>(
  unitID: string,
  stage: GoalChildSchema.Stage,
  operation: "create" | "prompt",
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.suspend(() => {
    const token = Object.freeze({})
    witnesses.set(token, { unitID, stage, operation })
    return effect.pipe(
      Effect.provideService(Current, token),
      Effect.ensuring(Effect.sync(() => witnesses.delete(token))),
    )
  })
}

export const read = (db: Reader, unitID: string) =>
  Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(GoalChildUnitTable)
      .where(eq(GoalChildUnitTable.unit_id, unitID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    if (
      !Schema.is(GoalChildSchema.Binding)(row.binding) ||
      !Schema.is(GoalChildSchema.Inputs)(row.inputs) ||
      !Schema.is(GoalChildSchema.State)(row.state) ||
      (row.creation_receipt !== null && !Schema.is(GoalChildSchema.CreationReceipt)(row.creation_receipt))
    )
      return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal child record is malformed")
    if (
      row.binding_hash !== GoalControl.fingerprint(row.binding) ||
      row.binding.unitID !== row.unit_id ||
      row.binding.goalID !== row.goal_id ||
      row.binding.permitID !== row.permit_id ||
      row.binding.roleKey !== row.role_key ||
      row.binding.childSessionID !== row.child_session_id ||
      row.binding.parentSessionID !== row.parent_session_id
    )
      return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal child binding changed")
    const stages = row.binding.mode === "plain" ? ["plain"] : ["research", "finalizer.1", "finalizer.2"]
    if (
      row.inputs.some(
        (item, index) =>
          item.stage !== stages[index] ||
          item.inputID !== inputID(row.unit_id, item.stage) ||
          item.promptHash !== GoalControl.fingerprint(new Prompt({ text: item.text })),
      )
    )
      return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal input identity or prompt binding changed")
    if (
      row.creation_receipt &&
      row.creation_receipt.sessionHash !== GoalControl.fingerprint(expectedCreation(row.binding))
    )
      return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal creation receipt binding changed")
    if (row.inputs.some((item) => item.admittedSeq !== null) && !row.creation_receipt)
      return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal input lacks its creation receipt")
    return row
  })

const witness = (db: Reader, row: Row, operation: "create" | "prompt") =>
  Effect.gen(function* () {
    const current = yield* Current
    const proof = current ? witnesses.get(current) : undefined
    if (
      !proof ||
      proof.unitID !== row.unit_id ||
      proof.operation !== operation ||
      !row.inputs.some((item) => item.stage === proof.stage)
    )
      return yield* failure(
        "GOAL_CHILD_MANAGED",
        "Only the exact private Goal admission operation may write this child",
      )
    const source = yield* currentPermit(db, row.permit_id, row.binding.permitToken)
    yield* GoalChildPolicy.requireCurrent(db, row.binding)
    if (
      source.goal.initialization_hash !== row.binding.initializationHash ||
      source.goal.initialization.planHash !== row.binding.planHash
    )
      return yield* failure("GOAL_CHILD_CONFLICT", "Goal initialization changed after reservation")
    if (row.state !== "reserved" && row.state !== "admitted")
      return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal child no longer accepts admission")
    const parent = yield* GoalControl.session(db, row.parent_session_id)
    if (parentFingerprint(parent) !== row.binding.parentHash)
      return yield* failure("GOAL_CHILD_CONFLICT", "Goal parent binding changed")
    return proof
  })

const currentPermit = (db: Reader, permitID: string, token: string) =>
  Effect.gen(function* () {
    const permit = yield* db.select().from(GoalTickPermitTable).where(eq(GoalTickPermitTable.permit_id, permitID)).get()
    if (!permit || permit.token !== token || permit.state !== "issued" || permit.owner_id !== GoalControl.ownerID)
      return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal child admission has no current-process issued permit")
    const goal = yield* GoalControl.get(db, permit.goal_id)
    if (
      !goal ||
      !goal.is_current ||
      goal.preparation !== "ready" ||
      goal.requested_phase !== "running" ||
      goal.revision !== permit.control_revision ||
      goal.next_seq !== permit.tick_seq ||
      goal.plan_version !== permit.plan_version
    )
      return yield* failure("GOAL_CHILD_CONFLICT", "Goal control or cursor no longer authorizes child admission")
    const parent = yield* GoalControl.session(db, goal.session_id)
    if (
      parent.project_id !== goal.project_id ||
      parent.directory !== goal.directory ||
      parent.workspace_id !== goal.workspace_id
    )
      return yield* failure("GOAL_CHILD_CONFLICT", "Goal placement changed")
    yield* GoalControl.requireOrdinary(db, parent.id)
    return { permit, goal, parent }
  })

const reserve = (db: Transaction, input: Admission) =>
  Effect.gen(function* () {
    if (
      !Schema.is(GoalChildSchema.Text)(input.roleKey) ||
      !Schema.is(GoalChildSchema.Text)(input.agent) ||
      !Schema.is(GoalChildSchema.Hash)(input.steeringHash) ||
      !Schema.is(GoalChildSchema.Hash)(input.promptPolicyHash) ||
      Buffer.byteLength(input.text, "utf8") > 262144
    )
      return yield* failure("GOAL_CHILD_INVALID_REQUEST", "Goal child role, prompt or fingerprint is invalid")
    const source = yield* currentPermit(db, input.permitID, input.permitToken)
    const key = GoalControl.fingerprint([input.permitID, input.roleKey])
    const unitID = `goalchild_${key}`
    const childSessionID = `ses_goalchild_${key.slice(0, 40)}`
    const parent = fromRow(source.parent)
    if (parent.model?.variant !== undefined && parent.model.variant !== "default")
      return yield* failure("GOAL_CHILD_UNAVAILABLE", "Goal initialization does not freeze a non-default model variant")
    const legacyBinding: typeof GoalChildSchema.BindingV1.Type = {
      version: 1,
      unitID,
      goalID: source.goal.goal_id,
      permitID: input.permitID,
      permitToken: input.permitToken,
      roleKey: input.roleKey,
      parentSessionID: source.parent.id,
      childSessionID,
      projectID: source.parent.project_id,
      directory: source.parent.directory,
      ...(source.parent.workspace_id ? { workspaceID: source.parent.workspace_id } : {}),
      agent: input.agent,
      model: {
        providerID: source.goal.initialization.model.providerID,
        id: source.goal.initialization.model.modelID,
        variant: "default",
      },
      permissions: parent.permissions,
      permissionPolicy: "parent-exact-v1",
      mode: input.mode,
      initializationHash: source.goal.initialization_hash,
      planHash: source.goal.initialization.planHash,
      steeringHash: input.steeringHash,
      promptPolicyHash: input.promptPolicyHash,
      parentHash: parentFingerprint(source.parent),
    }
    const policy = input.policy ? GoalChildPolicy.inspect(input.policy) : undefined
    if (input.policy && !policy) return yield* failure("GOAL_CHILD_CONFLICT", "Goal native policy snapshot expired")
    const binding: GoalChildSchema.Binding = policy
      ? policy.policy.version === "derived-subagent-v3"
        ? {
            ...legacyBinding,
            version: 3,
            permissionPolicy: "derived-subagent-v3",
            policy: policy.policy,
            permissions: policy.permissions,
          }
        : {
            ...legacyBinding,
            version: 2,
            permissionPolicy: "derived-subagent-v2",
            policy: policy.policy,
            permissions: policy.permissions,
          }
      : legacyBinding
    if (binding.version !== 1) yield* GoalChildPolicy.authorizeBinding(db, binding, input.policy!)
    if (binding.version === 3 && ["plain", "research"].includes(input.stage)) {
      const checkpoint = yield* GoalTickCheckpointV2.read(db, input.permitID)
      const activation = checkpoint?.journal.activations.find((item) => item.unitID === unitID)
      if (!activation || activation.promptHash !== GoalControl.fingerprint(new Prompt({ text: input.text })))
        return yield* failure("GOAL_CHILD_CONFLICT", "Goal prompt differs from its one-time program activation")
    }
    if (binding.version === 2 && ["plain", "research"].includes(input.stage)) {
      const checkpoint = yield* GoalTickCheckpoint.read(db, input.permitID)
      if (
        checkpoint?.journal.roles.find((role) => role.key === input.roleKey)?.promptHash !==
        GoalControl.fingerprint(new Prompt({ text: input.text }))
      )
        return yield* failure("GOAL_CHILD_CONFLICT", "Goal prompt differs from the pre-dispatch role manifest")
    }
    if (!Schema.is(GoalChildSchema.Binding)(binding))
      return yield* failure("GOAL_CHILD_INVALID_REQUEST", "Goal child binding is invalid")
    const existing = yield* read(db, unitID)
    if (existing && existing.binding_hash !== GoalControl.fingerprint(binding))
      return yield* failure("GOAL_CHILD_CONFLICT", "Goal role was reserved with different content")
    if (
      !existing &&
      (yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionSchema.ID.make(childSessionID)))
        .get())
    )
      return yield* failure("GOAL_CHILD_CONFLICT", "Reserved Goal child identity is already occupied")
    if (existing && existing.state !== "reserved" && existing.state !== "admitted")
      return yield* failure("GOAL_CHILD_RECOVERY_REQUIRED", "Goal child no longer accepts admission")
    // Later stages need the trusted result/owned-run integration from F15-B/C. A never accepts
    // multiple queued inputs based solely on caller-supplied result references.
    if (input.stage === "finalizer.1" || input.stage === "finalizer.2") {
      if (binding.version === 1 || !existing)
        return yield* failure("GOAL_CHILD_UNAVAILABLE", "Goal finalizers require verified prior-stage results")
      const checkpoint =
        binding.version === 3
          ? yield* GoalTickCheckpointV2.read(db, binding.permitID)
          : yield* GoalTickCheckpoint.read(db, binding.permitID)
      const predecessor = input.stage === "finalizer.1" ? "research" : "finalizer.1"
      const result = checkpoint?.journal.results.find(
        (result) => result.unitID === unitID && result.stage === predecessor,
      )
      const priorInput = existing.inputs.find((item) => item.stage === predecessor)
      if (
        !result ||
        !priorInput?.resultRef ||
        priorInput.resultHash !== result.resultHash ||
        priorInput.execution?.state !== "settled" ||
        (input.stage === "finalizer.2" && result.outcome !== "schema_invalid")
      )
        return yield* failure(
          "GOAL_CHILD_RECOVERY_REQUIRED",
          "Goal successor requires the exact known predecessor result",
        )
      yield* GoalChildResult.inspect(db, unitID, predecessor)
    }
    const prior = existing?.inputs.find((item) => item.stage === input.stage)
    const receipt: GoalChildSchema.InputReceipt = {
      stage: input.stage,
      inputID: inputID(unitID, input.stage),
      promptHash: GoalControl.fingerprint(new Prompt({ text: input.text })),
      text: input.text,
      delivery: "queue",
      admittedSeq: null,
      activityID: null,
      resultRef: null,
      resultHash: null,
    }
    if (prior && (prior.promptHash !== receipt.promptHash || prior.text !== input.text))
      return yield* failure("GOAL_CHILD_CONFLICT", "Goal stage has a different prompt")
    const stages = input.mode === "plain" ? ["plain"] : ["research", "finalizer.1", "finalizer.2"]
    if (!prior && stages[existing?.inputs.length ?? 0] !== input.stage)
      return yield* failure("GOAL_CHILD_CONFLICT", "Goal stages must follow their fixed bounded order")
    if (existing) {
      if (!prior)
        yield* db
          .update(GoalChildUnitTable)
          .set({ inputs: [...existing.inputs, receipt], updated_at: Date.now() })
          .where(eq(GoalChildUnitTable.unit_id, unitID))
          .run()
      return (yield* read(db, unitID))!
    }
    yield* db
      .insert(GoalChildUnitTable)
      .values({
        unit_id: unitID,
        goal_id: source.goal.goal_id,
        permit_id: input.permitID,
        role_key: input.roleKey,
        parent_session_id: source.parent.id,
        child_session_id: childSessionID,
        binding,
        binding_hash: GoalControl.fingerprint(binding),
        state: "reserved",
        inputs: [receipt],
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .run()
    return (yield* read(db, unitID))!
  })

function inputID(unitID: string, stage: string) {
  return `msg_goalchild_${GoalControl.fingerprint([unitID, stage]).slice(0, 40)}`
}
function expectedCreation(binding: GoalChildSchema.Binding) {
  return {
    id: binding.childSessionID,
    parentID: binding.parentSessionID,
    agent: binding.agent,
    model: binding.model,
    permissions: binding.permissions,
    location: { directory: binding.directory, ...(binding.workspaceID ? { workspaceID: binding.workspaceID } : {}) },
  }
}
function creationBinding(input: Creation) {
  return {
    id: input.id,
    parentID: input.parentID,
    agent: input.agent,
    model: input.model,
    permissions: input.permissions ?? [],
    location: input.location,
  }
}
function parentFingerprint(row: typeof SessionTable.$inferSelect) {
  const info = fromRow(row)
  return GoalControl.fingerprint({
    id: info.id,
    parentID: info.parentID,
    projectID: info.projectID,
    location: info.location,
    agent: info.agent,
    model: info.model,
    permissions: info.permissions,
  })
}
const matchSession = (row: Row, session: typeof SessionTable.$inferSelect) =>
  Effect.gen(function* () {
    const info = fromRow(session)
    if (
      !session.v2_authority ||
      session.project_id !== row.binding.projectID ||
      GoalControl.fingerprint(creationBinding(info)) !== GoalControl.fingerprint(expectedCreation(row.binding))
    )
      return yield* failure("GOAL_CHILD_CONFLICT", "Persisted Goal child does not match its exact creation binding")
  })
