export * as SessionFederatedContext from "./session-context-runtime"

import {
  ContextAuthorization,
  Sensitivity,
  type EgressPolicy,
  type Principal,
} from "@deepagent-code/core/context-federation/authorization"
import { GraphKind } from "@deepagent-code/core/context-federation/contract"
import { ContextFederation, type GraphQueryStatus } from "@deepagent-code/core/context-federation/federation"
import { FederatedContextQuery } from "@deepagent-code/core/context-federation/query"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { ContextProjection } from "@deepagent-code/core/context-federation/projection"
import { ContextReference } from "@deepagent-code/core/context-federation/reference"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { SessionProviderAttempt } from "@deepagent-code/core/context-federation/provider-attempt"
import {
  SessionActivityTable,
  SessionContextSelectionTable,
  SessionContextValidationTable,
  SessionProviderAttemptTable,
} from "@deepagent-code/core/context-federation/session-sql"
import { ContextTokenCodec } from "@deepagent-code/core/context-federation/token-codec"
import { Database } from "@deepagent-code/core/database/database"
import { Hash } from "@deepagent-code/core/util/hash"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import { projectIdForWorkspace } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { and, desc, eq } from "drizzle-orm"
import type { Agent } from "../agent/agent"
import { Permission } from "../permission"
import type { Provider } from "../provider/provider"
import type { Session } from "../session/session"
import { LocationIndexRuntime } from "../location-index/runtime"
import { LiveContextArtifactStore } from "./artifact-service"
import { LiveFederatedContextQuery } from "./federated-query-service"
import { LiveContextQueryAuthorization } from "./query-authorization"
import { LiveContextTokenCodec } from "./token-service"
import { ContextFederationObservability } from "./observability"

const ValidationMs = 60_000
const SelectionLifetimeMs = 14 * 60_000
const TokenLifetimeMs = 15 * 60_000

export type Resolved = {
  readonly selection: SessionContext.Selection
  readonly envelope: ContextQueryAuthorization.Envelope
  readonly observedLocationMutationEpoch: number
}

export type AttemptAdmission = Omit<SessionProviderAttempt.PrepareInput, "ownerToken">

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()("SessionFederatedContext.RuntimeError", {
  reason: Schema.String,
}) {}

export interface Interface {
  readonly recover: (sessionId: string) => Effect.Effect<number, RuntimeError>
  readonly resolve: (input: {
    readonly session: Session.Info
    readonly inputIds: readonly string[]
    readonly query: string
    readonly agent: Agent.Info
    readonly model: Provider.Model
    readonly current?: SessionContext.Selection
    readonly releasedKnowledgeSelection?: DeepAgentReleasedSnapshot.Selection
    readonly now?: number
  }) => Effect.Effect<Resolved, RuntimeError>
  readonly prepareProviderTurn: (input: {
    readonly selection: SessionContext.Selection
    readonly envelope: ContextQueryAuthorization.Envelope
    readonly requestHash: string
    readonly providerId: string
    readonly observedLocationMutationEpoch: number
    readonly now?: number
  }) => Effect.Effect<AttemptAdmission, RuntimeError>
  readonly settleActivity: (
    selection: SessionContext.Selection,
    state: "settled" | "failed" | "interrupted",
  ) => Effect.Effect<void, RuntimeError>
  /** Restart recovery (BUG-003): settle every federation activity still marked `active`. */
  readonly settleOrphanedActivities: () => Effect.Effect<number, RuntimeError>
  readonly replayIndeterminate: (input: {
    readonly session: Session.Info
    readonly attemptId: string
    readonly actorId: string
    readonly reason: string
    readonly riskAcknowledged: boolean
    readonly recoveryOwnerToken: string
    readonly now?: number
  }) => Effect.Effect<
    {
      readonly attempt: SessionProviderAttempt.Attempt
      readonly replay: SessionProviderAttempt.Attempt
    },
    RuntimeError
  >
  readonly releasedKnowledgeForActiveSession: (
    sessionId: string,
  ) => Effect.Effect<
    { readonly pinned: true; readonly selection: DeepAgentReleasedSnapshot.Selection | undefined } | undefined,
    RuntimeError
  >
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionFederatedContext") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const runtime = yield* LocationIndexRuntime.Service
    const query = yield* FederatedContextQuery.Service
    const authorization = yield* ContextQueryAuthorization.Controller
    const codec = yield* ContextTokenCodec.Service
    const contexts = yield* SessionContext.Service
    const attempts = yield* SessionProviderAttempt.Service

    const activeSelection = (sessionId: string) =>
      database.db
        .select({ selectionId: SessionContextSelectionTable.selection_id })
        .from(SessionContextSelectionTable)
        .innerJoin(SessionActivityTable, eq(SessionActivityTable.activity_id, SessionContextSelectionTable.activity_id))
        .where(and(eq(SessionContextSelectionTable.session_id, sessionId), eq(SessionActivityTable.state, "active")))
        .orderBy(desc(SessionContextSelectionTable.revision))
        .get()
        .pipe(
          Effect.orDie,
          Effect.flatMap((row) => (row ? contexts.getSelection(row.selectionId) : Effect.succeed(undefined))),
          Effect.mapError((error) => runtimeError(error)),
        )

