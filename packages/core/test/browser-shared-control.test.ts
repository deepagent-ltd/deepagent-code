import os from "node:os"
import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Exit, Option, Cause, Schema } from "effect"
import { count, eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { FSUtil } from "../src/fs-util"
import { EventV2 } from "../src/event"
import { LocationIdentity } from "../src/context-federation/identity"
import { SecurityNamespaceTable } from "../src/context-federation/sql"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { SessionMessage } from "../src/session/message"
import { SessionInput } from "../src/session/input"
import { SessionProjector } from "../src/session/projector"
import { SessionTable } from "../src/session/sql"
import { Prompt } from "../src/session/prompt"
import { BrowserSchema } from "../src/browser/schema"
import { BrowserControl } from "../src/browser/control"
import { SharedBrowserSchema } from "../src/browser/shared-schema"
import { SharedBrowserControl } from "../src/browser/shared-control"
import { SharedBrowserUserInput } from "../src/browser/shared-user-input"
import { SessionContext } from "../src/context-federation/session-context"
import { SessionRunnerCanonical } from "../src/session/runner/canonical-turn"
import { SessionProviderOwner } from "../src/context-federation/provider-owner"
import { V2ProviderTurn } from "../src/session/runner/v2-provider-turn"
import { BrowserUserSelectionTable, BrowserSharedRequestTable } from "../src/browser/shared.sql"
import { Hash } from "../src/util/hash"

test("shared browser create validates in a renderer without Node Buffer", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer")!
  Reflect.deleteProperty(globalThis, "Buffer")
  try {
    for (const origin of ["http://127.0.0.1:65361", "https://example.com"]) {
      expect(Schema.decodeUnknownOption(SharedBrowserSchema.Create, { onExcessProperty: "error" })({
        version: 2,
        profile: SharedBrowserSchema.PROFILE,
        inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
        requestID: "browser-renderer-request",
        sessionID: "browser-renderer-session",
        expiresAt: Date.now() + 60_000,
        policy: { origin, approvedOrigins: [origin], manualApprovedOrigins: [origin], resolverPolicy: "system", postGrants: [] },
      })._tag).toBe("Some")
    }
    expect(Schema.is(BrowserSchema.ID)("中".repeat(170) + "ab")).toBeTrue()
    expect(Schema.is(BrowserSchema.ID)("中".repeat(171))).toBeFalse()
    expect(Schema.is(BrowserSchema.Address)("中".repeat(682) + "ab")).toBeTrue()
    expect(Schema.is(BrowserSchema.Address)("中".repeat(683))).toBeFalse()
    expect(Schema.is(BrowserSchema.PublicOrigin)("https://example.com/path")).toBeFalse()
  } finally {
    Object.defineProperty(globalThis, "Buffer", descriptor)
  }
})

const code = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
function runtime(filename: string) {
  const database = Database.layerFromPath(filename)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
  return Layer.mergeAll(
    database,
    events,
    owners,
    V2ProviderTurn.layer.pipe(Layer.provide(database), Layer.provide(owners)),
    SessionContext.layer.pipe(Layer.provide(database), Layer.provide(SessionRunnerCanonical.degradedArtifactStore)),
    LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer)),
    SessionProjector.layer.pipe(Layer.provide(database), Layer.provide(events)),
  )
}
const setup = (directory: string) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    const sessionID = SessionSchema.ID.make("ses_shared_core")
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        directory,
        slug: "shared",
        title: "Shared SQL contract",
        version: "fixture",
        v2_authority: true,
        execution_claim_token: 104,
      })
      .run()
    const identity = yield* (yield* LocationIdentity.Service).resolve({
      boundary: { kind: "implicit_local" },
      directory: AbsolutePath.make(directory),
      project: { kind: "registered_root", observedProjectId: "shared_project" },
    })
    const namespace = yield* db
      .select()
      .from(SecurityNamespaceTable)
      .where(eq(SecurityNamespaceTable.id, identity.securityNamespaceId))
      .get()
    const scope: BrowserSchema.Scope = {
      principal: "owner",
      securityNamespaceID: identity.securityNamespaceId,
      namespaceBindingHash: namespace!.binding_hash,
      locationKey: identity.locationKey,
      projectScopeKey: identity.projectScopeKey,
      sessionID,
      projectID: Project.ID.global,
      directory: identity.canonicalRoot,
      workspaceID: null,
    }
    const request: SharedBrowserSchema.Create = {
      version: 2,
      profile: SharedBrowserSchema.PROFILE,
      inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
      requestID: "create",
      sessionID,
      policy: {
        origin: "http://127.0.0.1:4455",
        approvedOrigins: ["http://127.0.0.1:4455"],
        manualApprovedOrigins: ["http://127.0.0.1:4455"],
        resolverPolicy: "system",
        postGrants: [],
      },
      expiresAt: Date.now() + 60_000,
    }
    return { db, scope, request, mainIncarnation: "main", sidecarIncarnation: "sidecar" }
  })
function observation(
  resource: SharedBrowserSchema.Resource,
  lease: SharedBrowserSchema.Lease | null,
  manual: boolean,
): SharedBrowserSchema.Observation {
  return {
    resourceID: resource.resourceID,
    mainIncarnation: resource.mainIncarnation,
    manualEpoch: resource.manualEpoch,
    barrierOrder: resource.barrierOrder,
    resourceAlive: true,
    agentAccessFenced: manual,
    leaseRevoked: manual,
    inputIsolated: true,
    heldReleased: true,
    transportStopped: true,
    manualEnabled: manual,
    unknownEffects: false,
    leaseID: lease?.leaseID ?? null,
    leaseEpoch: lease?.leaseEpoch ?? 0,
  }
}

