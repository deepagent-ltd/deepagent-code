import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { ContextArtifactStore, type Limits } from "../../src/context-federation/artifact-store"
import { ContextFederation } from "../../src/context-federation/federation"
import { ContextProjection } from "../../src/context-federation/projection"
import { SessionContext, type CommitSelectionInput } from "../../src/context-federation/session-context"
import { SessionProviderAttempt } from "../../src/context-federation/provider-attempt"
import { SessionProviderOwner } from "../../src/context-federation/provider-owner"
import {
  LocationIdentityTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "../../src/context-federation/sql"
import { ContextTokenCodec } from "../../src/context-federation/token-codec"
import {
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
  type ContextRef,
} from "../../src/context-federation/reference"
import { ContextArtifactTable, SessionContextSelectionTable } from "../../src/context-federation/session-sql"
import { Database } from "../../src/database/database"
import { DeepAgentReleasedSnapshot } from "../../src/deepagent/released-snapshot"
import { ProjectV2 } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { SessionMessage } from "../../src/session/message"
import { Prompt } from "../../src/session/prompt"
import { SessionSchema } from "../../src/session/schema"
import { SessionInputTable, SessionTable } from "../../src/session/sql"
import { V2ProviderTurn } from "../../src/session/runner/v2-provider-turn"

const namespace = SecurityNamespaceID.make("sec_context_test")
const location = LocationKey.make("loc_context_test")
const projectScope = ProjectScopeKey.make("prjctx_context_test")
const projectId = ProjectV2.ID.make("project-context-test")
const sessionId = SessionSchema.ID.make("ses_context_test")
const triggerId = SessionMessage.ID.make("msg_context_trigger")
const steerId = SessionMessage.ID.make("msg_context_steer")
const queueId = SessionMessage.ID.make("msg_context_queue")
const ownerToken = "provider-owner-test"
const v2OwnerToken = "provider-owner-v2-test"
const recoveryOwnerToken = "provider-owner-recovery"
const ref: ContextRef = {
  graph: "code",
  entityId: "entity-context-test",
  binding: { scope: "location", securityNamespaceId: namespace, locationKey: location, projectScopeKey: projectScope },
  locator: { path: "src/private.ts", startLine: 1, endLine: 4 },
  revision: "code:1",
}

describe("context projection", () => {
  test("is deterministic, ordered, escaped, and byte-framed", () => {
    const input = {
      evidence: [
        evidence("memory", "ctx-memory", "past & present", 0.25),
        evidence("code", "ctx-code", 'if (a < b) return "\u2028"', -0),
      ],
      statuses: [
        { graph: "memory" as const, state: "stale" as const, reasonCode: "old" },
        { graph: "code" as const, state: "ready_empty" as const, reasonCode: "none" },
      ],
    }
    const rendered = ContextProjection.render(input)
    const reversed = ContextProjection.render({
      evidence: input.evidence.toReversed(),
      statuses: input.statuses.toReversed(),
    })

    expect(reversed).toEqual(rendered)
    expect(rendered.projection).toStartWith(`project-context-json-v1 bytes=${Buffer.byteLength(rendered.body)}\n`)
    expect(rendered.body.indexOf('"code"')).toBeLessThan(rendered.body.indexOf('"memory"'))
    expect(rendered.body).not.toContain("<")
    expect(rendered.body).not.toContain("&")
    expect(rendered.body).not.toContain("\u2028")
    expect(rendered.body).toContain("\\u2028")
    expect(() =>
      ContextProjection.render({ evidence: [evidence("code", "bad", "bad", Number.NaN)], statuses: [] }),
    ).toThrow()
  })
})

describe("durable activity and context selection", () => {
  test("coalesces steer inputs but keeps queue inputs for the next activity", async () => {
    const harness = makeHarness()
    await harness.run(
      Effect.gen(function* () {
        yield* seed()
        const context = yield* SessionContext.Service
        const active = yield* context.openActivity({ sessionId, triggerInputId: triggerId, now: 10 })
        expect((yield* context.openActivity({ sessionId, triggerInputId: steerId, now: 11 })).activityId).toBe(
          active.activityId,
        )
        const queued = yield* context.openActivity({ sessionId, triggerInputId: queueId, now: 12 }).pipe(Effect.flip)
        expect(queued._tag).toBe("SessionContext.ActivityBlockedError")
        const attachedQueue = yield* context
          .attachInputs({ activityId: active.activityId, inputIds: [queueId], now: 12 })
          .pipe(Effect.flip)
        expect(attachedQueue).toMatchObject({ _tag: "SessionContext.InputError", reason: "wrong_delivery" })

        yield* context.settleActivity({ activityId: active.activityId, state: "settled", now: 20 })
        const next = yield* context.openActivity({ sessionId, triggerInputId: queueId, now: 21 })
        expect(next).toMatchObject({ ordinal: 1, delivery: "queue", state: "active" })
      }),
    )
  })

  test("commits one immutable exact selection and degrades only under best-effort audit policy", async () => {
    const harness = makeHarness()
    await harness.run(
      Effect.gen(function* () {
        yield* seed()
        const context = yield* SessionContext.Service
        const db = (yield* Database.Service).db
        const activity = yield* context.openActivity({ sessionId, triggerInputId: triggerId, now: 10 })
        yield* context.openActivity({ sessionId, triggerInputId: steerId, now: 11 })
        const input = selectionInput(activity.activityId, harness.codec)
        const selection = yield* context.commitSelection(input)
        const retry = yield* context.commitSelection(input)
        expect(retry).toEqual(selection)
        expect(selection.promotedInputIds).toEqual([triggerId, steerId])

        const conflict = yield* context
          .commitSelection({ ...input, observedLocationMutationEpoch: input.observedLocationMutationEpoch + 1 })
          .pipe(Effect.flip)
        expect(conflict._tag).toBe("SessionContext.SelectionConflictError")
        const locationConflict = yield* context
          .commitSelection({ ...input, locationKey: LocationKey.make("loc_other") })
          .pipe(Effect.flip)
        expect(locationConflict._tag).toBe("SessionContext.SelectionConflictError")
        const switched = yield* context.commitSelection({
          ...input,
          revision: 1,
          promotedInputIds: [],
          executionFingerprint: "execution-v2",
          now: 12,
        })
        expect(switched).toMatchObject({ revision: 1, executionFingerprint: "execution-v2" })
        const reusedInput = yield* context
          .commitSelection({ ...input, revision: 2, promotedInputIds: [steerId], now: 13 })
          .pipe(Effect.flip)
        expect(reusedInput).toMatchObject({ _tag: "SessionContext.InputError", reason: "already_owned" })
        const mutation = yield* db
          .update(SessionContextSelectionTable)
          .set({ projection: "mutated" })
          .where(eq(SessionContextSelectionTable.selection_id, selection.selectionId))
          .run()
          .pipe(Effect.exit)
        expect(Exit.isFailure(mutation)).toBe(true)
      }),
    )

    const constrainedLimits = { ...defaultLimits, maxItemBytes: 1, maxSessionBytes: 1, maxGlobalBytes: 1 }
    const constrained = makeHarness(constrainedLimits)
    await constrained.run(
      Effect.gen(function* () {
        yield* seed()
        const context = yield* SessionContext.Service
        const activity = yield* context.openActivity({ sessionId, triggerInputId: triggerId, now: 10 })
        const required = yield* context
          .commitSelection(selectionInput(activity.activityId, constrained.codec, [triggerId]))
          .pipe(Effect.flip)
        expect(required._tag).toBe("SessionContext.AuditStorageUnavailableError")
      }),
    )
    const bestEffort = makeHarness(constrainedLimits, "best_effort")
    await bestEffort.run(
      Effect.gen(function* () {
        yield* seed()
        const context = yield* SessionContext.Service
        const activity = yield* context.openActivity({ sessionId, triggerInputId: triggerId, now: 10 })
        const degraded = yield* context.commitSelection(
          selectionInput(activity.activityId, bestEffort.codec, [triggerId]),
        )
        expect(degraded.artifactBinding.status).toBe("degraded_unavailable")
      }),
    )

    const trimming = makeHarness({
      ...defaultLimits,
      maxItemBytes: 2_000,
      maxSessionBytes: 2_000,
      maxGlobalBytes: 2_000,
    })
    await trimming.run(
      Effect.gen(function* () {
        yield* seed()
        const context = yield* SessionContext.Service
        const artifacts = yield* ContextArtifactStore.Service
        const activity = yield* context.openActivity({ sessionId, triggerInputId: triggerId, now: 10 })
        const input = selectionInput(activity.activityId, trimming.codec, [triggerId])
        const selection = yield* context.commitSelection({
          ...input,
          artifact: {
            rankingVersion: "ranking-v1",
            rejected: [{ graph: "code", reasonCode: "over-budget".repeat(1_000) }],
          },
        })
        if (selection.artifactBinding.status !== "available") throw new Error("trimmed artifact unavailable")
        const result = yield* artifacts.read({
          ref: selection.artifactBinding.ref,
          principal: principal([location]),
          egress: egress(),
          now: 20,
        })
        expect(result.status === "available" && result.artifact.rejected).toEqual([])
      }),
    )
  })

  test("encrypts and reuses audit artifacts, reauthorizes reads, and tombstones expired content", async () => {
    const harness = makeHarness()
    await harness.run(
      Effect.gen(function* () {
        yield* seed()
        const context = yield* SessionContext.Service
        const artifacts = yield* ContextArtifactStore.Service
        const db = (yield* Database.Service).db
        const activity = yield* context.openActivity({ sessionId, triggerInputId: triggerId, now: 10 })
        const input = selectionInput(activity.activityId, harness.codec, [triggerId])
        const selection = yield* context.commitSelection(input)
        if (selection.artifactBinding.status !== "available") throw new Error("artifact unexpectedly unavailable")
        const artifact = audit(selection.selectionId, input)
        const repeated = yield* artifacts.write({
          securityNamespaceId: namespace,
          sessionId,
          selectionId: selection.selectionId,
          authorizationFingerprint: input.authorizationFingerprint,
          artifact,
          now: 20,
        })
        expect(repeated.ref).toBe(selection.artifactBinding.ref)
        const crossNamespace = yield* artifacts
          .write({
            securityNamespaceId: SecurityNamespaceID.make("sec_other"),
            sessionId,
            selectionId: selection.selectionId,
            authorizationFingerprint: input.authorizationFingerprint,
            artifact,
            now: 20,
          })
          .pipe(Effect.flip)
        expect(crossNamespace._tag).toBe("ContextArtifact.BindingError")

        const row = yield* db.select().from(ContextArtifactTable).get().pipe(Effect.orDie)
        expect(Buffer.from(row!.ciphertext!).toString("utf8")).not.toContain("sensitive excerpt")
        const allowed = yield* artifacts.read({
          ref: repeated.ref,
          principal: principal([location]),
          egress: egress(),
          now: 30,
        })
        expect(allowed.status).toBe("available")
        const revoked = yield* artifacts.read({
          ref: repeated.ref,
          principal: principal([]),
          egress: egress(),
          now: 31,
        })
        expect(revoked.status).toBe("redacted")

        expect(yield* artifacts.sweep(1_011)).toBe(1)
        const expired = yield* artifacts.read({
          ref: repeated.ref,
          principal: principal([location]),
          egress: egress(),
          now: 1_012,
        })
        expect(expired.status).toBe("expired")
        expect((yield* db.select().from(ContextArtifactTable).get())?.ciphertext).toBeNull()
      }),
    )
  })
})

describe("provider attempt safety", () => {
  test("binds a V2 receipt to one exact canonical provider attempt", async () => {
    const harness = makeHarness()
    await harness.run(
      Effect.gen(function* () {
        yield* seed()
        const context = yield* SessionContext.Service
        const attempts = yield* SessionProviderAttempt.Service
        const owners = yield* SessionProviderOwner.Service
        const turns = yield* V2ProviderTurn.Service
        const activity = yield* context.openActivity({ sessionId, triggerInputId: triggerId, now: 10 })
        const selection = yield* context.commitSelection(
          selectionInput(activity.activityId, harness.codec, [triggerId]),
        )
        yield* context.appendValidation({
          selectionId: selection.selectionId,
          providerTurnSeq: 1,
          authorizationEpoch: 2,
          egressEpoch: 3,
          observedLocationMutationEpoch: 9,
          selectedSourceFingerprint: "sources-v1",
          validatedAt: 100,
          validUntil: 500,
          outcome: "valid",
          reasonCode: "current",
        })
        const attempt = yield* attempts.prepare({
          ...prepareInput(activity.activityId, selection, 1),
          ownerToken: v2OwnerToken,
          now: 150,
        })
        const receipt = yield* turns.admit({
          sessionId,
          userMessageId: triggerId,
          activityId: activity.activityId,
          providerTurnSeq: 1,
          historyPromptEpoch: 1,
          historySourceEndMessageId: triggerId,
          requestInputHash: attempt.requestHash,
          providerId: attempt.providerId,
          modelId: "model-test",
          protocol: "openai-chat",
          ownerMode: "v2",
        })
        const bound = yield* turns.bindAttempt(receipt, attempt.attemptId)
        expect(bound.providerAttemptId).toBe(attempt.attemptId)
        expect(yield* turns.bindAttempt(bound, attempt.attemptId).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      }),
    )
  })

  test("fences attempt mutation by exact live owner and never revives an expired token", async () => {
    const harness = makeHarness()
    await harness.run(
      Effect.gen(function* () {
        yield* seed()
        const context = yield* SessionContext.Service
        const attempts = yield* SessionProviderAttempt.Service
        const owners = yield* SessionProviderOwner.Service
        const db = (yield* Database.Service).db
        expect((yield* owners.register({ ownerToken, leaseMs: 100, now: 100 })).registeredAt).not.toBe(100)
        yield* owners.register({ ownerToken: recoveryOwnerToken, leaseMs: 1_000, now: 100 })
        const activity = yield* context.openActivity({ sessionId, triggerInputId: triggerId, now: 10 })
        const selection = yield* context.commitSelection(
          selectionInput(activity.activityId, harness.codec, [triggerId]),
        )
        yield* context.appendValidation({
          selectionId: selection.selectionId,
          providerTurnSeq: 0,
          authorizationEpoch: 2,
          egressEpoch: 3,
          observedLocationMutationEpoch: 9,
          selectedSourceFingerprint: "sources-v1",
          validatedAt: 100,
          validUntil: 500,
          outcome: "valid",
          reasonCode: "current",
        })
        const prepared = yield* attempts.prepare({
          ...prepareInput(activity.activityId, selection, 0),
          now: 150,
        })
        expect(
          (yield* attempts
            .prepare({
              ...prepareInput(activity.activityId, selection, 0),
              ownerToken: recoveryOwnerToken,
              now: 151,
            })
            .pipe(Effect.flip))._tag,
        ).toBe("SessionProviderAttempt.ConflictError")
        expect(
          (yield* attempts.prepare({
            ...prepareInput(activity.activityId, selection, 0),
            now: 151,
          })).attemptId,
        ).toBe(prepared.attemptId)
        expect(
          yield* attempts
            .markDispatching({
              attemptId: prepared.attemptId,
              expectedOwnerToken: recoveryOwnerToken,
              now: 151,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "SessionProviderAttempt.ConflictError", reason: "provider_attempt_owner_mismatch" })
        expect(
          yield* attempts
            .markDispatching({ attemptId: prepared.attemptId, expectedOwnerToken: ownerToken, now: 200 })
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "SessionProviderAttempt.ConflictError",
          reason: "provider_attempt_wire_identity_not_sealed",
        })
        yield* owners.release({ ownerToken, now: 0 })
        expect((yield* owners.heartbeat({ ownerToken, leaseMs: 100, now: 200 }).pipe(Effect.flip)).reason).toBe(
          "provider_owner_lease_not_live",
        )
        expect(
          yield* db
            .transaction((tx) =>
              SessionProviderAttempt.recoverExactInTransaction(tx, {
                sessionId,
                staleOwnerToken: ownerToken,
                recoveryOwnerToken,
                undispatchedAttemptIds: [prepared.attemptId, "missing-attempt"],
                startedAttemptIds: [],
                now: 200,
              }),
            )
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "SessionProviderAttempt.ConflictError",
          reason: "provider_recovery_exact_attempt_mismatch",
        })
        expect((yield* attempts.get(prepared.attemptId))?.state).toBe("prepared")
        expect(
          yield* db.transaction((tx) =>
            SessionProviderAttempt.recoverExactInTransaction(tx, {
              sessionId,
              staleOwnerToken: ownerToken,
              recoveryOwnerToken,
              undispatchedAttemptIds: [prepared.attemptId],
              startedAttemptIds: [],
              now: 200,
            }),
          ),
        ).toBe(1)
        expect(yield* attempts.get(prepared.attemptId)).toMatchObject({
          state: "failed",
          errorCode: "owner_lease_lost_before_dispatch",
        })
        expect((yield* owners.release({ ownerToken: recoveryOwnerToken, now: 201 })).releasedAt).not.toBe(201)
        expect(
          (yield* owners.heartbeat({ ownerToken: recoveryOwnerToken, leaseMs: 100, now: 202 }).pipe(Effect.flip))
            .reason,
        ).toBe("provider_owner_lease_not_live")
        expect(
          (yield* owners.register({ ownerToken: recoveryOwnerToken, leaseMs: 100, now: 202 }).pipe(Effect.flip)).reason,
        ).toBe("owner_token_already_registered")
      }),
    )
  })

  test("durably abandons a prepared attempt before physical dispatch", async () => {
    const harness = makeHarness()
    await harness.run(
      Effect.gen(function* () {
        yield* seed()
        const context = yield* SessionContext.Service
        const attempts = yield* SessionProviderAttempt.Service
        const owners = yield* SessionProviderOwner.Service
        yield* owners.register({ ownerToken, leaseMs: 1_000, now: 1 })
        const activity = yield* context.openActivity({ sessionId, triggerInputId: triggerId, now: 10 })
        const selection = yield* context.commitSelection(
          selectionInput(activity.activityId, harness.codec, [triggerId]),
        )
        yield* context.appendValidation({
          selectionId: selection.selectionId,
          providerTurnSeq: 0,
          authorizationEpoch: 2,
          egressEpoch: 3,
          observedLocationMutationEpoch: 9,
          selectedSourceFingerprint: "sources-v1",
          validatedAt: 100,
          validUntil: 500,
          outcome: "valid",
          reasonCode: "current",
        })
        const prepared = yield* attempts.prepare(prepareInput(activity.activityId, selection, 0))
        expect(
          yield* attempts.abandonPrepared({
            attemptId: prepared.attemptId,
            expectedOwnerToken: ownerToken,
            errorCode: "provider_dispatch_readiness_expired",
            now: 200,
          }),
        ).toMatchObject({
          state: "failed",
          settledAt: 200,
          errorCode: "provider_dispatch_readiness_expired",
        })
        expect(
          (yield* attempts
            .markDispatching({ attemptId: prepared.attemptId, expectedOwnerToken: ownerToken, now: 201 })
            .pipe(Effect.flip))._tag,
        ).toBe("SessionProviderAttempt.InvalidStateError")
      }),
    )
  })

  test("requires a current validation and resolves crash-indeterminate replay explicitly", async () => {
    const harness = makeHarness()
    await harness.run(
      Effect.gen(function* () {
        yield* seed()
        const context = yield* SessionContext.Service
        const attempts = yield* SessionProviderAttempt.Service
        const owners = yield* SessionProviderOwner.Service
        yield* owners.register({ ownerToken, leaseMs: 201, now: 1 })
        yield* owners.register({ ownerToken: recoveryOwnerToken, leaseMs: 1_000, now: 1 })
        const activity = yield* context.openActivity({ sessionId, triggerInputId: triggerId, now: 10 })
        const selection = yield* context.commitSelection(
          selectionInput(activity.activityId, harness.codec, [triggerId]),
        )
        const prepare = prepareInput(activity.activityId, selection, 0)
        expect((yield* attempts.prepare(prepare).pipe(Effect.flip))._tag).toBe(
          "SessionProviderAttempt.ValidationRequiredError",
        )
        yield* context.appendValidation({
          selectionId: selection.selectionId,
          providerTurnSeq: 0,
          authorizationEpoch: 2,
          egressEpoch: 3,
          observedLocationMutationEpoch: 9,
          selectedSourceFingerprint: "sources-v1",
          validatedAt: 100,
          validUntil: 500,
          outcome: "valid",
          reasonCode: "current",
        })
        const attempt = yield* attempts.prepare(prepare)
        expect((yield* attempts.prepare(prepare)).attemptId).toBe(attempt.attemptId)
        expect(
          yield* attempts
            .markDispatching({ attemptId: attempt.attemptId, expectedOwnerToken: ownerToken, now: 200 })
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "SessionProviderAttempt.ConflictError",
          reason: "provider_attempt_wire_identity_not_sealed",
        })
        yield* attempts.sealPrepared({
          attemptId: attempt.attemptId,
          expectedOwnerToken: ownerToken,
          preparedTurnHash: "a".repeat(64),
          wireRequestHash: "b".repeat(64),
          now: 200,
        })
        yield* attempts.markDispatching({ attemptId: attempt.attemptId, expectedOwnerToken: ownerToken, now: 201 })
        expect((yield* attempts.prepare(prepare).pipe(Effect.flip))._tag).toBe(
          "SessionProviderAttempt.UnsafeRetryError",
        )
        yield* owners.release({ ownerToken, now: 0 })
        expect(
          yield* attempts.recoverIndeterminate({
            sessionId,
            staleOwnerToken: ownerToken,
            recoveryOwnerToken,
            now: 202,
          }),
        ).toBe(1)
        expect((yield* attempts.get(attempt.attemptId))?.state).toBe("indeterminate_after_crash")

        const denied = yield* attempts
          .resolve({
            attemptId: attempt.attemptId,
            recoveryOwnerToken,
            actor: actor(false),
            decision: "abandoned",
            riskAcknowledged: false,
            reason: "operator decision",
            now: 203,
          })
          .pipe(Effect.flip)
        expect(denied._tag).toBe("SessionProviderAttempt.ResolutionDeniedError")
        const noEvidence = yield* attempts
          .resolve({
            attemptId: attempt.attemptId,
            recoveryOwnerToken,
            actor: actor(true),
            decision: "settled",
            riskAcknowledged: false,
            reason: "provider reports completion",
            now: 203,
          })
          .pipe(Effect.flip)
        expect(noEvidence._tag).toBe("SessionProviderAttempt.ResolutionEvidenceError")
        const unsafe = yield* attempts
          .resolve({
            attemptId: attempt.attemptId,
            recoveryOwnerToken,
            actor: actor(true),
            decision: "replayed",
            riskAcknowledged: false,
            reason: "retry requested",
            replay: replayInput(1),
            now: 203,
          })
          .pipe(Effect.flip)
        expect(unsafe._tag).toBe("SessionProviderAttempt.ReplayRiskError")

        yield* context.appendValidation({
          selectionId: selection.selectionId,
          providerTurnSeq: 1,
          authorizationEpoch: 2,
          egressEpoch: 3,
          observedLocationMutationEpoch: 9,
          selectedSourceFingerprint: "sources-v1",
          validatedAt: 204,
          validUntil: 500,
          outcome: "valid",
          reasonCode: "current",
        })
        const resolved = yield* attempts.resolve({
          attemptId: attempt.attemptId,
          recoveryOwnerToken,
          actor: actor(true),
          decision: "replayed",
          riskAcknowledged: true,
          reason: "explicit duplicate-risk acknowledgement",
          replay: replayInput(1),
          now: 205,
        })
        expect(resolved.attempt.state).toBe("resolved_replayed")
        expect(resolved.replay).toMatchObject({
          state: "prepared",
          parentAttemptId: attempt.attemptId,
          providerTurnSeq: 1,
        })
        yield* attempts.sealPrepared({
          attemptId: resolved.replay!.attemptId,
          expectedOwnerToken: recoveryOwnerToken,
          preparedTurnHash: "c".repeat(64),
          wireRequestHash: "d".repeat(64),
          now: 206,
        })
        yield* attempts.markDispatching({
          attemptId: resolved.replay!.attemptId,
          expectedOwnerToken: recoveryOwnerToken,
          now: 206,
        })
        yield* owners.release({ ownerToken: recoveryOwnerToken, now: 207 })
        const finalOwnerToken = "provider-owner-final"
        yield* owners.register({ ownerToken: finalOwnerToken, leaseMs: 1_000, now: 207 })
        expect(
          yield* attempts.recoverIndeterminate({
            sessionId,
            staleOwnerToken: recoveryOwnerToken,
            recoveryOwnerToken: finalOwnerToken,
            now: 207,
          }),
        ).toBe(1)
        const abandoned = yield* attempts.resolve({
          attemptId: resolved.replay!.attemptId,
          recoveryOwnerToken: finalOwnerToken,
          actor: actor(true),
          decision: "abandoned",
          riskAcknowledged: false,
          reason: "operator abandoned unknown work",
          now: 208,
        })
        expect(abandoned.attempt.state).toBe("resolved_abandoned")
        expect((yield* context.openActivity({ sessionId, triggerInputId: queueId, now: 209 })).ordinal).toBe(1)
      }),
    )
  })
})