    const previousEpochs = (sessionId: string, selection?: SessionContext.Selection) =>
      Effect.gen(function* () {
        const latest = selection
          ? { selectionId: selection.selectionId, authorizationEpoch: selection.authorizationEpoch }
          : yield* database.db
              .select({
                selectionId: SessionContextSelectionTable.selection_id,
                authorizationEpoch: SessionContextSelectionTable.authorization_epoch,
              })
              .from(SessionContextSelectionTable)
              .where(eq(SessionContextSelectionTable.session_id, sessionId))
              .orderBy(desc(SessionContextSelectionTable.created_at))
              .get()
              .pipe(Effect.orDie)
        if (!latest) return { authorization: 0, egress: 0 }
        const validation = yield* database.db
          .select({ egressEpoch: SessionContextValidationTable.egress_epoch })
          .from(SessionContextValidationTable)
          .where(eq(SessionContextValidationTable.selection_id, latest.selectionId))
          .orderBy(desc(SessionContextValidationTable.validated_at))
          .get()
          .pipe(Effect.orDie)
        return {
          authorization: latest.authorizationEpoch,
          egress: validation?.egressEpoch ?? latest.authorizationEpoch,
        }
      })

    const recover: Interface["recover"] = (sessionId) =>
      database.db
        .select({ attemptId: SessionProviderAttemptTable.attempt_id })
        .from(SessionProviderAttemptTable)
        .where(
          and(
            eq(SessionProviderAttemptTable.session_id, sessionId),
            eq(SessionProviderAttemptTable.state, "indeterminate_after_crash"),
          ),
        )
        .all()
        .pipe(
          Effect.map((rows) => rows.length),
          Effect.mapError(runtimeError),
        )

