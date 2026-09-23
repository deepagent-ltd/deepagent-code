import { eq, inArray, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { SessionProviderOwner } from "../../src/context-federation/provider-owner"
import { SessionProviderAttempt } from "../../src/context-federation/provider-attempt"
import { Database } from "../../src/database/database"
import { ProjectV2 } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { SessionSchema } from "../../src/session/schema"
import { SessionInputTable, SessionTable } from "../../src/session/sql"
import {
  SessionActivityTable,
  SessionContextValidationTable,
} from "../../src/context-federation/session-sql"
import { PreparedProviderTurn } from "../../src/session/runner/prepared-provider-turn"
import { V2ProviderTurn } from "../../src/session/runner/v2-provider-turn"
import { V2ProviderTurnReceiptTable } from "../../src/session/runner/v2-provider-turn.sql"
import { Hash } from "../../src/util/hash"

const [mode, filename, marker, receiptID] = process.argv.slice(2)
if (!mode || !filename || !marker)
  throw new Error("usage: v2-provider-owner-process <dispatch|recover> <db> <marker> [receipt]")

const database = Database.layerFromPath(filename)
const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
const attempts = SessionProviderAttempt.layer.pipe(Layer.provide(database))
const ownerToken = mode === "dispatch" ? "v2-release-process-a" : "v2-release-process-b"
const turns = V2ProviderTurn.layerWith({ ownerToken, leaseMs: 300 }).pipe(
  Layer.provide(owners),
  Layer.provide(database),
)
const layer = Layer.mergeAll(database, owners, attempts, turns)
const projectID = ProjectV2.ID.make("project-v2-release-takeover")
const sessionID = SessionSchema.ID.make("ses_v2_release_takeover")

const program = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const service = yield* V2ProviderTurn.Service
  if (mode === "dispatch") {
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: AbsolutePath.make("/tmp/v2-release-takeover"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: "v2-release-takeover",
        directory: AbsolutePath.make("/tmp/v2-release-takeover"),
        title: "V2 release takeover",
        version: "release-test",
      })
      .onConflictDoNothing()
      .run()
    const receipt = yield* service.admit({
      sessionId: sessionID,
      userMessageId: "msg-v2-release-takeover",
      historyPromptEpoch: 0,
      requestInputHash: Hash.sha256("v2-release-takeover-request"),
      providerId: "release-provider",
      modelId: "release-model",
      protocol: "openai-chat",
      ownerMode: "v2",
    })
    const wireHash = Hash.sha256("v2-release-physical-wire")
    const prepared = PreparedProviderTurn.prepare({
      sessionID,
      requestOrdinal: receipt.requestOrdinal,
      activityID: receipt.activityId,
      providerTurnSeq: receipt.providerTurnSeq,
      owner: "v2",
      stableSystemParts: [],
      volatileSystemParts: [],
      historyMessages: [],
      historyPromptEpoch: 0,
      historySourceEndMessageID: null,
      contextSelectionID: null,
      contextProjectionHash: null,
      contextReadiness: "unavailable",
      contextSelectedRefs: [],
      toolRegistryIDs: [],
      toolPermissionFilteredIDs: [],
      toolFinalOfferedIDs: [],
      toolDefinitions: [],
      toolChoice: null,
      toolCapability: "supported",
      toolLoweringOutcome: "ok",
      toolResultReferences: [],
      samplingModelID: "release-model",
      samplingProviderID: "release-provider",
      budget: {
        decision: "ok",
        estimatedFullRequestTokens: 1,
        physicalInputBudget: 10,
        reservedOutputTokens: 1,
        safetyMargin: 1,
        provenance: "model_limit",
      },
      wireRequestHash: wireHash,
      receiptID: receipt.receiptId,
      userMessageID: receipt.userMessageId,
    })
    // Production-shaped dispatch crash (RI-53 binding): the runner's real admission path durably
    // writes the input row, the activity, the context selection + validation, and the session
    // execution claim BEFORE preparing the attempt; the startup classifier then requires the exact
    // receipt↔attempt binding. A bare admit+seal receipt (the pre-RI-53 fixture shape) is
    // unclassified and blocks boot, so this fixture builds the full durable chain by hand.
    const now = Date.now()
    yield* db
      .insert(SessionInputTable)
      .values({
        id: "msg-v2-release-takeover" as never,
        session_id: sessionID,
        prompt: { text: "v2-release-takeover" } as never,
        delivery: "steer",
        admitted_seq: 1,
        time_created: now,
      })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionActivityTable)
      .values({
        activity_id: receipt.activityId,
        session_id: sessionID,
        ordinal: 1,
        trigger_input_id: "msg-v2-release-takeover",
        delivery: "steer",
        state: "active",
        created_at: now,
      })
      .onConflictDoNothing()
      .run()
    // Released-knowledge authority chain (insert guards): namespace → project scope → location
    // identity, then the selection carries an `unavailable` binding with the empty-refs fingerprint.
    const securityNamespaceID = "release-takeover-namespace"
    const projectScopeKey = "release-takeover-scope"
    const locationKey = "release-takeover-location"
    yield* db
      .run(
        sql`INSERT INTO context_security_namespace (id, kind, binding_hash, created_at)
            VALUES (${securityNamespaceID}, 'workspace', ${Hash.sha256("release-takeover-namespace")}, ${now})`,
      )
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`INSERT INTO context_project_scope_identity (security_namespace_id, project_scope_key, project_kind, project_identity_hash, created_at)
            VALUES (${securityNamespaceID}, ${projectScopeKey}, 'registered_root', ${Hash.sha256("release-takeover-scope")}, ${now})`,
      )
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`INSERT INTO context_location_identity (security_namespace_id, location_key, project_scope_key, canonical_root, created_at)
            VALUES (${securityNamespaceID}, ${locationKey}, ${projectScopeKey}, ${"/tmp/v2-release-takeover"}, ${now})`,
      )
      .pipe(Effect.orDie)
    const selectionID = "release-takeover-selection"
    const projectionHash = Hash.sha256("release-takeover-projection")
    yield* db
      .run(
        sql`INSERT INTO session_context_selection (
              selection_id, session_id, activity_id, revision, trigger_input_id,
              location_key, security_namespace_id, project_scope_key,
              query_fingerprint, authorization_fingerprint, authorization_epoch,
              execution_fingerprint, selected_source_fingerprint,
              observed_location_mutation_epoch, next_revalidation_at,
              released_knowledge_binding_state, released_knowledge_exact_refs,
              released_knowledge_exact_refs_fingerprint,
              graph_revisions, graph_statuses, selected_refs, projection,
              projection_hash, token_count, artifact_write_status, inline_audit, created_at
            ) VALUES (
              ${selectionID}, ${sessionID}, ${receipt.activityId}, 1, ${"msg-v2-release-takeover"},
              ${locationKey}, ${securityNamespaceID}, ${projectScopeKey},
              ${Hash.sha256("release-takeover-query")}, ${Hash.sha256("release-takeover-authz")}, 0,
              ${Hash.sha256("release-takeover-execution")}, ${"release-takeover-fingerprint"},
              0, ${now + 60_000},
              "unavailable", "[]",
              ${Hash.sha256("[]")},
              "{}", "{}", "[]", "{}",
              ${projectionHash}, 1, "degraded_unavailable", "{}", ${now}
            ) ON CONFLICT DO NOTHING`,
      )
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionContextValidationTable)
      .values({
        validation_id: "release-takeover-validation",
        selection_id: selectionID,
        provider_turn_seq: receipt.providerTurnSeq,
        authorization_epoch: 0,
        egress_epoch: 0,
        observed_location_mutation_epoch: 0,
        selected_source_fingerprint: "release-takeover-fingerprint",
        validated_at: now,
        valid_until: now + 60_000,
        outcome: "valid",
        reason_code: "release-takeover-fixture",
      })
      .onConflictDoNothing()
      .run()
    yield* db
      .update(SessionTable)
      .set({ execution_claim_token: now })
      .where(eq(SessionTable.id, sessionID))
      .run()
    const attempt = yield* (yield* SessionProviderAttempt.Service).prepare({
      sessionId: sessionID,
      activityId: receipt.activityId,
      providerTurnSeq: receipt.providerTurnSeq,
      selectionId: selectionID,
      projectionHash,
      requestHash: receipt.requestInputHash,
      providerId: "release-provider",
      ownerToken,
      authorizationEpoch: 0,
      egressEpoch: 0,
      selectedSourceFingerprint: "release-takeover-fingerprint",
      observedLocationMutationEpoch: 0,
    })
    const bound = yield* service.bindAttempt(receipt, attempt.attemptId)
    const attemptService = yield* SessionProviderAttempt.Service
    yield* attemptService.sealPrepared({
      attemptId: attempt.attemptId,
      expectedOwnerToken: ownerToken,
      preparedTurnHash: prepared.prepared_turn_hash,
      wireRequestHash: wireHash,
    })
    yield* service.seal(bound, prepared, {
      wireHash,
      bodyHash: Hash.sha256("v2-release-body"),
      bodyLength: 1,
      contentType: "application/json",
    })
    // service.seal atomically marks BOTH the receipt and the bound attempt dispatching.
    yield* Effect.promise(() => Bun.write(marker, `${JSON.stringify(["dispatched"])}\n`))
    console.log(JSON.stringify({ receiptId: receipt.receiptId }))
    process.exit(0)
  }

  if (!receiptID) throw new Error("recover mode requires receipt ID")
  const current = yield* service.get(receiptID)
  const oldOwnerHeartbeat = yield* (yield* SessionProviderOwner.Service)
    .heartbeat({ ownerToken: "v2-release-process-a", leaseMs: 300 })
    .pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "unexpected_success" }))
  const activeV2 = yield* db
    .select({ id: V2ProviderTurnReceiptTable.receipt_id })
    .from(V2ProviderTurnReceiptTable)
    .where(inArray(V2ProviderTurnReceiptTable.state, ["preparing", "dispatching", "streaming"]))
    .all()
  const physical = yield* Effect.promise(() => Bun.file(marker).json() as Promise<string[]>)
  const recovered = yield* service.recover()
  const after = yield* db
    .select({ state: V2ProviderTurnReceiptTable.state })
    .from(V2ProviderTurnReceiptTable)
    .where(eq(V2ProviderTurnReceiptTable.receipt_id, receiptID))
    .get()
  console.log(
    JSON.stringify({
      state: current?.state ?? after?.state,
      errorCode: current?.errorCode,
      recovered,
      activeV2: activeV2.length,
      oldOwnerHeartbeat,
      physicalDispatches: physical.length,
    }),
  )
})

await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
