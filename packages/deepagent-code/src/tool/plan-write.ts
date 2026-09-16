import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./plan-write.txt"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import type { PlanStep } from "@deepagent-code/core/deepagent/plan-controller"
import { EventV2 } from "@deepagent-code/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "../session/schema"
import { NonNegativeInt } from "@deepagent-code/core/schema"

// U2: the live plan event. Published after each authority version change so the app can render a
// persistent plan panel (goal + steps + progress). Mirrors todo.updated in the same SSE stream.
const PlanStepEvent = Schema.Struct({
  step_id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  acceptance: Schema.optional(Schema.NullOr(Schema.String)),
  assigned_agent: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
  evidence: Schema.optional(Schema.Array(Schema.String)),
})
export const PlanEvent = {
  Updated: EventV2.define({
    type: "plan.updated",
    schema: {
      sessionID: SessionID,
      plan_id: Schema.String,
      goal: Schema.String,
      plan_version: Schema.Number,
      assumptions: Schema.Array(Schema.String),
      active_step_id: Schema.NullOr(Schema.String),
      steps: Schema.Array(PlanStepEvent),
      done: Schema.Number,
      total: Schema.Number,
      // U10: runtime-computed status transitions this write produced ("Title: from→to"). Lets the UI
      // and logs show WHAT changed, derived from before/after — not from the model's prose.
      changes: Schema.optional(Schema.Array(Schema.String)),
    },
  }),
}

// U1 PlanController write tool. The model calls this to create/update its working plan. Committing a
// semantic change clears a stale latch, which unblocks the soft gate after the runtime flagged the
// plan as out of date; a no-op acknowledgement deliberately leaves the latch unchanged.

const PlanStep = Schema.Struct({
  step_id: Schema.optional(Schema.String).annotate({
    description:
      "Stable id; required for advance, copy it only for a retained replan step, and omit it for create or a new replan step. Create rejects supplied IDs; replan rejects unknown supplied IDs",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "What this step does; required for create/replan and ignored for advance",
  }),
  status: Schema.String.annotate({ description: "pending | active | done | cancelled | blocked" }),
  // No NullOr: a nested optional(NullOr(...)) emits a double-nested anyOf whose inner
  // {type:null} survives normalize() and is rejected by some third-party providers (no-reply).
  // Optional already covers "absent"; strict admission normalizes missing values to null.
  acceptance: Schema.optional(Schema.String).annotate({
    description:
      "Acceptance criterion for create/replan; when retaining a replan step, omit to copy the authoritative value shown in the correction",
  }),
  assigned_agent: Schema.optional(Schema.String).annotate({
    description:
      "Subagent type for create/replan; when retaining a replan step, omit to copy the authoritative value shown in the correction",
  }),
  note: Schema.optional(Schema.String).annotate({
    description: "Short note; REQUIRED when status is 'blocked' — say why you are stuck",
  }),
})

export const Parameters = Schema.Struct({
  operation: Schema.optional(Schema.Literals(["create", "advance", "replan"])).annotate({
    description: "create a plan, advance an existing plan, or replan with a reason; omit for the default create",
  }),
  // Provider-tolerant decoding (GLM 5.x serializes tool-argument numbers as strings and null
  // as "null"): the schema accepts the coerced shapes and execute normalizes them, so the strict
  // protocol semantics downstream are unchanged. F-10: expected_* are OPTIONAL — GLM omits
  // meaningless fields, and for create they are meaningless (absent = null). An advance/replan
  // that omits them lands on the coached PlanConflict path (correction payload with the exact
  // authoritative values) instead of a dead schema rejection.
  expected_plan_id: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      "Use null (or omit) for create; for advance/replan copy expected_plan_id exactly from the latest <plan-status> or plan result",
  }),
  expected_version: Schema.optional(Schema.NullOr(Schema.Union([NonNegativeInt, Schema.NumberFromString]))).annotate({
    description:
      "Use null (or omit) for create; for advance/replan copy expected_version exactly from the latest <plan-status> or plan result",
  }),
  replan_reason: Schema.optional(Schema.String).annotate({
    description: "Required for replan; omit for create/advance",
  }),
  goal: Schema.optional(Schema.String).annotate({
    description: "One sentence: what 'done' means for this task; required for create/replan",
  }),
  steps: Schema.mutable(Schema.Array(PlanStep)).annotate({
    description:
      "Ordered plan steps. For advance, send the steps whose status or note changes; for replan, the full revised list. step_id is never required and is ignored.",
  }),
  assumptions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Facts for create; for replan omit to retain the authoritative list, or send [] to clear it",
  }),
  active_step_id: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      "Ignored — mark exactly one step status=active (or none) and the server derives the active step from the statuses.",
  }),
})
export const PlanWriteParameters = Parameters