    const resolve: Interface["resolve"] = (input) => {
      // BUG-003: when this call opens a fresh activity, any later failure before commit would
      // otherwise leave a permanent `active` row (the partial unique index then blocks every new
      // activity for the session). Track the opened id and roll it back to `interrupted` on error.
      let openedActivityId: string | undefined
      return Effect.gen(function* () {
        const handle = yield* runtime.current()
        if (!handle) return yield* new RuntimeError({ reason: "location_unavailable" })
        const now = input.now ?? Date.now()
        const current = input.current ?? (yield* activeSelection(input.session.id))
        const inputIds = input.inputIds.filter((inputId) => !current?.promotedInputIds.includes(inputId))
        const epochs = yield* previousEpochs(input.session.id, current)
        const priorEnvelope = envelopeFor({
          session: input.session,
          model: input.model,
          identity: handle.identity,
          agent: input.agent,
          authorizationEpoch: epochs.authorization,
          egressEpoch: epochs.egress,
        })
        const envelope =
          current &&
          ContextAuthorization.fingerprint(priorEnvelope.principal, priorEnvelope.egress) ===
            current.authorizationFingerprint
            ? priorEnvelope
            : envelopeFor({
                session: input.session,
                model: input.model,
                identity: handle.identity,
                agent: input.agent,
                authorizationEpoch: epochs.authorization + 1,
                egressEpoch: epochs.egress + 1,
              })
        yield* authorization.bind({ sessionId: input.session.id, envelope })
        const executionFingerprint = Hash.sha256(
          JSON.stringify({
            agent: input.agent.name,
            providerId: input.model.providerID,
            modelId: input.model.id,
            toolCall: input.model.capabilities.toolcall,
            resolver: "federated-rrf-v1",
            projection: ContextProjection.SerializerVersion,
            tokenizer: ContextProjection.TokenizerVersion,
            maxRefs: input.model.capabilities.toolcall ? 8 : 14,
            maxTokens: input.model.capabilities.toolcall ? 1_200 : 3_000,
            releasedKnowledgeSnapshotId: input.releasedKnowledgeSelection?.snapshotId ?? null,
            releasedKnowledgeMembershipHash: input.releasedKnowledgeSelection?.membershipHash ?? null,
          }),
        )
        const authorizationFingerprint = ContextAuthorization.fingerprint(envelope.principal, envelope.egress)
        const mutationEpoch = yield* (
          handle.coordinator.mutationEpoch?.() ?? Effect.succeed(current?.observedLocationMutationEpoch ?? 0)
        ).pipe(Effect.catch(() => Effect.succeed(current?.observedLocationMutationEpoch ?? 0)))
        if (current && inputIds.length === 0) {
          const unchanged =
            current.locationKey === handle.identity.locationKey &&
            current.authorizationFingerprint === authorizationFingerprint &&
            current.executionFingerprint === executionFingerprint &&
            DeepAgentReleasedSnapshot.matchesBinding(
              input.releasedKnowledgeSelection,
              current.releasedKnowledgeBinding,
            ) &&
            current.observedLocationMutationEpoch === mutationEpoch &&
            now < current.nextRevalidationAt
          if (unchanged) {
            return { selection: current, envelope, observedLocationMutationEpoch: mutationEpoch }
          }
          const refreshed = yield* refreshSelected({
            selected: current.selectedRefs,
            statuses: current.graphStatuses,
            query,
            envelope,
            sessionId: input.session.id,
            toolCall: input.model.capabilities.toolcall,
            releasedKnowledgeSelection: input.releasedKnowledgeSelection,
            now,
          })
          const sourceUnchanged = sourceFingerprint(refreshed.hits) === current.selectedSourceFingerprint
          if (
            sourceUnchanged &&
            current.executionFingerprint === executionFingerprint &&
            DeepAgentReleasedSnapshot.matchesBinding(
              input.releasedKnowledgeSelection,
              current.releasedKnowledgeBinding,
            ) &&
            now < current.nextRevalidationAt
          ) {
            return { selection: current, envelope, observedLocationMutationEpoch: mutationEpoch }
          }
          return {
            selection: yield* commit({
              sessionId: input.session.id,
              activityId: current.activityId,
              triggerInputId: current.triggerInputId,
              revision: current.revision + 1,
              inputIds: [],
              queryFingerprint: current.queryFingerprint,
              authorizationFingerprint,
              executionFingerprint,
              mutationEpoch,
              identity: handle.identity,
              envelope,
              hits: refreshed.hits,
              statuses: projectionStatuses(refreshed.statuses),
              sourceStatuses: refreshed.statuses,
              model: input.model,
              releasedKnowledgeSelection: input.releasedKnowledgeSelection,
              now,
            }),
            envelope,
            observedLocationMutationEpoch: mutationEpoch,
          }
        }
        if (inputIds.length === 0) return yield* new RuntimeError({ reason: "activity_input_missing" })
        const activity = current
          ? { activityId: current.activityId, triggerInputId: current.triggerInputId }
          : yield* contexts
              .openActivity({
                sessionId: SessionSchema.ID.make(input.session.id),
                triggerInputId: inputIds[0]!,
                now,
              })
              .pipe(Effect.tap((opened) => Effect.sync(() => (openedActivityId = opened.activityId))))
        yield* contexts.attachInputs({ activityId: activity.activityId, inputIds, now })
        const resolved = yield* query.query({
          intent: "search",
          query: input.query.trim() || "workspace context",
          sources: ["code", "documents", "knowledge", "memory"],
          limit: input.model.capabilities.toolcall ? 8 : 14,
          consistency: "stale_ok",
          principal: envelope.principal,
          egress: envelope.egress,
          sessionId: input.session.id,
          toolCall: input.model.capabilities.toolcall,
          releasedKnowledgeSelection: input.releasedKnowledgeSelection,
        })
        return {
          selection: yield* commit({
            sessionId: input.session.id,
            activityId: activity.activityId,
            triggerInputId: activity.triggerInputId,
            revision: current ? current.revision + 1 : 0,
            inputIds,
            queryFingerprint: Hash.sha256(
              JSON.stringify({
                previous: current?.queryFingerprint,
                inputIds,
                query: input.query.trim(),
                parentSessionId: input.session.parentID,
              }),
            ),
            authorizationFingerprint,
            executionFingerprint,
            mutationEpoch,
            identity: handle.identity,
            envelope,
            hits: resolved.hits,
            statuses: projectionStatuses(resolved.statuses),
            sourceStatuses: resolved.statuses,
            model: input.model,
            releasedKnowledgeSelection: input.releasedKnowledgeSelection,
            now,
          }),
          envelope,
          observedLocationMutationEpoch: mutationEpoch,
        }
      }).pipe(
        Effect.tapError(() =>
          openedActivityId === undefined
            ? Effect.void
            : contexts.settleActivity({ activityId: openedActivityId, state: "interrupted" }).pipe(Effect.ignore),
        ),
        Effect.mapError((error) => (error instanceof RuntimeError ? error : runtimeError(error))),
      )
    }

