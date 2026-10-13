export * as GoalChildPolicy from "./goal-child-policy"

import { eq } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { AgentV2 } from "../agent"
import type { Database } from "../database/database"
import { PermissionSchema } from "../permission/schema"
import { SessionTable } from "../session/sql"
import { SessionSchema } from "../session/schema"
import { GoalChild } from "./goal-child"
import { GoalTickProgram } from "./goal-tick-program"
import { DeepAgentPlanStore } from "./plan-store"
import { DocumentStore } from "./document-store"
import { GoalChildResult } from "./goal-child-result"
import { GoalChildSchema } from "./goal-child.schema"
import { GoalControl } from "./goal-control"
import { GoalTickCheckpoint } from "./goal-tick-checkpoint"
import { GoalTickCheckpointV2 } from "./goal-tick-checkpoint-v2"
import { GoalChildUnitTable } from "./goal-child.sql"

type Db = Database.Interface["db"]
type Reader = GoalTickCheckpoint.Reader
const identity: unique symbol = Symbol("GoalChildPolicy.Snapshot")
export type Snapshot = { readonly [identity]: true }
const frameIdentity: unique symbol = Symbol("GoalChildPolicy.Frame")
export type Frame = { readonly [frameIdentity]: true }
type FrameFacts = { permitID: string; active: boolean; bindings: Map<string, number> }
const frames = new WeakMap<object, FrameFacts>()
const liveFrames = new Map<string, Frame>()
const MAX_FRAMES = 32
const MAX_BINDINGS = 256
const MAX_BINDING_BYTES = 67_108_864
type Facts = {
  parent: AgentV2.Snapshot
  child: AgentV2.Snapshot
  permitID: string
  roleKey: string
  steeringHash: string
  promptPolicyHash: string
  mode: "plain" | "structured"
  policy: GoalChildSchema.Policy | GoalChildSchema.PolicyV3
  childSessionPermissions: PermissionSchema.Ruleset
  resultSchema: (Schema.Top & Schema.Decoder<unknown>) | undefined
  frame?: Frame
}
const snapshots = new WeakMap<object, Facts>()
// Process-local native snapshot handles only. A serialized binding never populates this map.
const bindings = new Map<string, Snapshot>()
const fail = (message: string) => new GoalChildSchema.Error({ code: "GOAL_CHILD_CONFLICT", message })

/** Bounded native references, not execution quota. Unknown SQL obligations are never discarded. */
export const openFrame = (db: Db, permitID: string) =>
  Effect.gen(function* () {
    yield* GoalTickCheckpoint.currentPermit(db, permitID)
    if (liveFrames.has(permitID) || liveFrames.size >= MAX_FRAMES)
      return yield* new GoalChildSchema.Error({
        code: "GOAL_CHILD_UNAVAILABLE",
        message: "Goal native policy frames are busy",
      })
    const frame: Frame = Object.freeze({ [frameIdentity]: true as const })
    frames.set(frame, { permitID, active: true, bindings: new Map() })
    liveFrames.set(permitID, frame)
    return frame
  })
export function revokeFrame(frame: Frame) {
  const facts = frames.get(frame)
  if (facts) facts.active = false
}
export function frameCurrent(frame: Frame, permitID: string) {
  const facts = frames.get(frame)
  return !!facts?.active && facts.permitID === permitID && liveFrames.get(permitID) === frame
}
export const releaseRole = (db: Db, frame: Frame, unitID: string) =>
  Effect.gen(function* () {
    const facts = frames.get(frame)
    const unit = yield* db
      .select()
      .from(GoalChildUnitTable)
      .where(eq(GoalChildUnitTable.unit_id, unitID))
      .get()
      .pipe(Effect.orDie)
    if (
      !facts ||
      !unit ||
      unit.permit_id !== facts.permitID ||
      unit.binding.version !== 3 ||
      unit.state !== "result_recorded" ||
      unit.inputs.some(
        (item) => item.execution?.state !== "settled" || item.resultHash === null || item.resultRef === null,
      )
    )
      return yield* fail("Only an atomically recorded terminal role can release its native references")
    const checkpoint = yield* GoalTickCheckpointV2.read(db, facts.permitID)
    const activation = checkpoint?.journal.activations.find((item) => item.unitID === unitID)
    if (
      !activation ||
      !checkpoint?.journal.dispositions.some((item) => item.role === activation.role && item.kind === "completed")
    )
      return yield* fail("Role result has no committed checkpoint disposition")
    bindings.delete(unit.binding_hash)
    facts.bindings.delete(unit.binding_hash)
  })
