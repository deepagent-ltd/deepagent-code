export * as WorkFileCapability from "./work-file-capability"

import { Context, Effect, Schema, Scope } from "effect"
import type { WorkAuthoritySchema } from "./work-authority.schema"
import type { WorkCommandSchema } from "./work-command.schema"
import type { WorkCommandWindowsSchema } from "./work-command-windows.schema"
import type { WorkCommandV2Schema } from "./work-command-v2.schema"
import type { WorkWriteStageSchema } from "./work-write-stage.schema"

declare const rooted: unique symbol
declare const observed: unique symbol
declare const written: unique symbol
declare const commanded: unique symbol
/** Native live objects. Neither a JSON binding nor a copied receipt reconstructs these. */
export interface Root { readonly [rooted]: true }
export interface Observation { readonly [observed]: true }
export interface WriteObservation { readonly [written]: true }
export interface CommandObservation { readonly [commanded]: true }
export type CommandDescription = Readonly<{ record: WorkCommandWindowsSchema.StoredRecord; observedAt: number;
  supervision?: WorkCommandV2Schema.Supervision }>
export type WriteDescription = Readonly<{
  record: WorkWriteStageSchema.Record
  outcome: "published" | "refused_before_publish"
  fileIdentity: Identity | null
  observedAt: number
}>
export type Identity = typeof WorkAuthoritySchema.ProjectBinding.Type.projectScope.rootIdentity
export type Description = Readonly<{
  workID: string
  bindingHash: string
  controlRevision: number
  rootIdentity: Identity
  fileIdentity: Identity
  helperHash: string
  relative: string
  offset: number
  bytes: number
  fileBytes: number
  scannedBytes: number
  observedHash: string
  pageHash: string
  observedAt: number
  snapshot: "stream_observation"
}>

export class Error extends Schema.TaggedErrorClass<Error>()("WorkFileCapability.Error", {
  code: Schema.Literals(["WORK_FILE_UNAVAILABLE", "WORK_FILE_CHANGED", "WORK_FILE_CAPACITY", "WORK_FILE_UNKNOWN"]),
  message: Schema.String,
}) {}

/** Internal host seam, absent in unverified/source hosts. It does not grant tool execution:
 * the canonical tool scope and the leaf must independently require current Work permission.
 * A service cannot replace Root through per-request caller metadata. */
export interface Interface {
  readonly open: (input: {
    binding: typeof WorkAuthoritySchema.ProjectBinding.Type
    controlRevision: number
  }) => Effect.Effect<Root, Error, Scope.Scope>
  readonly current: (root: Root) => Effect.Effect<void, Error>
  readonly read: (root: Root, input: {
    relative: string
    offset: number
    bytes: number
    scanLimit: number
    deadlineMs?: number
  }) => Effect.Effect<{ observation: Observation; text: string; next: number | null }, Error>
  readonly describe: (root: Root, observation: Observation) => Description | undefined
  /** Internal canonical leaf only. The hook rechecks the real leaf's captured permission
   * after native preparation; it cannot replace the host's Work/admission/asset checks. */
  readonly write?: (root: Root, input: {
    activityID: string; providerReceiptID: string; providerAttemptID: string; admissionID: string;
    toolCallID: string; ownerToken: string; sessionClaimToken: number; definitionHash: string;
    relative: string; content: string; expected: WorkWriteStageSchema.Expected;
    checkPermission: Effect.Effect<void, Error>;
  }) => Effect.Effect<{ observation: WriteObservation; outcome: WriteDescription["outcome"] }, Error>
  /** Shrinks custody only for the same live native observation after durable settlement. */
  readonly cleanupWrite?: (root: Root, observation: WriteObservation) => Effect.Effect<void, Error>
  readonly describeWrite?: (root: Root, observation: WriteObservation) => WriteDescription | undefined
  readonly command?: (root: Root, input: {
    activityID: string; providerReceiptID: string; providerAttemptID: string; admissionID: string;
    toolCallID: string; ownerToken: string; sessionClaimToken: number; definitionHash: string;
    input: WorkCommandSchema.Input; checkPermission: Effect.Effect<void, Error>;
  }) => Effect.Effect<{ observation: CommandObservation; output: WorkCommandSchema.Output }, Error>
  readonly describeCommand?: (root: Root, observation: CommandObservation) => CommandDescription | undefined
  /** References identify previously authenticated results; they never supply a filesystem path. */
  readonly commandOutput?: (root: Root, input: { admissionID: string; relative: string; sha256: string }) =>
    Effect.Effect<string, Error>
  readonly cleanupCommand?: (root: Root, admissionID: string, published?: WorkCommandSchema.OutputReference) => Effect.Effect<void, Error>
  /** Cleanup only: exact retained native objects after the actual Work/activity terminal.
   * Missing live ownership never reconstructs a filesystem capability from SQL. */
  readonly cleanupCompletedWork?: (input: { workID: string; bindingHash: string }) => Effect.Effect<void, Error>
  readonly live: () => Readonly<{ helpers: number; queued: number; inFlight: number; observations: number }>
}
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/WorkFileCapability") {}