    const commit = (input: {
      readonly sessionId: string
      readonly activityId: string
      readonly triggerInputId: string
      readonly revision: number
      readonly inputIds: readonly string[]
      readonly queryFingerprint: string
      readonly authorizationFingerprint: string
      readonly executionFingerprint: string
      readonly mutationEpoch: number
      readonly identity: Identity
      readonly envelope: ContextQueryAuthorization.Envelope
      readonly hits: readonly FederatedContextQuery.Hit[]
      readonly statuses: readonly ContextProjection.Status[]
      readonly sourceStatuses: readonly GraphQueryStatus[]
      readonly model: Provider.Model
      readonly releasedKnowledgeSelection?: DeepAgentReleasedSnapshot.Selection
      readonly now: number
    }) => {
      const maxTokens = input.model.capabilities.toolcall ? 1_200 : 3_000
      const maxRefs = input.model.capabilities.toolcall ? 8 : 14
      const lifetime = { issuedAt: input.now, expiresAt: input.now + TokenLifetimeMs }
      const candidates = input.hits.slice(0, maxRefs).map((hit) => ({
        hit,
        token: codec.sealContextRef(hit.ref, lifetime),
        provenanceTokens: hit.provenance
          .filter(
            (ref) =>
              ContextAuthorization.authorize({
                ref,
                principal: input.envelope.principal,
                egress: input.envelope.egress,
                sensitivity: hit.sensitivity,
              }).allowed,
          )
          .map((ref) => codec.sealContextRef(ref, lifetime)),
        relations: (hit.relationPath ?? []).flatMap((item) =>
          ContextAuthorization.authorize({
            ref: item.ref,
            principal: input.envelope.principal,
            egress: input.envelope.egress,
            sensitivity: hit.sensitivity,
          }).allowed
            ? [{ relation: item.relation, token: codec.sealContextRef(item.ref, lifetime), freshness: item.freshness }]
            : [],
        ),
      }))
      const fitted = candidates.reduce<typeof candidates>((selected, candidate) => {
        const next = [...selected, candidate]
        return ContextProjection.render({
          evidence: next.map(({ hit, token }) => evidence(hit, token)),
          statuses: input.statuses,
        }).tokenCount <= maxTokens
          ? next
          : selected
      }, [])
      const rendered = ContextProjection.render({
        evidence: fitted.map(({ hit, token }) => evidence(hit, token)),
        statuses: input.statuses,
      })
      const selectedSourceFingerprint = sourceFingerprint(fitted.map((item) => item.hit))
      return contexts
        .commitSelection({
          securityNamespaceId: input.identity.securityNamespaceId,
          projectScopeKey: input.identity.projectScopeKey,
          sessionId: SessionSchema.ID.make(input.sessionId),
          activityId: input.activityId,
          revision: input.revision,
          triggerInputId: input.triggerInputId,
          locationKey: input.identity.locationKey,
          promotedInputIds: input.inputIds,
          queryFingerprint: input.queryFingerprint,
          authorizationFingerprint: input.authorizationFingerprint,
          authorizationEpoch: input.envelope.principal.authorizationEpoch,
          executionFingerprint: input.executionFingerprint,
          selectedSourceFingerprint,
          observedLocationMutationEpoch: input.mutationEpoch,
          nextRevalidationAt: input.now + SelectionLifetimeMs,
          releasedKnowledgeBinding: DeepAgentReleasedSnapshot.binding(input.releasedKnowledgeSelection),
          graphRevisions: graphRevisions(
            input.sourceStatuses,
            fitted.map((item) => item.hit),
          ),
          graphStatuses: input.sourceStatuses,
          selectedRefs: fitted.map(({ hit, token, provenanceTokens, relations }) => ({
            ref: hit.ref,
            token,
            provenanceTokens,
            relations,
            freshness: hit.validity?.state ?? "unknown",
            sensitivity: hit.sensitivity,
            score: hit.score,
            reason: hit.relationPath?.map((item) => item.relation).join(" > ") || "federated_rank",
            excerpt: (hit.excerpt ?? hit.title).slice(0, 1_000),
            projectionStart: rendered.offsets[token]!.start,
            projectionEnd: rendered.offsets[token]!.end,
          })),
          rendered,
          artifact: {
            rankingVersion: "federated-rrf-v1",
            rejected: input.sourceStatuses.flatMap((status) =>
              status.kind === "blocked" || status.kind === "partial"
                ? [{ graph: status.graph, reasonCode: status.reasonCode }]
                : [],
            ),
          },
          now: input.now,
        })
        .pipe(
          Effect.tap((selection) =>
            Effect.sync(() =>
              ContextFederationObservability.observeSelection(selection.selectionId, selection.tokenCount),
            ),
          ),
        )
    }

