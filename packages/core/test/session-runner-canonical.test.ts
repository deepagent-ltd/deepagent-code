import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../src/database/database"
import { SessionContext } from "../src/context-federation/session-context"
import { ContextQueryAuthorization } from "../src/context-federation/query-authorization"
import { SessionProviderAttempt } from "../src/context-federation/provider-attempt"
import { SessionProviderOwner } from "../src/context-federation/provider-owner"
import { SessionRunnerCanonical } from "../src/session/runner/canonical-turn"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { SessionSchema } from "../src/session/schema"
import { SessionMessage } from "../src/session/message"
import { Prompt } from "../src/session/prompt"
import { SessionInputTable, SessionTable } from "../src/session/sql"
import { SessionContextSelectionTable, SessionProviderAttemptTable } from "../src/context-federation/session-sql"
import { V2ProviderTurnReceiptTable } from "../src/session/runner/v2-provider-turn.sql"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { Hash } from "../src/util/hash"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
const turns = V2ProviderTurn.layer.pipe(Layer.provide(owners), Layer.provide(database))
const attempts = SessionProviderAttempt.layer.pipe(Layer.provide(database))
const contexts = SessionContext.layer.pipe(
  Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
  Layer.provide(database),
)
const it = testEffect(Layer.mergeAll(database, owners, turns, attempts, contexts))
const sessionID = SessionSchema.ID.make("ses_canonical")

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "canonical",
      directory: "/project",
      title: "canonical",
      version: "test",
      // The runner holds the Session execution claim; prepareInTransaction refuses
      // (session_execution_claim_missing) without it.
      execution_claim_token: 104,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionInputTable)
    .values({
      id: SessionMessage.ID.make("msg_trigger"),
      session_id: sessionID,
      admitted_seq: 1,
      prompt: new Prompt({ text: "trigger" }),
      delivery: "steer",
      promoted_seq: 1,
      time_created: 1,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

it.effect("admits one canonical activity and selection for the promoted trigger input", () =>
  Effect.gen(function* () {
    yield* seed
    const { db } = yield* Database.Service
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_trigger"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_trigger",
    })
    expect(admission.activityId).toStartWith("activity_")
    expect(admission.selectionId).toBeTruthy()
    expect(admission.authorizationEpoch).toBe(0)
    expect(admission.readiness).toBe("fallback")
    expect(admission.selectedRefs).toEqual([])

    const second = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: [],
      fallbackUserInputId: "msg_trigger",
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_trigger",
    })
    expect(second.activityId).toBe(admission.activityId)
    expect(second.selectionId).toBe(admission.selectionId)
  }),
)

it.effect("binds explicit context tools to the exact V2 selection authority", () =>
  Effect.gen(function* () {
    yield* seed
    const { db } = yield* Database.Service
    let envelope: ContextQueryAuthorization.Envelope | undefined
    yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_trigger"],
      system: { baseline: "baseline", revision: 7, baselineSeq: 11 },
      historyEndMessageId: "msg_trigger",
    }).pipe(
      Effect.provideService(
        ContextQueryAuthorization.Controller,
        ContextQueryAuthorization.Controller.of({
          bind: (input) => Effect.sync(() => {
            envelope = input.envelope
          }),
          remove: () => Effect.void,
        }),
      ),
    )
    expect(envelope?.principal.principalId).toBe(sessionID)
    expect(envelope?.principal.sessionIds).toEqual([sessionID])
    expect(envelope?.principal.authorizationEpoch).toBe(7)
    expect(envelope?.egress.epoch).toBe(11)
    expect(envelope?.egress.graphs).toEqual(["code", "documents", "knowledge", "memory"])
    expect(envelope?.egress.sensitivities).toEqual(["public", "source_code", "secret_adjacent"])
  }),
)

