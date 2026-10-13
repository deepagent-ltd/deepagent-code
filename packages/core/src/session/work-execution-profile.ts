export * as WorkExecutionProfile from "./work-execution-profile"

import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Scope } from "effect"
import type { Database } from "../database/database"
import { LocationIdentityTable, ProjectScopeIdentityTable, SecurityNamespaceTable } from "../context-federation/sql"
import { ProjectScopeKey, SecurityNamespaceID } from "../context-federation/reference"
import type { LLMRequest } from "@deepagent-code/llm"
import type { RequestExecutor } from "@deepagent-code/llm/route"
import type { SessionRunnerModel } from "./runner/model"
import { WorkAuthority } from "./work-authority"
import { WorkAuthoritySchema } from "./work-authority.schema"
import { WorkRoutePolicy } from "./work-route-policy"
import { WorkRouteApproval } from "./work-route-approval"
import { WorkCountAcquisition } from "./work-count-acquisition"
import { SessionTable } from "./sql"
import { SessionSchema } from "./schema"
import { WorkFileCapability } from "./work-file-capability"
import { WorkToolPolicy } from "./work-tool-policy"
import { WorkTaskKnownProof } from "./work-task-known-proof"
import { BrowserFileCapability } from "../browser/file-capability"
import { EventWorkPlacement } from "../deepagent/event-work-placement"
import type { Config } from "../config"
import type { Location } from "../location"
import { LocalOperator } from "../im/local-operator"

/** Internal production composition, absent by default. A profile is not a second runner: the
 * existing Session coordinator, canonical writer and provider-turn lifecycle own execution.
 * Implementations must read actual approved route facts, observe the resolved model/client, and
 * acquire authenticated count evidence outside SQL. HTTP metadata cannot supply this service. */
export class Service extends Context.Service<
  Service,
  {
    /** No text, model resolution, filesystem discovery or network before the Session claim. */
    readonly preflight: (work: WorkAuthority.Work) => Effect.Effect<void, WorkAuthoritySchema.Error>
    /** Refresh opaque source facts outside SQL; final consumers still verify their current getter.
     * Legacy hosts omit this only when their source requires no external native observation. */
    readonly prepareSource?: (work: WorkAuthority.Work, options?: { readonly fresh?: boolean }) => Effect.Effect<void, WorkAuthoritySchema.Error>
    /** Observe this actual resolved object. Never manufacture runtime identities from a binding. */
    readonly observe: (input: {
      readonly sessionID: string
      readonly resolved: SessionRunnerModel.ResolvedModel
    }) => Effect.Effect<WorkRoutePolicy.Runtime, WorkAuthoritySchema.Error, Scope.Scope>
    /** Lazy call from INSIDE V2ProviderTurn's CurrentRequestSeal frame. No outer encoder. */
    readonly bind: (runtime: WorkRoutePolicy.Runtime, request: LLMRequest) => Effect.Effect<RequestExecutor.RequestSeal, WorkAuthoritySchema.Error, Scope.Scope>
    /** Fast private live-object check, no filesystem/network in the dispatch transaction. */
    readonly current: (runtime: WorkRoutePolicy.Runtime) => Effect.Effect<void, WorkAuthoritySchema.Error>
    /** Called after final lowering/overlays and current source/egress checks, BEFORE the dispatch
     * transaction. Persist a count receipt that Evidence.readCount can authenticate locally.
     * This operation must not dispatch generation or silently fall back to token estimates. */
    readonly acquireCount: (input: {
      readonly workID: string
      readonly controlRevision: number
      readonly receiptID: string
      readonly runtime: WorkRoutePolicy.Runtime
      readonly route: WorkRoutePolicy.RouteEvidence
      readonly wire: RequestExecutor.RequestSealInput
    }) => Effect.Effect<void, WorkAuthoritySchema.Error, Scope.Scope>
  }
>()("@deepagent-code/WorkExecutionProfile") {}

/** One host-created object shared by process-global execution and cached Locations. No service
 * here grants authority from an HTTP request; bare-core hosts leave this seam absent. */
export interface Installed {
  /** Original Host identity captured with the coordinator. Runtime is never a Mutation grant. */
  readonly eventOperator?: Context.Service.Shape<typeof LocalOperator.Runtime>
  /** Original placement-owned configuration inheritance. A Location ref or JSON alone cannot
   * register a child: the installed factory returns the actual approved parent Config service. */
  readonly configuration?: (ref: Location.Ref) => Effect.Effect<Config.Interface | undefined, WorkAuthoritySchema.Error>
  readonly profile: Context.Service.Shape<typeof Service>
  readonly verifier: Context.Service.Shape<typeof WorkAuthority.Verifier>
  readonly evidence: Context.Service.Shape<typeof WorkRoutePolicy.Evidence>
  readonly approval: Context.Service.Shape<typeof WorkRouteApproval.Authority>
  readonly count: Context.Service.Shape<typeof WorkCountAcquisition.Authority>
  readonly files?: WorkFileCapability.Interface
  readonly leafProof?: Context.Service.Shape<typeof WorkToolPolicy.LeafProof>
  readonly taskKnownProof?: Context.Service.Shape<typeof WorkTaskKnownProof.Authority>
  readonly browserFiles?: BrowserFileCapability.Interface
  readonly eventPlacement?: Context.Service.Shape<typeof EventWorkPlacement.Service>
}
export class Services extends Context.Service<Services, Installed>()("@deepagent-code/WorkExecutionProfile/Services") {}
export const servicesLayer = (installed: Installed) => Layer.mergeAll(
  Layer.succeed(Services, installed), Layer.succeed(Service, installed.profile),
  installed.eventOperator ? Layer.succeed(LocalOperator.Runtime, installed.eventOperator) : Layer.empty,
  Layer.succeed(WorkAuthority.Verifier, installed.verifier), Layer.succeed(WorkRoutePolicy.Evidence, installed.evidence),
  Layer.succeed(WorkRouteApproval.Authority, installed.approval), Layer.succeed(WorkCountAcquisition.Authority, installed.count),
  installed.files ? Layer.succeed(WorkFileCapability.Service, installed.files) : Layer.empty,
  installed.leafProof ? Layer.succeed(WorkToolPolicy.LeafProof, installed.leafProof) : Layer.empty,
  installed.taskKnownProof ? Layer.succeed(WorkTaskKnownProof.Authority, installed.taskKnownProof) : Layer.empty,
  installed.browserFiles ? Layer.succeed(BrowserFileCapability.Service, installed.browserFiles) : Layer.empty,
  installed.eventPlacement ? Layer.succeed(EventWorkPlacement.Service, installed.eventPlacement) : Layer.empty,
)

