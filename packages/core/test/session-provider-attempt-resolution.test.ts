import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { Database } from "../src/database/database"
import { SessionProviderAttempt } from "../src/context-federation/provider-attempt"
import { SessionProviderOwner } from "../src/context-federation/provider-owner"
import { SessionContext } from "../src/context-federation/session-context"
import { SessionRunnerCanonical } from "../src/session/runner/canonical-turn"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { SessionRestart } from "../src/session/execution/restart"
import { SessionSchema } from "../src/session/schema"
import { SessionMessage } from "../src/session/message"
import { Prompt } from "../src/session/prompt"
import { SessionInputTable, SessionTable } from "../src/session/sql"
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
const sessionID = SessionSchema.ID.make("ses_resolution")
const recoveryOwnerToken = "v2:recovery-owner"

it.effect("classifies resolved attempts only through matching resolution and bridge rows", () =>
  Effect.gen(function* () {
    const receipt = {
      receiptId: "receipt_classify",
      state: "indeterminate_after_crash" as const,
      activityId: "activity_resolved",
      providerTurnSeq: 1,
      providerAttemptId: "attempt_classify",
      requestHash: "r".repeat(64),
      providerId: "provider-test",
      ownerToken: "owner_classify",
    }
    const base = {
      attemptId: "attempt_classify",
      activityId: "activity_resolved",
      providerTurnSeq: 1,
      requestHash: "r".repeat(64),
      providerId: "provider-test",
      ownerToken: "owner_classify",
    }
    const resolved = { ...base, state: "resolved_abandoned" as const }
    // No resolution/bridge rows: the resolved state alone proves nothing.
    expect(SessionRestart.classifyTurn(receipt, resolved)).toBe("authority_conflict")
    // Resolution without bridge is still insufficient.
    expect(
      SessionRestart.classifyTurn(receipt, { ...resolved, resolutionDecision: "abandoned" }),
    ).toBe("authority_conflict")
    // Bridge pointing at another receipt must not classify.
    expect(
      SessionRestart.classifyTurn(receipt, {
        ...resolved,
        resolutionDecision: "abandoned",
        bridgeReceiptId: "receipt_other",
      }),
    ).toBe("authority_conflict")
    // Decision inconsistent with the recorded resolved state.
    expect(
      SessionRestart.classifyTurn(receipt, {
        ...resolved,
        resolutionDecision: "settled",
        bridgeReceiptId: "receipt_classify",
      }),
    ).toBe("authority_conflict")
    // Fully bridged resolution against the indeterminate receipt is terminal-consistent.
    expect(
      SessionRestart.classifyTurn(receipt, {
        ...resolved,
        resolutionDecision: "abandoned",
        bridgeReceiptId: "receipt_classify",
      }),
    ).toBe("terminal_consistent")
    // A receipt that is not indeterminate cannot be reconciled by resolution alone.
    expect(
      SessionRestart.classifyTurn(
        { ...receipt, state: "settled" },
        { ...resolved, resolutionDecision: "abandoned", bridgeReceiptId: "receipt_classify" },
      ),
    ).toBe("authority_conflict")
  }),
)

// Seeds one canonical turn (activity -> selection -> attempt + bound receipt in preparing state)
// driven through the real admission path, then quarantines the receipt via the real stream seam so
// both authorities end up indeterminate together.
const seedIndeterminateTurn = (suffix: string, seq = 1) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const turnsService = yield* V2ProviderTurn.Service
    const contextsService = yield* SessionContext.Service
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
        slug: "resolution",
        directory: "/project",
        title: "resolution",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const inputId = SessionMessage.ID.make(`msg_${suffix}`)
    yield* db
      .insert(SessionInputTable)
      .values({
        id: inputId,
        session_id: sessionID,
        admitted_seq: seq,
        prompt: new Prompt({ text: suffix }),
        delivery: "steer",
        promoted_seq: seq,
        time_created: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: contextsService,
      sessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: [inputId],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: inputId,
    })
    const committed = yield* SessionRunnerCanonical.commitTurn({
      db,
      contexts: contextsService,
      sessionID,
      admission,
      receipt: {
        sessionId: sessionID,
        userMessageId: inputId,
        historyPromptEpoch: 0,
        requestInputHash: Hash.sha256(`${suffix}-request`),
        providerId: "provider-test",
        modelId: "model-test",
        protocol: "openai-chat",
        ownerMode: "v2",
      },
      ownerToken: turnsService.ownerToken,
    })
    const receipt = committed.receipt
    const prepared = V2ProviderTurn.prepare(
      {
        receipt,
        stableSystemParts: ["stable"],
        volatileSystemParts: ["volatile"],
        historyMessages: [{ role: "user", content: receipt.userMessageId }],
        activityID: receipt.activityId,
        providerTurnSeq: receipt.providerTurnSeq,
        toolDefinitions: [],
        toolIDs: [],
        toolChoice: null,
        toolResultReferences: [],
        budget: {
          decision: "ok",
          estimatedFullRequestTokens: 16,
          physicalInputBudget: 1_000,
          reservedOutputTokens: 100,
          safetyMargin: 50,
          provenance: "model_limit",
        },
        userMessageID: receipt.userMessageId,
      },
      Hash.sha256(`${suffix}-wire`),
    )
    const failingStream = Stream.unwrap(
      V2ProviderTurn.CurrentRequestSeal.pipe(
        Effect.flatMap((seal) =>
          seal!.seal({
            wireHash: Hash.sha256(`${suffix}-wire`),
            bodyHash: "a".repeat(64),
            bodyLength: 1,
            contentType: "application/json",
          }),
        ),
        Effect.as(Stream.concat(Stream.fromIterable(["first"]), Stream.fail(new Error("transport lost")))),
      ),
    )
    yield* V2ProviderTurn.stream({
      service: turnsService,
      receipt,
      prepare: () => prepared,
      stream: failingStream,
      outcomeArtifact: () => ["first"],
      errorCode: () => "provider_stream_failed:transport",
    }).pipe(Stream.runCollect, Effect.exit)
    return { attemptId: committed.attempt.attemptId, receiptId: receipt.receiptId, inputId }
  })

