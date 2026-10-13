export * as GoalTickProjection from "./goal-tick-projection"

import { Effect, Option, Schema } from "effect"
import type { Database } from "@deepagent-code/core/database/database"
import { DocumentStore, type Doc } from "@deepagent-code/core/deepagent/document-store"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalControlSchema } from "@deepagent-code/core/deepagent/goal-control.schema"
import { GoalTickCheckpoint } from "@deepagent-code/core/deepagent/goal-tick-checkpoint"
import { GoalTickProgram } from "@deepagent-code/core/deepagent/goal-tick-program"
import { GoalTickState } from "@deepagent-code/core/deepagent/goal-tick-state"
import { decodePlanDoc, planDescription, planScope } from "@deepagent-code/core/deepagent/plan-store"
import type { GoalSpec } from "@deepagent-code/core/deepagent/goal-loop"
import type { PlanDoc } from "@deepagent-code/core/deepagent/plan-controller"
import { Hash } from "@deepagent-code/core/util/hash"

type Db = Database.Interface["db"]
type Preparation = NonNullable<GoalControlSchema.Initialization["ownedPreparation"]>
const failure = (message: string) => new GoalControlSchema.Error({ code: "recovery_required", message })

/** The actual allocator's bounded legacy candidates. Multiple plans need explicit reconciliation. */
export function readPlan(directory: string, sessionID: string) {
  const id = DocumentStore.logicalID("plan", null, `plan-${sessionID}`)
  const ids = [id, ...Array.from({ length: 7 }, (_, index) => `${id}-${index + 2}`)]
  const store = DocumentStore.openExactForCreate(directory, ids)
  const candidates = ids.flatMap((id) => {
    const doc = store.get(id)
    if (!doc) return []
    const plan = decodePlanDoc(doc.body)
    if (!plan || plan.session_id !== sessionID || doc.scope !== planScope(sessionID) || doc.type !== "plan")
      throw failure("A bounded plan candidate has a different Session identity")
    return [{ doc, plan }]
  })
  if (candidates.length > 1) throw failure("Multiple plan authorities require explicit reconciliation")
  return candidates[0] ?? null
}

export function documentIDs(goalID: string, planID: string) {
  return {
    plan: planID,
    state: `doc:run_context:${goalID}`,
    worklog: `doc:worklog:${goalID}`,
    diagnosis: `doc:diagnosis:${goalID}`,
    completion: `doc:decision:${goalID}`,
  }
}

export function fullDocument(
  payload: GoalTickProgram.DocumentPayload,
  previous?: Pick<Doc, "version" | "hash">,
): typeof GoalTickProgram.FullDocument.Type {
  const encoded = GoalTickProgram.canonical(payload)
  return {
    documentID: payload.id,
    expectedVersion: previous?.version ?? null,
    expectedHash: previous?.hash.slice(7) ?? null,
    payload: encoded,
    payloadHash: GoalTickProgram.hash(encoded),
    state: "pending",
    observedVersion: null,
    observedHash: null,
  }
}