type Metadata = {
  plan_id: string
  goal: string
  done: number
  total: number
  plan_protocol?: "success" | "invalid" | "conflict" | "no_progress"
  plan_progress?: boolean
  plan_version?: number
  plan_attempt_ordinal?: number
  plan_error_code?: string
  plan_error_step_ids?: string[]
  challenge_id?: string
}

export const PlanTool = Tool.define<typeof Parameters, Metadata, EventV2Bridge.Service>(
  "plan",
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // ToolSequenceTracker must compare the plan's semantic proposal rather than display text or
      // object key order. The version/precondition remains part of the fingerprint so repeated stale
      // retries are visible, while runtime evidence is intentionally excluded from model input.
      semanticFingerprint: (input: Schema.Schema.Type<typeof Parameters>) => ({
        // Advance is a status patch at this boundary. Identity fields are
        // server-owned and intentionally excluded from its semantic proposal.
        advance_patch: input.operation === "advance",
        operation: input.operation,
        expected_plan_id: input.expected_plan_id ?? null,
        expected_version: input.expected_version ?? null,
        replan_reason: input.operation === "advance" ? null : (input.replan_reason ?? null),
        goal: input.operation === "advance" ? null : (input.goal?.trim() ?? null),
        assumptions: input.operation === "advance" ? [] : (input.assumptions ?? []).map((value) => value.trim()),
        active_step_id:
          input.operation === "advance" && input.active_step_id === undefined
            ? "retain"
            : (input.active_step_id ?? null),
        steps: input.steps.map((step) => ({
          step_id: step.step_id ?? null,
          title: input.operation === "advance" ? null : (step.title?.trim() ?? null),
          status: step.status.trim().toLowerCase(),
          acceptance: input.operation === "advance" ? null : (step.acceptance ?? null),
          assigned_agent: input.operation === "advance" ? null : (step.assigned_agent ?? null),
          note: step.note ?? null,
        })),
      }),
      resultFingerprint: (result) => ({
        plan_protocol: result.metadata.plan_protocol ?? null,
        plan_progress: result.metadata.plan_progress ?? null,
        plan_id: result.metadata.plan_id,
        plan_version: result.metadata.plan_version ?? null,
        done: result.metadata.done,
        total: result.metadata.total,
      }),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "plan", patterns: ["*"], always: ["*"], metadata: {} })

          const previous = AgentGateway.DeepAgentPlanStore.getPlanDoc(ctx.sessionID)
          const ref = AgentGateway.DeepAgentPlanStore.planDocRef(ctx.sessionID)
          const expectedRef =
            previous && ref
              ? {
                  plan_id: previous.plan_id,
                  doc_id: ref.id,
                  version: ref.version,
                }
              : null
          const attempt = yield* Effect.try({
            try: () => {
              const built = AgentGateway.DeepAgentPlanController.buildPlanFromWriteInput(
                ctx.sessionID,
                normalizeModelPlanWrite(params, previous, expectedRef),
                previous,
                expectedRef,
              )
              // The runtime supplies validation evidence only after semantic admission succeeds.
              const plan = AgentGateway.DeepAgentPlanController.attachEvidenceToNewlyDone(
                previous,
                built,
                AgentGateway.DeepAgentSessionState.lastValidationSummary(ctx.sessionID),
              )
              const committed = AgentGateway.DeepAgentPlanStore.compareAndCommitPlan({
                sessionId: ctx.sessionID,
                expected: expectedRef,
                candidate: plan,
                origin: "model_tool",
              })
              AgentGateway.DeepAgentSessionState.bindPlan(ctx.sessionID, committed.plan, previous, committed.changed)
              return {
                previous,
                plan: committed.plan,
                version: committed.version,
                changed: committed.changed,
                changes: AgentGateway.DeepAgentPlanController.diffStepStatuses(previous, committed.plan),
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
            if (error instanceof AgentGateway.DeepAgentPlanController.PlanConflictError) {
              const conflict = error as InstanceType<typeof AgentGateway.DeepAgentPlanController.PlanConflictError>
              const current = AgentGateway.DeepAgentPlanStore.getPlanDoc(ctx.sessionID)
              const currentRef = AgentGateway.DeepAgentPlanStore.planDocRef(ctx.sessionID)
              const currentProgress = current
                ? AgentGateway.DeepAgentPlanController.planProgress(current)
                : { done: 0, total: 0 }
              return {
                title: "Plan conflict",
                output:
                  "The plan changed before this update was committed. Re-read the current plan and retry with its exact expected_plan_id and expected_version." +
                  renderPlanRetryBase(current, currentRef),
                metadata: {
                  plan_id: conflict.actual?.plan_id ?? current?.plan_id ?? previous?.plan_id ?? "",
                  goal: current?.goal ?? previous?.goal ?? params.goal ?? "",
                  done: currentProgress.done,
                  total: currentProgress.total,
                  plan_protocol: "conflict",
                  plan_error_code: "plan_conflict",
                  plan_version: conflict.actual?.version ?? currentRef?.version ?? ref?.version ?? 0,
                },
              }
            }
            if (error instanceof AgentGateway.DeepAgentPlanController.PlanValidationError) {
              const validation = error
              const offending = validation.offending_step_ids
              const offendingText = offending.length ? " Offending step IDs: " + offending.join(", ") + "." : ""
              // F-9: the all-steps-done advance has a legal terminal form (active_step_id null) —
              // teach it in the rejection itself instead of letting the budget die on it.
              const terminalHint =
                validation.code === "invalid_active_step" && params.operation === "advance"
                  ? " If every step is done after this update, resend the same advance with active_step_id set to null — a completed plan with no active step is the terminal state."
                  : ""
              const validationOutput = [
                "The plan was not committed (" + validation.code + ").",
                offendingText,
                terminalHint,
                " Correct the plan payload and retry once.",
                // A challenge is confirmed through the plan-edit receipt by the human/HTTP path
                // (`plan-edit-protocol.ts` `confirmed_challenge_id` -> `goal-loop.ts`), and no
                // model-facing field can carry it. Rendering the token here showed the model a value
                // it could not use, so it resent the same payload and was rejected again. Tell it
                // what it can actually do instead.
                validation.challenge_id
                  ? " This rejection is a safety challenge and only a human can confirm it: restore the" +
                    " steps you removed, or explain why they are no longer needed so the change can be" +
                    " approved."
                  : "",
                renderModelPlanCorrection(params, validation.code, previous, ref),
              ].join("")
              return {
                title: "Plan needs correction",
                output: validationOutput,
                metadata: {
                  plan_id: previous?.plan_id ?? "",
                  goal: previous?.goal ?? params.goal ?? "",
                  done: previous ? AgentGateway.DeepAgentPlanController.planProgress(previous).done : 0,
                  total: previous ? AgentGateway.DeepAgentPlanController.planProgress(previous).total : 0,
                  plan_protocol: "invalid",
                  plan_error_code: validation.code,
                  ...(offending.length ? { plan_error_step_ids: [...offending] } : {}),
                  ...(validation.challenge_id ? { challenge_id: validation.challenge_id } : {}),
                  ...(ref ? { plan_version: ref.version } : {}),
                },
              }
            }
            return yield* Effect.die(error)
          }

          const { previous: prior, plan, version, changed, changes } = attempt.value

          const { done, total } = AgentGateway.DeepAgentPlanController.planProgress(plan)
          const changeLines = changes.map((c) => AgentGateway.DeepAgentPlanController.formatStepChange(c))
          // U10: soft advisory — a step declared `done` whose acceptance criterion has no passing
          // validation on record is flagged (not blocked): the model may be marking done prematurely.
          const acceptanceWarnings = plan.steps
            .filter(
              (s) =>
                s.status === "done" &&
                s.acceptance != null &&
                s.acceptance.trim() !== "" &&
                (s.evidence == null || s.evidence.length === 0),
            )
            .map((s) => `"${s.title}" is done but its acceptance ("${s.acceptance}") has no recorded validation`)
          // U2: publish the live plan only after a real authority version changed. No-op writes still
          // settle the activity tracker as no-progress but must not manufacture a live event.
          if (changed) {
            yield* events
              .publish(PlanEvent.Updated, {
                sessionID: SessionID.make(ctx.sessionID),
                plan_id: plan.plan_id,
                plan_version: version,
                goal: plan.goal,
                assumptions: [...plan.assumptions],
                active_step_id: plan.active_step_id,
                steps: plan.steps.map((s) => ({
                  step_id: s.step_id,
                  title: s.title,
                  status: s.status,
                  acceptance: s.acceptance ?? null,
                  assigned_agent: s.assigned_agent ?? null,
                  note: s.note ?? null,
                  evidence: [...(s.evidence ?? [])],
                })),
                done,
                total,
                changes: changeLines,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("plan.updated publication failed; snapshot remains authoritative").pipe(
                    Effect.annotateLogs({
                      sessionID: ctx.sessionID,
                      plan_id: plan.plan_id,
                      plan_version: version,
                      cause,
                    }),
                    Effect.asVoid,
                  ),
                ),
              )
          }

          const changeSummary = changeLines.length > 0 ? `\n\nChanges: ${changeLines.join("; ")}` : ""
          const warnSummary =
            acceptanceWarnings.length > 0 ? `\n\n⚠ ${acceptanceWarnings.join("; ")}. Verify before finalizing.` : ""
          return {
            title: `Plan: ${done}/${total} steps`,
            output: renderModelPlanSuccess(plan, version, `${changeSummary}${warnSummary}`),
            metadata: {
              plan_id: plan.plan_id,
              goal: plan.goal,
              done,
              total,
              plan_protocol: changed ? "success" : "no_progress",
              plan_progress:
                changed &&
                (prior == null ||
                  AgentGateway.DeepAgentPlanController.planProgressFingerprint(prior) !==
                    AgentGateway.DeepAgentPlanController.planProgressFingerprint(plan)),
              plan_version: version,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

// The core controller keeps the full-document contract for human and HTTP writes. This adapter
// supplies model-owned intent to that strict boundary without letting the model allocate opaque IDs
// or reconstruct authority fields omitted from compact context.
export const normalizeModelPlanWrite = (
  params: Schema.Schema.Type<typeof Parameters>,
  previous: ReturnType<typeof AgentGateway.DeepAgentPlanStore.getPlanDoc>,
  expected: AgentGateway.DeepAgentPlanController.PlanExpected | null,
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
  // F-11: providers omit `operation` on obvious payload shapes. Infer instead of defaulting to
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
  AgentGateway.DeepAgentPlanController.requirePlanWriteExpected(normalized, previous, expected)
  const base = {
    operation: normalized.operation,
    expected_plan_id: normalized.expected_plan_id,
    expected_version: normalized.expected_version,
    ...(params.replan_reason !== undefined ? { replan_reason: params.replan_reason } : {}),
    goal: params.goal ?? "",
  }

  if (normalized.operation === "create") {
    // Step ids are SERVER-OWNED. The model is never required to supply one, and one it does supply is
    // ignored rather than rejected: an id is the anchor that carries runtime evidence across plan
    // rewrites, so demanding the model reproduce it turned an internal bookkeeping detail into a
    // submission-blocking rule. `buildPlanFromInput` mints `step_${i+1}` for a new plan.
    //
    // History: this branch used to reject ANY supplied id ("unsafe_step_identity"), and `replan`
    // rejected ids absent from the previous plan. Both fired in the full-roster sweep: a model that
    // invented `step_snap_types` for a NEW step had its whole submission rejected, twice, and the
    // session was terminated. None of Codex, Claude Code or deepseek-harness exposes step ids to the
    // model at all (Claude Code's TaskCreate has the harness allocate them), so the requirement had
    // no precedent and only taxed naming habits.
    return {
      ...base,
      assumptions: params.assumptions,
      steps: params.steps.map((step) => ({ ...step, step_id: undefined, title: step.title ?? "" })),
    }
  }

  if (previous == null) {
    throw new AgentGateway.DeepAgentPlanController.PlanValidationError("plan_missing")
  }

  if (normalized.operation === "advance") {
    // Identity is RECOVERED, not demanded. A supplied id is used only when it names a step of the
    // previous plan; otherwise the step is matched by the content the model already authored
    // (title + acceptance, the same pair `hasSameIdentity` uses). An unmatched step is simply not an
    // update — it cannot invent a step through `advance`, because `advance` only patches statuses.
    const byID = new Map(previous.steps.map((step) => [step.step_id, step] as const))
    const byContent = stepIdentityIndex(previous.steps)
    const updates = new Map<string, (typeof params.steps)[number]>()
    for (const update of params.steps) {
      const supplied = update.step_id?.trim() ?? ""
      const prior = supplied !== "" ? byID.get(supplied) : matchByIdentity(byContent, update)
      if (prior === undefined) continue
      // Last write wins for a repeated target: the model asked for the same step twice.
      updates.set(prior.step_id, update)
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
    // F-9/F-11/F-12: the supplied active_step_id is ADVISORY on advance — the built statuses are
    // the truth (exactly one active step, or none on the legal terminal close). Every hard-failure
    // variant so far was a pointer/statuses contradiction: retain-resurrected dead pointers, and
    // explicit stale pointers copied verbatim from a correction payload while that step was being
    // marked done. A pointer that matches a built ACTIVE step passes through; anything else is
    // dropped and the controller derives from statuses.
    const advisoryActive =
      normalized.active_step_id != null &&
      built.some((step) => step.step_id === normalized.active_step_id && step.status === "active")
        ? normalized.active_step_id
        : undefined
    return {
      ...base,
      // The goal is EDITABLE: a long-horizon task legitimately narrows or reframes its objective, and
      // freezing it forced a `replan` (with its own rejections) for what is often a one-word change.
      goal: base.goal.trim() === "" ? previous.goal : base.goal,
      assumptions: params.assumptions === undefined ? [...previous.assumptions] : params.assumptions,
      ...(advisoryActive !== undefined ? { active_step_id: advisoryActive } : {}),
      steps: built,
    }
  }

  // Replan is a structural revision, so identity is recovered per step rather than demanded:
  //   1. an id that names a previous step wins (the model echoed the authoritative payload), and
  //   2. otherwise the step is matched by title + acceptance — the SAME pair `hasSameIdentity` uses
  //      to decide whether runtime evidence may be carried forward. Matching by that pair is what
  //      keeps the anchor honest: a step the model reworded is genuinely a new step and starts with
  //      no evidence, while one it merely re-sent keeps its proof.
  // A supplied id that matches nothing is treated as a NEW step (its id is dropped and the
  // controller mints one). Rejecting it instead was the defect that ended whole sessions.
  const byID = new Map(previous.steps.map((step) => [step.step_id, step] as const))
  const byContent = stepIdentityIndex(previous.steps)
  const claimed = new Set<string>()
  return {
    ...base,
    assumptions: params.assumptions === undefined ? [...previous.assumptions] : params.assumptions,
    steps: params.steps.map((update) => {
      const supplied = update.step_id?.trim() ?? ""
      const echoed = supplied === "" ? undefined : byID.get(supplied)
      // A previous step may back at most one submitted step: a wholesale copy-paste of the old list
      // must not make several new steps claim one step's identity (and its evidence).
      const prior =
        echoed !== undefined && !claimed.has(echoed.step_id) ? echoed : matchByIdentity(byContent, update, claimed)
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
 * Index the previous plan's steps by the content pair that defines step identity (`hasSameIdentity`).
 * A key maps to every step carrying it, so an ambiguous match can be refused rather than guessed.
 */
const stepIdentityIndex = (steps: readonly PlanStep[]) => {
  const index = new Map<string, PlanStep[]>()
  for (const step of steps) {
    const key = stepIdentityKey(step.title, step.acceptance)
    const bucket = index.get(key)
    if (bucket === undefined) index.set(key, [step])
    else bucket.push(step)
  }
  return index
}

const stepIdentityKey = (title: string | null | undefined, acceptance: string | null | undefined) =>
  `${(title ?? "").trim()}\u0000${(acceptance ?? "").trim()}`

/**
 * Recover the previous step a submission refers to, by content.
 *
 * Candidates are the previous steps whose title + acceptance match exactly; an already-claimed step
 * is skipped, and an ambiguous match (two previous steps with identical content) yields nothing —
 * refusing to guess is the safe direction here, because a wrong match would carry another step's
 * runtime evidence onto this one.
 */
const matchByIdentity = (
  index: ReadonlyMap<string, readonly PlanStep[]>,
  update: { readonly title?: string | undefined; readonly acceptance?: string | undefined },
  claimed: ReadonlySet<string> = new Set(),
): PlanStep | undefined => {
  if (update.title === undefined) return undefined
  const bucket = index.get(stepIdentityKey(update.title, update.acceptance))
  if (bucket === undefined) return undefined
  const open = bucket.filter((step) => !claimed.has(step.step_id))
  return open.length === 1 ? open[0] : undefined
}

export const renderModelPlanCorrection = (
  params: Schema.Schema.Type<typeof Parameters>,
  code: AgentGateway.DeepAgentPlanController.PlanValidationCode,
  previous: ReturnType<typeof AgentGateway.DeepAgentPlanStore.getPlanDoc>,
  ref: ReturnType<typeof AgentGateway.DeepAgentPlanStore.planDocRef>,
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
    "\n\nCorrection protocol for replan: start from the schema-valid authoritative payload below. Repeat the title and acceptance of a step VERBATIM to keep it as the same step (that is how the server carries its runtime evidence forward); any step you reword is new. Do not send step_id or active_step_id — both are ignored — and mark at most one step status=active so the server derives the active step. Omit assumptions to retain the authoritative list, or send [] only when you intentionally clear it.\n" +
    JSON.stringify({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: params.replan_reason?.trim() || "Correct the rejected replan against current authority",
      goal: params.goal ?? previous.goal,
      ...(params.assumptions !== undefined ? { assumptions: params.assumptions } : {}),
      // No `step_id` in the example payload: the prose above says the field is ignored, and showing
      // ids here would contradict it — the model copies what it is shown.
      steps: previous.steps.map((step) => ({
        title: step.title,
        status: step.status,
        ...(step.acceptance != null ? { acceptance: step.acceptance } : {}),
        ...(step.assigned_agent != null ? { assigned_agent: step.assigned_agent } : {}),
        ...(step.note != null ? { note: step.note } : {}),
      })),
    })
  )
}

export const renderModelPlanSuccess = (
  plan: AgentGateway.DeepAgentPlanController.PlanDoc,
  version: number,
  summary = "",
): string =>
  AgentGateway.DeepAgentPlanController.renderPlanWriteContext(plan, version) +
  summary +
  "\n\nCopyable parameters for the next plan update:\n" +
  JSON.stringify(modelAdvanceParameters(plan, version))

export const renderPlanRetryBase = (
  previous: ReturnType<typeof AgentGateway.DeepAgentPlanStore.getPlanDoc>,
  ref: ReturnType<typeof AgentGateway.DeepAgentPlanStore.planDocRef>,
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

const modelAdvanceParameters = (plan: AgentGateway.DeepAgentPlanController.PlanDoc, version: number) => ({
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