const defaultLimits: Limits = {
  maxItemBytes: 16_384,
  maxSessionBytes: 64_000,
  maxGlobalBytes: 256_000,
  retentionMs: 1_000,
  tokenLifetimeMs: 5_000,
}

function makeHarness(limits = defaultLimits, policy: "required" | "best_effort" = "required") {
  const database = Database.layerFromPath(":memory:")
  const codec = ContextTokenCodec.make({
    activeKeyId: "context-test",
    keys: [{ id: "context-test", secret: randomBytes(32) }],
  })
  const artifacts = ContextArtifactStore.layer({
    securityNamespaceId: namespace,
    policy,
    keyId: "artifact-test",
    encryptionKey: randomBytes(32),
    tokenCodec: codec,
    limits,
  }).pipe(Layer.provide(database))
  const context = SessionContext.layer.pipe(Layer.provide(Layer.merge(database, artifacts)))
  const attempts = SessionProviderAttempt.layer.pipe(Layer.provide(database))
  const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
  const turns = V2ProviderTurn.layerWith({ ownerToken: v2OwnerToken }).pipe(
    Layer.provide(owners),
    Layer.provide(database),
  )
  const layer = Layer.mergeAll(database, artifacts, context, attempts, owners, turns)
  return {
    codec,
    run: <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | Database.Service
        | ContextArtifactStore.Service
        | SessionContext.Service
        | SessionProviderAttempt.Service
        | SessionProviderOwner.Service
        | V2ProviderTurn.Service
      >,
    ) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped)),
  }
}

