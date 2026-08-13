import { describe, expect, test } from "bun:test"
import { ContextFederation } from "@deepagent-code/core/context-federation/federation"
import { SessionProviderAttempt } from "@deepagent-code/core/context-federation/provider-attempt"
import {
  SessionActivityTable,
  SessionContextSelectionTable,
  SessionProviderAttemptResolutionTable,
  SessionProviderAttemptTable,
} from "@deepagent-code/core/context-federation/session-sql"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
import { SessionToolRequestReceiptTable } from "../../src/session/tool-request-receipt.sql"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Effect, Layer } from "effect"
import { ContextFederationDiagnostics } from "../../src/context-federation/diagnostics"
import { ContextFederationObservability } from "../../src/context-federation/observability"
import { SessionFederatedContext } from "../../src/context-federation/session-context-runtime"
import { Session } from "../../src/session/session"

const projectId = ProjectV2.ID.make("project-context-diagnostics")
const sessionId = SessionSchema.ID.make("ses_context_diagnostics")
const inputId = SessionMessage.ID.make("msg_context_diagnostics")
const activityId = "activity_context_diagnostics"
const selectionId = "selection_context_diagnostics"
const attemptId = "attempt_context_diagnostics"

describe("ContextFederationDiagnostics", () => {
  test("returns opaque evidence and requires durable terminal evidence before settle", async () => {
    ContextFederationObservability.reset()
    const database = Database.layerFromPath(":memory:")
    const attemptLayer = SessionProviderAttempt.layer.pipe(Layer.provide(database))
    const messages = { value: [] as SessionV1.WithParts[] }
    const sessionLayer = Layer.succeed(Session.Service, {
      messages: () => Effect.sync(() => messages.value),
    } as unknown as Session.Interface)
    const federationLayer = Layer.succeed(SessionFederatedContext.Service, {
      recover: () => Effect.succeed(0),
      resolve: () => Effect.die("not used"),
      prepareProviderTurn: () => Effect.die("not used"),
      settleActivity: () => Effect.void,
      replayIndeterminate: () => Effect.die("not used"),
    } satisfies SessionFederatedContext.Interface)
    const diagnostics = ContextFederationDiagnostics.layer.pipe(
      Layer.provide(database),
      Layer.provide(attemptLayer),
      Layer.provide(sessionLayer),
      Layer.provide(federationLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seed(db)
        const service = yield* ContextFederationDiagnostics.Service
        yield* db
          .insert(SessionToolRequestReceiptTable)
          .values({
            receipt_id: "receipt_context_legacy",
            request_ordinal: 1,
            session_id: sessionId,
            user_message_id: inputId,
            assistant_message_id: null,
            provider_attempt_id: attemptId,
            provider_id: "provider-test",
            model_id: "model-test",
            protocol: "chat",
            registry_tool_ids: [],
            permission_filtered_tool_ids: [],
            final_offered_tool_ids: [],
            call_ids: [],
            provider_state: "indeterminate_after_crash",
            request_state: "dispatched",
            request_error_code: "provider_started_outcome_unknown_after_process_restart",
            owner_token: "dead-process",
            created_at: 35,
          })
          .run()
        const bypass = yield* db
          .insert(SessionProviderAttemptResolutionTable)
          .values({
            resolution_id: "resolution_context_legacy_bypass",
            attempt_id: attemptId,
            actor_type: "user",
            actor_id: "local-user",
            decision: "abandoned",
            provider_evidence: null,
            risk_acknowledged: false,
            reason: "attempt to bypass unified recovery",
            created_at: 40,
          })
          .run()
          .pipe(Effect.orDie, Effect.exit)
        expect(bypass._tag).toBe("Failure")
        expect(String(bypass)).toContain("provider_attempt_requires_unified_legacy_recovery")
        const blocked = yield* service
          .resolveAttempt({
            session: { id: sessionId } as Session.Info,
            attemptId,
            decision: "abandoned",
            reason: "do not split recovery authorities",
            riskAcknowledged: false,
            actorId: "local-user",
            now: 50,
          })
          .pipe(Effect.flip)
        expect(blocked).toMatchObject({ reason: "legacy_provider_recovery_required" })
        expect((yield* db.select().from(SessionProviderAttemptTable).get())?.state).toBe("indeterminate_after_crash")
        expect(yield* db.select().from(SessionProviderAttemptResolutionTable).all()).toEqual([])
        expect((yield* db.select().from(SessionToolRequestReceiptTable).get())?.provider_state).toBe(
          "indeterminate_after_crash",
        )
        yield* db.delete(SessionToolRequestReceiptTable).run()
        const first = yield* service.get(sessionId, 50)
        expect(first.selections[0]).toMatchObject({
          summary: "partial",
          artifact: { status: "degraded_unavailable", reasonCode: "QuotaExceededError" },
          evidence: [{ token: "ctx_opaque", provenance: ["ctx_provenance"] }],
        })
        expect(first.attempts[0]).toMatchObject({
          state: "indeterminate_after_crash",
          canAbandon: true,
          canSettle: false,
          canReplay: true,
        })
        const serialized = JSON.stringify(first)
        expect(serialized).not.toContain("SECRET SOURCE BODY")
        expect(serialized).not.toContain("src/private.ts")
        expect(serialized).not.toContain("entity-private")
        expect(first.metrics.alerts).toContainEqual({
          graph: "documents",
          state: "degraded",
          reasonCode: "source_error",
        })
        expect(first.metrics.shadow).toMatchObject({
          comparisons: 1,
          legacyKnowledgeRefs: 2,
          legacyMemoryRefs: 1,
          federated: { code: 1, knowledge: 1, memory: 0, documents: 1 },
          knowledgeMemoryDelta: -2,
        })

        const missingEvidence = yield* service
          .resolveAttempt({
            session: { id: sessionId } as Session.Info,
            attemptId,
            decision: "settled",
            reason: "provider completed",
            riskAcknowledged: false,
            actorId: "local-user",
            now: 60,
          })
          .pipe(Effect.flip)
        expect(missingEvidence.reason).toBe("persisted_terminal_event_required")

        messages.value = [terminalMessage()]
        expect((yield* service.get(sessionId, 61)).attempts[0]?.canSettle).toBe(true)
        const settled = yield* service.resolveAttempt({
          session: { id: sessionId } as Session.Info,
          attemptId,
          decision: "settled",
          reason: "durable assistant message completed",
          riskAcknowledged: false,
          actorId: "local-user",
          now: 62,
        })
        expect(settled.state).toBe("resolved_settled")
        expect((yield* db.select().from(SessionActivityTable).get())?.state).toBe("settled")
      }).pipe(Effect.provide(Layer.merge(database, diagnostics)), Effect.scoped),
    )
  })
})