    const prepareProviderTurn: Interface["prepareProviderTurn"] = (input) =>
      Effect.gen(function* () {
        const latest = yield* database.db
          .select()
          .from(SessionProviderAttemptTable)
          .where(eq(SessionProviderAttemptTable.session_id, input.selection.sessionId))
          .orderBy(desc(SessionProviderAttemptTable.provider_turn_seq))
          .get()
          .pipe(Effect.orDie)
        if (latest && ["dispatching", "streaming", "indeterminate_after_crash"].includes(latest.state)) {
          return yield* new RuntimeError({ reason: `provider_attempt_blocked:${latest.state}` })
        }
        const providerTurnSeq =
          latest?.state === "prepared" ? latest.provider_turn_seq : (latest?.provider_turn_seq ?? -1) + 1
        const now = input.now ?? Date.now()
        const validUntil = Math.min(now + ValidationMs, input.selection.nextRevalidationAt)
        if (validUntil <= now) return yield* new RuntimeError({ reason: "selection_revalidation_required" })
        yield* contexts.appendValidation({
          selectionId: input.selection.selectionId,
          providerTurnSeq,
          authorizationEpoch: input.envelope.principal.authorizationEpoch,
          egressEpoch: input.envelope.egress.epoch,
          observedLocationMutationEpoch: input.observedLocationMutationEpoch,
          selectedSourceFingerprint: input.selection.selectedSourceFingerprint,
          validatedAt: now,
          validUntil,
          outcome: "valid",
          reasonCode: "selected_sources_current",
        })
        return {
          sessionId: input.selection.sessionId,
          activityId: input.selection.activityId,
          providerTurnSeq,
          selectionId: input.selection.selectionId,
          projectionHash: input.selection.projectionHash,
          requestHash: input.requestHash,
          providerId: input.providerId,
          ...(latest?.state === "prepared" && latest.parent_attempt_id
            ? { parentAttemptId: latest.parent_attempt_id }
            : {}),
          ...(latest?.state === "prepared" && latest.idempotency_key ? { idempotencyKey: latest.idempotency_key } : {}),
          authorizationEpoch: input.envelope.principal.authorizationEpoch,
          egressEpoch: input.envelope.egress.epoch,
          selectedSourceFingerprint: input.selection.selectedSourceFingerprint,
          observedLocationMutationEpoch: input.observedLocationMutationEpoch,
          now,
        }
      }).pipe(Effect.mapError((error) => (error instanceof RuntimeError ? error : runtimeError(error))))

    const settleActivity: Interface["settleActivity"] = (selection, state) =>
      contexts.settleActivity({ activityId: selection.activityId, state }).pipe(
        Effect.asVoid,
        Effect.ensuring(authorization.remove(selection.sessionId)),
        Effect.mapError((error) => runtimeError(error)),
      )