it.effect("creates attempt and receipt in one recoverable boundary and binds them exactly once", () =>
  Effect.gen(function* () {
    yield* seed
    const { db } = yield* Database.Service
    const providerTurns = yield* V2ProviderTurn.Service
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_trigger"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_trigger",
    })
    const receiptInput = {
      sessionId: sessionID,
      userMessageId: "msg_trigger",
      historyPromptEpoch: 0,
      historySourceEndMessageId: "msg_trigger",
      requestInputHash: Hash.sha256("request-one"),
      providerId: "provider-test",
      modelId: "model-test",
      protocol: "openai-chat",
      ownerMode: "v2" as const,
    }
    const first = yield* SessionRunnerCanonical.commitTurn({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      admission,
      receipt: receiptInput,
      ownerToken: yield* providerTurns.currentOwnerToken(),
    })
    expect(first.attempt.state).toBe("prepared")
    expect(first.receipt.state).toBe("preparing")
    expect(first.receipt.activityId).toBe(admission.activityId)
    expect(first.receipt.providerAttemptId).toBe(first.attempt.attemptId)
    expect(first.receipt.providerTurnSeq).toBe(first.attempt.providerTurnSeq)

    // Exact retry converges onto the same prepared attempt and preparing receipt.
    const retry = yield* SessionRunnerCanonical.commitTurn({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      admission,
      receipt: receiptInput,
      ownerToken: yield* providerTurns.currentOwnerToken(),
    })
    expect(retry.attempt.attemptId).toBe(first.attempt.attemptId)
    expect(retry.receipt.receiptId).toBe(first.receipt.receiptId)
  }),
)

// A provider turn that streams past the 60s selection TTL must NOT kill the session: the durable
// selection row still matching the admitted identity (fingerprints + location epoch) revalidates
// in place. Only real drift (fingerprint mismatch) keeps failing closed.
it.effect("commitTurn past the selection TTL revalidates a matching selection in place", () =>
  Effect.gen(function* () {
    yield* seed
    const { db } = yield* Database.Service
    const providerTurns = yield* V2ProviderTurn.Service
    const admittedAt = 1_000_000
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_trigger"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_trigger",
      now: admittedAt,
    })
    const late = admittedAt + SessionRunnerCanonical.ValidationMs * 4
    const expired = yield* SessionRunnerCanonical.commitTurn({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      admission,
      receipt: {
        sessionId: sessionID,
        userMessageId: "msg_trigger",
        historyPromptEpoch: 0,
        historySourceEndMessageId: "msg_trigger",
        requestInputHash: Hash.sha256("request-late"),
        providerId: "provider-test",
        modelId: "model-test",
        protocol: "openai-chat",
        ownerMode: "v2" as const,
      },
      ownerToken: yield* providerTurns.currentOwnerToken(),
      now: late,
    })
    expect(expired.attempt.state).toBe("prepared")
    expect(expired.receipt.providerTurnSeq).toBe(expired.attempt.providerTurnSeq)

    // Real drift — the durable selection row is gone / superseded — still refuses (fail closed,
    // unchanged §4.1 semantics; the row itself is immutable so in-place fingerprint drift can't
    // occur, but a successor rebuild removes the row's binding for this admission).
    const refused = yield* SessionRunnerCanonical.commitTurn({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      admission: { ...admission, selectionId: "sel_superseded_by_rebuild" },
      receipt: {
        sessionId: sessionID,
        userMessageId: "msg_trigger",
        historyPromptEpoch: 0,
        historySourceEndMessageId: "msg_trigger",
        requestInputHash: Hash.sha256("request-drift"),
        providerId: "provider-test",
        modelId: "model-test",
        protocol: "openai-chat",
        ownerMode: "v2" as const,
      },
      ownerToken: yield* providerTurns.currentOwnerToken(),
      now: late + 1,
    }).pipe(Effect.flip)
    expect(String((refused as { readonly reason?: string }).reason ?? refused)).toContain(
      "selection_revalidation_required",
    )
  }),
)

// §16.3 order 4 package D — the federation selection evidence seam. Wired compositions record the
// session's real federation evidence on the V2 selection commit; unwired keeps v2:local defaults.
const seamSessionID = SessionSchema.ID.make("ses_canonical_seam")

