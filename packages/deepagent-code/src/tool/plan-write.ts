import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./plan-write.txt"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
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
  operation: Schema.Literals(["create", "advance", "replan"]).annotate({
    description: "create a plan, advance an existing plan, or replan with a reason",
  }),
  expected_plan_id: Schema.NullOr(Schema.String).annotate({
    description:
      "Use null for create; for advance/replan copy expected_plan_id exactly from the latest <plan-status> or plan result",
  }),
  expected_version: Schema.NullOr(NonNegativeInt).annotate({
    description:
      "Use null for create; for advance/replan copy expected_version exactly from the latest <plan-status> or plan result",
  }),
  replan_reason: Schema.optional(Schema.String).annotate({
    description: "Required for replan; omit for create/advance",
  }),
  goal: Schema.optional(Schema.String).annotate({
    description: "One sentence: what 'done' means for this task; required for create/replan",
  }),
  steps: Schema.mutable(Schema.Array(PlanStep)).annotate({
    description:
      "Ordered plan steps for create/replan; for advance copy existing step_id values from <plan-status> and send status/note updates",
  }),
  assumptions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Facts for create; for replan omit to retain the authoritative list, or send [] to clear it",
  }),
  active_step_id: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      "For create/replan, omit this field because supplying it is rejected; mark at most one step active and the server derives its ID. For advance, copy a visible step_id, omit to retain it, or use null to clear it",
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
        expected_plan_id: input.expected_plan_id,
        expected_version: input.expected_version,
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
              const validationOutput = [
                "The plan was not committed (" + validation.code + ").",
                offendingText,
                " Correct the plan payload and retry once.",
                validation.challenge_id ? " Confirmation: " + validation.challenge_id : "",
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
  // Stale writers are concurrency conflicts even when a concurrent replan also changed step IDs.
  // Check the shared core precondition before interpreting the patch against current authority.
  AgentGateway.DeepAgentPlanController.requirePlanWriteExpected(params, previous, expected)
  const base = {
    operation: params.operation,
    expected_plan_id: params.expected_plan_id,
    expected_version: params.expected_version,
    ...(params.replan_reason !== undefined ? { replan_reason: params.replan_reason } : {}),
    goal: params.goal ?? "",
  }

  if (params.operation === "create") {
    const suppliedIDs = params.steps.map((step) => step.step_id?.trim()).filter((stepID) => stepID !== undefined)
    if (suppliedIDs.length > 0 || params.active_step_id !== undefined) {
      throw new AgentGateway.DeepAgentPlanController.PlanValidationError("unsafe_step_identity", [
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
    throw new AgentGateway.DeepAgentPlanController.PlanValidationError("plan_missing")
  }

  if (params.operation === "advance") {
    const suppliedIDs = params.steps.map((step) => step.step_id?.trim() ?? "")
    if (suppliedIDs.some((stepID) => stepID === "")) {
      throw new AgentGateway.DeepAgentPlanController.PlanValidationError("unsafe_step_identity", [], previous.plan_id)
    }
    const duplicateIDs = suppliedIDs.filter((stepID, index) => suppliedIDs.indexOf(stepID) !== index)
    if (duplicateIDs.length > 0) {
      throw new AgentGateway.DeepAgentPlanController.PlanValidationError(
        "duplicate_step_id",
        [...new Set(duplicateIDs)],
        previous.plan_id,
      )
    }
    const knownIDs = new Set(previous.steps.map((step) => step.step_id))
    const unknownIDs = suppliedIDs.filter((stepID) => !knownIDs.has(stepID))
    if (unknownIDs.length > 0) {
      throw new AgentGateway.DeepAgentPlanController.PlanValidationError(
        "unsafe_step_identity",
        unknownIDs,
        previous.plan_id,
      )
    }
    const updates = new Map(params.steps.map((step, index) => [suppliedIDs[index], step] as const))
    return {
      ...base,
      goal: previous.goal,
      assumptions: [...previous.assumptions],
      active_step_id: params.active_step_id === undefined ? previous.active_step_id : params.active_step_id,
      steps: previous.steps.map((step) => {
        const update = updates.get(step.step_id)
        return {
          step_id: step.step_id,
          title: step.title,
          status: update?.status ?? step.status,
          acceptance: step.acceptance ?? null,
          assigned_agent: step.assigned_agent ?? null,
          note: update?.note ?? step.note ?? null,
        }
      }),
    }
  }

  const suppliedIDs = params.steps.map((step) => step.step_id?.trim() ?? "")
  const duplicateIDs = suppliedIDs.filter((stepID, index) => suppliedIDs.indexOf(stepID) !== index)
  const duplicateKnownIDs = duplicateIDs.filter(Boolean)
  if (duplicateKnownIDs.length > 0) {
    throw new AgentGateway.DeepAgentPlanController.PlanValidationError(
      "duplicate_step_id",
      [...new Set(duplicateKnownIDs)],
      previous.plan_id,
    )
  }
  const knownIDs = new Set(previous.steps.map((step) => step.step_id))
  const unknownIDs = suppliedIDs.filter((stepID) => stepID !== "" && !knownIDs.has(stepID))
  if (unknownIDs.length > 0) {
    throw new AgentGateway.DeepAgentPlanController.PlanValidationError(
      "unsafe_step_identity",
      unknownIDs,
      previous.plan_id,
    )
  }
  if (params.active_step_id !== undefined) {
    throw new AgentGateway.DeepAgentPlanController.PlanValidationError(
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
  if (params.operation === "create") {
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
