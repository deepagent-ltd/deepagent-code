export * as PlanApprovalPresentation from "./plan-approval-presentation"

import { Option, Schema } from "effect"
import { hash } from "../util/encode"

const Step = Schema.Struct({
  step_id: Schema.String,
  title: Schema.String,
  status: Schema.Literals(["pending", "active", "done", "cancelled", "blocked"]),
  acceptance: Schema.optional(Schema.NullOr(Schema.String)),
  assigned_agent: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
  evidence: Schema.optional(Schema.Array(Schema.String)),
})
const Plan = Schema.Struct({
  plan_id: Schema.String,
  session_id: Schema.String,
  goal: Schema.String,
  assumptions: Schema.Array(Schema.String),
  steps: Schema.Array(Step),
  active_step_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  replan_reason: Schema.optional(Schema.NullOr(Schema.String)),
  last_write_activity_id: Schema.optional(Schema.NullOr(Schema.String)),
})
const Approval = Schema.Struct({
  documentID: Schema.String,
  planID: Schema.String,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  hash: Schema.String,
})

export type Kind = "question" | "approved"
export type Label =
  | "question"
  | "approved"
  | "scope"
  | "goal"
  | "assumptions"
  | "steps"
  | "acceptance"
  | "agent"
  | "note"
  | "evidence"
  | "plan"
  | "version"
  | "hash"
  | "session"
  | "activeStep"
  | "created"
  | "replan"
  | "activity"
  | typeof Step.Type.status
export type View = NonNullable<ReturnType<typeof parse>>

// A read-only view of the existing wire text. This never creates or substitutes
// an approval: callers keep the original question, prompt, metadata and bytes.
type Input = { kind: Kind; sessionID: string; approval?: unknown }

export async function read(text: string, input: Input) {
  const view = parse(text, input)
  if (!view || (await hash(view.body).catch(() => undefined)) !== view.hash) return
  return view
}

// Native TUI renderers stay synchronous; their existing crypto implementation
// verifies the same byte digest without an asynchronous mount/dispose boundary.
export function readWithDigest(text: string, input: Input, digest: (body: string) => string) {
  const view = parse(text, input)
  return view && digest(view.body) === view.hash ? view : undefined
}

function parse(text: string, input: Input) {
  const prefix =
    input.kind === "question"
      ? /^Approve plan ([^\n]+), version ([1-9]\d*) \(([a-f0-9]{64})\)\? Approval queues this exact version in the same Session\. Later drafts will not replace it\.\n\n/
      : /^The user approved the exact plan below for execution under the existing permissions\. This approved snapshot is the execution request; later drafts are observations, not substitutes for the approved scope\.\nPlan: ([^\n]+); version: ([1-9]\d*); SHA256: ([a-f0-9]{64})\n\n/
  const matched = prefix.exec(text)
  if (!matched) return
  const body = text.slice(matched[0].length)
  if (new TextEncoder().encode(body).byteLength > 131072) return
  const plan = Schema.decodeUnknownOption(Schema.fromJsonString(Plan), { onExcessProperty: "error" })(body)
  if (
    Option.isNone(plan) ||
    plan.value.plan_id !== matched[1] ||
    plan.value.session_id !== input.sessionID ||
    !plan.value.steps.length
  )
    return
  const version = Number(matched[2])
  if (!Number.isSafeInteger(version)) return
  if (input.kind === "approved") {
    const approval = Schema.decodeUnknownOption(Approval, { onExcessProperty: "error" })(input.approval)
    if (
      Option.isNone(approval) ||
      approval.value.planID !== matched[1] ||
      approval.value.version !== version ||
      approval.value.hash !== matched[3]
    )
      return
  }
  return Object.freeze({ kind: input.kind, plan: plan.value, planID: matched[1], version, hash: matched[3], body })
}

export function format(view: View, label: (key: Label) => string) {
  const plan = view.plan
  return [
    label(view.kind),
    label("scope"),
    `${label("goal")}\n${plan.goal}`,
    ...(plan.assumptions.length
      ? [`${label("assumptions")}\n${plan.assumptions.map((value) => `• ${value}`).join("\n")}`]
      : []),
    `${label("steps")}\n${plan.steps
      .map((step, index) =>
        [
          `${index + 1}. [${label(step.status)}] ${step.title} (${step.step_id})`,
          ...(step.acceptance ? [`  ${label("acceptance")}: ${step.acceptance}`] : []),
          ...(step.assigned_agent ? [`  ${label("agent")}: ${step.assigned_agent}`] : []),
          ...(step.note ? [`  ${label("note")}: ${step.note}`] : []),
          ...(step.evidence?.length
            ? [`  ${label("evidence")}:\n${step.evidence.map((value) => `    • ${value}`).join("\n")}`]
            : []),
        ].join("\n"),
      )
      .join("\n\n")}`,
    ...(plan.replan_reason ? [`${label("replan")}: ${plan.replan_reason}`] : []),
    `${label("plan")}: ${view.planID}\n${label("version")}: ${view.version}\n${label("hash")}: ${view.hash}\n${label("session")}: ${plan.session_id}`,
    `${label("activeStep")}: ${plan.active_step_id ?? "—"}\n${label("created")}: ${plan.created_at}`,
    ...(plan.last_write_activity_id ? [`${label("activity")}: ${plan.last_write_activity_id}`] : []),
  ].join("\n\n")
}