/** Invoke after exact owned drains have settled. Revocation always precedes release. */
export const releaseFrame = (db: Db, frame: Frame) =>
  Effect.gen(function* () {
    const facts = frames.get(frame)
    if (!facts) return
    if (facts.active) return yield* fail("Live native frame cannot be released")
    const units = yield* db
      .select()
      .from(GoalChildUnitTable)
      .where(eq(GoalChildUnitTable.permit_id, facts.permitID))
      .limit(65)
      .all()
      .pipe(Effect.orDie)
    if (units.length > 64 || units.some((unit) => unit.inputs.some((item) => item.execution?.state === "bound")))
      return yield* fail("Native frame still has an unsettled owned drain")
    for (const key of facts.bindings.keys()) bindings.delete(key)
    facts.bindings.clear()
    if (liveFrames.get(facts.permitID) === frame) liveFrames.delete(facts.permitID)
    frames.delete(frame)
  })

export const prepare = (
  db: Db,
  agents: AgentV2.Interface,
  input: {
    version?: 3
    frame?: Frame
    permitID: string
    roleKey: string
    agent: string
    mode: "plain" | "structured"
    resultSchema?: Schema.Top & Schema.Decoder<unknown>
  },
) =>
  Effect.gen(function* () {
    if (input.version === 3 && (!input.frame || !frameCurrent(input.frame, input.permitID)))
      return yield* fail("Version 3 policy requires the exact active tick frame")
    if (!agents.snapshot)
      return yield* new GoalChildSchema.Error({
        code: "GOAL_CHILD_UNAVAILABLE",
        message: "The actual Agent roster has no native policy snapshot capability",
      })
    const accepted = yield* Effect.gen(function* () {
      if (input.version === 3) {
        const checkpoint = yield* GoalTickCheckpointV2.read(db, input.permitID)
        if (!checkpoint) return yield* fail("Goal policy requires a pre-reserved program")
        yield* db.transaction((tx) => GoalTickCheckpointV2.requireParent(tx, checkpoint), { behavior: "immediate" })
        const roleIndex = checkpoint.journal.program.roles.findIndex((role) => role.key === input.roleKey)
        const activation = checkpoint.journal.activations.find((item) => item.role === roleIndex)
        if (!activation || checkpoint.journal.cursor.role !== roleIndex)
          return yield* fail("Goal role has no current one-time activation")
        return {
          checkpoint,
          role: checkpoint.journal.program.roles[roleIndex],
          promptHash: activation.promptHash,
          program: {
            programHash: checkpoint.journal.programHash,
            activationHash: GoalControl.fingerprint(activation),
            unitID: activation.unitID,
          },
        }
      }
      const checkpoint = yield* GoalTickCheckpoint.read(db, input.permitID)
      if (!checkpoint) return yield* fail("Goal policy requires a pre-reserved checkpoint")
      yield* db.transaction((tx) => GoalTickCheckpoint.requireParent(tx, checkpoint), { behavior: "immediate" })
      const role = checkpoint.journal.roles.find((role) => role.key === input.roleKey)
      return { checkpoint, role, promptHash: role?.promptHash, program: undefined }
    })
    const checkpoint = accepted.checkpoint
    const role = accepted.role
    if (!role || role.agent !== input.agent || role.mode !== input.mode)
      return yield* fail("Goal role differs from its immutable manifest")
    if (input.mode === "structured" && !input.resultSchema)
      return yield* fail("Structured Goal role requires a native result decoder")
    const session = yield* GoalControl.session(db, checkpoint.journal.parent.sessionID)
    const parent = yield* agents.snapshot(session.agent ?? undefined)
    const child = yield* agents.snapshot(input.agent)
    const parentView = AgentV2.snapshotView(parent)
    const childView = AgentV2.snapshotView(child)
    if (
      !parentView ||
      !childView ||
      parentView.instanceID !== childView.instanceID ||
      parentView.generation !== childView.generation ||
      childView.role?.version !== "owned-goal-v2" ||
      childView.role.kind !== role.kind
    )
      return yield* fail("Agent definitions or trusted role registration changed")
    if (role.policyHash !== roleHash(parent, child))
      return yield* fail("Role policy differs from its accepted manifest")
    const childSessionPermissions: PermissionSchema.Ruleset = [
      { action: "task", resource: "*", effect: "deny" },
      { action: "todowrite", resource: "*", effect: "deny" },
      ...(childView.role.planWriteOwnGoal ? [] : [{ action: "plan", resource: "*", effect: "deny" } as const]),
    ]
    const source = yield* GoalTickCheckpoint.currentPermit(db, input.permitID)
    const previousPolicy: GoalChildSchema.Policy = {
      version: "derived-subagent-v2",
      parentSelector: session.agent,
      parentResolvedAgentID: parentView.info.id,
      parentAgentHash: GoalControl.fingerprint(parentView.info),
      childAgentHash: GoalControl.fingerprint(childView.info),
      rosterInstanceID: parentView.instanceID,
      rosterGeneration: parentView.generation,
      role: childView.role,
      roleHash: GoalControl.fingerprint(childView.role),
      parentAgentPermissions: parentView.info.permissions,
      parentSessionPermissions: fromPermissions(session.permission),
      childAgentPermissions: childView.info.permissions,
      childSessionPermissions,
      planResource: source.goal.plan_doc_id,
      checkpointHash: checkpoint.binding_hash,
      resultSchemaHash: GoalControl.fingerprint(
        input.resultSchema ? Schema.toJsonSchemaDocument(input.resultSchema) : { type: "string" },
      ),
    }
    const policy: GoalChildSchema.Policy | GoalChildSchema.PolicyV3 = accepted.program
      ? {
          ...previousPolicy,
          version: "derived-subagent-v3",
          parentPlanResource: source.goal.plan_doc_id,
          planResource: `doc:plan:plan-ses_goalchild_${GoalControl.fingerprint([input.permitID, input.roleKey]).slice(0, 40)}`,
          programHash: accepted.program.programHash,
          activationHash: accepted.program.activationHash,
        }
      : previousPolicy
    if (accepted.program && "recipe" in role && role.recipe.schemaHash !== previousPolicy.resultSchemaHash)
      return yield* fail("Native result decoder differs from the immutable role recipe")
    const token: Snapshot = Object.freeze({ [identity]: true as const })
    snapshots.set(token, {
      parent,
      child,
      permitID: input.permitID,
      roleKey: input.roleKey,
      steeringHash: GoalControl.fingerprint(checkpoint.journal.parent.steering),
      promptPolicyHash: accepted.promptHash!,
      mode: input.mode,
      policy: freeze(policy),
      childSessionPermissions: freeze(childSessionPermissions),
      resultSchema: input.resultSchema,
      frame: input.frame,
    })
    return token
  })