function seed(db: Database.Interface["db"]) {
  const statuses = [
    ContextFederation.status.matched("code", [{ source: "code", revision: "code:1", state: "ready" }]),
    ContextFederation.status.empty("knowledge", [{ source: "knowledge", revision: "knowledge:1", state: "ready" }]),
    ContextFederation.status.empty("memory", [{ source: "memory", revision: "memory:1", state: "ready" }]),
    ContextFederation.status.partial({
      graph: "documents",
      state: "degraded",
      reasonCode: "source_error",
      revisions: [{ source: "repo_documents", state: "degraded", reasonCode: "source_error" }],
    }),
  ]
  ContextFederationObservability.observeQuery({
    statuses,
    candidates: { code: 2 },
    selected: { code: 1 },
    rejected: { code: 1 },
    latencyMs: 12,
    observedAt: 40,
  })
  ContextFederationObservability.observeShadowComparison({
    legacyKnowledgeRefs: 2,
    legacyMemoryRefs: 1,
    federated: { code: 1, knowledge: 1, memory: 0, documents: 1 },
  })
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({
        id: projectId,
        worktree: AbsolutePath.make("/tmp/context-diagnostics"),
        sandboxes: [],
      })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionId,
        project_id: projectId,
        slug: "diagnostics",
        directory: "/tmp/context-diagnostics",
        title: "Diagnostics",
        version: "test",
      })
      .run()
    yield* db
      .insert(SessionInputTable)
      .values({
        id: inputId,
        session_id: sessionId,
        prompt: new Prompt({ text: "inspect context" }),
        delivery: "steer",
        admitted_seq: 0,
        promoted_seq: 0,
      })
      .run()
    yield* db
      .insert(SessionActivityTable)
      .values({
        activity_id: activityId,
        session_id: sessionId,
        ordinal: 0,
        trigger_input_id: inputId,
        delivery: "steer",
        state: "active",
        created_at: 10,
      })
      .run()
    yield* db
      .insert(SessionContextSelectionTable)
      .values({
        selection_id: selectionId,
        session_id: sessionId,
        activity_id: activityId,
        revision: 0,
        trigger_input_id: inputId,
        location_key: "loc_context_diagnostics",
        query_fingerprint: "query",
        authorization_fingerprint: "authorization",
        authorization_epoch: 1,
        execution_fingerprint: "execution",
        selected_source_fingerprint: "sources",
        observed_location_mutation_epoch: 1,
        next_revalidation_at: 1_000,
        graph_revisions: JSON.stringify({ code: "1", knowledge: "1", memory: "1", documents: "1" }),
        graph_statuses: JSON.stringify(statuses),
        selected_refs: JSON.stringify([
          {
            ref: {
              graph: "code",
              entityId: "entity-private",
              binding: { scope: "builtin" },
              locator: { path: "src/private.ts" },
              revision: "code:1",
            },
            token: "ctx_opaque",
            provenanceTokens: ["ctx_provenance"],
            relations: [{ relation: "implements", token: "ctx_relation", freshness: "broken" }],
            freshness: "current",
            sensitivity: "source_code",
            score: 0.9,
            reason: "federated_rank",
            excerpt: "SECRET SOURCE BODY",
            projectionStart: 0,
            projectionEnd: 10,
          },
        ]),
        projection: "project-context-json-v1 bytes=2\n{}",
        projection_hash: "projection",
        token_count: 8,
        artifact_write_status: "degraded_unavailable",
        inline_audit: JSON.stringify({ reasonCode: "QuotaExceededError" }),
        created_at: 20,
      })
      .run()
    yield* db
      .insert(SessionProviderAttemptTable)
      .values({
        attempt_id: attemptId,
        session_id: sessionId,
        activity_id: activityId,
        provider_turn_seq: 0,
        selection_id: selectionId,
        projection_hash: "projection",
        request_hash: "request",
        provider_id: "provider-test",
        state: "indeterminate_after_crash",
        created_at: 30,
        error_code: "process_recovery",
      })
      .run()
  })
}

function terminalMessage(): SessionV1.WithParts {
  return {
    info: {
      id: "msg_assistant_terminal",
      sessionID: sessionId,
      role: "assistant",
      time: { created: 31, completed: 55 },
      parentID: inputId,
      modelID: "model-test",
      providerID: "provider-test",
      providerAttemptID: attemptId,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/context-diagnostics", root: "/tmp/context-diagnostics" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [],
  } as unknown as SessionV1.WithParts
}