const seamSeed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(SessionTable)
    .values({
      id: seamSessionID,
      project_id: Project.ID.global,
      slug: "canonical-seam",
      directory: "/project",
      title: "canonical seam",
      version: "test",
      execution_claim_token: 104,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionInputTable)
    .values({
      id: SessionMessage.ID.make("msg_trigger_seam"),
      session_id: seamSessionID,
      admitted_seq: 1,
      prompt: new Prompt({ text: "trigger" }),
      delivery: "steer",
      promoted_seq: 1,
      time_created: 1,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

it.effect("commits a real four-graph V2 selection (never v2-none) with explicit statuses", () =>
  Effect.gen(function* () {
    yield* seed
    yield* seamSeed
    const { db } = yield* Database.Service
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID: seamSessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_trigger_seam"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_trigger_seam",
    })
    const row = yield* db
      .select()
      .from(SessionContextSelectionTable)
      .where(eq(SessionContextSelectionTable.selection_id, admission.selectionId))
      .get()
      .pipe(Effect.orDie)
    // C3-08: the V2 turn selection carries four real graph statuses (never the v2-none fallback).
    expect(row).toBeDefined()
    const statuses = JSON.parse(row?.graph_statuses ?? "{}") as Record<string, { status: string }>
    expect(Object.keys(statuses).sort()).toEqual(["code", "documents", "knowledge", "memory"])
    for (const status of Object.values(statuses)) {
      expect(status.status).not.toBe("v2-none")
      expect(["ready", "empty", "degraded_unavailable", "denied", "timeout"]).toContain(status.status)
    }
    expect(row?.graph_revisions).not.toContain("v2-none")
  }),
)

it.effect("keeps explicit graph statuses (never v2-none) when no graph source is wired under the W3 production default", () =>
  Effect.gen(function* () {
    yield* seed
    const { db } = yield* Database.Service
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_trigger"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_trigger",
    })
    const row = yield* db
      .select()
      .from(SessionContextSelectionTable)
      .where(eq(SessionContextSelectionTable.selection_id, admission.selectionId))
      .get()
      .pipe(Effect.orDie)
    // W3.1: the default flag is ON, so the PRODUCTION adapter set runs with the (empty) composition
    // sources: code/documents degrade honestly (source_disabled), knowledge/memory are legitimate
    // empty domains — explicit statuses, never v2-none.
    expect(JSON.parse(row?.graph_revisions ?? "{}")).toEqual({
      code: "code:unavailable",
      documents: "documents:unavailable",
      knowledge: "released:no-store",
      memory: "memory:no-store",
    })
    expect(row?.observed_location_mutation_epoch).toBe(0)
  }),
)

// F-18 — a crashed process leaves its in-flight attempt (and receipt) in `dispatching`/`streaming`.
// The lease-gated quarantine at the commitTurn block site must (a) keep blocking while the owner's
// lease is live, (b) quarantine attempt+receipt as indeterminate_after_crash once the lease is
// provably dead, so the user's explicit new input opens a fresh attempt instead of failing forever.
const staleSessionID = SessionSchema.ID.make("ses_canonical_stale")