function seed() {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(SecurityNamespaceTable)
      .values({
        id: namespace,
        kind: "implicit_local",
        binding_hash: "namespace-binding",
        created_at: 1,
      })
      .run()
    yield* db
      .insert(ProjectScopeIdentityTable)
      .values({
        security_namespace_id: namespace,
        project_scope_key: projectScope,
        project_kind: "registered_root",
        project_identity_hash: "project-identity",
        observed_project_id: projectId,
        created_at: 1,
      })
      .run()
    yield* db
      .insert(LocationIdentityTable)
      .values({
        security_namespace_id: namespace,
        location_key: location,
        project_scope_key: projectScope,
        canonical_root: "/tmp/context-test",
        observed_project_id: projectId,
        created_at: 1,
      })
      .run()
    yield* db
      .insert(ProjectTable)
      .values({ id: projectId, worktree: AbsolutePath.make("/tmp/context-test"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionId,
        project_id: projectId,
        slug: "context-test",
        directory: "/tmp/context-test",
        title: "Context test",
        version: "test",
      })
      .run()
    yield* db
      .insert(SessionInputTable)
      .values([
        {
          id: triggerId,
          session_id: sessionId,
          prompt: new Prompt({ text: "trigger" }),
          delivery: "steer",
          admitted_seq: 0,
          promoted_seq: 0,
        },
        {
          id: steerId,
          session_id: sessionId,
          prompt: new Prompt({ text: "steer" }),
          delivery: "steer",
          admitted_seq: 1,
          promoted_seq: 1,
        },
        {
          id: queueId,
          session_id: sessionId,
          prompt: new Prompt({ text: "queue" }),
          delivery: "queue",
          admitted_seq: 2,
          promoted_seq: 2,
        },
      ])
      .run()
  })
}