    const settleOrphanedActivities: Interface["settleOrphanedActivities"] = () =>
      Effect.gen(function* () {
        // Restart recovery (BUG-003), mirroring the global semantics of the legacy
        // SessionPromptIntent.recoverActiveActivities: an activity still `active` at startup
        // belongs to a dead run loop (the previous process died or was killed mid-turn) and would
        // otherwise lock the session's partial unique index forever. Best-effort per row; real DB
        // failures surface through the error channel.
        const active = yield* database.db
          .select({ activityId: SessionActivityTable.activity_id, sessionId: SessionActivityTable.session_id })
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.state, "active"))
          .all()
          .pipe(Effect.mapError(runtimeError))
        yield* Effect.forEach(active, (row) =>
          Effect.gen(function* () {
            yield* contexts.settleActivity({ activityId: row.activityId, state: "interrupted" }).pipe(Effect.ignore)
            yield* authorization.remove(row.sessionId).pipe(Effect.ignore)
          }),
        )
        return active.length
      })

    const replayIndeterminate: Interface["replayIndeterminate"] = (input) =>
      Effect.gen(function* () {
        const attempt = yield* attempts.get(input.attemptId)
        if (!attempt || attempt.sessionId !== input.session.id || attempt.state !== "indeterminate_after_crash") {
          return yield* new RuntimeError({ reason: "provider_attempt_not_indeterminate" })
        }
        const selection = yield* contexts.getSelection(attempt.selectionId)
        if (!selection || selection.sessionId !== input.session.id) {
          return yield* new RuntimeError({ reason: "selection_unavailable" })
        }
        const handle = yield* runtime.current()
        if (
          !handle ||
          handle.identity.locationKey !== selection.locationKey ||
          handle.identity.securityNamespaceId !== selection.securityNamespaceId ||
          handle.identity.projectScopeKey !== selection.projectScopeKey
        ) {
          return yield* new RuntimeError({ reason: "location_unavailable" })
        }
        const now = input.now ?? Date.now()
        if (selection.nextRevalidationAt <= now) {
          return yield* new RuntimeError({ reason: "selection_revalidation_required" })
        }
        const priorValidation = yield* database.db
          .select({ egressEpoch: SessionContextValidationTable.egress_epoch })
          .from(SessionContextValidationTable)
          .where(
            and(
              eq(SessionContextValidationTable.selection_id, selection.selectionId),
              eq(SessionContextValidationTable.provider_turn_seq, attempt.providerTurnSeq),
            ),
          )
          .orderBy(desc(SessionContextValidationTable.validated_at))
          .get()
          .pipe(Effect.orDie)
        if (!priorValidation) return yield* new RuntimeError({ reason: "selection_validation_unavailable" })
        const envelope: ContextQueryAuthorization.Envelope = {
          principal: {
            securityNamespaceId: handle.identity.securityNamespaceId,
            principalId: input.session.parentID ? `subagent:${input.session.id}` : "local-user",
            authorizationEpoch: selection.authorizationEpoch,
            locationKeys: [handle.identity.locationKey],
            projectScopeKeys: [handle.identity.projectScopeKey],
            sessionIds: [input.session.id],
            subjectIds: input.session.parentID ? [] : ["local-user"],
            allowBuiltin: true,
          },
          egress: {
            policyId: `provider:${attempt.providerId}`,
            epoch: priorValidation.egressEpoch,
            graphs: [...new Set(selection.selectedRefs.map((selected) => selected.ref.graph))],
            sensitivities: [...new Set(selection.selectedRefs.map((selected) => selected.sensitivity))],
          },
        }
        const replayReleasedKnowledge = yield* requireReleasedKnowledgeBinding({
          binding: selection.releasedKnowledgeBinding,
          identity: handle.identity,
        })
        const refreshed = yield* refreshSelected({
          selected: selection.selectedRefs,
          statuses: selection.graphStatuses,
          query,
          envelope,
          sessionId: input.session.id,
          toolCall: true,
          releasedKnowledgeSelection: replayReleasedKnowledge,
          now,
        })
        if (
          refreshed.hits.length !== selection.selectedRefs.length ||
          sourceFingerprint(refreshed.hits) !== selection.selectedSourceFingerprint
        ) {
          return yield* new RuntimeError({ reason: "selected_source_changed" })
        }
        const latest = yield* database.db
          .select({ providerTurnSeq: SessionProviderAttemptTable.provider_turn_seq })
          .from(SessionProviderAttemptTable)
          .where(eq(SessionProviderAttemptTable.session_id, input.session.id))
          .orderBy(desc(SessionProviderAttemptTable.provider_turn_seq))
          .get()
          .pipe(Effect.orDie)
        const providerTurnSeq = (latest?.providerTurnSeq ?? -1) + 1
        yield* contexts.appendValidation({
          selectionId: selection.selectionId,
          providerTurnSeq,
          authorizationEpoch: selection.authorizationEpoch,
          egressEpoch: priorValidation.egressEpoch,
          observedLocationMutationEpoch: selection.observedLocationMutationEpoch,
          selectedSourceFingerprint: selection.selectedSourceFingerprint,
          validatedAt: now,
          validUntil: Math.min(now + ValidationMs, selection.nextRevalidationAt),
          outcome: "valid",
          reasonCode: "explicit_replay_selected_sources_current",
        })
        const resolved = yield* attempts.resolve({
          attemptId: input.attemptId,
          recoveryOwnerToken: input.recoveryOwnerToken,
          actor: {
            type: "user",
            id: input.actorId,
            canResolve: true,
            canAcknowledgeReplayRisk: true,
          },
          decision: "replayed",
          riskAcknowledged: input.riskAcknowledged,
          reason: input.reason,
          replay: {
            sessionId: selection.sessionId,
            providerTurnSeq,
            authorizationEpoch: selection.authorizationEpoch,
            egressEpoch: priorValidation.egressEpoch,
            selectedSourceFingerprint: selection.selectedSourceFingerprint,
            observedLocationMutationEpoch: selection.observedLocationMutationEpoch,
          },
          now,
        })
        if (!resolved.replay) return yield* new RuntimeError({ reason: "provider_replay_not_prepared" })
        return { attempt: resolved.attempt, replay: resolved.replay }
      }).pipe(Effect.mapError((error) => (error instanceof RuntimeError ? error : runtimeError(error))))

    const releasedKnowledgeForActiveSession: Interface["releasedKnowledgeForActiveSession"] = (sessionId) =>
      Effect.gen(function* () {
        const row = yield* database.db
          .select({ selectionId: SessionContextSelectionTable.selection_id })
          .from(SessionContextSelectionTable)
          .innerJoin(
            SessionActivityTable,
            eq(SessionActivityTable.activity_id, SessionContextSelectionTable.activity_id),
          )
          .where(and(eq(SessionContextSelectionTable.session_id, sessionId), eq(SessionActivityTable.state, "active")))
          .orderBy(desc(SessionContextSelectionTable.revision))
          .get()
          .pipe(Effect.orDie)
        if (!row) return undefined
        const selection = yield* contexts.getSelection(row.selectionId)
        if (!selection) return yield* new RuntimeError({ reason: "selection_unavailable" })
        const handle = yield* runtime.current()
        if (
          !handle ||
          handle.identity.locationKey !== selection.locationKey ||
          handle.identity.securityNamespaceId !== selection.securityNamespaceId ||
          handle.identity.projectScopeKey !== selection.projectScopeKey
        ) {
          return yield* new RuntimeError({ reason: "location_unavailable" })
        }
        return {
          pinned: true as const,
          selection: yield* requireReleasedKnowledgeBinding({
            binding: selection.releasedKnowledgeBinding,
            identity: handle.identity,
          }),
        }
      }).pipe(Effect.mapError((error) => (error instanceof RuntimeError ? error : runtimeError(error))))

    const requireReleasedKnowledgeBinding = Effect.fn("SessionFederatedContext.requireReleasedKnowledgeBinding")(
      function* (input: { readonly binding: DeepAgentReleasedSnapshot.Binding; readonly identity: Identity }) {
        if (input.binding.state === "unavailable") return undefined
        const selection = yield* DeepAgentReleasedSnapshot.get(
          database.db,
          {
            securityNamespaceId: input.identity.securityNamespaceId,
            projectScopeKey: input.identity.projectScopeKey,
            legacyProjectId: input.identity.observedProjectId ?? projectIdForWorkspace(input.identity.canonicalRoot),
          },
          input.binding.snapshotId,
        ).pipe(Effect.mapError((error) => new RuntimeError({ reason: error._tag })))
        if (!DeepAgentReleasedSnapshot.matchesBinding(selection, input.binding)) {
          return yield* new RuntimeError({ reason: "released_knowledge_binding_mismatch" })
        }
        return selection
      },
    )

    return Service.of({
      recover,
      resolve,
      prepareProviderTurn,
      settleActivity,
      settleOrphanedActivities,
      replayIndeterminate,
      releasedKnowledgeForActiveSession,
    })
  }),
)