export const prepare = (
  db: Db,
  input: {
    directory: string
    sessionID: string
    requestID: string
    plan: PlanDoc
    spec: Omit<GoalSpec, "planDocId">
    model: GoalControlSchema.Initialization["model"]
    netTokenBudget: boolean
    panel: Preparation["panel"]
  },
) =>
  Effect.gen(function* () {
    const session = yield* GoalControl.session(db, input.sessionID)
    const planSource = yield* Effect.try({
      try: () => readPlan(input.directory, input.sessionID),
      catch: () => failure("The initial plan could not be read within its exact bounded set"),
    })
    const goalID = `goal_${GoalControl.fingerprint([input.sessionID, input.requestID]).slice(0, 40)}`
    const planID = planSource?.doc.id ?? DocumentStore.logicalID("plan", null, `plan-${input.sessionID}`)
    const ids = documentIDs(goalID, planID)
    const scope = planScope(input.sessionID)
    const spec = { ...input.spec, planDocId: planID }
    const state = GoalTickState.requireState({
      version: 2,
      goalId: goalID,
      spec,
      planDocId: planID,
      sessionId: input.sessionID,
      phase: "running",
      ledger: { ticks: 0, tokens: 0, cost: 0, costComplete: true, wallclockMs: 0, startedAtMs: Date.now() },
      stallCount: 0,
      lastFingerprint: null,
      lastDoneCount: 0,
      lastEvidenceCount: 0,
      lastMetCount: 0,
      lastProcessedVersion: null,
      lastOutcome: null,
      gaps: [],
      lastDeliveredFeedback: [],
      pendingSteers: [],
      budgetTokenScope: input.netTokenBudget ? "net" : "gross",
      lastTransitionHash: null,
      haltReason: null,
    })
    const template = (
      id: string,
      type: GoalTickProgram.DocumentPayload["type"],
      description: string,
      body: string,
    ): GoalTickProgram.DocumentPayload => ({
      id,
      type,
      scope,
      status: "draft",
      version: 1,
      superseded_by: null,
      created_round: null,
      domain: null,
      tags: [],
      description,
      provenance: { source: "runner", run_ref: scope },
      links: [],
      extensions: { goal_id: goalID, execution_contract: "owned-goal-v2" },
      body,
    })
    const plan: GoalTickProgram.DocumentPayload = planSource
      ? Schema.decodeUnknownSync(GoalTickProgram.DocumentPayload)(
          Object.fromEntries(Object.entries(planSource.doc).filter(([key]) => key !== "hash")),
        )
      : template(planID, "plan", planDescription(input.sessionID), JSON.stringify(input.plan))
    // The existing parsed plan is the actual source, not an arbitrary model proposal or metadata claim.
    if (planSource && GoalControl.fingerprint(planSource.plan) !== GoalControl.fingerprint(input.plan))
      return yield* failure("The selected initial plan changed before preparation")
    const stateDoc = {
      ...template(ids.state, "run_context", "Goal runtime state", GoalTickProgram.canonical(state)),
      links: Object.values(ids)
        .filter((id) => id !== ids.state)
        .map((to) => ({ rel: "references", to })),
    }
    const payloads = [
      plan,
      stateDoc,
      template(ids.worklog, "worklog", "Goal worklog", ""),
      template(ids.diagnosis, "diagnosis", "Goal diagnostics", ""),
      template(ids.completion, "decision", "Goal completion decision", ""),
    ]
    if (payloads.some((item) => item.links.some((link) => !Object.values(ids).includes(link.to))))
      return yield* failure("Initial plan links are outside the exact Goal document set")
    const preparation: Preparation = {
      parentHash: GoalControl.fingerprint(GoalTickCheckpoint.authority(session)),
      documents: payloads.map((item) => fullDocument(item, item.id === planID ? planSource?.doc : undefined)),
      panel: input.panel,
    }
    const initialization: GoalControlSchema.Initialization = {
      executionContract: "owned-goal-v2",
      ownedPreparation: preparation,
      spec,
      model: input.model,
      netTokenBudget: input.netTokenBudget,
      planVersion: plan.version,
      planHash: Hash.sha256(plan.body),
    }
    if (
      !Schema.is(GoalControlSchema.Initialization)(initialization) ||
      Buffer.byteLength(JSON.stringify(initialization)) > 262144 ||
      Buffer.byteLength(plan.body) > 65536 ||
      Buffer.byteLength(preparation.documents[0].payload) > 131072
    )
      return yield* failure("Owned preparation exceeds its complete encoded storage budget")
    return initialization
  })

/** Each exact file effect is linearized against current SQL control. A crash repairs only the
 * frozen bytes; a rollback cannot undo files and must never choose different bytes on retry. */
export const initialize = (
  db: Db,
  input: { row: GoalControl.Row; requestID: string; requestHash: string; directory: string },
) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const row = yield* GoalControl.requireTarget(tx, input.row.goal_id, input.row.session_id)
        if (
          row.preparation !== "preparing" ||
          row.requested_phase !== "running" ||
          row.revision !== 0 ||
          row.initialization_hash !== input.row.initialization_hash ||
          !row.initialization.ownedPreparation ||
          row.initialization.executionContract !== "owned-goal-v2"
        )
          return yield* failure("Owned Goal initialization is no longer current")
        const preparation = row.initialization.ownedPreparation
        const session = yield* GoalControl.session(tx, row.session_id)
        if (GoalControl.fingerprint(GoalTickCheckpoint.authority(session)) !== preparation.parentHash)
          return yield* failure("Parent authority changed before initial document projection")
        yield* Effect.try({
          try: () => {
            const store = DocumentStore.openExactForCreate(
              input.directory,
              preparation.documents.map((item) => item.documentID),
            )
            const payloads = preparation.documents.map((item) => {
              const payload = Schema.decodeUnknownOption(Schema.fromJsonString(GoalTickProgram.DocumentPayload))(
                item.payload,
              )
              if (
                Option.isNone(payload) ||
                item.payloadHash !== GoalTickProgram.hash(item.payload) ||
                payload.value.id !== item.documentID ||
                payload.value.scope !== planScope(row.session_id) ||
                payload.value.links.some(
                  (link) => !preparation.documents.some((target) => target.documentID === link.to),
                )
              )
                throw failure("Invalid initial bytes or scope")
              return { item, payload: payload.value }
            })
            for (const { item, payload } of payloads) {
              const observed = store.projectExact(
                payload,
                item.expectedVersion === null
                  ? null
                  : {
                      id: item.documentID,
                      version: item.expectedVersion,
                      hash: `sha256:${item.expectedHash}`,
                    },
              )
              if (observed.scope !== planScope(row.session_id)) throw failure("Initial document changed Session scope")
            }
          },
          catch: () => failure("Exact initial Goal document bytes could not be confirmed"),
        })
        return yield* GoalControl.activate(db, {
          sessionID: row.session_id,
          goalId: row.goal_id,
          requestID: input.requestID,
          requestHash: input.requestHash,
        })
      }),
    { behavior: "immediate" },
  )
