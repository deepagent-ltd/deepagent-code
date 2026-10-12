export * as SessionRunnerCanonical from "./canonical-turn"

import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "../../database/database"
import { ContextArtifactStore } from "../../context-federation/artifact-store"
import { SessionProviderAttempt } from "../../context-federation/provider-attempt"
import { SessionProviderOwner } from "../../context-federation/provider-owner"
import { ContextReference, LocationKey, ProjectScopeKey, SecurityNamespaceID } from "../../context-federation/reference"
import { SessionContext } from "../../context-federation/session-context"
import { ContextQueryAuthorization } from "../../context-federation/query-authorization"
import { resolveGraphs, GraphOrder, type QueryEnvelope, type QueryResultV2 } from "../../context-federation/resolver-v2"
import { budgetSelection } from "../../context-federation/selection-budget"
import {
  buildSelectionEnvelope,
  isLegacyIncompleteRow,
  writeSelectionRow,
  assertAttemptBoundSelection,
  type ReleasedKnowledgeIdentity,
} from "../../context-federation/selection-writer"
import { stagedV2Adapters } from "../../context-federation/staged-adapters-v2"
import {
  productionV2Adapters,
  productionAdaptersEnabled,
  ProductionV2Sources,
  type ProductionV2AdapterInput,
  type ProductionV2LocationIdentity,
} from "../../context-federation/production-adapters"
import type { RuntimeFeatureRegistry } from "../../flag/runtime-features"
import { DeepAgentReleasedSnapshot } from "../../deepagent/released-snapshot"
import { SelectionEnvelope, type GraphKind, type GraphStatus, type SelectionQueryIntent, type SelectionRef } from "../../contract/selection"
import {
  SessionActivityInputTable,
  SessionActivityTable,
  SessionContextSelectionTable,
  SessionProviderAttemptTable,
  SessionProviderOwnerLeaseTable,
} from "../../context-federation/session-sql"
import {
  LocationIdentityTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "../../context-federation/sql"
import { SessionSchema } from "../schema"
import { LongContext } from "../long-context"
import { Hash } from "../../util/hash"
import { CanonicalJson } from "../../util/canonical-json"
import { SessionMessage } from "../message"
import { SessionInputTable, SessionMessageTable, SessionTable } from "../sql"
import { WorkAuthority } from "../work-authority"
import { WorkAuthorityPolicy } from "../work-authority-policy"
import { WorkAuthoritySchema } from "../work-authority.schema"
import { WorkToolPolicy } from "../work-tool-policy"
import { V2ProviderTurn } from "./v2-provider-turn"
import { V2ProviderTurnReceiptTable } from "./v2-provider-turn.sql"

// V2 runner turns bind Context Federation authority through the same admission chain as the legacy
// durable runtime (activity -> selection -> validation -> attempt). Since C3-08 the selection is a
// REAL four-graph V2 selection produced by the F1 resolver + F2 writer (never the legacy v2-none
// fallback), so a V2 attempt is always bound to real graph statuses/revisions. W3: the runner
// composition uses the PRODUCTION adapter set (real code/documents/knowledge/memory sources) while
// `DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION` is ON (default), and falls back to the staged
// adapter set (`source_disabled`) only under an explicit `=false`.
export const SelectionLifetimeMs = 14 * 60_000
export const ValidationMs = 60_000

/** Internal continuation scope supplied by the serialized runner, never a persisted grant. */
export const CurrentContinuationActivity = Context.Reference<string | undefined>(
  "SessionRunnerCanonical.CurrentContinuationActivity", { defaultValue: () => undefined },
)

/**
 * opencode upstream port #1 — the durable resume budget (upstream default 10). Counted from the
 * durable attempt rows as the leading run of crash-quarantined attempts (indeterminate_after_crash
 * or the pre-dispatch owner-loss failure) before any other terminal state; a settled attempt
 * resets the run. Bounds quarantine/retry loops without a new migration.
 */
export const MaxConsecutiveCrashResumes = 10

const V2Namespace = ContextReference.SecurityNamespaceID.make("v2:local")
const V2Scope = ContextReference.ProjectScopeKey.make("v2:local")
// L4: the constant is the per-graph QUERY timeout (applies to the production adapters too, not the
// staged set), named for what it is — the previous `StagedPerGraphTimeoutMs` name was misleading.
const PerGraphQueryTimeoutMs = 5_000
const emptyProductionSources: ProductionV2AdapterInput = {}

/** The effective V2 frame identity: the real location-derived identity when the production sources
 * seam carries one, otherwise the `v2:local` degradation identity (no location context). The
 * envelope/principal/scope/released picker all use this single value, so a real frame authorizes
 * the real refs and the fallback reproduces the pre-W3.8 semantics (the envelope's scope values
 * are the v2:local constants; the contract now also carries `projectId: "v2:local"`, which the
 * adapters already fell back to via `projectScopeKey`). */
type EffectiveFrameIdentity = {
  readonly securityNamespaceId: SecurityNamespaceID
  readonly locationKey: LocationKey
  readonly projectScopeKey: ProjectScopeKey
  readonly legacyProjectId: string
}

function effectiveFrameIdentity(
  identity: ProductionV2LocationIdentity | undefined,
  locationKey: LocationKey,
): EffectiveFrameIdentity {
  return identity === undefined
    ? { securityNamespaceId: V2Namespace, locationKey, projectScopeKey: V2Scope, legacyProjectId: V2Scope }
    : {
        securityNamespaceId: identity.securityNamespaceId,
        locationKey: identity.locationKey,
        projectScopeKey: identity.projectScopeKey,
        legacyProjectId: identity.legacyProjectId,
      }
}

// §16.3 order 4 package D — the legacy federation selection evidence seam is DELETED by C3-08.
// A V2 turn no longer copies legacy evidence (or the v2-none fallback) into the selection; the
// selection is produced by the F1 resolver + F2 writer and always carries real graph statuses.
// TaggedErrorClass leaves Error.message empty, so every log/print surface that renders
// `error.message` (server error log, SSE error parts, CLI) showed a bare class name with no
// reason — F-18's "empty reason" symptom. Carry the reason in the message itself.
export class AdmissionError extends Schema.TaggedErrorClass<AdmissionError>()(
  "SessionRunnerCanonical.AdmissionError",
  {
    reason: Schema.String,
  },
) {
  constructor(props: { readonly reason: string }) {
    super(props)
    this.message = props.reason
  }
}

export type SystemSnapshot = {
  readonly baseline: string
  readonly revision: number
  readonly baselineSeq: number
}

export type SelectionAdmission = {
  readonly activityId: string
  readonly selectionId: string
  readonly projectionHash: string
  readonly authorizationEpoch: number
  readonly egressEpoch: number
  readonly observedLocationMutationEpoch: number
  readonly selectedSourceFingerprint: string
  readonly nextRevalidationAt: number
  readonly readiness?: "ready" | "fallback" | "unavailable"
  readonly selectedRefs?: readonly string[]
}

export type AdmitSelectionInput = {
  readonly db: Database.Interface["db"]
  readonly contexts: SessionContext.Interface
  readonly sessionID: SessionSchema.ID
  readonly agent: string
  readonly location: { readonly directory: string; readonly workspaceID?: string }
  // Promoted inputs for this wake, in admitted_seq order; the first one triggers the activity.
  readonly promotedInputIds: readonly string[]
  // Durable identity of the surrounding turn (last promoted user input) used to reopen or lazily
  // create the canonical activity for continuation turns without a fresh promotion.
  readonly fallbackUserInputId?: string
  readonly system: SystemSnapshot
  readonly historyEndMessageId?: string
  /** Force one post-checkpoint successor; reuse it on exact retry instead of churning revisions. */
  readonly refreshAfterSelectionID?: string
  readonly model?: {
    readonly id: string
    readonly providerID: string
    readonly protocol: SelectionEnvelope["modelCapability"]["protocol"]
    readonly contextWindow?: number
    readonly structuredOutput: boolean
  }
  /** Location-scoped production sources captured by the runner at layer construction. Direct
   * callers may omit this and provide the seam in their Effect environment. */
  readonly sources?: ProductionV2AdapterInput
  /** Process-local query authority captured by the runner alongside the source frame. */
  readonly queryAuthorization?: ContextQueryAuthorization.ControllerInterface
  /** Runtime feature registry the W3.1 adapter gate reads; the runner captures its composition's
   * registry at layer construction. Omitted = the process-start global (the `=false` kill-switch
   * resolves at process start, so tests inject an explicit registry instead of flipping env). */
  readonly runtimeFeatures?: RuntimeFeatureRegistry
  /**
   * L1 — selection query intent seam. The V2 core prompt admission carries no per-input intent
   * signal yet (the session input/Prompt shapes have none), so the runner leaves this unset and the
   * envelope uses the `"search"` default; a caller with a real intent (classifier or host prompt
   * metadata) passes it here and it reaches the resolver/adapter `intentFor` mapping.
   */
  readonly queryIntent?: SelectionQueryIntent
  readonly now?: number
}

export const admitSelection = Effect.fn("SessionRunnerCanonical.admitSelection")(function* (
  input: AdmitSelectionInput,
) {
  return yield* Effect.gen(function* () {
    const now = input.now ?? Date.now()
    const locationKey = `${input.location.directory}#${input.location.workspaceID ?? ""}`
    const sources =
      input.sources ??
      (yield* Effect.serviceOption(ProductionV2Sources).pipe(
        Effect.map((option) => Option.getOrElse(option, () => emptyProductionSources)),
      ))
    // W3.8 A — the frame identity: real (location-derived, host seam) or the v2:local degradation.
    // The same identity seeds the guard chain and builds the envelope, so the selection row and the
    // envelope never disagree about the frame.
    const frame = effectiveFrameIdentity(sources.identity, LocationKey.make(locationKey))
    yield* ensureLocationIdentity(input.db, frame, now)
    const activity = yield* admitActivity(input, now)
    const selection = yield* selectContext(input, activity, now, frame)
    const authorization =
      input.queryAuthorization ??
      Option.getOrUndefined(yield* Effect.serviceOption(ContextQueryAuthorization.Controller))
    if (authorization !== undefined) {
      yield* authorization.bind({
        sessionId: input.sessionID,
        envelope: queryAuthorization(input, frame, {
          authorizationEpoch: selection.authorizationEpoch,
          egressEpoch: selection.egressEpoch,
        }),
      })
    }
    return {
      activityId: activity.activityId,
      selectionId: selection.selectionId,
      projectionHash: selection.projectionHash,
      authorizationEpoch: selection.authorizationEpoch,
      egressEpoch: selection.egressEpoch,
      observedLocationMutationEpoch: selection.observedLocationMutationEpoch,
      selectedSourceFingerprint: selection.selectedSourceFingerprint,
      nextRevalidationAt: selection.nextRevalidationAt,
      readiness: selection.readiness,
      selectedRefs: selection.selectedRefs,
    }
  }).pipe(
    Effect.catch((error) => (isContextError(error) ? Effect.fail(toAdmission(error)) : Effect.fail(error))),
  )
})

/** Restricted admission shares the canonical activity and selection writers. It never registers
 * a missing identity or loads the ordinary system/history/production graph sources. Promotion is
 * owned by the existing runner: this entry requires the one audited input already be promoted.
 * Retrieval remains unavailable by policy; that does NOT mean the fixed instructions/text are
 * missing. The caller must not append graph evidence to those fixed instructions. */
export const admitRestrictedSelection = Effect.fn("SessionRunnerCanonical.admitRestrictedSelection")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly contexts: SessionContext.Interface
  readonly sessionID: SessionSchema.ID
  readonly workID: string
  readonly expectedRevision: number
}) {
  const bound = yield* WorkAuthority.lookupSession(input.db, input.sessionID)
  if (bound.kind === "bound" && bound.work.binding.schemaVersion === "work-execution.v2") {
    yield* WorkToolPolicy.preparePrevious(input.db, input.sessionID)
    // Authenticating cold native outcomes may outlive the short source observation. Reobserve
    // only after all external preparation; the immediate SQL fence consumes that same witness.
    const { WorkExecutionProfile } = yield* Effect.promise(() => import("../work-execution-profile"))
    yield* WorkExecutionProfile.prepareSource(bound.work, { fresh: true })
  }
  return yield* input.db.transaction(
    (tx) =>
      Effect.gen(function* () {
        // Effect SQLite uses a fiber-local transaction connection, so requireContext's nested
        // transaction, captured contexts.openActivity and writeSelectionRow share this outer fence.
        const work = yield* WorkAuthority.requireContext(input.db, { sessionID: input.sessionID })
        if (!work)
          return yield* new WorkAuthoritySchema.Error({
            code: "WORK_AUTHORITY_MISSING",
            message: "Restricted selection requires durable Work authority",
          })
        if (work.work_id !== input.workID || work.control_revision !== input.expectedRevision)
          return yield* new WorkAuthoritySchema.Error({
            code: "WORK_CONTROL_CONFLICT",
            message: "Restricted selection Work identity or revision changed",
          })
        if (work.binding.location.workspaceID !== undefined)
          return yield* new WorkAuthoritySchema.Error({
            code: "PROFILE_UNAVAILABLE",
            message: "Restricted selection currently requires registered implicit-local placement",
          })
        const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get()
        const admitted = yield* tx
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, SessionMessage.ID.make(work.input_id)))
          .get()
        const parent = work.parent_work_id ? yield* Effect.gen(function* () {
          const { WorkDerivedAuthority } = yield* Effect.promise(() => import("../work-derived-authority"))
          yield* WorkDerivedAuthority.requireCurrent(tx, work)
          return yield* WorkDerivedAuthority.get(tx, work.work_id)
        }) : undefined
        if (
          !session ||
          session.parent_id !== (parent?.parentSessionID ?? null) ||
          session.metadata !== null ||
          (session.permission?.length ?? 0) !== 0 ||
          !admitted ||
          admitted.promoted_seq === null
        )
          return yield* new WorkAuthoritySchema.Error({
            code: "WORK_BINDING_CONFLICT",
            message: "Restricted Session or promoted input is unavailable",
          })
        yield* WorkAuthority.bindInputInTransaction(tx, {
          workID: work.work_id,
          sessionID: input.sessionID,
          inputID: work.input_id,
          promptHash: work.binding.auditedText.hash,
          admittedSeq: admitted.admitted_seq,
          expectedRevision: input.expectedRevision,
        })
        const message = yield* tx
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, admitted.id))
          .get()
        const projected = message
          ? Schema.decodeUnknownOption(SessionMessage.User, { onExcessProperty: "error" })({
              ...message.data,
              id: message.id,
              type: message.type,
            })
          : Option.none()
        const inputs = yield* tx
          .select({ id: SessionInputTable.id })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, input.sessionID))
          .limit(2)
          .all()
        const messages = yield* tx
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, input.sessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .limit(work.binding.schemaVersion === "work-execution.v2" ? 34 : 2)
          .all()
        if (
          !message ||
          message.session_id !== input.sessionID ||
          message.seq !== admitted.promoted_seq ||
          Option.isNone(projected) ||
          projected.value.text !== admitted.prompt.text ||
          !Object.keys(message.data).every((key) => ["text", "time", "agent", "model"].includes(key)) ||
          projected.value.agent !== admitted.prompt.agent ||
          CanonicalJson.stringify(projected.value.model ?? null) !==
            CanonicalJson.stringify(admitted.prompt.model ?? null) ||
          inputs.length !== 1 ||
          (work.binding.schemaVersion === "work-execution.v1" ? messages.length !== 1
            : messages.length > 33 || messages[0]?.id !== admitted.id ||
              messages.slice(1).some((row) => row.type !== "assistant"))
        )
          return yield* new WorkAuthoritySchema.Error({
            code: "WORK_BINDING_CONFLICT",
            message: "Restricted selection requires exactly the audited promoted user text",
          })
        const previous = yield* WorkToolPolicy.previous(tx, work)
        if (work.binding.schemaVersion === "work-execution.v2" &&
          messages.length !== (previous?.receipt.provider_turn_seq ?? 0) + 1)
          return yield* new WorkAuthoritySchema.Error({ code: "WORK_BINDING_CONFLICT",
            message: "Project history has no complete authenticated predecessor chain" })
        const identity = yield* tx
          .select({
            namespace: SecurityNamespaceTable,
            project: ProjectScopeIdentityTable,
            location: LocationIdentityTable,
          })
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
          .get()
        if (
          !identity ||
          identity.namespace.kind !== "implicit_local" ||
          identity.namespace.retired_at !== null ||
          identity.project.retired_at !== null ||
          identity.location.retired_at !== null ||
          identity.location.workspace_binding !== null ||
          (identity.project.observed_project_id !== null &&
            identity.project.observed_project_id !== session.project_id) ||
          (identity.location.observed_project_id !== null &&
            identity.location.observed_project_id !== session.project_id) ||
          (work.binding.schemaVersion === "work-execution.v2" &&
            (work.binding.projectScope.projectID !== session.project_id ||
              work.binding.projectScope.locationKey !== identity.location.location_key ||
              work.binding.projectScope.namespaceBindingHash !== identity.namespace.binding_hash))
        )
          return yield* new WorkAuthoritySchema.Error({
            code: "WORK_BINDING_CONFLICT",
            message: "Restricted selection scope has no current registered Location identity",
          })
        const protocol = restrictedProtocol(work.binding.provider.protocol)
        if (protocol === undefined)
          return yield* new WorkAuthoritySchema.Error({
            code: "PROFILE_UNAVAILABLE",
            message: "Restricted selection protocol is unavailable",
          })
        const now = Date.now()
        const activity = yield* input.contexts.openActivity({
          sessionId: input.sessionID,
          triggerInputId: admitted.id,
          now,
        })
        const members = yield* tx
          .select()
          .from(SessionActivityInputTable)
          .where(eq(SessionActivityInputTable.activity_id, activity.activityId))
          .all()
        if (
          activity.triggerInputId !== admitted.id ||
          activity.state !== "active" ||
          members.length !== 1 ||
          members[0]?.input_id !== admitted.id
        )
          return yield* new WorkAuthoritySchema.Error({
            code: "WORK_BINDING_CONFLICT",
            message: "Restricted activity membership differs from its single audited input",
          })
        const profile = WorkAuthorityPolicy.profileFor(work.binding.profile)
        if (!profile)
          return yield* new WorkAuthoritySchema.Error({
            code: "WORK_BINDING_CONFLICT",
            message: "Restricted instructions require the verified execution profile",
          })
        const instructions = profile.instructions
        const historyHash = Hash.sha256(CanonicalJson.stringify(messages))
        const queryFingerprint = Hash.sha256(
          CanonicalJson.stringify({
            profileHash: work.binding.profile.hash,
            instructions,
            inputID: admitted.id,
            text: admitted.prompt.text,
            ...(work.binding.schemaVersion === "work-execution.v2" ? { historyHash } : {}),
          }),
        )
        const authorizationFingerprint = Hash.sha256(
          CanonicalJson.stringify({
            workID: work.work_id,
            bindingHash: work.binding_hash,
            controlRevision: work.control_revision,
            sourceRecordHash: work.source_record_hash,
            scope: work.binding.scope,
          }),
        )
        const executionFingerprint = Hash.sha256(
          CanonicalJson.stringify({
            queryFingerprint,
            authorizationFingerprint,
            locationKey: identity.location.location_key,
            provider: work.binding.provider,
          }),
        )
        const envelope: QueryEnvelope = {
          membership: { sessionId: input.sessionID, activityId: activity.activityId, inputIds: [admitted.id] },
          location: { locationKey: identity.location.location_key },
          principal: {
            principalId: work.binding.scope.actorID,
            securityNamespaceId: SecurityNamespaceID.make(identity.namespace.id),
            authorizationEpoch: work.control_revision,
            locationKeys: [LocationKey.make(identity.location.location_key)],
            projectScopeKeys: [ProjectScopeKey.make(identity.project.project_scope_key)],
            sessionIds: [input.sessionID],
            subjectIds: [],
            allowBuiltin: false,
          },
          workspace: { workspaceId: work.binding.scope.workspaceID },
          securityNamespace: { securityNamespaceId: identity.namespace.id },
          projectScope: { projectScopeKey: identity.project.project_scope_key, projectId: session.project_id },
          egress: {
            policyId: `work:${work.binding.profile.hash}`,
            epoch: work.control_revision,
            graphs: [],
            sensitivities: [],
          },
          agentPolicy: { agentId: work.binding.agentID, autonomyCeiling: "low", permitDegraded: false },
          modelCapability: {
            modelId: work.binding.provider.modelID,
            providerId: work.binding.provider.providerID,
            protocol,
            structuredOutput: false,
          },
          releasedKnowledge: { snapshotId: "", binding: "unavailable" },
          queryIntent: "explain_decision",
          query: queryFingerprint,
          observedLocationMutationEpoch: 0,
        }
        const graphStatuses = Object.fromEntries(
          GraphOrder.map((graph) => [
            graph,
            {
              graph,
              status: "denied" as const,
              revision: work.binding.profile.hash,
              adapterVersion: work.binding.schemaVersion === "work-execution.v2" ? "work-project-selection.v1" : "work-text-only-selection.v1",
              observedMutationEpoch: 0,
              latencyMs: 0,
              candidateCount: 0,
              rejectedCount: 0,
              reasonCode: "agent_policy_denied" as const,
            },
          ]),
        ) as QueryResultV2["graphStatuses"]
        const resolved: QueryResultV2 = {
          queryFingerprint,
          authorizationFingerprint,
          executionFingerprint,
          membership: envelope.membership,
          location: envelope.location,
          graphStatuses,
          results: [],
          candidates: [],
          successorRebuild: undefined,
          truncated: false,
          truncatedCount: 0,
        }
        const selection = buildSelectionEnvelope(budgetSelection(resolved, envelope), resolved, envelope, {
          revision: previous?.receipt.provider_turn_seq ?? 0,
          triggerInputId: admitted.id,
          providerTurnSeq: previous?.receipt.provider_turn_seq ?? 0,
          now,
          validUntil: Math.min(
            now + ValidationMs,
            work.binding.deadline,
            work.created_at + work.binding.budget.maxDurationMs,
          ),
        })
        // Recheck deadline and trusted authority immediately before writing; a failed check
        // rolls back the activity too. No production source callback runs in this transaction.
        yield* WorkAuthority.requireContext(input.db, { sessionID: input.sessionID })
        const written = yield* writeSelectionRow(input.db, selection, now)
        if (written.conflict || written.selectionId !== selection.selectionId)
          return yield* new WorkAuthoritySchema.Error({
            code: "WORK_BINDING_CONFLICT",
            message: "Restricted selection slot already contains different evidence",
          })
        const stored = yield* tx
          .select({ nextRevalidationAt: SessionContextSelectionTable.next_revalidation_at })
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, written.selectionId))
          .get()
        if (!stored)
          return yield* new WorkAuthoritySchema.Error({
            code: "WORK_BINDING_CONFLICT",
            message: "Restricted selection was not persisted",
          })
        // tokenCount=0 describes selected graph refs only. It is NEVER an input-token bound.
        return {
          admission: {
            activityId: activity.activityId,
            selectionId: written.selectionId,
            projectionHash: selection.projectionHash,
            authorizationEpoch: work.control_revision,
            egressEpoch: work.control_revision,
            observedLocationMutationEpoch: 0,
            selectedSourceFingerprint: selection.identity.selectedSourceFingerprint,
            nextRevalidationAt: stored.nextRevalidationAt,
            readiness: "unavailable" as const,
            selectedRefs: [] as readonly string[],
          },
          workID: work.work_id,
          controlRevision: work.control_revision,
          bindingHash: work.binding_hash,
          inputID: admitted.id,
          auditedText: admitted.prompt.text,
          instructions,
          profileHash: work.binding.profile.hash,
          historyHash,
          history: messages,
          predecessor: previous,
        }
      }),
    { behavior: "immediate" },
  )
})