function selectionInput(activityId: string, codec: ContextTokenCodec.Codec, promotedInputIds = [triggerId, steerId]) {
  const token = codec.sealContextRef(ref, { issuedAt: 0, expiresAt: 5_000 })
  const rendered = ContextProjection.render({
    evidence: [evidence("code", token, "sensitive excerpt", 0.9)],
    statuses: [{ graph: "documents", state: "cold", reasonCode: "not_indexed" }],
  })
  const offsets = rendered.offsets[token]!
  return {
    securityNamespaceId: namespace,
    projectScopeKey: projectScope,
    sessionId,
    activityId,
    revision: 0,
    triggerInputId: triggerId,
    locationKey: location,
    promotedInputIds,
    queryFingerprint: "query-v1",
    authorizationFingerprint: "auth-v1",
    authorizationEpoch: 1,
    executionFingerprint: "execution-v1",
    selectedSourceFingerprint: "sources-v1",
    observedLocationMutationEpoch: 4,
    nextRevalidationAt: 1_000,
    releasedKnowledgeBinding: DeepAgentReleasedSnapshot.binding(undefined),
    graphRevisions: { code: "code:1", documents: "documents:0", knowledge: "knowledge:1", memory: "memory:1" },
    graphStatuses: [
      ContextFederation.status.matched("code", [{ source: "code", revision: "code:1", state: "ready" }]),
      ContextFederation.status.partial({
        graph: "documents",
        state: "cold",
        reasonCode: "cold_start",
        revisions: [],
      }),
      ContextFederation.status.matched("knowledge", [{ source: "knowledge", revision: "knowledge:1", state: "ready" }]),
      ContextFederation.status.matched("memory", [{ source: "memory", revision: "memory:1", state: "ready" }]),
    ],
    selectedRefs: [
      {
        ref,
        token,
        provenanceTokens: [],
        relations: [],
        freshness: "current" as const,
        sensitivity: "source_code" as const,
        score: 0.9,
        reason: "query_match",
        excerpt: "sensitive excerpt",
        projectionStart: offsets.start,
        projectionEnd: offsets.end,
      },
    ],
    rendered,
    artifact: { rankingVersion: "ranking-v1", rejected: [] },
    now: 10,
  } satisfies CommitSelectionInput
}

