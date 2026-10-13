import type {
  BrowserActionResponses,
  DeepagentGoalPlanRebaseApplyData,
  DeepagentGoalPlanRebaseApplyErrors,
  DeepagentGoalPlanRebaseApplyResponses,
  DeepagentGoalPlanRebaseBeginData,
  DeepagentGoalPlanRebaseBeginErrors,
  DeepagentGoalPlanRebaseCancelErrors,
  DeepagentGoalPlanRebaseGetErrors,
  DeepagentGoalPlanRebaseReconcileErrors,
  EventValidationRunsResponses,
  EventInvestigationCandidatesResponses,
  EventInvestigationControlData,
  EventInvestigationControlErrors,
  EventInvestigationCaptureResponses,
  EventInvestigationReportsResponses,
} from "../src/gen/types.gen.js"

type Assert<T extends true> = T
type Body = DeepagentGoalPlanRebaseApplyData["body"]
type Response = DeepagentGoalPlanRebaseApplyResponses[200]
type Receipt = NonNullable<Response["originalReceipt"]>
type PreparationRelease = NonNullable<EventValidationRunsResponses[200][number]["record"]["preparationRelease"]>

// Compile the generated public call shape, including durable null values. Runtime
// schema tests separately verify that optional evidence cannot accept null.
export type NativeContract = [
  Assert<{} extends Pick<DeepagentGoalPlanRebaseBeginData, "body"> ? false : true>,
  Assert<{} extends Pick<DeepagentGoalPlanRebaseApplyData, "body"> ? false : true>,
  Assert<Body["requestID"] extends string ? true : false>,
  Assert<Body["expectedControlRevision"] extends number ? true : false>,
  Assert<null extends Body["candidate"]["activeStepID"] ? true : false>,
  Assert<null extends Response["originalReceipt"] ? true : false>,
  Assert<null extends Response["current"]["editSource"] ? true : false>,
  Assert<Receipt["requestHash"] extends string ? true : false>,
  Assert<Receipt["controlRevision"] extends number ? true : false>,
  Assert<401 extends keyof DeepagentGoalPlanRebaseBeginErrors ? true : false>,
  Assert<401 extends keyof DeepagentGoalPlanRebaseApplyErrors ? true : false>,
  Assert<401 extends keyof DeepagentGoalPlanRebaseCancelErrors ? true : false>,
  Assert<401 extends keyof DeepagentGoalPlanRebaseGetErrors ? true : false>,
  Assert<401 extends keyof DeepagentGoalPlanRebaseReconcileErrors ? true : false>,
  Assert<BrowserActionResponses[200]["nativeVerification"] extends "verified" | "unavailable" ? true : false>,
  Assert<BrowserActionResponses[200]["observedOutcome"] extends "pending" | "completed" | "failed" | "cancelled" | "unknown" ? true : false>,
  Assert<PreparationRelease["version"] extends 1 ? true : false>,
  Assert<PreparationRelease["kind"] extends "no_workspace_created" | "partial_workspace_cleaned" ? true : false>,
  Assert<null extends PreparationRelease["workspaceIdentity"] ? true : false>,
  Assert<null extends EventValidationRunsResponses[200][number]["record"]["preparationRelease"] ? false : true>,
  Assert<EventInvestigationCandidatesResponses[200]["targets"][number]["profile"]["id"] extends "event_investigate_v1" ? true : false>,
  Assert<EventInvestigationControlData["body"]["operation"] extends "enable" | "disable" ? true : false>,
  Assert<EventInvestigationControlData["body"]["expectedEpoch"] extends number ? true : false>,
  Assert<null extends EventInvestigationControlData["body"]["captureID"] ? true : false>,
  Assert<null extends EventInvestigationControlData["body"]["targetID"] ? true : false>,
  Assert<EventInvestigationCaptureResponses[200]["preview"]["grantExpiresAt"] extends number ? true : false>,
  Assert<EventInvestigationReportsResponses[200][number]["work"]["controlRevision"] extends number ? true : false>,
  Assert<401 extends keyof EventInvestigationControlErrors ? true : false>,
  Assert<409 extends keyof EventInvestigationControlErrors ? true : false>,
]