function restrictedProtocol(protocol: string): SelectionEnvelope["modelCapability"]["protocol"] | undefined {
  if (protocol === "openai-responses") return "openai.responses"
  if (protocol === "openai-chat") return "openai-compatible.chat"
  if (protocol === "anthropic-messages") return "anthropic.messages"
  return undefined
}

function admitActivity(input: AdmitSelectionInput, now: number) {
  return Effect.gen(function* () {
    const expected = yield* CurrentContinuationActivity
    if (expected !== undefined) {
      const original = yield* input.db.select().from(SessionActivityTable).where(and(
        eq(SessionActivityTable.activity_id, expected),
        eq(SessionActivityTable.session_id, input.sessionID),
        eq(SessionActivityTable.state, "active"),
      )).get().pipe(Effect.orDie)
      if (!original) return yield* new AdmissionError({ reason: "continuation_activity_obsolete" })
      yield* input.contexts.attachInputs({ activityId: expected, inputIds: input.promotedInputIds, now })
        .pipe(Effect.mapError(() => new AdmissionError({ reason: "continuation_activity_obsolete" })))
      return { activityId: expected, triggerInputId: original.trigger_input_id }
    }
    return yield* admitOrdinaryActivity(input, now)
  })
}

function admitOrdinaryActivity(input: AdmitSelectionInput, now: number) {
  const triggerInputId = input.promotedInputIds[0]
  if (triggerInputId !== undefined) {
    return input.contexts
      .openActivity({ sessionId: input.sessionID, triggerInputId, now })
      .pipe(
        // openActivity already attaches the trigger input (any delivery); only the remaining
        // promoted steers are attached afterwards — queue inputs may only ever be triggers.
        Effect.tap((opened) =>
          input.contexts.attachInputs({
            activityId: opened.activityId,
            inputIds: input.promotedInputIds.filter((id) => id !== opened.triggerInputId),
            now,
          }),
        ),
        Effect.mapError((error) => new AdmissionError({ reason: `activity_admission_failed:${contextErrorDetail(error)}` })),
        Effect.map((opened) => ({ activityId: opened.activityId, triggerInputId: opened.triggerInputId })),
      )
  }
  return Effect.gen(function* () {
    const active = yield* input.db
      .select()
      .from(SessionActivityTable)
      .where(and(eq(SessionActivityTable.session_id, input.sessionID), eq(SessionActivityTable.state, "active")))
      .get()
      .pipe(Effect.orDie)
    if (active) return { activityId: active.activity_id, triggerInputId: active.trigger_input_id }
    if (input.fallbackUserInputId === undefined)
      return yield* new AdmissionError({ reason: "canonical_activity_unavailable" })
    const opened = yield* input.contexts
      .openActivity({ sessionId: input.sessionID, triggerInputId: input.fallbackUserInputId, now })
      .pipe(
        Effect.mapError((error) => new AdmissionError({ reason: `activity_admission_failed:${contextErrorDetail(error)}` })),
      )
    return { activityId: opened.activityId, triggerInputId: opened.triggerInputId }
  })
}