const resolveAbandoned = (attemptId: string) =>
  Effect.gen(function* () {
    const attemptsService = yield* SessionProviderAttempt.Service
    const ownersService = yield* SessionProviderOwner.Service
    // Resolution is a recovery command: the crashed owner must be stale and a recovery owner live.
    yield* ownersService.release({ ownerToken: (yield* V2ProviderTurn.Service).ownerToken })
    yield* ownersService.register({ ownerToken: recoveryOwnerToken, leaseMs: 600_000 })
    return yield* attemptsService.resolve({
      attemptId,
      recoveryOwnerToken,
      actor: { type: "user", id: "operator", canResolve: true, canAcknowledgeReplayRisk: false },
      decision: "abandoned",
      riskAcknowledged: true,
      reason: "resolution test",
    })
  })

it.effect("bridges a resolution exactly once and rejects mismatched bindings", () =>
  Effect.gen(function* () {
    const seeded = yield* seedIndeterminateTurn("bridge")
    const attemptsService = yield* SessionProviderAttempt.Service
    const resolved = yield* resolveAbandoned(seeded.attemptId)
    expect(resolved.attempt.state).toBe("resolved_abandoned")

    yield* attemptsService.bridgeResolution({
      resolutionId: resolved.resolutionId,
      receiptId: seeded.receiptId,
      commandId: "command-1",
    })
    // Exact re-bridge is idempotent.
    yield* attemptsService.bridgeResolution({
      resolutionId: resolved.resolutionId,
      receiptId: seeded.receiptId,
      commandId: "command-1",
    })
    // A conflicting command against the same resolution must fail closed.
    expect(
      yield* attemptsService
        .bridgeResolution({ resolutionId: resolved.resolutionId, receiptId: seeded.receiptId, commandId: "command-2" })
        .pipe(Effect.exit),
    ).toMatchObject({ _tag: "Failure" })
    // An unknown resolution must fail closed.
    expect(
      yield* attemptsService
        .bridgeResolution({ resolutionId: "resolution_missing", receiptId: seeded.receiptId, commandId: "command-3" })
        .pipe(Effect.exit),
    ).toMatchObject({ _tag: "Failure" })
  }),
)

it.effect("rejects bridging before the decision is recorded and against unbound receipts", () =>
  Effect.gen(function* () {
    const seeded = yield* seedIndeterminateTurn("early", 2)
    // A second turn's receipt is bound to its own attempt; both turns are seeded before the
    // resolution because resolving releases the crashed owner lease.
    const other = yield* seedIndeterminateTurn("other", 3)
    const attemptsService = yield* SessionProviderAttempt.Service
    // Bridging before resolve() recorded the decision must fail closed: there is no resolution row
    // yet, so nothing can authorize the bridge.
    expect(
      yield* attemptsService
        .bridgeResolution({ resolutionId: "resolution_pending", receiptId: seeded.receiptId, commandId: "command-1" })
        .pipe(Effect.exit),
    ).toMatchObject({ _tag: "Failure" })
    const resolved = yield* resolveAbandoned(seeded.attemptId)
    // Bridging the first turn's resolution against the second turn's receipt must fail closed.
    expect(
      yield* attemptsService
        .bridgeResolution({ resolutionId: resolved.resolutionId, receiptId: other.receiptId, commandId: "command-2" })
        .pipe(Effect.exit),
    ).toMatchObject({ _tag: "Failure" })
  }),
)
