export * as PlanWriteTool from "./plan"

// V2 plan-write leaf (core port of deepagent-code's `@/tool/plan-write`).
//
// The V2 runner's strict plan gate blocks mutating tools until the model commits a
// plan, and the block copy tells the model to "call the `plan` tool" — but the core
// builtin set never shipped one, so every gated V2 session deadlocked into the
// consecutive-block grace release (3 blocked → 1 released) instead of self-unlocking.
// This leaf closes that loop: the SAME controller/store the gate reads
// (DeepAgentPlanController / DeepAgentPlanStore / DeepAgentSessionState), so a plan
// committed here clears the latch the very next settle.
//
// Differences from the app version are deliberate:
//  - the live `plan.updated` event publishes best-effort through serviceOption
//    (the committed PlanStore doc is the authority; a missing bridge must never
//    fail the write), and
//  - permission is declared via Tool.withPermission instead of ctx.ask.

import { Effect, Layer, Schema } from "effect"
import * as controller from "../deepagent/plan-controller"
import * as store from "../deepagent/plan-store"
import * as sessionState from "../deepagent/session-state"
import { NonNegativeInt } from "../schema"
import { Tool } from "./tool"
import { Tools } from "./tools"
import DESCRIPTION from "./plan.txt"

const PlanStep = Schema.Struct({
  step_id: Schema.optional(Schema.String).annotate({
    description:
      "Stable id; required for advance, copied for a retained replan step, omitted for create or a new step",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "What this step does; required for create/replan and ignored for advance",
  }),
  status: Schema.String.annotate({ description: "pending | active | done | cancelled | blocked" }),
  acceptance: Schema.optional(Schema.String).annotate({
    description:
      "Acceptance criterion; omit when retaining a replan step",
  }),
  assigned_agent: Schema.optional(Schema.String).annotate({
    description:
      "Subagent type; omit when retaining a replan step",
  }),
  note: Schema.optional(Schema.String).annotate({
    description: "Short note; REQUIRED when status is 'blocked' — say why you are stuck",
  }),
})

export const Parameters = Schema.Struct({
  operation: Schema.optional(Schema.Literals(["create", "advance", "replan"])).annotate({
    description: "create a plan, advance an existing plan, or replan with a reason; omit for the default create",
  }),
  expected_plan_id: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      "Null for create; for advance/replan copy it exactly from the latest <plan-status> or plan result",
  }),
  expected_version: Schema.optional(
    Schema.NullOr(Schema.Union([NonNegativeInt, Schema.NumberFromString])),
  ).annotate({
    description:
      "Null for create; for advance/replan copy it exactly from the latest <plan-status> or plan result",
  }),
  replan_reason: Schema.optional(Schema.String).annotate({
    description: "Required for replan; omit for create/advance",
  }),
  goal: Schema.optional(Schema.String).annotate({
    description: "One sentence: what 'done' means for this task; required for create/replan",
  }),
  steps: Schema.mutable(Schema.Array(PlanStep)).annotate({
    description:
      "Ordered steps for create/replan; for advance copy step_ids and send status/note updates",
  }),
  assumptions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Facts for create; for replan omit to retain the authoritative list, or send [] to clear it",
  }),
  active_step_id: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      "Omit for create/replan (the server derives it from status); for advance copy a visible step_id, omit to retain, or null to clear",
  }),
})

// plan_protocol/plan_error_code mirror the legacy plan-write tool's metadata contract: the V2
// runner's plan protocol budget reads the outcome from the settled structured output (and from
// projected history) to count consecutive model plan failures toward termination. The model
// still sees only `output` text (toModelOutput).
const Output = Schema.Struct({
  output: Schema.String,
  plan_protocol: Schema.optional(Schema.Literals(["success", "invalid", "conflict", "no_progress"])),
  plan_error_code: Schema.optional(Schema.String),
})