const staleSeed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(SessionTable)
    .values({
      id: staleSessionID,
      project_id: Project.ID.global,
      slug: "canonical-stale",
      directory: "/project",
      title: "canonical stale",
      version: "test",
      execution_claim_token: 104,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionInputTable)
    .values({
      id: SessionMessage.ID.make("msg_trigger_stale"),
      session_id: staleSessionID,
      admitted_seq: 1,
      prompt: new Prompt({ text: "trigger" }),
      delivery: "steer",
      promoted_seq: 1,
      time_created: 1,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

// Crash residue seeding: drive the committed attempt into the in-flight `dispatching` state via
// the LEGAL service path (the DB trigger rejects raw prepared->streaming writes).
const forceInFlight = (attemptId: string, ownerToken: string) =>
  Effect.gen(function* () {
    const attempts = yield* SessionProviderAttempt.Service
    yield* attempts.sealPrepared({
      attemptId,
      expectedOwnerToken: ownerToken,
      preparedTurnHash: Hash.sha256("prepared-turn"),
      wireRequestHash: Hash.sha256("wire-request"),
    })
    yield* attempts.markDispatching({ attemptId, expectedOwnerToken: ownerToken })
  })

it.effect("blocks a streaming attempt while its owner lease is live, with the reason in the message", () =>
  Effect.gen(function* () {
    yield* seed
    yield* staleSeed
    const { db } = yield* Database.Service
    const providerTurns = yield* V2ProviderTurn.Service
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID: staleSessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_trigger_stale"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_trigger_stale",
    })
    const committed = yield* SessionRunnerCanonical.commitTurn({
      db,
      contexts: yield* SessionContext.Service,
      sessionID: staleSessionID,
      admission,
      receipt: {
        sessionId: staleSessionID,
        userMessageId: "msg_trigger_stale",
        historyPromptEpoch: 0,
        historySourceEndMessageId: "msg_trigger_stale",
        requestInputHash: Hash.sha256("stale-live"),
        providerId: "provider-test",
        modelId: "model-test",
        protocol: "openai-chat",
        ownerMode: "v2" as const,
      },
      ownerToken: yield* providerTurns.currentOwnerToken(),
    })
    yield* forceInFlight(committed.attempt.attemptId, yield* providerTurns.currentOwnerToken())
    const blocked = yield* SessionRunnerCanonical.commitTurn({
      db,
      contexts: yield* SessionContext.Service,
      sessionID: staleSessionID,
      admission,
      receipt: {
        sessionId: staleSessionID,
        userMessageId: "msg_trigger_stale",
        historyPromptEpoch: 0,
        historySourceEndMessageId: "msg_trigger_stale",
        requestInputHash: Hash.sha256("stale-live-next"),
        providerId: "provider-test",
        modelId: "model-test",
        protocol: "openai-chat",
        ownerMode: "v2" as const,
      },
      ownerToken: yield* providerTurns.currentOwnerToken(),
    }).pipe(Effect.flip)
    // F-18 diagnostic fidelity: the reason reaches the message, not just the schema field.
    expect(blocked).toBeInstanceOf(SessionRunnerCanonical.AdmissionError)
    expect((blocked as SessionRunnerCanonical.AdmissionError).reason).toBe("provider_attempt_blocked:dispatching")
    expect((blocked as SessionRunnerCanonical.AdmissionError).message).toBe("provider_attempt_blocked:dispatching")
  }),
)

it.effect("refuses a dead-owner attempt when its receipt was not advanced to the same state", () =>
  Effect.gen(function* () {
    yield* seed
    yield* staleSeed
    const { db } = yield* Database.Service
    const owners = yield* SessionProviderOwner.Service
    const providerTurns = yield* V2ProviderTurn.Service
    // The dying owner commits the first turn, crashes mid-stream, and loses its lease (released).
    const dyingToken = "v2:f18-dying-owner"
    yield* owners.register({ ownerToken: dyingToken, leaseMs: 60_000 })
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID: staleSessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_trigger_stale"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_trigger_stale",
    })
    const crashed = yield* SessionRunnerCanonical.commitTurn({
      db,
      contexts: yield* SessionContext.Service,
      sessionID: staleSessionID,
      admission,
      receipt: {
        sessionId: staleSessionID,
        userMessageId: "msg_trigger_stale",
        historyPromptEpoch: 0,
        historySourceEndMessageId: "msg_trigger_stale",
        requestInputHash: Hash.sha256("f18-crashed"),
        providerId: "provider-test",
        modelId: "model-test",
        protocol: "openai-chat",
        ownerMode: "v2" as const,
      },
      ownerToken: dyingToken,
    })
    yield* forceInFlight(crashed.attempt.attemptId, dyingToken)
    yield* owners.release({ ownerToken: dyingToken })

    const blocked = yield* SessionRunnerCanonical.commitTurn({
      db,
      contexts: yield* SessionContext.Service,
      sessionID: staleSessionID,
      admission,
      receipt: {
        sessionId: staleSessionID,
        userMessageId: "msg_trigger_stale",
        historyPromptEpoch: 0,
        historySourceEndMessageId: "msg_trigger_stale",
        requestInputHash: Hash.sha256("f18-after-crash"),
        providerId: "provider-test",
        modelId: "model-test",
        protocol: "openai-chat",
        ownerMode: "v2" as const,
      },
      ownerToken: yield* providerTurns.currentOwnerToken(),
    }).pipe(Effect.flip)
    expect(blocked).toBeInstanceOf(SessionRunnerCanonical.AdmissionError)
    expect((blocked as SessionRunnerCanonical.AdmissionError).reason).toBe("stale_provider_receipt_binding_conflict")
    const unchangedAttempt = yield* db
      .select({ state: SessionProviderAttemptTable.state, error_code: SessionProviderAttemptTable.error_code })
      .from(SessionProviderAttemptTable)
      .where(eq(SessionProviderAttemptTable.attempt_id, crashed.attempt.attemptId))
      .get()
      .pipe(Effect.orDie)
    expect(unchangedAttempt?.state).toBe("dispatching")
    expect(unchangedAttempt?.error_code).toBeNull()
  }),
)