const databaseLayer = Database.defaultLayer
const tokenLayer = LiveContextTokenCodec.defaultLayer
const artifactLayer = LiveContextArtifactStore.defaultLayer.pipe(
  Layer.provide(tokenLayer),
  Layer.provide(databaseLayer),
)
const contextLayer = SessionContext.layer.pipe(Layer.provide(Layer.merge(databaseLayer, artifactLayer)))
const attemptLayer = SessionProviderAttempt.layer.pipe(Layer.provide(databaseLayer))
const queryLayer = LiveFederatedContextQuery.productionLayer.pipe(Layer.provide(LocationIndexRuntime.defaultLayer))

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      databaseLayer,
      LocationIndexRuntime.defaultLayer,
      LiveContextQueryAuthorization.defaultLayer,
      tokenLayer,
      artifactLayer,
      contextLayer,
      attemptLayer,
      queryLayer,
    ),
  ),
)

function envelopeFor(input: {
  readonly session: Session.Info
  readonly model: Provider.Model
  readonly identity: Identity
  readonly agent: Agent.Info
  readonly authorizationEpoch: number
  readonly egressEpoch: number
}) {
  const principal: Principal = {
    securityNamespaceId: input.identity.securityNamespaceId,
    principalId: input.session.parentID ? `subagent:${input.session.id}` : "local-user",
    authorizationEpoch: input.authorizationEpoch,
    locationKeys: [input.identity.locationKey],
    projectScopeKeys: [input.identity.projectScopeKey],
    sessionIds: [input.session.id],
    subjectIds: input.session.parentID ? [] : ["local-user"],
    allowBuiltin: true,
  }
  const requestedSensitivities: unknown = input.model.options?.contextEgressSensitivities
  const egress: EgressPolicy = {
    policyId: `provider:${input.model.providerID}`,
    epoch: input.egressEpoch,
    graphs: GraphKind.literals.filter(
      (graph) =>
        Permission.evaluate("context_query", graph, input.agent.permission, input.session.permission ?? []).action ===
        "allow",
    ),
    sensitivities: Array.isArray(requestedSensitivities)
      ? Sensitivity.literals.filter((sensitivity) => requestedSensitivities.includes(sensitivity))
      : ["public", "source_code", "secret_adjacent"],
  }
  return { principal, egress }
}

function evidence(hit: FederatedContextQuery.Hit, token: string): ContextProjection.Evidence {
  return {
    graph: hit.graph,
    ref: token,
    revision: hit.ref.revision,
    freshness: hit.validity?.state === "current" ? "current" : hit.validity ? "historical" : "unknown",
    trust:
      hit.graph === "knowledge"
        ? "governed_guidance"
        : hit.graph === "memory"
          ? "historical_evidence"
          : "repository_evidence",
    title: hit.title.slice(0, 160),
    evidence: (hit.excerpt ?? hit.title).slice(0, hit.graph === "code" ? 1_200 : 600),
    score: hit.score,
  }
}

function projectionStatuses(statuses: readonly GraphQueryStatus[]) {
  return statuses.flatMap((status): readonly ContextProjection.Status[] => {
    if (status.kind === "complete" && status.outcome === "matched") return []
    if (status.kind === "complete")
      return [{ graph: status.graph, state: "ready_empty", reasonCode: status.reasonCode ?? "ready_empty" }]
    if (status.kind === "partial") return [{ graph: status.graph, state: status.state, reasonCode: status.reasonCode }]
    if (status.kind === "blocked") return [{ graph: status.graph, state: status.state, reasonCode: status.reasonCode }]
    return [{ graph: status.graph, state: "unavailable", reasonCode: status.reasonCode }]
  })
}