export const name = "plan"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description: DESCRIPTION,
            input: Parameters,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text" as const, text: output.output }],
            execute: (params, context) =>
              Effect.gen(function* () {
                const sid = context.sessionID
                const previous = store.getPlanDoc(sid)
                const ref = store.planDocRef(sid)
                const expectedRef = previous && ref ? { plan_id: previous.plan_id, doc_id: ref.id, version: ref.version } : null
                const attempt = yield* Effect.try({
                  try: () => {
                    const built = controller.buildPlanFromWriteInput(
                      sid,
                      normalizeModelPlanWrite(params, previous, expectedRef),
                      previous,
                      expectedRef,
                    )
                    const plan = controller.attachEvidenceToNewlyDone(
                      previous,
                      built,
                      sessionState.lastValidationSummary(sid),
                    )
                    const committed = store.compareAndCommitPlan({
                      sessionId: sid,
                      expected: expectedRef,
                      candidate: plan,
                      origin: "model_tool",
                    })
                    sessionState.bindPlan(sid, committed.plan, previous, committed.changed)
                    return {
                      previous,
                      plan: committed.plan,
                      version: committed.version,
                      changed: committed.changed,
                      changes: controller.diffStepStatuses(previous, committed.plan),
                    }
                  },
                  catch: (error) => error,
                }).pipe(
                  Effect.match({
                    onFailure: (error) => ({ ok: false as const, error }),
                    onSuccess: (value) => ({ ok: true as const, value }),
                  }),
                )

                if (!attempt.ok) {
                  const error = attempt.error
                  if (error instanceof controller.PlanConflictError) {
                    const current = store.getPlanDoc(sid)
                    const currentRef = store.planDocRef(sid)
                    const currentProgress = current ? controller.planProgress(current) : { done: 0, total: 0 }
                    return {
                      output:
                        "The plan changed before this update was committed. Re-read the current plan and retry with its exact expected_plan_id and expected_version." +
                        renderPlanRetryBase(current, currentRef),
                      plan_protocol: "conflict" as const,
                      plan_error_code: "plan_conflict",
                    }
                  }
                  if (error instanceof controller.PlanValidationError) {
                    const offending = error.offending_step_ids
                    const offendingText = offending.length ? " Offending step IDs: " + offending.join(", ") + "." : ""
                    const terminalHint =
                      error.code === "invalid_active_step" && params.operation === "advance"
                        ? " If every step is done after this update, resend the same advance with active_step_id set to null — a completed plan with no active step is the terminal state."
                        : ""
                    return {
                      output:
                        ("The plan was not committed (" + error.code + ")." + offendingText + terminalHint + " Correct the plan payload and retry once." + renderModelPlanCorrection(params, error.code, previous, ref)),
                      plan_protocol: "invalid" as const,
                      plan_error_code: error.code,
                    }
                  }
                  return yield* Effect.die(error)
                }

                const { plan, version, changed, changes } = attempt.value
                const { done, total } = controller.planProgress(plan)
                const changeLines = changes.map((c) => controller.formatStepChange(c))
                const acceptanceWarnings = plan.steps
                  .filter(
                    (s) =>
                      s.status === "done" &&
                      s.acceptance != null &&
                      s.acceptance.trim() !== "" &&
                      (s.evidence == null || s.evidence.length === 0),
                  )
                  .map((s) => `"${s.title}" is done but its acceptance ("${s.acceptance}") has no recorded validation`)
                const summary =
                  (changeLines.length > 0 ? `\n\nChanges: ${changeLines.join("; ")}` : "") +
                  (acceptanceWarnings.length > 0 ? `\n\n⚠ ${acceptanceWarnings.join("; ")}. Verify before finalizing.` : "")
                return {
                  output: renderModelPlanSuccess(plan, version, summary, changed),
                  plan_protocol: changed ? ("success" as const) : ("no_progress" as const),
                }
              }),
          }),
          "plan",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