test("shared close settlement requires complete cleanup and adopts only a monotone Main close frontier", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "dac-shared-close-")))
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const fixture = yield* setup(directory)
      for (const field of ["transportStopped", "inputIsolated", "heldReleased", "leaseRevoked"] as const) {
        const created = yield* SharedBrowserControl.create(fixture.db, { ...fixture,
          request: { ...fixture.request, requestID: `close-${field}` } })
        const active = yield* SharedBrowserControl.observeCreated(fixture.db, created.resource,
          observation(created.resource, created.lease, false))
        const input = { resourceID: active.resourceID, requestID: `reduce-${field}`, expectedRevision: active.revision }
        const prepared = yield* SharedBrowserControl.prepareClose(fixture.db, active, input)
        const result = { ...observation(prepared.resource, null, true), resourceAlive: false, manualEnabled: false,
          manualEpoch: prepared.resource.manualEpoch + 1, barrierOrder: prepared.resource.barrierOrder + 3 }
        for (const invalid of [
          { ...result, mainIncarnation: "other-main" },
          { ...result, manualEpoch: prepared.resource.manualEpoch },
          { ...result, barrierOrder: prepared.resource.barrierOrder },
        ]) expect(code(yield* SharedBrowserControl.observeClose(fixture.db, prepared.resource, input.requestID, invalid)
          .pipe(Effect.exit))).toMatchObject({ code: "BROWSER_CONFLICT" })
        const blocked = yield* SharedBrowserControl.observeClose(fixture.db, prepared.resource, input.requestID,
          { ...result, [field]: false })
        expect(blocked.state).toBe("recovery_required")
        expect(blocked.manualEpoch).toBe(result.manualEpoch)
        expect(blocked.manualEnabled).toBe(false)
        expect((yield* SharedBrowserControl.request(fixture.db, active.resourceID, input.requestID))?.state).toBe("unknown")
        expect(code(yield* SharedBrowserControl.observeClose(fixture.db, prepared.resource, input.requestID, result)
          .pipe(Effect.exit))).toMatchObject({ code: "BROWSER_CONFLICT" })
        const countBefore = yield* fixture.db.select({ total: count() }).from(BrowserSharedRequestTable).get()
        const retry = yield* SharedBrowserControl.prepareClose(fixture.db, blocked, input)
        const closed = yield* SharedBrowserControl.observeClose(fixture.db, retry.resource, input.requestID,
          { ...result, unknownEffects: true })
        expect(closed.state).toBe("closed")
        expect(closed.barrierOrder).toBe(result.barrierOrder)
        expect((yield* SharedBrowserControl.request(fixture.db, active.resourceID, input.requestID))?.state).toBe("completed")
        expect(yield* fixture.db.select({ total: count() }).from(BrowserSharedRequestTable).get()).toEqual(countBefore)
      }
    }).pipe(Effect.provide(runtime(path.join(directory, "close.sqlite"))), Effect.scoped))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("shared fileDB keeps exact receipts, monotone barriers and real durable queue cutoff", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "dac-shared-sql-")))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* setup(directory)
        const created = yield* SharedBrowserControl.create(fixture.db, fixture)
        expect(created.created).toBeTrue()
        const active = yield* SharedBrowserControl.observeCreated(
          fixture.db,
          created.resource,
          observation(created.resource, created.lease, false),
        )
        const events = yield* EventV2.Service
        const first = yield* SessionInput.admit(fixture.db, events, {
          id: SessionMessage.ID.make("msg_shared_old"),
          sessionID: SessionSchema.ID.make(active.rootSessionID),
          prompt: new Prompt({ text: "Old queue" }),
          delivery: "queue",
        })
        const ticket: SharedBrowserSchema.BarrierTicket = {
          resourceID: active.resourceID,
          rootSessionID: active.rootSessionID,
          mainIncarnation: "main",
          requestID: "takeover",
          expectedRevision: active.revision,
          manualEpoch: 1,
          barrierOrder: 10,
          reason: "human_takeover",
        }
        const fenced = yield* SharedBrowserControl.recordBarrier(fixture.db, ticket)
        expect(fenced.resource.coreCutoff).toBe(first.admittedSeq)
        expect((yield* SharedBrowserControl.lease(fixture.db, created.lease.leaseID))?.state).toBe("revoked")
        const human = yield* SharedBrowserControl.observeBarrier(
          fixture.db,
          ticket,
          observation(fenced.resource, null, true),
        )
        expect(human.state).toBe("human_owned")
        expect(
          (yield* SharedBrowserControl.observeBarrier(fixture.db, ticket, observation(fenced.resource, null, true)))
            .revision,
        ).toBe(human.revision)
        expect((yield* SharedBrowserControl.recordBarrier(fixture.db, ticket)).changed).toBeFalse()
        expect(
          code(
            yield* SharedBrowserControl.recordBarrier(fixture.db, { ...ticket, barrierOrder: 11 }).pipe(Effect.exit),
          ),
        ).toMatchObject({ code: "BROWSER_CONFLICT" })
        const later = yield* SessionInput.admit(fixture.db, events, {
          id: SessionMessage.ID.make("msg_shared_api"),
          sessionID: SessionSchema.ID.make(active.rootSessionID),
          prompt: new Prompt({ text: "Unattested API queue" }),
          delivery: "queue",
        })
        expect(later.admittedSeq).toBeGreaterThan(human.coreCutoff)
        expect(yield* SharedBrowserUserInput.get(fixture.db, later.id)).toBeUndefined()
        const denied = yield* SharedBrowserControl.prepareAcquire(fixture.db, {
          request: { resourceID: human.resourceID, requestID: "no-origin", expectedManualEpoch: 1 },
          scope: fixture.scope,
          sidecarIncarnation: "sidecar",
          witness: {
            inputID: later.id,
            rootSessionID: human.rootSessionID,
            mainIncarnation: "main",
            submissionOrder: 11,
            admittedSeq: later.admittedSeq,
            promotedSeq: later.admittedSeq + 1,
            originHash: "a".repeat(64),
            providerReceiptID: "missing",
            selectionID: "missing",
            projectionHash: "a".repeat(64),
          },
        }).pipe(Effect.exit)
        expect(code(denied)).toMatchObject({ code: "BROWSER_AUTHORITY_REQUIRED" })
        const second = {
          ...ticket,
          requestID: "lost",
          expectedRevision: human.revision,
          manualEpoch: 2,
          barrierOrder: 20,
          reason: "sidecar_lost" as const,
        }
        const next = yield* SharedBrowserControl.recordBarrier(fixture.db, second)
        expect(next.resource.coreCutoff).toBe(later.admittedSeq)
        expect(
          code(
            yield* SharedBrowserControl.observeBarrier(
              fixture.db,
              ticket,
              observation(fenced.resource, null, true),
            ).pipe(Effect.exit),
          ),
        ).toMatchObject({ code: "BROWSER_STALE_TARGET" })
        const manual = yield* SharedBrowserControl.observeBarrier(
          fixture.db,
          second,
          observation(next.resource, null, true),
        )
        const same = yield* SharedBrowserControl.create(fixture.db, fixture)
        expect(same.created).toBeFalse()
        expect(same.resource.resourceID).toBe(active.resourceID)
        expect(same.lease.state).toBe("revoked")
        const closing = yield* SharedBrowserControl.prepareClose(fixture.db, manual, {
          resourceID: manual.resourceID,
          requestID: "close",
          expectedRevision: manual.revision,
        })
        const closed = yield* SharedBrowserControl.observeClose(fixture.db, closing.resource, "close", {
          ...observation(closing.resource, null, true),
          resourceAlive: false,
          manualEnabled: false,
        })
        expect(closed.state).toBe("closed")
        expect((yield* SharedBrowserControl.request(fixture.db, closed.resourceID, "close"))?.state).toBe("completed")
      }).pipe(Effect.provide(runtime(path.join(directory, "actual.sqlite"))), Effect.scoped),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("v1 and shared resources share four active slots while retaining v1 record bytes", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "dac-shared-capacity-")))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* setup(directory)
        const request: BrowserSchema.Create = {
          profile: BrowserSchema.PROFILE,
          requestID: "legacy",
          sessionID: fixture.scope.sessionID,
          origin: "http://127.0.0.1:4455",
          expiresAt: fixture.request.expiresAt,
        }
        const input = {
          request,
          scope: fixture.scope,
          hostID: "host",
          hostIncarnation: fixture.sidecarIncarnation,
          sharedMainIncarnation: fixture.mainIncarnation,
          credentialBinding: "a".repeat(64),
        }
        const old = yield* BrowserControl.create(fixture.db, input)
        const before = BrowserControl.hash(old.record)
        for (const requestID of ["one", "two", "three"])
          expect(
            (yield* SharedBrowserControl.create(fixture.db, { ...fixture, request: { ...fixture.request, requestID } }))
              .created,
          ).toBeTrue()
        expect(
          code(
            yield* SharedBrowserControl.create(fixture.db, {
              ...fixture,
              request: { ...fixture.request, requestID: "five" },
            }).pipe(Effect.exit),
          ),
        ).toMatchObject({ code: "BROWSER_CAPACITY" })
        expect(
          code(
            yield* BrowserControl.create(fixture.db, {
              ...input,
              request: { ...request, requestID: "legacy-five" },
            }).pipe(Effect.exit),
          ),
        ).toMatchObject({ code: "BROWSER_CAPACITY" })
        expect(BrowserControl.hash((yield* BrowserControl.get(fixture.db, old.record.controlID))!)).toBe(before)
        expect(old.record.version).toBe(1)
      }).pipe(Effect.provide(runtime(path.join(directory, "actual.sqlite"))), Effect.scoped),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("trusted origin admission is atomic and only actual current promotion supplies receipt lineage", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "dac-shared-origin-")))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* setup(directory)
        const events = yield* EventV2.Service
        const created = yield* SharedBrowserControl.create(fixture.db, fixture)
        const active = yield* SharedBrowserControl.observeCreated(
          fixture.db,
          created.resource,
          observation(created.resource, created.lease, false),
        )
        const ticket: SharedBrowserSchema.BarrierTicket = {
          resourceID: active.resourceID,
          rootSessionID: active.rootSessionID,
          mainIncarnation: active.mainIncarnation,
          requestID: "before-owner-input",
          expectedRevision: active.revision,
          manualEpoch: 1,
          barrierOrder: 10,
          reason: "human_takeover",
        }
        const fenced = yield* SharedBrowserControl.recordBarrier(fixture.db, ticket)
        const originalHuman = yield* SharedBrowserControl.observeBarrier(
          fixture.db,
          ticket,
          observation(fenced.resource, null, true),
        )
        const approval: SharedBrowserSchema.ApproveOrigin = { resourceID: originalHuman.resourceID,
          requestID: "manual-origin", expectedRevision: originalHuman.revision, expectedManualEpoch: originalHuman.manualEpoch,
          expectedPolicyHash: originalHuman.policyHash, origin: "https://manual.example" }
        const before = SharedBrowserControl.hash(originalHuman)
        expect(code(yield* SharedBrowserControl.approveOrigin(fixture.db, originalHuman, approval,
          () => Effect.fail(BrowserControl.failure("BROWSER_SCOPE_DENIED"))).pipe(Effect.exit))).toMatchObject({ code: "BROWSER_SCOPE_DENIED" })
        expect(SharedBrowserControl.hash(yield* SharedBrowserControl.get(fixture.db, originalHuman.resourceID))).toBe(before)
        const human = yield* SharedBrowserControl.approveOrigin(fixture.db, originalHuman, approval, () => Effect.void)
        expect(human.policyRevision).toBe(2)
        expect(human.revision).toBe(originalHuman.revision + 1)
        expect(human.policy.approvedOrigins).toEqual(originalHuman.policy.approvedOrigins)
        expect(human.policy.manualApprovedOrigins).toEqual([...originalHuman.policy.manualApprovedOrigins, approval.origin])
        expect(human.policyApprovals?.length).toBe(1)
        expect(yield* SharedBrowserControl.approveOrigin(fixture.db, originalHuman, approval,
          () => Effect.die("Exact committed receipt must not create a new approval"))).toEqual(human)
        expect(code(yield* SharedBrowserControl.approveOrigin(fixture.db, human, { ...approval, origin: "https://other.example" },
          () => Effect.void).pipe(Effect.exit))).toMatchObject({ code: "BROWSER_CONFLICT" })
        expect(code(yield* SharedBrowserControl.approveOrigin(fixture.db, human, { ...approval, requestID: "stale-origin" },
          () => Effect.void).pipe(Effect.exit))).toMatchObject({ code: "BROWSER_CONFLICT" })
        const inputID = SessionMessage.ID.make("msg_shared_owner")
        const prompt = new Prompt({ text: "Continue the browser task" })
        const stamp: SharedBrowserSchema.InputStamp = {
          inputID,
          rootSessionID: fixture.scope.sessionID,
          originalSubmissionID: "owner-submit",
          rawInputHash: SharedBrowserUserInput.hash("Continue the browser task"),
          promptHash: SharedBrowserUserInput.hash(prompt),
          sourceKind: "gui_composer",
          sourceBindingHash: "a".repeat(64),
          mainIncarnation: "main",
          submissionOrder: 11,
        }
        // A deterministic registry seam tests this Core module only. It is not Main/Native
        // qualification, and no object from this fixture enters product runtime.
        const issued = new Map([[stamp.inputID, stamp]])
        const host = {
          mainIncarnation: "main",
          validateInput: (value: SharedBrowserSchema.InputStamp) =>
            Effect.succeed(
              SharedBrowserUserInput.hash(issued.get(value.inputID)) === SharedBrowserUserInput.hash(value),
            ),
        }
        const admit = () =>
          SharedBrowserUserInput.withOrigin(
            stamp,
            host,
            SessionInput.admit(fixture.db, events, {
              id: inputID,
              sessionID: SessionSchema.ID.make(fixture.scope.sessionID),
              prompt,
              delivery: "steer",
              commit: (admittedSeq) =>
                SharedBrowserUserInput.recordAdmission(fixture.db, {
                  id: inputID,
                  sessionID: fixture.scope.sessionID,
                  prompt,
                  delivery: "steer",
                  admittedSeq,
                }),
            }),
          )
        const wrongPrompt = yield* SharedBrowserUserInput.withOrigin(
          stamp,
          host,
          SharedBrowserUserInput.recordAdmission(fixture.db, {
            id: inputID,
            sessionID: fixture.scope.sessionID,
            prompt: new Prompt({ text: "Changed after sealing" }),
            delivery: "steer",
            admittedSeq: 0,
          }),
        ).pipe(Effect.exit)
        expect(code(wrongPrompt)).toMatchObject({ code: "BROWSER_AUTHORITY_REQUIRED" })
        expect(yield* SharedBrowserUserInput.get(fixture.db, inputID)).toBeUndefined()
        expect(
          code(
            yield* SharedBrowserUserInput.withOrigin({ ...stamp, promptHash: undefined }, host, Effect.void).pipe(
              Effect.exit,
            ),
          ),
        ).toMatchObject({ code: "BROWSER_AUTHORITY_REQUIRED" })
        const admitted = yield* admit()
        expect((yield* admit()).admittedSeq).toBe(admitted.admittedSeq)
        const pending = yield* SharedBrowserUserInput.get(fixture.db, inputID)
        expect(pending?.submissionOrder).toBe(11)
        expect(pending?.promotedSeq).toBeNull()
        const selected = yield* SessionInput.captureSelection(
          fixture.db,
          SessionSchema.ID.make(fixture.scope.sessionID),
          "steer",
        )
        const promoted = yield* SessionInput.promoteSelection(fixture.db, events, selected)
        expect(promoted).toEqual([inputID])
        const contexts = yield* SessionContext.Service
        const base = {
          db: fixture.db,
          contexts,
          sessionID: SessionSchema.ID.make(fixture.scope.sessionID),
          agent: "auto",
          location: { directory },
          system: { baseline: "fixture", revision: 0, baselineSeq: 1 },
        }
        const first = yield* SessionRunnerCanonical.admitSelection({
          ...base,
          promotedInputIds: promoted,
          historyEndMessageId: inputID,
        })
        const turns = yield* V2ProviderTurn.Service
        const firstTurn = yield* SessionRunnerCanonical.commitTurn({
          db: fixture.db,
          contexts,
          sessionID: SessionSchema.ID.make(fixture.scope.sessionID),
          admission: first,
          receipt: {
            sessionId: SessionSchema.ID.make(fixture.scope.sessionID),
            userMessageId: inputID,
            historyPromptEpoch: 0,
            requestInputHash: SharedBrowserUserInput.hash("first"),
            providerId: "fixture",
            modelId: "fixture",
            protocol: "openai-chat",
            ownerMode: "v2",
          },
          ownerToken: yield* turns.currentOwnerToken(),
        })
        yield* SharedBrowserUserInput.recordTurn(fixture.db, {
          sessionID: fixture.scope.sessionID,
          receiptID: firstTurn.receipt.receiptId,
          activityID: first.activityId,
          selectionID: first.selectionId,
          projectionHash: first.projectionHash,
          promotedInputIDs: promoted,
        })
        const origin = yield* fixture.db
          .select()
          .from(BrowserUserSelectionTable)
          .where(eq(BrowserUserSelectionTable.receipt_id, firstTurn.receipt.receiptId))
          .get()
        expect(origin?.input_id).toBe(inputID)
        const wire = "shared user-turn lineage fixture"
        const wireHash = Hash.sha256(wire)
        const prepared = V2ProviderTurn.prepare(
          {
            receipt: firstTurn.receipt,
            stableSystemParts: [],
            volatileSystemParts: [],
            historyMessages: [],
            toolDefinitions: [],
            toolIDs: ["browser"],
            toolChoice: null,
            toolResultReferences: [],
            budget: {
              decision: "ok",
              estimatedFullRequestTokens: 1,
              physicalInputBudget: 1000,
              reservedOutputTokens: 10,
              safetyMargin: 0,
              provenance: "model_limit",
            },
            userMessageID: inputID,
            activityID: first.activityId,
            providerTurnSeq: firstTurn.receipt.providerTurnSeq,
            contextSelectionID: first.selectionId,
            contextProjectionHash: first.projectionHash,
          },
          wireHash,
        )
        const streaming = yield* turns.markStreaming(
          yield* turns.seal(firstTurn.receipt, prepared, {
            wireHash,
            bodyHash: wireHash,
            bodyLength: Buffer.byteLength(wire),
            bodyText: wire,
            contentType: "application/json",
          }),
        )
        const witness = yield* SharedBrowserUserInput.witness(fixture.db, streaming.receiptId)
        expect(witness?.inputID).toBe(inputID)
        if (!witness) return yield* Effect.die(new Error("actual sealed receipt did not retain its user input lineage"))
        const acquire = {
          request: { resourceID: human.resourceID, requestID: "owner-acquire", expectedManualEpoch: 1, approvedOrigins: human.policy.manualApprovedOrigins },
          policy: { expectedHash: human.policyHash, approvedOrigins: human.policy.manualApprovedOrigins },
          scope: fixture.scope,
          sidecarIncarnation: "sidecar",
          witness,
        }
        expect(code(yield* SharedBrowserControl.prepareAcquire(fixture.db, acquire,
          () => Effect.fail(BrowserControl.failure("BROWSER_SCOPE_DENIED"))).pipe(Effect.exit))).toMatchObject({ code: "BROWSER_SCOPE_DENIED" })
        expect(yield* SharedBrowserControl.get(fixture.db, human.resourceID)).toEqual(human)
        expect(code(yield* SharedBrowserControl.prepareAcquire(fixture.db, { ...acquire,
          policy: { expectedHash: human.policyHash, approvedOrigins: [...human.policy.manualApprovedOrigins, "https://unapproved.example"] } }).pipe(Effect.exit)))
          .toMatchObject({ code: "BROWSER_SCOPE_DENIED" })
        const pendingLease = yield* SharedBrowserControl.prepareAcquire(fixture.db, acquire)
        expect(pendingLease.resource.policyRevision).toBe(3)
        expect(pendingLease.resource.policy.approvedOrigins).toEqual(human.policy.manualApprovedOrigins)
        expect(pendingLease.lease.policyHash).toBe(pendingLease.resource.policyHash)
        expect(pendingLease.created).toBeTrue()
        const owned = yield* SharedBrowserControl.observeAcquire(
          fixture.db,
          pendingLease.resource,
          pendingLease.lease,
          observation(pendingLease.resource, pendingLease.lease, false),
        )
        expect(owned.state).toBe("agent_owned")
        expect((yield* SharedBrowserControl.prepareAcquire(fixture.db, acquire)).created).toBeFalse()
        const nextTicket = {
          ...ticket,
          requestID: "second-owner-barrier",
          expectedRevision: owned.revision,
          manualEpoch: 2,
          barrierOrder: 20,
        }
        const nextFenced = yield* SharedBrowserControl.recordBarrier(fixture.db, nextTicket)
        yield* SharedBrowserControl.observeBarrier(fixture.db, nextTicket, observation(nextFenced.resource, null, true))
        expect(
          code(
            yield* SharedBrowserControl.prepareAcquire(fixture.db, {
              ...acquire,
              request: { ...acquire.request, requestID: "same-user-reacquire", expectedManualEpoch: 2 },
            }).pipe(Effect.exit),
          ),
        ).toMatchObject({ code: "BROWSER_AUTHORITY_REQUIRED" })
        yield* turns.settle({ receipt: streaming, outcome: "settled", outcomeArtifact: [] })
        const continuation = yield* SessionRunnerCanonical.admitSelection({
          ...base,
          promotedInputIds: [],
          fallbackUserInputId: inputID,
          historyEndMessageId: inputID,
        })
        const continued = yield* SessionRunnerCanonical.commitTurn({
          db: fixture.db,
          contexts,
          sessionID: SessionSchema.ID.make(fixture.scope.sessionID),
          admission: continuation,
          receipt: {
            sessionId: SessionSchema.ID.make(fixture.scope.sessionID),
            userMessageId: inputID,
            historyPromptEpoch: 0,
            requestInputHash: SharedBrowserUserInput.hash("continuation"),
            providerId: "fixture",
            modelId: "fixture",
            protocol: "openai-chat",
            ownerMode: "v2",
          },
          ownerToken: yield* turns.currentOwnerToken(),
        })
        yield* SharedBrowserUserInput.recordTurn(fixture.db, {
          sessionID: fixture.scope.sessionID,
          receiptID: continued.receipt.receiptId,
          activityID: continuation.activityId,
          selectionID: continuation.selectionId,
          projectionHash: continuation.projectionHash,
          promotedInputIDs: [],
        })
        expect(
          (yield* fixture.db
            .select()
            .from(BrowserUserSelectionTable)
            .where(eq(BrowserUserSelectionTable.receipt_id, continued.receipt.receiptId))
            .get())?.input_id,
        ).toBe(inputID)
        yield* turns.abandon(continued.receipt, "fixture_before_dispatch")
        const automatic = yield* SessionInput.admit(fixture.db, events, {
          id: SessionMessage.ID.make("msg_shared_automatic"),
          sessionID: SessionSchema.ID.make(fixture.scope.sessionID),
          prompt: new Prompt({ text: "Automatic root continuation" }),
          delivery: "steer",
        })
        const next = yield* SessionInput.promoteSelection(
          fixture.db,
          events,
          yield* SessionInput.captureSelection(fixture.db, SessionSchema.ID.make(fixture.scope.sessionID), "steer"),
        )
        const second = yield* SessionRunnerCanonical.admitSelection({
          ...base,
          promotedInputIds: next,
          historyEndMessageId: automatic.id,
        }).pipe(Effect.provideService(SessionRunnerCanonical.CurrentContinuationActivity, first.activityId))
        expect(second.selectionId).toBe(first.selectionId)
        const secondTurn = yield* SessionRunnerCanonical.commitTurn({
          db: fixture.db,
          contexts,
          sessionID: SessionSchema.ID.make(fixture.scope.sessionID),
          admission: second,
          receipt: {
            sessionId: SessionSchema.ID.make(fixture.scope.sessionID),
            userMessageId: automatic.id,
            historyPromptEpoch: 0,
            requestInputHash: SharedBrowserUserInput.hash("second"),
            providerId: "fixture",
            modelId: "fixture",
            protocol: "openai-chat",
            ownerMode: "v2",
          },
          ownerToken: yield* turns.currentOwnerToken(),
        })
        yield* SharedBrowserUserInput.recordTurn(fixture.db, {
          sessionID: fixture.scope.sessionID,
          receiptID: secondTurn.receipt.receiptId,
          activityID: second.activityId,
          selectionID: second.selectionId,
          projectionHash: second.projectionHash,
          promotedInputIDs: next,
        })
        const reset = yield* fixture.db
          .select()
          .from(BrowserUserSelectionTable)
          .where(eq(BrowserUserSelectionTable.receipt_id, secondTurn.receipt.receiptId))
          .get()
        expect(reset).toBeDefined()
        expect(reset?.input_id).toBeNull()
        expect(reset?.origin_hash).toBeNull()
        expect(
          yield* SharedBrowserUserInput.promoted(fixture.db, fixture.scope.sessionID, [automatic.id]),
        ).toBeUndefined()
        const bad = yield* SharedBrowserUserInput.withOrigin({ ...stamp, submissionOrder: 12 }, host, Effect.void).pipe(
          Effect.exit,
        )
        expect(code(bad)).toMatchObject({ code: "BROWSER_AUTHORITY_REQUIRED" })
      }).pipe(Effect.provide(runtime(path.join(directory, "actual.sqlite"))), Effect.scoped),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("trusted reducing barrier tolerates committed observation ahead of Main projection without granting stale ownership", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "dac-shared-projection-race-")))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* setup(directory)
        const created = yield* SharedBrowserControl.create(fixture.db, fixture)
        const active = yield* SharedBrowserControl.observeCreated(
          fixture.db,
          created.resource,
          observation(created.resource, created.lease, false),
        )
        expect(active.revision).toBe(created.resource.revision + 1)
        // Core has persisted this observation, but its post-transaction projection ACK to Main
        // has not run. The real reducing ticket therefore still references Main's older rev.
        const first: SharedBrowserSchema.BarrierTicket = {
          resourceID: active.resourceID,
          rootSessionID: active.rootSessionID,
          mainIncarnation: active.mainIncarnation,
          requestID: "projection-race-first",
          expectedRevision: created.resource.revision,
          manualEpoch: 1,
          barrierOrder: 10,
          reason: "human_takeover",
        }
        expect(
          code(
            yield* SharedBrowserControl.recordBarrier(fixture.db, {
              ...first,
              expectedRevision: active.revision + 1,
            }).pipe(Effect.exit),
          ),
        ).toMatchObject({ code: "BROWSER_CONFLICT" })
        const fenced = yield* SharedBrowserControl.recordBarrier(fixture.db, first)
        expect(fenced.resource.revision).toBe(active.revision + 1)
        expect(fenced.resource.liveLeaseID).toBeNull()
        expect((yield* SharedBrowserControl.lease(fixture.db, created.lease.leaseID))?.state).toBe("revoked")
        const human = yield* SharedBrowserControl.observeBarrier(
          fixture.db,
          first,
          observation(fenced.resource, null, true),
        )
        const second = {
          ...first,
          requestID: "projection-race-second",
          manualEpoch: 2,
          barrierOrder: 20,
          expectedRevision: fenced.resource.revision,
          reason: "sidecar_lost" as const,
        }
        expect(human.revision).toBe(second.expectedRevision + 1)
        expect(
          code(yield* SharedBrowserControl.recordBarrier(fixture.db, { ...second, manualEpoch: 1 }).pipe(Effect.exit)),
        ).toMatchObject({ code: "BROWSER_CONFLICT" })
        expect(
          code(
            yield* SharedBrowserControl.recordBarrier(fixture.db, { ...second, mainIncarnation: "another-main" }).pipe(
              Effect.exit,
            ),
          ),
        ).toMatchObject({ code: "BROWSER_SCOPE_DENIED" })
        const next = yield* SharedBrowserControl.recordBarrier(fixture.db, second)
        expect(next.resource.revision).toBe(human.revision + 1)
        expect(next.resource.manualEpoch).toBe(2)
        expect(next.resource.agentAccessFenced).toBeTrue()
        expect(next.resource.manualEnabled).toBeFalse()
        expect((yield* SharedBrowserControl.recordBarrier(fixture.db, second)).changed).toBeFalse()
        expect(
          code(
            yield* SharedBrowserControl.requireActive(fixture.db, next.resource.resourceID, fixture.scope).pipe(
              Effect.exit,
            ),
          ),
        ).toMatchObject({ code: "BROWSER_CANCELLED" })
        expect(
          code(
            yield* SharedBrowserControl.observeBarrier(
              fixture.db,
              first,
              observation(fenced.resource, null, true),
            ).pipe(Effect.exit),
          ),
        ).toMatchObject({ code: "BROWSER_STALE_TARGET" })
      }).pipe(Effect.provide(runtime(path.join(directory, "actual.sqlite"))), Effect.scoped),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("shared action journal persists an unknown once and does not redispatch the same canonical admission", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "dac-shared-action-")))
  try {
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* setup(directory)
        const created = yield* SharedBrowserControl.create(fixture.db, fixture)
        const resource = yield* SharedBrowserControl.observeCreated(
          fixture.db,
          created.resource,
          observation(created.resource, created.lease, false),
        )
        const active = yield* SharedBrowserControl.requireActive(fixture.db, resource.resourceID, fixture.scope)
        // This verifies the SQL leaf journal, not canonical tool admission or native execution.
        // Production supplies the actual private CurrentToolExecution admission and checks.
        const input = {
          ...active,
          command: { type: "tabs.list" } as const,
          timeoutMs: 1000,
          admission: {
            admissionId: "action-admission",
            sessionId: fixture.scope.sessionID,
            providerAttemptId: "actual-tool-seam",
            receiptId: "actual-tool-seam",
            toolCallId: "call",
            toolName: "browser",
            effectKind: "mutating" as const,
            ownerToken: "actual-tool-seam",
            timeCreated: Date.now(),
          },
        }
        const action = yield* SharedBrowserControl.prepareAction(fixture.db, input, () => Effect.void)
        expect(action.outcome).toBe("pending")
        expect((yield* SharedBrowserControl.getAction(fixture.db, action.actionID))?.commandHash).toBe(
          SharedBrowserControl.hash(input.command),
        )
        const unknown = yield* SharedBrowserControl.observeAction(fixture.db, action, {
          outcome: "unknown",
          errorCode: "BROWSER_UNKNOWN",
        })
        expect(unknown.outcome).toBe("unknown")
        expect(
          code(yield* SharedBrowserControl.prepareAction(fixture.db, input, () => Effect.void).pipe(Effect.exit)),
        ).toMatchObject({ code: "BROWSER_UNKNOWN" })
        expect(
          code(
            yield* SharedBrowserControl.observeAction(fixture.db, action, {
              outcome: "cancelled",
              errorCode: "BROWSER_CANCELLED",
            }).pipe(Effect.exit),
          ),
        ).toMatchObject({ code: "BROWSER_CONFLICT" })
        return unknown
      }).pipe(Effect.provide(runtime(path.join(directory, "actual.sqlite"))), Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(yield* SharedBrowserControl.getAction(db, saved.actionID)).toEqual(saved)
      }).pipe(Effect.provide(Database.layerFromPath(path.join(directory, "actual.sqlite"))), Effect.scoped),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("private-port capacity withholds origin without replaying the prompt body or inheriting an outer stamp", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "dac-shared-origin-capacity-")))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* setup(directory)
        const prompt = new Prompt({ text: "One ordinary chat despite browser pressure" })
        const stamp: SharedBrowserSchema.InputStamp = {
          inputID: "msg_shared_capacity",
          rootSessionID: fixture.scope.sessionID,
          originalSubmissionID: "owner-submit",
          rawInputHash: Hash.sha256(prompt.text),
          promptHash: SharedBrowserUserInput.hash(prompt),
          sourceKind: "gui_composer",
          sourceBindingHash: "a".repeat(64),
          mainIncarnation: "main",
          submissionOrder: 11,
        }
        const counts = { validates: 0, body: 0 }
        const current = { mainIncarnation: "main", validateInput: () => Effect.succeed(true) }
        const busy = {
          mainIncarnation: "main",
          validateInput: () =>
            Effect.sync(() => {
              counts.validates++
            }).pipe(Effect.andThen(Effect.fail(BrowserControl.failure("BROWSER_CAPACITY")))),
        }
        const admitted = yield* SharedBrowserUserInput.withOrigin(
          stamp,
          current,
          SharedBrowserUserInput.withOrigin(
            stamp,
            busy,
            Effect.gen(function* () {
              counts.body++
              return yield* SessionInput.admit(fixture.db, yield* EventV2.Service, {
                id: SessionMessage.ID.make(stamp.inputID),
                sessionID: SessionSchema.ID.make(stamp.rootSessionID),
                prompt,
                delivery: "steer",
                commit: (admittedSeq) =>
                  SharedBrowserUserInput.recordAdmission(fixture.db, {
                    id: stamp.inputID,
                    sessionID: stamp.rootSessionID,
                    prompt,
                    delivery: "steer",
                    admittedSeq,
                  }),
              })
            }),
          ),
        )
        expect(admitted.id).toBe(SessionMessage.ID.make(stamp.inputID))
        expect(counts.validates).toBe(1)
        expect(counts.body).toBe(1)
        expect(yield* SharedBrowserUserInput.get(fixture.db, stamp.inputID)).toBeUndefined()
        const denied = { mainIncarnation: "main", validateInput: () => Effect.succeed(false) }
        expect(
          code(yield* SharedBrowserUserInput.withOrigin(stamp, denied, Effect.void).pipe(Effect.exit)),
        ).toMatchObject({ code: "BROWSER_AUTHORITY_REQUIRED" })
      }).pipe(Effect.provide(runtime(path.join(directory, "actual.sqlite"))), Effect.scoped),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("blocked manual setup leaves takeover retryable until the same reducing ticket confirms real manual availability", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "dac-shared-takeover-recovery-")))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* setup(directory)
        const created = yield* SharedBrowserControl.create(fixture.db, fixture)
        const active = yield* SharedBrowserControl.observeCreated(
          fixture.db,
          created.resource,
          observation(created.resource, created.lease, false),
        )
        const ticket: SharedBrowserSchema.BarrierTicket = {
          resourceID: active.resourceID,
          rootSessionID: active.rootSessionID,
          mainIncarnation: active.mainIncarnation,
          requestID: "takeover-manual-recovery",
          expectedRevision: active.revision,
          manualEpoch: 1,
          barrierOrder: 10,
          reason: "human_takeover",
        }
        const fenced = yield* SharedBrowserControl.recordBarrier(fixture.db, ticket)
        const unavailable = { ...observation(fenced.resource, null, true), manualEnabled: false }
        const blocked = yield* SharedBrowserControl.observeBarrier(fixture.db, ticket, unavailable)
        expect(blocked.state).toBe("fenced_blocked")
        expect((yield* SharedBrowserControl.request(fixture.db, active.resourceID, ticket.requestID))?.state).toBe(
          "unknown",
        )
        const retry = yield* SharedBrowserControl.recordBarrier(fixture.db, ticket)
        expect(retry.changed).toBeFalse()
        expect(retry.resource.coreCutoff).toBe(fenced.resource.coreCutoff)
        const recovered = yield* SharedBrowserControl.observeBarrier(
          fixture.db,
          ticket,
          observation(blocked, null, true),
        )
        expect(recovered.state).toBe("human_owned")
        expect((yield* SharedBrowserControl.request(fixture.db, active.resourceID, ticket.requestID))?.state).toBe(
          "completed",
        )
        expect((yield* SharedBrowserControl.lease(fixture.db, created.lease.leaseID))?.state).toBe("revoked")
        expect(
          code(
            yield* SharedBrowserControl.requireActive(fixture.db, active.resourceID, fixture.scope).pipe(Effect.exit),
          ),
        ).toMatchObject({ code: "BROWSER_CANCELLED" })
        expect(
          (yield* SharedBrowserControl.observeBarrier(fixture.db, ticket, observation(blocked, null, true))).revision,
        ).toBe(recovered.revision)
        expect(
          code(yield* SharedBrowserControl.observeBarrier(fixture.db, ticket, unavailable).pipe(Effect.exit)),
        ).toMatchObject({ code: "BROWSER_CONFLICT" })
      }).pipe(Effect.provide(runtime(path.join(directory, "actual.sqlite"))), Effect.scoped),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