export function roleHash(parent: AgentV2.Snapshot, child: AgentV2.Snapshot) {
  const source = AgentV2.snapshotView(parent)
  const target = AgentV2.snapshotView(child)
  if (!source || !target || source.instanceID !== target.instanceID || source.generation !== target.generation)
    return undefined
  return GoalControl.fingerprint({
    parent: source.info,
    child: target.info,
    role: target.role,
    instanceID: source.instanceID,
    generation: source.generation,
  })
}

export function decodeResult(binding: GoalChildSchema.Binding, stage: GoalChildSchema.Stage, text: string) {
  if (binding.version === 1) return undefined
  const token = bindings.get(GoalControl.fingerprint(binding))
  const proof = token ? snapshots.get(token) : undefined
  if (!proof || Buffer.byteLength(text) > 262144) return undefined
  if (stage === "plain" || stage === "research")
    return { outcome: "valid" as const, schemaHash: GoalControl.fingerprint({ type: "string" }), value: text }
  if (!proof.resultSchema) return undefined
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  const decoded = Option.isSome(json) ? Schema.decodeUnknownOption(proof.resultSchema)(json.value) : Option.none()
  return {
    outcome: Option.isSome(decoded) ? ("valid" as const) : ("schema_invalid" as const),
    schemaHash: binding.policy.resultSchemaHash,
    value: Option.isSome(decoded) ? decoded.value : null,
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function fromPermissions(value: unknown): PermissionSchema.Ruleset {
  if (value === null) return []
  return Schema.decodeUnknownSync(PermissionSchema.Ruleset)(value)
}

export const inspect = (snapshot: Snapshot) => {
  const proof = snapshots.get(snapshot)
  if (
    !proof ||
    (proof.frame && !frameCurrent(proof.frame, proof.permitID)) ||
    !AgentV2.snapshotView(proof.parent) ||
    !AgentV2.snapshotView(proof.child)
  )
    return undefined
  return {
    permitID: proof.permitID,
    roleKey: proof.roleKey,
    steeringHash: proof.steeringHash,
    promptPolicyHash: proof.promptPolicyHash,
    mode: proof.mode,
    policy: proof.policy,
    agent: AgentV2.snapshotView(proof.child)!.info.id,
    permissions: proof.childSessionPermissions,
  }
}

/** Called only by the internal admission path with a native opaque snapshot. */
export const authorizeBinding = (
  db: Reader,
  binding: typeof GoalChildSchema.BindingV2.Type | typeof GoalChildSchema.BindingV3.Type,
  snapshot: Snapshot,
) =>
  Effect.gen(function* () {
    const proof = inspect(snapshot)
    if (
      !proof ||
      proof.permitID !== binding.permitID ||
      proof.roleKey !== binding.roleKey ||
      proof.mode !== binding.mode ||
      proof.steeringHash !== binding.steeringHash ||
      proof.promptPolicyHash !== binding.promptPolicyHash ||
      proof.agent !== binding.agent ||
      GoalControl.fingerprint(proof.policy) !== GoalControl.fingerprint(binding.policy) ||
      GoalControl.fingerprint(proof.permissions) !== GoalControl.fingerprint(binding.permissions)
    )
      return yield* fail("Goal policy witness does not match the binding")
    yield* check(db, binding, snapshot)
    if (binding.version === 3) {
      const native = snapshots.get(snapshot)!
      const frame = native.frame ? frames.get(native.frame) : undefined
      if (!frame?.active) return yield* fail("Version 3 policy lost its native frame")
      const size = Buffer.byteLength(
        GoalTickCheckpoint.canonical({
          policy: native.policy,
          parent: AgentV2.snapshotView(native.parent)?.info,
          child: AgentV2.snapshotView(native.child)?.info,
        }),
      )
      const current = [...liveFrames.values()].flatMap((item) => [...frames.get(item)!.bindings.entries()])
      if (
        !frame.bindings.has(GoalControl.fingerprint(binding)) &&
        (current.length >= MAX_BINDINGS || current.reduce((sum, item) => sum + item[1], 0) + size > MAX_BINDING_BYTES)
      )
        return yield* new GoalChildSchema.Error({
          code: "GOAL_CHILD_UNAVAILABLE",
          message: "Goal native policy references are busy",
        })
      frame.bindings.set(GoalControl.fingerprint(binding), size)
    }
    bindings.set(GoalControl.fingerprint(binding), snapshot)
  })

export const requireCurrent = (db: Reader, binding: GoalChildSchema.Binding) =>
  Effect.gen(function* () {
    if (binding.version === 1) return
    const snapshot = bindings.get(GoalControl.fingerprint(binding))
    if (!snapshot)
      return yield* new GoalChildSchema.Error({
        code: "GOAL_CHILD_RECOVERY_REQUIRED",
        message: "Goal policy has no live native roster witness",
      })
    return yield* check(db, binding, snapshot)
  })

/** Pre-execution file preparation only. An opaque live policy cannot be reconstructed from JSON. */
export const requirePreparation = (db: Reader, unitID: string, snapshot: Snapshot) =>
  Effect.gen(function* () {
    const proof = inspect(snapshot)
    const source = yield* GoalChild.executionSource(db, unitID)
    if (
      !proof ||
      source.row.binding.version !== 3 ||
      proof.policy.version !== "derived-subagent-v3" ||
      GoalControl.fingerprint(proof.policy) !== GoalControl.fingerprint(source.row.binding.policy) ||
      bindings.get(source.row.binding_hash) !== snapshot ||
      proof.policy.role.kind !== "worker" ||
      source.row.inputs.length !== 1 ||
      source.input.stage !== "plain" ||
      source.input.execution ||
      source.session.execution_claim_token !== null ||
      source.inbox.promoted_seq !== null
    )
      return yield* fail("Scratch preparation has no exact virgin owned worker")
    const checkpoint = yield* GoalTickCheckpointV2.read(db, source.row.permit_id)
    const activation = checkpoint?.journal.activations.find((item) => item.unitID === unitID)
    const scratch = activation ? checkpoint!.journal.program.roles[activation.role].scratch : undefined
    const goal = yield* GoalControl.get(db, source.row.goal_id)
    if (
      !scratch ||
      !goal ||
      scratch.documentID !== source.row.binding.policy.planResource ||
      scratch.parentDocumentID !== source.row.binding.policy.parentPlanResource ||
      scratch.criteriaHash !== GoalControl.fingerprint(goal.initialization.spec.criteria)
    )
      return yield* fail("Scratch preparation is absent from the frozen program")
    const payload = Schema.decodeUnknownOption(Schema.fromJsonString(GoalTickProgram.DocumentPayload))(scratch.payload)
    if (Option.isNone(payload) || payload.value.scope !== `run:${source.row.child_session_id}`)
      return yield* fail("Scratch preparation has another Session scope")
    const plan = DeepAgentPlanStore.decodePlanDoc(payload.value.body)
    const parent = yield* Effect.try({
      try: () =>
        DocumentStore.openExact(DeepAgentPlanStore.planStoreRoot(source.row.parent_session_id), [
          scratch.parentDocumentID,
        ]).get(scratch.parentDocumentID),
      catch: () => fail("Parent plan source cannot be proven"),
    })
    const prior = parent ? DeepAgentPlanStore.decodePlanDoc(parent.body) : null
    if (
      !plan ||
      !parent ||
      !prior ||
      plan.session_id !== source.row.child_session_id ||
      parent.scope !== `run:${source.row.parent_session_id}` ||
      parent.type !== "plan" ||
      parent.version !== scratch.parentVersion ||
      parent.hash !== `sha256:${scratch.parentHash}` ||
      GoalControl.fingerprint(plan.steps) !== GoalControl.fingerprint(prior.steps) ||
      plan.goal !== prior.goal ||
      GoalControl.fingerprint(plan.assumptions) !== GoalControl.fingerprint(prior.assumptions) ||
      plan.active_step_id !== prior.active_step_id
    )
      return yield* fail("Scratch structure differs from the frozen parent plan")
    return { ...source, scratch, payload: payload.value }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof GoalChildSchema.Error ? error : fail("Scratch preparation authority is unavailable"),
    ),
  )

const check = (
  db: Reader,
  binding: typeof GoalChildSchema.BindingV2.Type | typeof GoalChildSchema.BindingV3.Type,
  snapshot: Snapshot,
) =>
  Effect.gen(function* () {
    const proof = inspect(snapshot)
    if (!proof || GoalControl.fingerprint(proof.policy) !== GoalControl.fingerprint(binding.policy))
      return yield* fail("Goal native policy snapshot is no longer current")
    if (binding.version === 3) {
      const checkpoint = yield* GoalTickCheckpointV2.read(db, binding.permitID)
      const activation = checkpoint?.journal.activations.find((item) => item.unitID === binding.unitID)
      if (
        !checkpoint ||
        !activation ||
        checkpoint.binding_hash !== binding.policy.checkpointHash ||
        checkpoint.journal.programHash !== binding.policy.programHash ||
        GoalControl.fingerprint(activation) !== binding.policy.activationHash ||
        checkpoint.journal.cursor.role !== activation.role
      )
        return yield* fail("Goal program or activation differs from its policy binding")
      yield* GoalTickCheckpointV2.requireParent(db, checkpoint)
      yield* GoalChildResult.inspectMany(db, checkpoint.journal.results)
    } else {
      const checkpoint = yield* GoalTickCheckpoint.read(db, binding.permitID)
      if (!checkpoint || checkpoint.binding_hash !== binding.policy.checkpointHash)
        return yield* fail("Goal checkpoint differs from the policy binding")
      yield* GoalTickCheckpoint.requireParent(db, checkpoint)
      yield* GoalChildResult.inspectMany(db, checkpoint.journal.results)
    }
    const parent = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionSchema.ID.make(binding.parentSessionID)))
      .get()
      .pipe(Effect.orDie)
    if (
      !parent ||
      GoalControl.fingerprint(fromPermissions(parent.permission)) !==
        GoalControl.fingerprint(binding.policy.parentSessionPermissions)
    )
      return yield* fail("Goal parent permissions changed")
    return binding.policy
  })