// The core controller keeps the full-document contract for human and HTTP writes. This adapter
// supplies model-owned intent to that strict boundary without letting the model allocate opaque IDs
// or reconstruct authority fields omitted from compact context.
const normalizeModelPlanWrite = (
  params: Schema.Schema.Type<typeof Parameters>,
  previous: ReturnType<typeof store.getPlanDoc>,
  expected: controller.PlanExpected | null,
) => {
  // Provider-tolerant normalization (GLM 5.x): the literal "null" string and stringified
  // numbers decode through the tolerant schema but must land as real nulls/numbers before
  // the strict core precondition runs. NumberFromString can also surface the "null" string
  // as NaN — a number-typed value that still fails every downstream `!== null` check — so
  // only finite non-negative integers survive as versions; everything else reads as absent.
  const expectedVersionNumber =
    typeof params.expected_version === "number" ? params.expected_version : Number(params.expected_version)
  const expectedPlanID =
    params.expected_plan_id == null || params.expected_plan_id === "null" ? null : params.expected_plan_id
  // Providers omit `operation` on obvious payload shapes. Infer instead of defaulting to
  // create: no prior plan (or no expected precondition) → create; a supplied precondition with an
  // existing plan → advance (replan iff it carries a reason). Wrong inferences land on the coached
  // validation/conflict paths, never a dead schema rejection.
  const inferredOperation =
    previous == null || (expectedPlanID == null && params.expected_version == null)
      ? "create"
      : params.replan_reason !== undefined
        ? "replan"
        : "advance"
  const normalized = {
    ...params,
    operation: params.operation ?? inferredOperation,
    expected_plan_id: expectedPlanID,
    expected_version:
      params.expected_version == null || !Number.isInteger(expectedVersionNumber) || expectedVersionNumber < 0
        ? null
        : expectedVersionNumber,
    active_step_id:
      params.active_step_id === undefined
        ? undefined
        : params.active_step_id === "null"
          ? null
          : params.active_step_id,
  }
  // Stale writers are concurrency conflicts even when a concurrent replan also changed step IDs.
  // Check the shared core precondition before interpreting the patch against current authority.
  controller.requirePlanWriteExpected(normalized, previous, expected)
  const base = {
    operation: normalized.operation,
    expected_plan_id: normalized.expected_plan_id,
    expected_version: normalized.expected_version,
    ...(params.replan_reason !== undefined ? { replan_reason: params.replan_reason } : {}),
    goal: params.goal ?? "",
  }

  if (normalized.operation === "create") {
    const suppliedIDs = params.steps.map((step) => step.step_id?.trim()).filter((stepID) => stepID !== undefined)
    // A null pointer ("null" string or real null) is absent intent, not an invented ID —
    // GLM sends it while echoing the schema; only a real string pointer is unsafe on create.
    if (suppliedIDs.length > 0 || normalized.active_step_id != null) {
      throw new controller.PlanValidationError("unsafe_step_identity", [
        ...new Set([...suppliedIDs, ...(typeof params.active_step_id === "string" ? [params.active_step_id] : [])]),
      ])
    }
    return {
      ...base,
      assumptions: params.assumptions,
      steps: params.steps.map((step) => ({ ...step, title: step.title ?? "" })),
    }
  }

  if (previous == null) {
    throw new controller.PlanValidationError("plan_missing")
  }

  if (normalized.operation === "advance") {
    const suppliedIDs = params.steps.map((step) => step.step_id?.trim() ?? "")
    if (suppliedIDs.some((stepID) => stepID === "")) {
      throw new controller.PlanValidationError("unsafe_step_identity", [], previous.plan_id)
    }
    const duplicateIDs = suppliedIDs.filter((stepID, index) => suppliedIDs.indexOf(stepID) !== index)
    if (duplicateIDs.length > 0) {
      throw new controller.PlanValidationError("duplicate_step_id", [...new Set(duplicateIDs)], previous.plan_id)
    }
    const knownIDs = new Set(previous.steps.map((step) => step.step_id))
    const unknownIDs = suppliedIDs.filter((stepID) => !knownIDs.has(stepID))
    if (unknownIDs.length > 0) {
      throw new controller.PlanValidationError("unsafe_step_identity", unknownIDs, previous.plan_id)
    }
    const updates = new Map(params.steps.map((step, index) => [suppliedIDs[index], step] as const))
    const built = previous.steps.map((step) => {
      const update = updates.get(step.step_id)
      return {
        step_id: step.step_id,
        title: step.title,
        status: update?.status ?? step.status,
        acceptance: step.acceptance ?? null,
        assigned_agent: step.assigned_agent ?? null,
        note: update?.note ?? step.note ?? null,
      }
    })
    // The supplied active_step_id is ADVISORY on advance — the built statuses are the
    // truth (exactly one active step, or none on the legal terminal close). A pointer that
    // matches a built ACTIVE step passes through; anything else is dropped and the
    // controller derives from statuses.
    const advisoryActive =
      normalized.active_step_id != null &&
      built.some((step) => step.step_id === normalized.active_step_id && step.status === "active")
        ? normalized.active_step_id
        : undefined
    return {
      ...base,
      goal: previous.goal,
      assumptions: [...previous.assumptions],
      ...(advisoryActive !== undefined ? { active_step_id: advisoryActive } : {}),
      steps: built,
    }
  }

  const suppliedIDs = params.steps.map((step) => step.step_id?.trim() ?? "")
  const duplicateIDs = suppliedIDs.filter((stepID, index) => suppliedIDs.indexOf(stepID) !== index)
  const duplicateKnownIDs = duplicateIDs.filter(Boolean)
  if (duplicateKnownIDs.length > 0) {
    throw new controller.PlanValidationError("duplicate_step_id", [...new Set(duplicateKnownIDs)], previous.plan_id)
  }
  const knownIDs = new Set(previous.steps.map((step) => step.step_id))
  const unknownIDs = suppliedIDs.filter((stepID) => stepID !== "" && !knownIDs.has(stepID))
  if (unknownIDs.length > 0) {
    throw new controller.PlanValidationError("unsafe_step_identity", unknownIDs, previous.plan_id)
  }
  if (params.active_step_id !== undefined) {
    throw new controller.PlanValidationError(
      "unsafe_step_identity",
      typeof params.active_step_id === "string" ? [params.active_step_id] : [],
      previous.plan_id,
    )
  }
  return {
    ...base,
    assumptions: params.assumptions === undefined ? [...previous.assumptions] : params.assumptions,
    steps: params.steps.map((update) => {
      const stepID = update.step_id?.trim() ?? ""
      const prior = stepID === "" ? undefined : previous.steps.find((step) => step.step_id === stepID)
      return {
        step_id: stepID === "" ? undefined : stepID,
        title: update.title ?? prior?.title ?? "",
        status: update.status,
        acceptance: update.acceptance ?? prior?.acceptance ?? null,
        assigned_agent: update.assigned_agent ?? prior?.assigned_agent ?? null,
        note: update.note ?? prior?.note ?? null,
      }
    }),
  }
}

