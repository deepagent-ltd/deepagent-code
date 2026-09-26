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
//  - permission is declared via Tool.withPermission for the registry's inventory
//    classification AND asserted at execute time (bash.ts pattern): withPermission
//    metadata alone never raises an interactive ask, so a `plan: "ask"` ruleset
//    silently behaved as allow under the V2 owner.

import { ToolFailure } from "@deepagent-code/llm"
import { Effect, Layer, Schema } from "effect"
import * as controller from "../deepagent/plan-controller"
import * as store from "../deepagent/plan-store"
import * as sessionState from "../deepagent/session-state"
import { PermissionV2 } from "../permission"
import { NonNegativeInt } from "../schema"
import { Tool } from "./tool"
import { Tools } from "./tools"
import DESCRIPTION from "./plan.txt"

const PlanStep = Schema.Struct({
  // Accepted but IGNORED: step ids are server-owned anchors for runtime evidence, never something
  // the model must carry. Kept in the schema so an older client (or a model echoing the field) is not
  // a hard failure; the tool drops whatever arrives and recovers identity from title + acceptance.
  step_id: Schema.optional(Schema.String).annotate({
    description: "Ignored — the server tracks step identity; never send this",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "What this step does; required for create/replan and ignored for advance",
  }),
  status: Schema.String.annotate({ description: "pending | active | done | cancelled | blocked" }),
  acceptance: Schema.optional(Schema.String).annotate({
    description: "Acceptance criterion; omit when retaining a replan step",
  }),
  assigned_agent: Schema.optional(Schema.String).annotate({
    description: "Subagent type; omit when retaining a replan step",
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
    description: "Null for create; for advance/replan copy it exactly from the latest <plan-status> or plan result",
  }),
  expected_version: Schema.optional(Schema.NullOr(Schema.Union([NonNegativeInt, Schema.NumberFromString]))).annotate({
    description: "Null for create; for advance/replan copy it exactly from the latest <plan-status> or plan result",
  }),
  replan_reason: Schema.optional(Schema.String).annotate({
    description: "Required for replan; omit for create/advance",
  }),
  goal: Schema.optional(Schema.String).annotate({
    description: "One sentence: what 'done' means for this task; required for create/replan",
  }),
  steps: Schema.mutable(Schema.Array(PlanStep)).annotate({
    description: "Ordered steps for create/replan; for advance copy step_ids and send status/note updates",
  }),
  assumptions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Facts for create; for replan omit to retain the authoritative list, or send [] to clear it",
  }),
  active_step_id: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description: "Ignored — the server derives the active step from the statuses you send",
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
    const permission = yield* PermissionV2.Service
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
                // V1-parity plan permission gate: the declared action must actually be asserted
                // (bash.ts pattern), or `plan: "ask"` silently behaves as allow. Refusals lower to
                // ToolFailure so the model sees the coached denial instead of a runtime defect.
                yield* permission
                  .assert({
                    action: "plan",
                    resources: ["*"],
                    save: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: {
                      type: "tool" as const,
                      messageID: context.assistantMessageID,
                      callID: context.toolCallID,
                    },
                  })
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        PermissionV2.permissionToolFailure(error) ??
                        new ToolFailure({ message: "Plan write was not authorized." }),
                    ),
                  )
                const sid = context.sessionID
                const previous = store.getPlanDoc(sid)
                const ref = store.planDocRef(sid)
                const expectedRef =
                  previous && ref ? { plan_id: previous.plan_id, doc_id: ref.id, version: ref.version } : null
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
                        "The plan was not committed (" +
                        error.code +
                        ")." +
                        offendingText +
                        terminalHint +
                        " Correct the plan payload and retry once." +
                        renderModelPlanCorrection(params, error.code, previous, ref),
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
                  (acceptanceWarnings.length > 0
                    ? `\n\n⚠ ${acceptanceWarnings.join("; ")}. Verify before finalizing.`
                    : "")
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
      params.active_step_id === undefined ? undefined : params.active_step_id === "null" ? null : params.active_step_id,
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
    // Server-owned identity: ids the model sends are dropped, not rejected (plan.txt tells it never
    // to send one; a client that still does must not fail the whole submission over bookkeeping).
    return {
      ...base,
      assumptions: params.assumptions,
      steps: params.steps.map((step) => ({ ...step, step_id: undefined, title: step.title ?? "" })),
    }
  }

  if (previous == null) {
    throw new controller.PlanValidationError("plan_missing")
  }

  if (normalized.operation === "advance") {
    // Step ids are server-owned; the model is never required to send one (see plan.txt). A supplied
    // id is honoured when it names a previous step, and otherwise the step is matched by the content
    // the model authored — title + acceptance, the pair that defines step identity and therefore
    // decides whether runtime evidence carries forward. An unmatched step simply is not an update:
    // `advance` patches statuses and cannot invent steps.
    const byID = new Map(previous.steps.map((step) => [step.step_id, step] as const))
    const byContent = planStepIdentityIndex(previous.steps)
    const updates = new Map<string, (typeof params.steps)[number]>()
    for (const step of params.steps) {
      const supplied = step.step_id?.trim() ?? ""
      const prior = supplied === "" ? matchPlanStepByIdentity(byContent, step) : byID.get(supplied)
      if (prior === undefined) continue
      updates.set(prior.step_id, step)
    }
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

  // Replan recovers identity per step the same way `advance` does: an echoed id that names a
  // previous step wins, otherwise the step is matched by title + acceptance. An unmatched step is
  // NEW (its id is dropped and the controller mints one) — rejecting it ended whole sessions.
  const replanByID = new Map(previous.steps.map((step) => [step.step_id, step] as const))
  const replanByContent = planStepIdentityIndex(previous.steps)
  const claimed = new Set<string>()
  return {
    ...base,
    assumptions: params.assumptions === undefined ? [...previous.assumptions] : params.assumptions,
    steps: params.steps.map((update) => {
      const supplied = update.step_id?.trim() ?? ""
      const echoed = supplied === "" ? undefined : replanByID.get(supplied)
      const prior =
        echoed !== undefined && !claimed.has(echoed.step_id)
          ? echoed
          : matchPlanStepByIdentity(replanByContent, update, claimed)
      if (prior !== undefined) claimed.add(prior.step_id)
      return {
        step_id: prior?.step_id,
        title: update.title ?? prior?.title ?? "",
        status: update.status,
        acceptance: update.acceptance ?? prior?.acceptance ?? null,
        assigned_agent: update.assigned_agent ?? prior?.assigned_agent ?? null,
        note: update.note ?? prior?.note ?? null,
      }
    }),
  }
}