// R1 — a crash in the commitTurn→wire-seal window leaves a PREPARED attempt (and its preparing
// receipt) owned by the dead process. A foreign commitTurn must quarantine it (failed /
// owner_lease_lost_before_dispatch, receipt failed / owner_lost_before_dispatch) and open a fresh
// attempt instead of failing forever on the seq-reuse binding mismatch.
it.effect("quarantines a dead-owner prepared attempt (pre-dispatch crash) and opens a fresh one", () =>
  Effect.gen(function* () {
    yield* seed
    yield* staleSeed
    const { db } = yield* Database.Service
    const owners = yield* SessionProviderOwner.Service
    const providerTurns = yield* V2ProviderTurn.Service
    const dyingToken = "v2:r1-dying-owner"
    yield* owners.register({ ownerToken: dyingToken, leaseMs: 60_000 })
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID: staleSessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_trigger_stale"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_trigger_stale",
    })
    const crashed = yield* SessionRunnerCanonical.commitTurn({
      db,
      contexts: yield* SessionContext.Service,
      sessionID: staleSessionID,
      admission,
      receipt: {
        sessionId: staleSessionID,
        userMessageId: "msg_trigger_stale",
        historyPromptEpoch: 0,
        historySourceEndMessageId: "msg_trigger_stale",
        requestInputHash: Hash.sha256("r1-pre-dispatch-crash"),
        providerId: "provider-test",
        modelId: "model-test",
        protocol: "openai-chat",
        ownerMode: "v2" as const,
      },
      ownerToken: dyingToken,
    })
    expect(crashed.attempt.state).toBe("prepared")
    yield* owners.release({ ownerToken: dyingToken })
    const fresh = yield* SessionRunnerCanonical.commitTurn({
      db,
      contexts: yield* SessionContext.Service,
      sessionID: staleSessionID,
      admission,
      receipt: {
        sessionId: staleSessionID,
        userMessageId: "msg_trigger_stale",
        historyPromptEpoch: 0,
        historySourceEndMessageId: "msg_trigger_stale",
        requestInputHash: Hash.sha256("r1-after-pre-dispatch-crash"),
        providerId: "provider-test",
        modelId: "model-test",
        protocol: "openai-chat",
        ownerMode: "v2" as const,
      },
      ownerToken: yield* providerTurns.currentOwnerToken(),
    })
    expect(fresh.attempt.attemptId).not.toBe(crashed.attempt.attemptId)
    expect(fresh.attempt.providerTurnSeq).toBe(crashed.attempt.providerTurnSeq + 1)
    const quarantinedAttempt = yield* db
      .select({
        state: SessionProviderAttemptTable.state,
        error_code: SessionProviderAttemptTable.error_code,
        settled_at: SessionProviderAttemptTable.settled_at,
      })
      .from(SessionProviderAttemptTable)
      .where(eq(SessionProviderAttemptTable.attempt_id, crashed.attempt.attemptId))
      .get()
      .pipe(Effect.orDie)
    expect(quarantinedAttempt?.state).toBe("failed")
    expect(quarantinedAttempt?.error_code).toBe("owner_lease_lost_before_dispatch")
    expect(quarantinedAttempt?.settled_at).not.toBeNull()
    const quarantinedReceipt = yield* db
      .select({ state: V2ProviderTurnReceiptTable.state })
      .from(V2ProviderTurnReceiptTable)
      .where(eq(V2ProviderTurnReceiptTable.receipt_id, crashed.receipt.receiptId))
      .get()
      .pipe(Effect.orDie)
    expect(quarantinedReceipt?.state).toBe("failed")
  }),
)