const renderModelPlanCorrection = (
  params: Schema.Schema.Type<typeof Parameters>,
  code: controller.PlanValidationCode,
  previous: ReturnType<typeof store.getPlanDoc>,
  ref: ReturnType<typeof store.planDocRef>,
): string => {
  if (params.operation === "advance") return renderPlanRetryBase(previous, ref)
  if (code === "plan_already_exists") {
    return (
      "\n\nCorrection protocol: create cannot replace an existing plan. Use advance for status/note changes or replan for structural changes, with the exact authoritative precondition below." +
      renderPlanRetryBase(previous, ref)
    )
  }
  if ((params.operation ?? "create") === "create") {
    return (
      "\n\nCorrection protocol for create: copy the schema-valid payload below. It deliberately omits every step_id and active_step_id; the server allocates IDs and derives the active pointer. Do not invent a future server ID.\n" +
      JSON.stringify({
        operation: "create",
        expected_plan_id: null,
        expected_version: null,
        ...(params.goal !== undefined ? { goal: params.goal } : {}),
        ...(params.assumptions !== undefined ? { assumptions: params.assumptions } : {}),
        steps: params.steps.map((step) => ({
          ...(step.title !== undefined ? { title: step.title } : {}),
          status: step.status,
          ...(step.acceptance !== undefined ? { acceptance: step.acceptance } : {}),
          ...(step.assigned_agent !== undefined ? { assigned_agent: step.assigned_agent } : {}),
          ...(step.note !== undefined ? { note: step.note } : {}),
        })),
      })
    )
  }
  if (previous == null || ref == null) {
    return "\n\nAuthoritative replan parameters are unavailable. Do not guess expected_plan_id, expected_version, step_id, or active_step_id. If no plan exists, use create with null expected values."
  }
  return (
    "\n\nCorrection protocol for replan: start from the schema-valid authoritative payload below. Retain a step only with its exact step_id; for every new step, omit step_id. Omit active_step_id and mark at most one step status=active so the server derives its ID after allocation. Omit assumptions to retain the authoritative list, or send [] only when you intentionally clear it.\n" +
    JSON.stringify({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: params.replan_reason?.trim() || "Correct the rejected replan against current authority",
      goal: params.goal ?? previous.goal,
      ...(params.assumptions !== undefined ? { assumptions: params.assumptions } : {}),
      steps: previous.steps.map((step) => ({
        step_id: step.step_id,
        title: step.title,
        status: step.status,
        ...(step.acceptance != null ? { acceptance: step.acceptance } : {}),
        ...(step.assigned_agent != null ? { assigned_agent: step.assigned_agent } : {}),
        ...(step.note != null ? { note: step.note } : {}),
      })),
    })
  )
}

const renderModelPlanSuccess = (
  plan: controller.PlanDoc,
  version: number,
  summary: string,
  changed: boolean,
): string => {
  if (!changed) return "No changes: the plan already matches this update." + summary
  return (
    controller.renderPlanWriteContext(plan, version) +
    summary +
    "\n\nCopyable parameters for the next plan update:\n" +
    JSON.stringify(modelAdvanceParameters(plan, version))
  )
}

const renderPlanRetryBase = (
  previous: ReturnType<typeof store.getPlanDoc>,
  ref: ReturnType<typeof store.planDocRef>,
): string => {
  if (previous == null) return ""
  if (ref == null) {
    return `\n\nAuthoritative plan parameters unavailable: expected_version is unavailable for expected_plan_id=${JSON.stringify(previous.plan_id)}. Do not guess or call advance/replan.`
  }
  return (
    "\n\nAuthoritative plan parameters (copy expected_* and step_id values exactly; do not infer them):\n" +
    JSON.stringify(modelAdvanceParameters(previous, ref.version))
  )
}

const modelAdvanceParameters = (plan: controller.PlanDoc, version: number) => ({
  operation: "advance" as const,
  expected_plan_id: plan.plan_id,
  expected_version: version,
  active_step_id: plan.active_step_id,
  steps: plan.steps.map((step) => ({
    step_id: step.step_id,
    status: step.status,
    ...(step.note != null ? { note: step.note } : {}),
  })),
})