/**
 * Index plan steps by the content pair that defines step identity (title + acceptance). A key maps
 * to every step carrying it so an ambiguous match can be refused rather than guessed: a wrong match
 * would carry another step's runtime evidence onto this one.
 */
const planStepIdentityIndex = (steps: readonly controller.PlanStep[]) => {
  const index = new Map<string, controller.PlanStep[]>()
  for (const step of steps) {
    const key = planStepIdentityKey(step.title, step.acceptance)
    const bucket = index.get(key)
    if (bucket === undefined) index.set(key, [step])
    else bucket.push(step)
  }
  return index
}

const planStepIdentityKey = (title: string | null | undefined, acceptance: string | null | undefined) =>
  `${(title ?? "").trim()}\u0000${(acceptance ?? "").trim()}`

const matchPlanStepByIdentity = (
  index: ReadonlyMap<string, readonly controller.PlanStep[]>,
  update: { readonly title?: string | undefined; readonly acceptance?: string | undefined },
  claimed: ReadonlySet<string> = new Set(),
): controller.PlanStep | undefined => {
  if (update.title === undefined) return undefined
  const bucket = index.get(planStepIdentityKey(update.title, update.acceptance))
  if (bucket === undefined) return undefined
  const open = bucket.filter((step) => !claimed.has(step.step_id))
  return open.length === 1 ? open[0] : undefined
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