// opencode port #1 — the durable resume budget: a leading run of MaxConsecutiveCrashResumes
// quarantined attempts without a settle in between must converge to a typed refusal.
it.effect("refuses new turns once the consecutive crash-resume budget is exhausted", () =>
  Effect.gen(function* () {
    yield* seed
    const { db } = yield* Database.Service
    const owners = yield* SessionProviderOwner.Service
    const budgetSessionID = SessionSchema.ID.make("ses_canonical_budget")
    yield* db
      .insert(SessionTable)
      .values({
        id: budgetSessionID,
        project_id: Project.ID.global,
        slug: "canonical-budget",
        directory: "/project",
        title: "canonical budget",
        version: "test",
        execution_claim_token: 104,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionInputTable)
      .values({
        id: SessionMessage.ID.make("msg_trigger_budget"),
        session_id: budgetSessionID,
        admitted_seq: 1,
        prompt: new Prompt({ text: "trigger" }),
        delivery: "steer",
        promoted_seq: 1,
        time_created: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID: budgetSessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_trigger_budget"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_trigger_budget",
    })
    const commitWith = (ownerToken: string, salt: string) =>
      Effect.gen(function* () {
        return yield* SessionRunnerCanonical.commitTurn({
          db,
          contexts: yield* SessionContext.Service,
          sessionID: budgetSessionID,
          admission,
          receipt: {
            sessionId: budgetSessionID,
            userMessageId: "msg_trigger_budget",
            historyPromptEpoch: 0,
            historySourceEndMessageId: "msg_trigger_budget",
            requestInputHash: Hash.sha256(`budget-${salt}`),
            providerId: "provider-test",
            modelId: "model-test",
            protocol: "openai-chat",
            ownerMode: "v2" as const,
          },
          ownerToken,
        })
      })
    // Crash-loop emulation: round i commits under owner i, dies (release), and the next round's
    // commit quarantines it and itself runs under owner i+1.
    for (let round = 0; round <= SessionRunnerCanonical.MaxConsecutiveCrashResumes; round++) {
      const owner = `v2:budget-owner-${round}`
      yield* owners.register({ ownerToken: owner, leaseMs: 60_000 })
      if (round > 0) yield* owners.release({ ownerToken: `v2:budget-owner-${round - 1}` })
      // The v4 Exit failure variant carries the error value directly in `.failure`.
      const outcome = yield* commitWith(owner, String(round)).pipe(Effect.result)
      const failure = (outcome as { failure?: unknown }).failure
      if (round < SessionRunnerCanonical.MaxConsecutiveCrashResumes) {
        expect(failure).toBeUndefined()
      } else {
        expect(failure).toBeInstanceOf(SessionRunnerCanonical.AdmissionError)
        expect((failure as SessionRunnerCanonical.AdmissionError).reason).toStartWith("resume_budget_exhausted:")
      }
    }
  }),
)
