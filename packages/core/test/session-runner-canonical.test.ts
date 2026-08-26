import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../src/database/database"
import { SessionContext } from "../src/context-federation/session-context"
import { SessionProviderAttempt } from "../src/context-federation/provider-attempt"
import { SessionProviderOwner } from "../src/context-federation/provider-owner"
import { SessionRunnerCanonical } from "../src/session/runner/canonical-turn"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { SessionSchema } from "../src/session/schema"
import { SessionMessage } from "../src/session/message"
import { Prompt } from "../src/session/prompt"
import { SessionInputTable, SessionTable } from "../src/session/sql"
import { SessionContextSelectionTable } from "../src/context-federation/session-sql"
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
    expect(admission.selectionId).toStartWith("selection_")
    expect(admission.authorizationEpoch).toBe(0)

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
      ownerToken: providerTurns.ownerToken,
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
      ownerToken: providerTurns.ownerToken,
    })
    expect(retry.attempt.attemptId).toBe(first.attempt.attemptId)
    expect(retry.receipt.receiptId).toBe(first.receipt.receiptId)
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

it.effect("records the wired selection evidence on the V2 selection commit", () =>
  Effect.gen(function* () {
    yield* seed
    yield* seamSeed
    const { db } = yield* Database.Service
    const evidence = {
      graphRevisions: { code: "rev_code_9", documents: "rev_docs_4", knowledge: "rev_k_1", memory: "rev_m_2" },
      selectedSourceFingerprint: "federation_source_fingerprint",
      observedLocationMutationEpoch: 7,
    }
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID: seamSessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_trigger_seam"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_trigger_seam",
    }).pipe(
      Effect.provideService(
        SessionRunnerCanonical.CurrentSelectionEvidenceLookup,
        () => Effect.succeed(evidence),
      ),
    )
    const row = yield* db
      .select()
      .from(SessionContextSelectionTable)
      .where(eq(SessionContextSelectionTable.selection_id, admission.selectionId))
      .get()
      .pipe(Effect.orDie)
    expect(row?.graph_revisions).toBe(JSON.stringify(evidence.graphRevisions))
    expect(row?.selected_source_fingerprint).toBe("federation_source_fingerprint")
    expect(row?.observed_location_mutation_epoch).toBe(7)
    expect(admission.selectedSourceFingerprint).toBe("federation_source_fingerprint")
    expect(admission.observedLocationMutationEpoch).toBe(7)
  }),
)

it.effect("keeps the v2:local evidence when the seam lookup yields nothing or faults", () =>
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
    }).pipe(
      // A faulting lookup degrades to the pre-seam local evidence; it never fails the admission.
      Effect.provideService(SessionRunnerCanonical.CurrentSelectionEvidenceLookup, () =>
        Effect.fail(new Error("federation unavailable")),
      ),
    )
    const row = yield* db
      .select()
      .from(SessionContextSelectionTable)
      .where(eq(SessionContextSelectionTable.selection_id, admission.selectionId))
      .get()
      .pipe(Effect.orDie)
    expect(JSON.parse(row?.graph_revisions ?? "{}")).toEqual({
      code: "v2-none",
      documents: "v2-none",
      knowledge: "v2-none",
      memory: "v2-none",
    })
    expect(row?.observed_location_mutation_epoch).toBe(0)
  }),
)