function graphRevisions(
  statuses: readonly GraphQueryStatus[],
  hits: readonly FederatedContextQuery.Hit[],
): Readonly<Record<typeof GraphKind.Type, string>> {
  return Object.fromEntries(
    GraphKind.literals.map((graph) => {
      const revisions = statuses
        .find((status) => status.graph === graph)
        ?.revisions.map((revision) => ({ source: revision.source, revision: revision.revision, state: revision.state }))
      return [
        graph,
        Hash.sha256(
          JSON.stringify(
            revisions ??
              hits
                .filter((hit) => hit.graph === graph)
                .map((hit) => ContextReference.canonicalContextRef(hit.ref))
                .toSorted(),
          ),
        ),
      ]
    }),
  ) as Readonly<Record<typeof GraphKind.Type, string>>
}

function sourceFingerprint(hits: readonly FederatedContextQuery.Hit[]) {
  return Hash.sha256(
    JSON.stringify(
      hits
        .map((hit) => ({
          ref: ContextReference.canonicalContextRef(hit.ref),
          sensitivity: hit.sensitivity,
          validity: hit.validity,
        }))
        .toSorted((a, b) => a.ref.localeCompare(b.ref)),
    ),
  )
}

function refreshSelected(input: {
  readonly selected: readonly SessionContext.SelectedRef[]
  readonly statuses: readonly GraphQueryStatus[]
  readonly query: FederatedContextQuery.Interface
  readonly envelope: ContextQueryAuthorization.Envelope
  readonly sessionId: string
  readonly toolCall: boolean
  readonly releasedKnowledgeSelection?: DeepAgentReleasedSnapshot.Selection
  readonly now: number
}) {
  return Effect.forEach(
    input.selected,
    (selected) => {
      const decision = ContextAuthorization.authorize({
        ref: selected.ref,
        principal: input.envelope.principal,
        egress: input.envelope.egress,
        sensitivity: selected.sensitivity,
      })
      if (!decision.allowed) {
        return Effect.succeed({
          graph: selected.ref.graph,
          status: ContextFederation.status.blocked({
            graph: selected.ref.graph,
            state: "denied",
            reasonCode: decision.reason === "provider_egress_denied" ? "provider_egress_denied" : "scope_denied",
            revisions: [],
          }),
          hit: undefined,
        })
      }
      return input.query
        .query({
          intent: "related",
          ref: selected.ref,
          sources: [selected.ref.graph],
          limit: 100,
          consistency: "stale_ok",
          principal: input.envelope.principal,
          egress: input.envelope.egress,
          sessionId: input.sessionId,
          toolCall: input.toolCall,
          releasedKnowledgeSelection: input.releasedKnowledgeSelection,
        })
        .pipe(
          Effect.map((result) => ({
            graph: selected.ref.graph,
            status:
              result.statuses.find((status) => status.graph === selected.ref.graph) ??
              ContextFederation.status.notQueried(selected.ref.graph),
            hit: result.hits.find(
              (hit) =>
                hit.ref.graph === selected.ref.graph &&
                hit.ref.entityId === selected.ref.entityId &&
                hit.validity?.state !== "expired" &&
                hit.validity?.state !== "superseded",
            ),
          })),
          Effect.catch(() =>
            Effect.succeed({
              graph: selected.ref.graph,
              status: ContextFederation.status.partial({
                graph: selected.ref.graph,
                state: "degraded",
                reasonCode: "source_error",
                revisions: input.statuses.find((status) => status.graph === selected.ref.graph)?.revisions ?? [],
              }),
              hit: undefined,
            }),
          ),
        )
    },
    { concurrency: 4 },
  ).pipe(
    Effect.map((results) => ({
      hits: results.flatMap((result): readonly FederatedContextQuery.Hit[] => (result.hit ? [result.hit] : [])),
      statuses: GraphKind.literals.map(
        (graph) =>
          results
            .filter((result) => result.graph === graph)
            .map((result) => result.status)
            .toSorted((a, b) => statusPriority(b) - statusPriority(a))[0] ??
          input.statuses.find((status) => status.graph === graph) ??
          ContextFederation.status.notQueried(graph),
      ),
    })),
  )
}

function statusPriority(status: GraphQueryStatus) {
  if (status.kind === "blocked") return 4
  if (status.kind === "partial") return 3
  if (status.kind === "not_queried") return 2
  if (status.outcome === "empty") return 1
  return 0
}

function runtimeError(error: unknown) {
  const reason =
    error && typeof error === "object" && "_tag" in error
      ? `${String(error._tag)}${"reason" in error && typeof error.reason === "string" ? `:${error.reason}` : ""}`
      : errorCode(error)
  return new RuntimeError({ reason })
}

function errorCode(error: unknown) {
  if (error instanceof Error) return error.name || "provider_error"
  return "provider_error"
}
