export * as EventWorkPlacement from "./event-work-placement"

import { Context, Effect, Schema, Scope } from "effect"
import { WorkAuthoritySchema } from "../session/work-authority.schema"
import type { EventWorkDagSchema } from "./event-work-dag.schema"
import type { IMTaskAuthoritySchema } from "../im/task-authority.schema"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))
const Digest = WorkAuthoritySchema.Digest
const Positive = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
/** Stored facts do not create a witness. Cold use must re-observe the exact physical worktree,
 * original root and Native configuration through the installation-owned service. */
export const Description = Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("event_task_worktree_v1"),
  controllerID: Text, receiptID: Text, eventID: Text, nodeID: Text, rootWorkID: Text,
  childWorkID: Text, childSessionID: Text, childInputID: Text, rootBindingHash: Digest, planHash: Digest,
  rootRevision: Positive, controllerRevision: Positive,
  workspace: Schema.Struct({ generation: Schema.Literal(0), operationKey: Text, repositoryRoot: Path,
    baseCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)), branch: Text, directory: Path,
    immutableRowHash: Digest,
    files: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8192)),
    bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(67_108_864)),
    manifestSha256: Digest,
    allocatedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(536_870_912)) }),
  parentRootIdentity: WorkAuthoritySchema.ProjectBinding.fields.projectScope.fields.rootIdentity,
  childRootIdentity: WorkAuthoritySchema.ProjectBinding.fields.projectScope.fields.rootIdentity,
  projectID: Text, locationKey: Text, namespaceBindingHash: Digest, helperHash: Digest,
  gitRuntimeHash: Digest, configurationStamp: Digest, configuredTargetStamp: Digest,
  childConfigurationStamp: Digest, childConfiguredTargetStamp: Digest,
  observedAt: Positive, expiresAt: Positive,
}).check(Schema.makeFilter((value) => value.observedAt < value.expiresAt && value.workspace.directory !== value.workspace.repositoryRoot &&
  Buffer.byteLength(JSON.stringify(value), "utf8") <= 16_384))
export type Description = typeof Description.Type
export const MAX_WORKSPACES = 64
export const CLONE_RESERVATION_BYTES = 67_108_864
export const WORKSPACE_CUSTODY_RESERVATION_BYTES = 536_870_912
export const BASELINE_CUSTODY_RESERVATION_BYTES = 268_435_456
export const MAX_CUSTODY_BYTES = 4_294_967_296
declare const witness: unique symbol
export interface Witness { readonly [witness]: true }

/** Only the trusted Host Native factory installs this port. No HTTP endpoint accepts or mints
 * a witness; run-time current() is a pure live-object check suitable inside final SQL fences. */
export class Service extends Context.Service<Service, {
  readonly available: (target: typeof IMTaskAuthoritySchema.ProjectTarget.Type, plan: EventWorkDagSchema.Plan) => Effect.Effect<boolean, WorkAuthoritySchema.Error>
  readonly availableCurrent: (target: typeof IMTaskAuthoritySchema.ProjectTarget.Type, plan: EventWorkDagSchema.Plan) => boolean
  readonly prepare: (input: { controllerID: string; nodeID: string; expectedRevision: number }) => Effect.Effect<Witness, WorkAuthoritySchema.Error, Scope.Scope>
  readonly restore: (description: Description) => Effect.Effect<Witness, WorkAuthoritySchema.Error, Scope.Scope>
  readonly describe: (value: Witness) => Description | undefined
  readonly forWork: (workID: string) => Witness | undefined
  readonly current: (value: Witness) => Effect.Effect<void, WorkAuthoritySchema.Error>
  readonly accountingCurrent: (value: Witness) => Effect.Effect<void, WorkAuthoritySchema.Error>
  readonly artifact: (value: Witness) => EventWorkDagSchema.ArtifactCustody | undefined
  readonly settle: (value: Witness) => Effect.Effect<{ continuationRef: string; commit: string }, WorkAuthoritySchema.Error>
  readonly settleKnown: (workID: string) => Effect.Effect<{ continuationRef: string; commit: string }, WorkAuthoritySchema.Error>
  readonly collectKnown: (workID: string) => Effect.Effect<boolean, WorkAuthoritySchema.Error>
  readonly collectStale: Effect.Effect<void, WorkAuthoritySchema.Error>
}>()("@deepagent-code/EventWorkPlacement") {}

/** A process-local opaque observation is refreshed before, never during, database consumption. */
export const Current = Context.Reference<Witness | undefined>("@deepagent-code/EventWorkPlacement/Current", { defaultValue: () => undefined })
export const withWitness = <A, E, R>(value: Witness, body: Effect.Effect<A, E, R>) => body.pipe(Effect.provideService(Current, value))