/** Prepare native source observations before, never during, a consuming transaction. */
export const prepareSource = Effect.fn("WorkExecutionProfile.prepareSource")(function* (work: WorkAuthority.Work, options?: { readonly fresh?: boolean }) {
  const profile = yield* Effect.serviceOption(Service)
  if (profile._tag === "Some" && profile.value.prepareSource) yield* profile.value.prepareSource(work, options)
})

/** Placement facts are re-read before claim/model and inside the final dispatch transaction.
 * No auto-registration or filesystem fallback may turn a retired/missing scope into authority. */
export const requirePlacement = Effect.fn("WorkExecutionProfile.requirePlacement")(function* (
  db: Pick<Database.Interface["db"], "select">,
  work: WorkAuthority.Work,
): Effect.fn.Return<void, WorkAuthoritySchema.Error> {
  const session = yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, SessionSchema.ID.make(work.session_id)))
    .get().pipe(Effect.orDie)
  const identity = yield* db
    .select({ namespace: SecurityNamespaceTable, project: ProjectScopeIdentityTable, location: LocationIdentityTable })
    .from(LocationIdentityTable)
    .innerJoin(SecurityNamespaceTable, eq(SecurityNamespaceTable.id, LocationIdentityTable.security_namespace_id))
    .innerJoin(
      ProjectScopeIdentityTable,
      and(
        eq(ProjectScopeIdentityTable.security_namespace_id, LocationIdentityTable.security_namespace_id),
        eq(ProjectScopeIdentityTable.project_scope_key, LocationIdentityTable.project_scope_key),
      ),
    )
    .where(
      and(
        eq(
          LocationIdentityTable.security_namespace_id,
          SecurityNamespaceID.make(work.binding.scope.securityNamespaceID),
        ),
        eq(LocationIdentityTable.project_scope_key, ProjectScopeKey.make(work.binding.scope.projectScopeKey)),
        eq(LocationIdentityTable.canonical_root, work.binding.location.directory),
      ),
    )
    .get().pipe(Effect.orDie)
  const child = work.parent_work_id ? yield* Effect.gen(function* () {
    const { WorkDerivedAuthority } = yield* Effect.promise(() => import("./work-derived-authority"))
    const record = yield* WorkDerivedAuthority.get(db, work.work_id).pipe(Effect.mapError((error) =>
      error instanceof WorkAuthoritySchema.Error ? error : new WorkAuthoritySchema.Error({
        code: "WORK_RECOVERY_REQUIRED", message: "Original derived placement could not be verified",
      })))
    if (!record || record.childBindingHash !== work.binding_hash || record.childSessionID !== work.session_id ||
      record.parentWorkID !== work.parent_work_id || record.rootWorkID !== work.root_work_id)
      return yield* new WorkAuthoritySchema.Error({ code: "WORK_BINDING_CONFLICT", message: "Derived child placement has no original grant" })
    return record
  }) : undefined
  if (
    !session ||
    session.parent_id !== (child?.parentSessionID ?? null) ||
    session.metadata !== null ||
    (session.permission?.length ?? 0) !== 0 ||
    session.directory !== work.binding.location.directory ||
    session.workspace_id !== null ||
    work.binding.location.workspaceID !== undefined ||
    session.agent !== work.binding.agentID ||
    session.model?.providerID !== work.binding.provider.providerID ||
    session.model.id !== work.binding.provider.modelID ||
    (session.model.variant !== undefined && session.model.variant !== "default") ||
    !identity ||
    identity.namespace.kind !== "implicit_local" ||
    identity.namespace.retired_at !== null ||
    identity.project.retired_at !== null ||
    identity.location.retired_at !== null ||
    identity.location.workspace_binding !== null ||
    (identity.project.observed_project_id !== null && identity.project.observed_project_id !== session.project_id) ||
    (identity.location.observed_project_id !== null && identity.location.observed_project_id !== session.project_id)
  )
    return yield* new WorkAuthoritySchema.Error({
      code: "WORK_BINDING_CONFLICT",
      message: "Restricted Work has no current immutable registered placement",
    })
})