function audit(selectionId: string, input: CommitSelectionInput) {
  return {
    schemaVersion: 1 as const,
    selectionId,
    queryFingerprint: input.queryFingerprint,
    authorizationFingerprint: input.authorizationFingerprint,
    graphStatuses: input.graphStatuses,
    rankingVersion: input.artifact.rankingVersion,
    selected: input.selectedRefs.map((selected) => ({
      ref: selected.ref,
      sensitivity: selected.sensitivity,
      score: selected.score,
      reason: selected.reason,
      excerpt: selected.excerpt,
    })),
    rejected: input.artifact.rejected,
  }
}

function prepareInput(activityId: string, selection: SessionContext.Selection, providerTurnSeq: number) {
  return {
    sessionId,
    activityId,
    providerTurnSeq,
    selectionId: selection.selectionId,
    projectionHash: selection.projectionHash,
    requestHash: "request-v1",
    providerId: "provider-test",
    ownerToken,
    authorizationEpoch: 2,
    egressEpoch: 3,
    selectedSourceFingerprint: "sources-v1",
    observedLocationMutationEpoch: 9,
    now: 200,
  }
}

function replayInput(providerTurnSeq: number) {
  return {
    sessionId,
    providerTurnSeq,
    authorizationEpoch: 2,
    egressEpoch: 3,
    selectedSourceFingerprint: "sources-v1",
    observedLocationMutationEpoch: 9,
  }
}

function actor(canResolve: boolean) {
  return { type: "user" as const, id: "operator", canResolve, canAcknowledgeReplayRisk: canResolve }
}

function principal(locationKeys: readonly LocationKey[]) {
  return {
    securityNamespaceId: namespace,
    principalId: "principal",
    authorizationEpoch: 2,
    locationKeys,
    projectScopeKeys: [projectScope],
    sessionIds: [sessionId],
    subjectIds: [],
    allowBuiltin: false,
  }
}

function egress() {
  return {
    policyId: "provider-test",
    epoch: 3,
    graphs: ["code", "knowledge", "memory", "documents"] as const,
    sensitivities: ["public", "source_code"] as const,
  }
}

function evidence(
  graph: "code" | "knowledge" | "memory" | "documents",
  reference: string,
  text: string,
  score: number,
) {
  return {
    graph,
    ref: reference,
    revision: `${graph}:1`,
    freshness: "current" as const,
    trust: "repository_evidence" as const,
    title: `${graph} evidence`,
    evidence: text,
    score,
  }
}