// V2 selections live in a dedicated namespace frame. The selection insert guard requires the
// namespace/scope/location identity chain to exist and stay unretired, so ensure it idempotently
// (per-id onConflictDoNothing: when the host already resolved the identity through
// `LocationIdentity.resolve`, those rows win; this seed only covers a bare-core / test frame).
function ensureLocationIdentity(db: Database.Interface["db"], frame: EffectiveFrameIdentity, now: number) {
  return Effect.gen(function* () {
    yield* db
      .insert(SecurityNamespaceTable)
      .values({
        id: frame.securityNamespaceId,
        kind: "implicit_local",
        binding_hash: Hash.sha256(frame.securityNamespaceId),
        created_at: now,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(ProjectScopeIdentityTable)
      .values({
        security_namespace_id: frame.securityNamespaceId,
        project_scope_key: frame.projectScopeKey,
        project_kind: "registered_root",
        project_identity_hash: Hash.sha256(`${frame.securityNamespaceId}:${frame.projectScopeKey}`),
        observed_project_id: frame.legacyProjectId,
        created_at: now,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(LocationIdentityTable)
      .values({
        security_namespace_id: frame.securityNamespaceId,
        location_key: frame.locationKey,
        project_scope_key: frame.projectScopeKey,
        canonical_root: String(frame.locationKey),
        observed_project_id: frame.legacyProjectId,
        created_at: now,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
}

function selectContext(
  input: AdmitSelectionInput,
  activity: { readonly activityId: string; readonly triggerInputId: string },
  now: number,
  frame: EffectiveFrameIdentity,
) {
  return Effect.gen(function* () {
    const latest = yield* input.db
      .select()
      .from(SessionContextSelectionTable)
      .where(
        and(
          eq(SessionContextSelectionTable.session_id, input.sessionID),
          eq(SessionContextSelectionTable.activity_id, activity.activityId),
        ),
      )
      .orderBy(desc(SessionContextSelectionTable.revision))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    // Reuse an existing V2 selection for this activity (exact-retry/continuation): ONLY a real V2
    // selection is dispatchable. A legacy_incomplete row (C3-08 read-side marking) stays readable
    // for history but is NOT reusable for a new dispatch — build a V2 successor instead.
    if (latest && !isLegacyIncompleteRow(latest) && latest.selection_id !== input.refreshAfterSelectionID)
      return yield* admissionFromRow(latest, activity, input, now)
    const revision = latest ? latest.revision + 1 : 0
    return yield* buildV2Selection(input, activity, now, frame, revision)
  })
}

/** Derive the selection admission from an existing V2 selection row (read-only reuse). */
function admissionFromRow(
  row: typeof SessionContextSelectionTable.$inferSelect,
  activity: { readonly activityId: string },
  input: AdmitSelectionInput,
  now: number,
): Effect.Effect<SelectionAdmission, AdmissionError> {
  return Effect.gen(function* () {
    const graphStatuses = Schema.decodeUnknownOption(Schema.fromJsonString(SelectionEnvelope.fields.graphStatuses))(
      row.graph_statuses,
    )
    const selectedRefs = Schema.decodeUnknownOption(Schema.fromJsonString(SelectionEnvelope.fields.selectedRefs))(
      row.selected_refs,
    )
    if (Option.isNone(graphStatuses) || Option.isNone(selectedRefs))
      return yield* new AdmissionError({ reason: "stored_selection_evidence_invalid" })
    return {
      activityId: activity.activityId,
      selectionId: row.selection_id,
      projectionHash: row.projection_hash,
      authorizationEpoch: row.authorization_epoch,
      egressEpoch: input.system.baselineSeq,
      observedLocationMutationEpoch: row.observed_location_mutation_epoch,
      selectedSourceFingerprint: row.selected_source_fingerprint,
      nextRevalidationAt: row.next_revalidation_at,
      readiness: readinessOf(graphStatuses.value),
      selectedRefs: selectedRefs.value.map((ref) => ref.ref),
    }
  })
}

/**
 * C3-08 — build a REAL V2 selection (never v2-none) through the F1 resolver-v2 + F2 selection-budget
 * + selection-writer flow, write the selection row, and derive the admission. W3.1: the resolver is
 * fed the PRODUCTION adapter set (`productionV2Adapters`) while the W0.1 flag
 * `DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION` is ON (single flip-flag table, default ON); `=false`
 * falls back to the staged adapter set (existing explicit degraded_unavailable behavior). W3.3: a
 * `successorRebuild` signal is consumed — a `released_snapshot_drift` re-binds the released snapshot
 * and re-resolves once (a release happened between the bind and the resolve); any remaining signal
 * fails with `selection_rebuild_required:<trigger>` under the existing AdmissionError semantics
 * (the caller's rebuild path owns the turn rebuild).
 */
function buildV2Selection(
  input: AdmitSelectionInput,
  activity: { readonly activityId: string; readonly triggerInputId: string },
  now: number,
  frame: EffectiveFrameIdentity,
  revision: number,
): Effect.Effect<SelectionAdmission, AdmissionError> {
  const inputs = activityInputIds(input, activity.activityId)
  return Effect.gen(function* () {
    const ids = yield* inputs
    const sources =
      input.sources ??
      (yield* Effect.serviceOption(ProductionV2Sources).pipe(
        Effect.map((option) => Option.getOrElse(option, () => emptyProductionSources)),
      ))
    const resolveOnce = Effect.fn("SessionRunnerCanonical.resolveOnce")(function* () {
      const current = yield* currentReleasedSelection(sources, frame)
      const releasedBinding = {
        snapshotId: current?.snapshotId ?? "",
        binding: current ? ("bound" as const) : ("unavailable" as const),
        current: releasedPicker(sources),
      }
      const adapters = productionAdaptersEnabled(input.runtimeFeatures)
        ? productionV2Adapters({
            ...sources,
            ...(sources.knowledge ? { knowledge: { stores: sources.knowledge.stores, released: releasedBinding } } : {}),
          })
        : stagedV2Adapters()
      const envelope = buildV2Envelope(input, activity, ids, frame, now, current)
      const resolved = yield* resolveGraphs(envelope, adapters, PerGraphQueryTimeoutMs)
      return { resolved, envelope, current }
    })
    const first = yield* resolveOnce()
    // W3.3: a released-snapshot drift re-binds the CURRENT snapshot and re-resolves ONCE; the
    // rebinding is a fresh envelope (+ fresh adapter binding), so the second resolution observes the
    // post-release authority. All other signals (authorization/location epoch drift) are consumed by
    // failing the admission — the turn-rebuild path of the caller owns the successor.
    const second =
      first.resolved.successorRebuild?.trigger === "released_snapshot_drift"
        ? yield* resolveOnce()
        : first
    const { resolved, envelope, current } = second
    if (resolved.successorRebuild !== undefined) {
      return yield* new AdmissionError({ reason: `selection_rebuild_required:${resolved.successorRebuild.trigger}` })
    }
    const denied = Object.values(resolved.graphStatuses).find((status) => status.status === "denied")
    if (denied) return yield* new AdmissionError({ reason: `selection_denied:${denied.graph}:${denied.reasonCode}` })
    const batch = budgetSelection(resolved, envelope)
    const selectionEnvelope = buildSelectionEnvelope(batch, resolved, envelope, {
      revision,
      triggerInputId: activity.triggerInputId,
      providerTurnSeq: 0,
      now,
      ...(current === undefined ? {} : { releasedKnowledgeIdentity: releasedKnowledgeIdentityOf(current) }),
    })
    const written = yield* writeSelectionRow(input.db, selectionEnvelope, now).pipe(
      Effect.mapError((error) => new AdmissionError({ reason: `selection_commit_failed:${selectionErrorDetail(error)}` })),
    )
    if (written.conflict && !selectionRowsEqual(written.selectionId, selectionEnvelope.selectionId)) {
      // A different selection already owns this (session, activity, revision) slot. Build a
      // successor at the next revision so the attempt binds THIS turn's selection (design §6.4).
      const successor = buildSelectionEnvelope(batch, resolved, envelope, {
        revision: revision + 1,
        triggerInputId: activity.triggerInputId,
        providerTurnSeq: 0,
        now,
        ...(current === undefined ? {} : { releasedKnowledgeIdentity: releasedKnowledgeIdentityOf(current) }),
      })
      const successorWritten = yield* writeSelectionRow(input.db, successor, now).pipe(
        Effect.mapError((error) => new AdmissionError({ reason: `selection_commit_failed:${selectionErrorDetail(error)}` })),
      )
      return admissionOf(successorWritten.selectionId, successor, input, activity, now)
    }
    return admissionOf(written.selectionId, selectionEnvelope, input, activity, now)
  })
}

/** The production released-snapshot picker (bounded: a missing picker is simply not bound). */
function releasedPicker(
  sources: ProductionV2AdapterInput,
): (scope: DeepAgentReleasedSnapshot.Scope) => Effect.Effect<DeepAgentReleasedSnapshot.Selection | undefined, unknown> {
  return sources.knowledge?.released?.current ?? (() => Effect.succeed(undefined))
}

/** Resolve-time current released snapshot for the V2 envelope frame (best-effort). */
function currentReleasedSelection(
  sources: ProductionV2AdapterInput,
  frame: EffectiveFrameIdentity,
): Effect.Effect<DeepAgentReleasedSnapshot.Selection | undefined> {
  const scope = {
    securityNamespaceId: frame.securityNamespaceId,
    projectScopeKey: frame.projectScopeKey,
    legacyProjectId: frame.legacyProjectId,
  }
  return releasedPicker(sources)(scope).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.map((value) => value ?? undefined),
  )
}

/** W3.4 — runtime released-knowledge identity for the bound selection row (contract unchanged). */
function releasedKnowledgeIdentityOf(selection: DeepAgentReleasedSnapshot.Selection): ReleasedKnowledgeIdentity {
  return {
    generation: selection.generation,
    membershipHash: selection.membershipHash,
    manifestHash: selection.manifestHash,
    exactRefs: selection.documents,
    exactRefsFingerprint: DeepAgentReleasedSnapshot.exactRefsFingerprint(selection.documents),
  }
}

/**
 * W3.6 — compact, bounded selection graph evidence for the model-visible system tail: per-graph
 * status + revision summary and the selected refs (tokens) e.g. used by `llm.ts` after admission.
 * A missing row or unreadable JSON yields `undefined` (no evidence), and the rendered evidence is
 * bounded by `EvidenceByteBudget` (L2) so the tail can never blow the request context. The one DB
 * read is `Effect.orDie` like every other runner read: a storage fault is a defect, NOT a typed
 * "undefined" — this function never lets a DB error masquerade as missing evidence.
 */
export const EvidenceByteBudget = 4 * 1024

export const selectionGraphEvidence = Effect.fn("SessionRunnerCanonical.selectionGraphEvidence")(function* (
  db: Database.Interface["db"],
  selectionId: string,
) {
  const row = yield* db
    .select()
    .from(SessionContextSelectionTable)
    .where(eq(SessionContextSelectionTable.selection_id, selectionId))
    .get()
    .pipe(Effect.orDie)
  if (row === undefined) return yield* Effect.succeed(undefined)
  let statuses: Readonly<Record<GraphKind, GraphStatus & { readonly rejectedCount?: number }>>
  try {
    statuses = JSON.parse(row.graph_statuses) as Readonly<Record<GraphKind, GraphStatus & { readonly rejectedCount?: number }>>
  } catch {
    return undefined
  }
  const decodedRefs = Schema.decodeUnknownOption(Schema.fromJsonString(SelectionEnvelope.fields.selectedRefs))(row.selected_refs)
  const refs: readonly SelectionRef[] = Option.isSome(decodedRefs) ? decodedRefs.value : []
  return renderGraphEvidence({ graphStatuses: statuses, selectedRefs: refs })
})

/** Pure renderer shared by the durable read and the four-source request-evidence oracle. */
export function renderGraphEvidence(input: {
  readonly graphStatuses: Readonly<Record<GraphKind, GraphStatus & { readonly rejectedCount?: number }>>
  readonly selectedRefs: readonly SelectionRef[]
}): string {
  const graphLines = GraphOrder.map((graph) => {
    const status = input.graphStatuses[graph]
    if (status === undefined) return `- ${graph}: n/a`
    const revision = status.revision.length === 0 ? "" : ` [rev ${status.revision.slice(0, 48)}]`
    const adapterVersion = typeof status.adapterVersion === "string" ? status.adapterVersion.slice(0, 48) : "unknown"
    const rejected = status.rejectedCount !== undefined && status.rejectedCount > 0
      ? ` (${status.rejectedCount} rejected)`
      : ""
    return `- ${graph}: ${status.status}${revision} [adapter version ${adapterVersion}]${rejected} (${status.candidateCount} refs)`
  })
  // L2 — total evidence byte budget (4 KB). Keep each ref and provenance exact when rendered;
  // omit whole entries that do not fit rather than truncate an identity into a false reference.
  const lines: string[] = ["Context selection (this turn):", ...graphLines]
  let budgetUsed = bytesOf(lines.join("\n"))
  const refs = input.selectedRefs
  const tailReserve = bytesOf(`\nSelected refs:\n(and ${refs.length} more refs)`)
  const rendered: string[] = []
  for (const ref of refs) {
    if (rendered.length >= 8) break
    const line = `- ${ref.graph} ${JSON.stringify(ref.token.slice(0, 120))} version=${JSON.stringify(ref.version ?? "degraded_unavailable")} ref=${JSON.stringify(ref.ref)} provenance_refs=${ref.provenanceRefs?.length ? JSON.stringify(ref.provenanceRefs) : "degraded_unavailable"}`
    if (budgetUsed + bytesOf(line) + 1 + tailReserve > EvidenceByteBudget) break
    rendered.push(line)
    budgetUsed += bytesOf(line) + 1
  }
  if (rendered.length > 0) lines.push("Selected refs:", ...rendered)
  const remaining = refs.length - rendered.length
  if (remaining > 0) lines.push(`(and ${remaining} more refs)`)
  return lines.join("\n")
}

function bytesOf(value: string): number {
  return new TextEncoder().encode(value).length
}

function admissionOf(
  selectionId: string,
  envelope: SelectionEnvelope,
  input: AdmitSelectionInput,
  activity: { readonly activityId: string },
  now: number,
): SelectionAdmission {
  return {
    activityId: activity.activityId,
    selectionId,
    projectionHash: envelope.projectionHash,
    authorizationEpoch: envelope.principal.authorizationEpoch,
    egressEpoch: envelope.egress.epoch,
    observedLocationMutationEpoch: envelope.identity.observedLocationMutationEpoch,
    selectedSourceFingerprint: envelope.identity.selectedSourceFingerprint,
    nextRevalidationAt: envelope.validation.validUntil,
    readiness: readinessOf(envelope.graphStatuses),
    selectedRefs: envelope.selectedRefs.map((ref) => ref.ref),
  }
}

function readinessOf(graphStatuses: SelectionEnvelope["graphStatuses"]): SelectionAdmission["readiness"] {
  const available = Object.values(graphStatuses).filter(
    (status) => status.status === "ready" || status.status === "empty",
  ).length
  if (available === 0) return "unavailable"
  return available === Object.keys(graphStatuses).length ? "ready" : "fallback"
}

/** Build the F1 resolver QueryEnvelope for a V2 runner turn under the effective frame identity. */
function buildV2Envelope(
  input: AdmitSelectionInput,
  activity: { readonly activityId: string; readonly triggerInputId: string },
  inputIds: readonly string[],
  frame: EffectiveFrameIdentity,
  now: number,
  released?: DeepAgentReleasedSnapshot.Selection,
): QueryEnvelope {
  const authorization = queryAuthorization(input, frame)
  return {
    membership: { sessionId: input.sessionID, activityId: activity.activityId, inputIds },
    location: { locationKey: frame.locationKey, ...(input.location.workspaceID === undefined ? {} : { workspaceId: input.location.workspaceID }) },
    principal: authorization.principal,
    workspace: { workspaceId: input.location.workspaceID ?? "" },
    securityNamespace: { securityNamespaceId: frame.securityNamespaceId },
    // The contract `projectId` is the released-knowledge legacy project id: the real frame carries
    // the host derivation (resolver feeds it to the adapters as `legacyProjectId`); the v2:local
    // fallback carries "v2:local" — the pre-W3.8 value (projectScopeKey fallback) unchanged.
    projectScope: { projectScopeKey: frame.projectScopeKey, projectId: frame.legacyProjectId },
    // W3.8.1: the selection frame's egress carries the live-query sensitivity set (same default as
    // the deepagent-code readiness probe) — otherwise the LiveCodeQuery authorization gate rejects
    // the code graph with provider_egress_denied even when the real identity frame is bound.
    egress: authorization.egress,
    agentPolicy: { agentId: input.agent, autonomyCeiling: "medium", permitDegraded: true },
    modelCapability: input.model
      ? {
          modelId: input.model.id,
          providerId: input.model.providerID,
          protocol: input.model.protocol,
          ...(input.model.contextWindow === undefined ? {} : { contextWindow: input.model.contextWindow }),
          structuredOutput: input.model.structuredOutput,
        }
      : {
          modelId: "",
          providerId: "",
          protocol: "openai.responses",
          structuredOutput: false,
        },
    releasedKnowledge: released
      ? { snapshotId: released.snapshotId, binding: "bound" }
      : { snapshotId: "", binding: "unavailable" },
    queryIntent: input.queryIntent ?? "search",
    query: "session context",
    observedLocationMutationEpoch: 0,
    now,
  }
}

/** The exact authority shared by automatic selection and explicit V2 context tools. */
function queryAuthorization(
  input: AdmitSelectionInput,
  frame: EffectiveFrameIdentity,
  epochs?: { readonly authorizationEpoch: number; readonly egressEpoch: number },
): ContextQueryAuthorization.Envelope {
  return {
    principal: {
      securityNamespaceId: frame.securityNamespaceId,
      principalId: input.sessionID,
      authorizationEpoch: epochs?.authorizationEpoch ?? input.system.revision,
      locationKeys: [frame.locationKey],
      projectScopeKeys: [frame.projectScopeKey],
      sessionIds: [input.sessionID],
      subjectIds: [],
      allowBuiltin: false,
    },
    // W3.8.1: the selection frame's egress carries the live-query sensitivity set (same default as
    // the deepagent-code readiness probe) — otherwise the LiveCodeQuery authorization gate rejects
    // the code graph with provider_egress_denied even when the real identity frame is bound.
    egress: {
      policyId: "v2:history-context",
      epoch: epochs?.egressEpoch ?? input.system.baselineSeq,
      graphs: [...GraphOrder],
      sensitivities: ["public", "source_code", "secret_adjacent"],
    },
  }
}

function selectionRowsEqual(a: string, b: string) {
  return a === b
}

function selectionErrorDetail(error: unknown): string {
  return typeof error === "object" && error !== null && "_tag" in error
    ? String((error as { readonly _tag: unknown })._tag)
    : String(error)
}

function activityInputIds(input: AdmitSelectionInput, activityId: string) {
  return input.db
    .select({ inputId: SessionActivityInputTable.input_id })
    .from(SessionActivityInputTable)
    .where(eq(SessionActivityInputTable.activity_id, activityId))
    .orderBy(asc(SessionActivityInputTable.admitted_seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.inputId)),
    )
}

function isContextError(value: unknown): value is SessionContext.Error {
  return (
    value instanceof SessionContext.InputError ||
    value instanceof SessionContext.ActivityBlockedError ||
    value instanceof SessionContext.ActivityStateError ||
    value instanceof SessionContext.SelectionConflictError ||
    value instanceof SessionContext.ValidationError ||
    value instanceof SessionContext.AuditStorageUnavailableError ||
    value instanceof SessionContext.StoredDataError
  )
}

function toAdmission(error: SessionContext.Error) {
  return new AdmissionError({ reason: `context_admission_failed:${contextErrorDetail(error)}` })
}

function contextErrorDetail(error: SessionContext.Error) {
  return "reason" in error && typeof error.reason === "string" ? `${error._tag}:${error.reason}` : error._tag
}

/**
 * The database-clock timestamp observed when `ownerToken` provably lost its lease (no lease row,
 * released, or expired) — `undefined` while the lease is live. Same liveness predicate as
 * V2ProviderTurn.recover / requireStaleOwner; an ownerless attempt has no lease to lose.
 */
function staleAfterLeaseLoss(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  ownerToken: string | null,
) {
  return Effect.gen(function* () {
    const observedAt = yield* SessionProviderOwner.observedAtInTransaction(tx)
    if (ownerToken === null) return observedAt
    const live = yield* tx
      .select({ ownerToken: SessionProviderOwnerLeaseTable.owner_token })
      .from(SessionProviderOwnerLeaseTable)
      .where(
        and(
          eq(SessionProviderOwnerLeaseTable.owner_token, ownerToken),
          isNull(SessionProviderOwnerLeaseTable.released_at),
          gt(SessionProviderOwnerLeaseTable.lease_expires_at, observedAt),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    return live ? undefined : observedAt
  })
}

/** The leading run of crash-quarantined attempts ending at `fromSeq` (inclusive). */
function consecutiveCrashQuarantines(
  tx: Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0],
  sessionId: SessionSchema.ID,
  fromSeq: number,
) {
  return tx
    .select({ state: SessionProviderAttemptTable.state, errorCode: SessionProviderAttemptTable.error_code })
    .from(SessionProviderAttemptTable)
    .where(
      and(
        eq(SessionProviderAttemptTable.session_id, sessionId),
        lte(SessionProviderAttemptTable.provider_turn_seq, fromSeq),
      ),
    )
    .orderBy(desc(SessionProviderAttemptTable.provider_turn_seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => {
        let run = 0
        for (const row of rows) {
          if (
            row.state === "indeterminate_after_crash" ||
            (row.state === "failed" && row.errorCode === "owner_lease_lost_before_dispatch")
          ) {
            run++
            continue
          }
          break
        }
        return run
      }),
    )
}

export type CommitTurnInput = {
  readonly db: Database.Interface["db"]
  readonly contexts: SessionContext.Interface
  readonly sessionID: SessionSchema.ID
  readonly admission: SelectionAdmission
  readonly receipt: Omit<V2ProviderTurn.AdmitInput, "ownerToken" | "activityId" | "providerTurnSeq">
  readonly protocolAttemptIdentityHash?: string
  readonly ownerToken: string
  /** Dispatchable model policy is committed in the same transaction as the attempt. */
  readonly policy?: LongContext.PolicyInput
  readonly now?: number
}

// Creates the canonical provider attempt, V2 receipt, and optional model policy for one physical
// request inside a single transaction. Exact retries converge on the same prepared attempt.
export const commitTurn = Effect.fn("SessionRunnerCanonical.commitTurn")(function* (input: CommitTurnInput) {
  const now = input.now ?? Date.now()
  const authority = yield* WorkAuthority.lookupSession(input.db, input.sessionID)
  if (authority.kind === "bound" && authority.work.binding.schemaVersion === "work-execution.v2") {
    yield* WorkToolPolicy.preparePrevious(input.db, input.sessionID)
    // Materialization and authenticating prior outcomes are external preparation. Their
    // observation cannot carry an earlier source witness into this new attempt's SQL fence.
    const { WorkExecutionProfile } = yield* Effect.promise(() => import("../work-execution-profile"))
    yield* WorkExecutionProfile.prepareSource(authority.work, { fresh: true })
  }
  const result = yield* input.db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const latest = yield* tx
            .select()
            .from(SessionProviderAttemptTable)
            .where(eq(SessionProviderAttemptTable.session_id, input.sessionID))
            .orderBy(desc(SessionProviderAttemptTable.provider_turn_seq))
            .limit(1)
            .get()
          if (authority.kind === "bound" && authority.work.binding.schemaVersion === "work-execution.v2") {
            const work = yield* WorkAuthority.requireCurrentControlInTransaction(tx, {
              workID: authority.work.work_id, expectedRevision: authority.work.control_revision,
            })
            const existing = latest?.state === "prepared" && latest.owner_token === input.ownerToken &&
              latest.request_hash === input.receipt.requestInputHash
              ? yield* tx.select({ id: V2ProviderTurnReceiptTable.receipt_id }).from(V2ProviderTurnReceiptTable)
                .where(eq(V2ProviderTurnReceiptTable.provider_attempt_id, latest.attempt_id)).get()
              : undefined
            yield* WorkToolPolicy.previous(tx, work, existing?.id)
          }
          // Only attempts that may still be physically streaming block new work. An
          // `indeterminate_after_crash` attempt is known-dead with an unknown outcome: explicit
          // forced continuation may open a fresh attempt (new seq, no replay of the quarantined
          // identity); the quarantined attempt still requires explicit resolution before recovery
          // may treat its turn as terminal.
          // R1 — a `prepared` attempt (crash in the commitTurn→wire-seal window) of a foreign
          // owner is quarantined too when that owner's lease is provably dead: otherwise the seq
          // reuse below hands the new turn to prepareInTransaction, which fails forever with
          // `prepared_attempt_binding_mismatch` (the attempt-side sweep recoverIndeterminate has
          // no production caller). Same-owner prepared attempts keep the exact-retry convergence.
          let quarantinedLatest = false
          if (latest) {
            const inFlight = ["dispatching", "streaming"].includes(latest.state)
            const foreignPrepared = latest.state === "prepared" && latest.owner_token !== input.ownerToken
            if (inFlight || foreignPrepared) {
              const stale = yield* staleAfterLeaseLoss(tx, latest.owner_token)
              if (!stale) {
                if (inFlight) return yield* new AdmissionError({ reason: `provider_attempt_blocked:${latest.state}` })
                // prepared + live foreign owner falls through: the same-owner exact-retry reuse does
                // not apply and prepareInTransaction answers with the typed binding mismatch.
              } else {
              // F-18 — the owner's lease is provably dead (crashed process, lease expired after
              // the one-shot layer-build recovery already ran): quarantine the attempt + its
              // receipt in THIS transaction, then let the user's explicit input open a fresh
              // attempt. In-flight turns go to indeterminate_after_crash (unknown outcome, never
              // replayed, §2.2, explicit resolution still required); a prepared turn never
              // dispatched, so it terminalizes as failed/owner_lease_lost_before_dispatch.
              // Mirrors V2ProviderTurn.recover / recoverIndeterminate.
              const updatedAttempts = yield* tx
                .update(SessionProviderAttemptTable)
                .set(
                  inFlight
                    ? {
                        state: "indeterminate_after_crash",
                        attempt_version: sql`${SessionProviderAttemptTable.attempt_version} + 1`,
                        error_code: "process_recovery",
                      }
                    : {
                        state: "failed",
                        attempt_version: sql`${SessionProviderAttemptTable.attempt_version} + 1`,
                        error_code: "owner_lease_lost_before_dispatch",
                        settled_at: stale,
                      },
                )
                .where(
                  and(
                    eq(SessionProviderAttemptTable.attempt_id, latest.attempt_id),
                    eq(SessionProviderAttemptTable.state, latest.state),
                  ),
                )
                .returning({ attemptId: SessionProviderAttemptTable.attempt_id })
                .all()
                .pipe(Effect.orDie)
              if (updatedAttempts.length !== 1)
                return yield* new AdmissionError({ reason: "stale_provider_attempt_cas_lost" })
              const staleReceipt =
                latest.owner_token === null
                  ? undefined
                  : yield* tx
                      .update(V2ProviderTurnReceiptTable)
                      .set(
                        inFlight
                          ? {
                              state: "indeterminate_after_crash",
                              error_code: "owner_lost_after_dispatch",
                              terminal_at: stale,
                            }
                          : {
                              state: "failed",
                              error_code: "owner_lost_before_dispatch",
                              terminal_at: stale,
                            },
                      )
                      .where(
                        and(
                          eq(V2ProviderTurnReceiptTable.session_id, input.sessionID),
                          eq(V2ProviderTurnReceiptTable.provider_attempt_id, latest.attempt_id),
                          eq(V2ProviderTurnReceiptTable.owner_token, latest.owner_token),
                          inArray(
                            V2ProviderTurnReceiptTable.state,
                            inFlight ? ["dispatching", "streaming"] : ["preparing"],
                          ),
                        ),
                      )
                      .returning()
                      .all()
                      .pipe(Effect.orDie)
              if (!staleReceipt || staleReceipt.length !== 1)
                return yield* new AdmissionError({ reason: "stale_provider_receipt_binding_conflict" })
              yield* V2ProviderTurn.writeTurnTerminalDescriptor(tx, staleReceipt[0]!, stale)
              quarantinedLatest = true
              // opencode upstream port #1 — durable resume budget: consecutive crash
              // quarantines without a single settled attempt in between converge to a typed
              // refusal instead of an unbounded quarantine/retry loop (the budget is derived
              // from the durable attempt rows; a settled attempt anywhere in the leading run
              // resets it).
              const budget = yield* consecutiveCrashQuarantines(tx, input.sessionID, latest.provider_turn_seq)
              if (budget >= MaxConsecutiveCrashResumes)
                return yield* new AdmissionError({ reason: `resume_budget_exhausted:${budget}` })
              }
            }
          }
          // Receipt identity requires provider_turn_seq >= 1; canonical sequences are 1-based. A
          // just-quarantined latest must NOT be reused (exact-retry reuse is same-owner only).
          const providerTurnSeq =
            latest && latest.state === "prepared" && !quarantinedLatest
              ? latest.provider_turn_seq
              : (latest?.provider_turn_seq ?? 0) + 1
          // A single provider turn can stream for minutes (long-reasoning models); the 60s
          // selection TTL is a freshness window for the ADMITTED identity, not a session
          // deadline. Elapsed TTL alone must not kill the turn: design §4.1 step 7 keeps the
          // quarantine for real drift (identity mismatch vs the durable row), while a
          // still-matching row is revalidated in place (validUntil = now + ValidationMs).
          const durableSelection = yield* tx
            .select({
              observed_location_mutation_epoch: SessionContextSelectionTable.observed_location_mutation_epoch,
              selected_source_fingerprint: SessionContextSelectionTable.selected_source_fingerprint,
            })
            .from(SessionContextSelectionTable)
            .where(eq(SessionContextSelectionTable.selection_id, input.admission.selectionId))
            .get()
            .pipe(Effect.orDie)
          if (
            durableSelection === undefined ||
            durableSelection.observed_location_mutation_epoch > input.admission.observedLocationMutationEpoch ||
            durableSelection.selected_source_fingerprint !== input.admission.selectedSourceFingerprint
          )
            return yield* new AdmissionError({ reason: "selection_revalidation_required" })
          if (input.policy && (
            input.policy.sessionID !== input.sessionID ||
            input.policy.activityID !== input.admission.activityId ||
            input.policy.userMessageID !== input.receipt.userMessageId ||
            input.policy.promptEpoch !== input.receipt.historyPromptEpoch ||
            input.policy.requestHash !== input.receipt.requestInputHash ||
            input.policy.providerID !== input.receipt.providerId ||
            input.policy.apiModelID !== input.receipt.modelId ||
            input.policy.selectionID !== input.admission.selectionId ||
            input.policy.projectionHash !== input.admission.projectionHash ||
            (input.policy.policy.state !== "unmanaged" &&
              (input.policy.policy.state !== "managed" ||
                (input.policy.policy.action !== "normal" && input.policy.policy.action !== "observed")))
          )) return yield* new AdmissionError({ reason: "model_policy_attempt_binding_mismatch" })
          const validUntil = now + ValidationMs
          yield* input.contexts.appendValidation({
            selectionId: input.admission.selectionId,
            providerTurnSeq,
            authorizationEpoch: input.admission.authorizationEpoch,
            egressEpoch: input.admission.egressEpoch,
            observedLocationMutationEpoch: input.admission.observedLocationMutationEpoch,
            selectedSourceFingerprint: input.admission.selectedSourceFingerprint,
            validatedAt: now,
            validUntil,
            outcome: "valid",
            reasonCode: "v2_history_context_current",
          })
          const attempt = yield* SessionProviderAttempt.prepareInTransaction(tx, {
            sessionId: input.sessionID,
            activityId: input.admission.activityId,
            providerTurnSeq,
            selectionId: input.admission.selectionId,
            projectionHash: input.admission.projectionHash,
            requestHash: input.receipt.requestInputHash,
            protocolAttemptIdentityHash: input.protocolAttemptIdentityHash,
            providerId: input.receipt.providerId,
            ownerToken: input.ownerToken,
            authorizationEpoch: input.admission.authorizationEpoch,
            egressEpoch: input.admission.egressEpoch,
            selectedSourceFingerprint: input.admission.selectedSourceFingerprint,
            observedLocationMutationEpoch: input.admission.observedLocationMutationEpoch,
            now,
          })
          const receipt = yield* V2ProviderTurn.admitInTransaction(
            tx,
            { ...input.receipt, activityId: input.admission.activityId, providerTurnSeq },
            input.ownerToken,
          )
          // Exact-retry convergence: an existing receipt already bound to the reused attempt is
          // returned as-is; first-time admission binds once.
          const bound =
            receipt.providerAttemptId === attempt.attemptId
              ? receipt
              : yield* V2ProviderTurn.bindAttemptInTransaction(tx, receipt, attempt.attemptId)
          if (input.policy)
            yield* LongContext.recordPolicyInTransaction(tx, input.policy, attempt.attemptId)
          return { receipt: bound, attempt, providerTurnSeq }
        }),
      { behavior: "immediate" },
    )
    .pipe(
      Effect.catch((error) =>
        error instanceof WorkAuthoritySchema.Error ||
        error instanceof AdmissionError ||
        error instanceof V2ProviderTurn.ConflictError ||
        error instanceof V2ProviderTurn.UnsafeRetryError ||
        error instanceof V2ProviderTurn.NotFoundError ||
        error instanceof SessionProviderAttempt.NotFoundError ||
        error instanceof SessionProviderAttempt.ConflictError ||
        error instanceof SessionProviderAttempt.InvalidStateError ||
        error instanceof SessionProviderAttempt.ValidationRequiredError ||
        error instanceof SessionProviderAttempt.UnsafeRetryError
          ? Effect.fail(error)
          : isContextError(error)
            ? Effect.fail(toAdmission(error))
            : Effect.die(error),
      ),
    )
  // C3-08 dispatch seam: before ONE physical dispatch, the attempt must be bound to a real
  // (never v2-none, never legacy_incomplete) selection with a valid, unexpired validation. A
  // legacy_incomplete or v2-none/absent selection refuses here (no request is dispatched).
  yield* assertAttemptBoundSelection(input.db, {
    attemptId: result.attempt.attemptId,
    selectionId: input.admission.selectionId,
    now,
  }).pipe(Effect.mapError((error) => new AdmissionError({ reason: `selection_dispatch_refused:${selectionErrorDetail(error)}` })))
  return result
})

// Best-effort audit store for V2 selections: V2 has no federation security namespace yet, so writes
// are refused and commitSelection records the degraded inline audit (projection fingerprints) instead
// of silently skipping it.
export const degradedArtifactStore = Layer.succeed(
  ContextArtifactStore.Service,
  ContextArtifactStore.Service.of({
    policy: "best_effort",
    write: () => Effect.fail(new ContextArtifactStore.BindingError()),
    read: () => Effect.fail(new ContextArtifactStore.NotFoundError()),
    sweep: () => Effect.succeed(0),
    sweepOrphans: () => Effect.succeed(0),
  }),
)
