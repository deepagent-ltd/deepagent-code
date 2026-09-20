import { describe, expect, test, beforeEach } from "bun:test"
import { Effect } from "effect"
import { Hash } from "@deepagent-code/core/util/hash"
import {
  mapCapabilityLoadResult,
  sessionCapabilityLoad,
  recordedCapabilityLoadsForDirectory,
  recordedCapabilityLoadsForSession,
  withTurnIdentity,
  capabilityLoadRequestHash,
  type CapabilityLoadRequest,
  type CapabilityLoadTurnIdentity,
} from "@deepagent-code/core/system-context/capability-load-adapter"
import { Database } from "@deepagent-code/core/database/database"
import { capabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import { capabilitySearch, fullAuthorization } from "@deepagent-code/core/system-context/capability-search"
import { findCapabilityBody } from "@deepagent-code/core/system-context/capability-bodies"
import type { CapabilityLoadResult } from "@deepagent-code/core/system-context/capability-loader"
import { resetCapabilityLoader } from "@deepagent-code/core/system-context/capability-loader-memory"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"

// C4-07 — wire the K2 kernel onto the frozen C0-02 contract: the 6-state -> ContentLoadState
// mapping, the frozen durable receipt, the withTurnIdentity seam, and the search -> load path.
// W4: `sessionCapabilityLoad` persists the receipt to `session_capability_load` (in-memory DB).

const digestOf = (body: string): string => `sha256:${Hash.sha256(body)}`

/** Run an adapter call against a fresh in-memory DB (migrations applied by the layer). */
const load = (args: Parameters<typeof sessionCapabilityLoad>[1]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* sessionCapabilityLoad(db, args)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
  )

const REQUEST: CapabilityLoadRequest = {
  capabilityId: "deepagent.code-read",
  version: "1.0.0-beta.0",
  bodyHash: digestOf("Read source body"),
  runtimeHash: "rt-1",
  permissionHash: "perm-1",
  bodyRef: "capability://deepagent.code-read@1.0.0-beta.0",
  body: "Read source body",
  declaredDigest: digestOf("Read source body"),
  catalogSnapshotId: "capability_catalog:test",
  requiredPermissions: ["read", "glob", "grep"],
  grantedPermissions: ["read", "glob", "grep"],
  requiredRuntimeFeatures: [],
}

const IDENTITY: CapabilityLoadTurnIdentity = { sessionId: "session-1", activityId: "activity-1", turnId: "turn-1" }

beforeEach(() => resetCapabilityLoader())

function kernelReceipt(bodyHash = digestOf("Read source body")) {
  return {
    identity: "capability_load:abc",
    capabilityId: "deepagent.code-read",
    version: "1.0.0-beta.0",
    bodyRef: "capability://deepagent.code-read@1.0.0-beta.0",
    bodyHash,
    runtimeHash: "rt-1",
    permissionHash: "perm-1",
    state: "loaded" as const,
    tokenCount: 5,
    byteCount: 20,
  }
}

// --- mapping table: every K2 kernel state -> ContentLoadState --------------------
describe("mapCapabilityLoadResult (6-state kernel -> ContentLoadState)", () => {
  const cases: ReadonlyArray<[string, CapabilityLoadResult, { state: string; extra: Record<string, unknown> }]> = [
    [
      "available",
      { state: "available", body: "b", tokenCount: 5, byteCount: 20, receipt: kernelReceipt() },
      {
        state: "loaded",
        extra: { bodyRef: "capability://deepagent.code-read@1.0.0-beta.0", tokenCount: 5, byteCount: 20 },
      },
    ],
    [
      "existing",
      { state: "existing", body: "b", receipt: kernelReceipt() },
      { state: "already_loaded", extra: { bodyRef: "capability://deepagent.code-read@1.0.0-beta.0" } },
    ],
    [
      "denied",
      { state: "denied", reasonCode: "permission_scope_denied" },
      { state: "denied", extra: { reasonCode: "permission_scope_denied" } },
    ],
    [
      "budget_exceeded",
      { state: "budget_exceeded", level: "L2", limitTokens: 1200, requestedTokens: 1500 },
      {
        state: "budget_exceeded",
        extra: { level: "L2", limitTokens: 1200, requestedTokens: 1500, limitNewPerTurn: 2, newThisTurn: 0 },
      },
    ],
    [
      "missing_body",
      { state: "missing_body", bodyRef: "capability://deepagent.code-edit@1.0.0-beta.0" },
      { state: "not_found", extra: { reasonCode: "capability_unregistered" } },
    ],
    [
      "superseded",
      { state: "superseded", supersedingRef: "capability://deepagent.code-read@2.0.0-beta.0" },
      { state: "not_found", extra: { reasonCode: "catalog_snapshot_mismatch" } },
    ],
  ]

  for (const [label, kernel, expected] of cases) {
    test(`${label} -> ${expected.state}`, () => {
      const mapped = mapCapabilityLoadResult(kernel) as { state: string } & Record<string, unknown>
      expect(mapped.state).toBe(expected.state)
      for (const [key, value] of Object.entries(expected.extra)) expect(mapped[key]).toEqual(value)
    })
  }
})

// --- frozen receipt field completeness -------------------------------------------
describe("sessionCapabilityLoad builds the durable frozen receipt", () => {
  test("a successful load yields a ContentLoadState 'loaded' + a fully-populated receipt", async () => {
    const out = await load({ request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-1" })
    expect(out.state.state).toBe("loaded")
    const receipt = out.receipt
    // Every frozen field is present and coherent.
    expect(receipt.schemaVersion).toBe("capability-load.v1")
    expect(receipt.contentKind).toBe("capability")
    expect(receipt.loadId).toBeTruthy()
    expect(receipt.sessionId).toBe("session-1")
    expect(receipt.activityId).toBe("activity-1")
    expect(receipt.turnId).toBe("turn-1")
    expect(receipt.catalogSnapshotId).toBe("capability_catalog:test")
    expect(receipt.version).toBe("1.0.0-beta.0")
    expect(receipt.bodyHash).toBe(REQUEST.bodyHash)
    expect(receipt.runtimeHash).toBe("rt-1")
    expect(receipt.permissionHash).toBe("perm-1")
    expect(receipt.permissionBinding.required).toEqual(["read", "glob", "grep"])
    expect(receipt.permissionBinding.granted).toEqual(["read", "glob", "grep"])
    expect(receipt.requestHash).toBeTruthy()
    expect(receipt.resultHash).toBeTruthy()
    expect(receipt.contextEpoch).toBe("epoch-1")
    expect(receipt.level).toBe("L2")
    expect(receipt.bodyRef).toBe(REQUEST.bodyRef)
    expect(receipt.budgetState).toBe("within")
    expect(receipt.newLoadsThisTurn).toBeGreaterThanOrEqual(0)
    expect(receipt.tokenCount).toBeGreaterThan(0)
    expect(receipt.byteCount).toBeGreaterThan(0)
  })

  test("request hash is byte-stable and binds turn/session identity", () => {
    const a = capabilityLoadRequestHash(REQUEST, IDENTITY)
    const b = capabilityLoadRequestHash(REQUEST, IDENTITY)
    expect(a).toBe(b)
    const c = capabilityLoadRequestHash(REQUEST, { ...IDENTITY, turnId: "turn-2" })
    expect(c).not.toBe(a)
  })

  test("withTurnIdentity binds the real session/activity/turn identity into the request", () => {
    const bound = withTurnIdentity(REQUEST, IDENTITY)
    expect(bound.sessionId).toBe("session-1")
    expect(bound.activityId).toBe("activity-1")
    expect(bound.turnId).toBe("turn-1")
    expect(bound.capabilityId).toBe("deepagent.code-read")
  })

  test("an exact retry returns the already_loaded state with a stable request/body binding", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const first = yield* sessionCapabilityLoad(db, {
          request: REQUEST,
          identity: IDENTITY,
          contextEpoch: "epoch-1",
        })
        const second = yield* sessionCapabilityLoad(db, {
          request: REQUEST,
          identity: IDENTITY,
          contextEpoch: "epoch-1",
        })
        expect(second.state.state).toBe("already_loaded")
        expect(second.receipt.requestHash).toBe(first.receipt.requestHash)
        expect(second.receipt.bodyHash).toBe(first.receipt.bodyHash)
        expect(second.receipt.catalogSnapshotId).toBe(first.receipt.catalogSnapshotId)
        expect(second.body).toBe("Read source body")
      }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
    )
  })

  test("sessionCapabilityLoad persists the receipt to session_capability_load (W4 write table)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const out = yield* sessionCapabilityLoad(db, { request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-1" })
        expect(out.state.state).toBe("loaded")
        // Durable read-back from the SAME connection.
        const receipts = yield* recordedCapabilityLoadsForSession(db, "session-1", REQUEST.catalogSnapshotId)
        expect(receipts).toHaveLength(1)
        expect(receipts[0]!.loadId).toBe(out.receipt.loadId)
        expect(receipts[0]!.bodyHash).toBe(REQUEST.bodyHash)
        expect(receipts[0]!.sessionId).toBe("session-1")
      }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
    )
  })

  test("directory diagnostics read durable receipts without crossing workspace roots", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const leftProject = ProjectV2.ID.make("project-capability-left")
        const rightProject = ProjectV2.ID.make("project-capability-right")
        const leftSession = SessionSchema.ID.make("ses_capability_left")
        const rightSession = SessionSchema.ID.make("ses_capability_right")
        yield* db
          .insert(ProjectTable)
          .values([
            { id: leftProject, worktree: AbsolutePath.make("/tmp/capability-left"), sandboxes: [] },
            { id: rightProject, worktree: AbsolutePath.make("/tmp/capability-right"), sandboxes: [] },
          ])
          .run()
        yield* db
          .insert(SessionTable)
          .values([
            {
              id: leftSession,
              project_id: leftProject,
              slug: "capability-left",
              directory: "/tmp/capability-left",
              title: "Capability left",
              version: "test",
            },
            {
              id: rightSession,
              project_id: rightProject,
              slug: "capability-right",
              directory: "/tmp/capability-right",
              title: "Capability right",
              version: "test",
            },
          ])
          .run()
        yield* sessionCapabilityLoad(db, {
          request: REQUEST,
          identity: { sessionId: leftSession, activityId: "activity-left", turnId: "turn-left" },
          contextEpoch: "epoch-left",
        })
        yield* sessionCapabilityLoad(db, {
          request: REQUEST,
          identity: { sessionId: rightSession, activityId: "activity-right", turnId: "turn-right" },
          contextEpoch: "epoch-right",
        })

        const left = yield* recordedCapabilityLoadsForDirectory(db, "/tmp/capability-left")
        const right = yield* recordedCapabilityLoadsForDirectory(db, "/tmp/capability-right")
        expect(left.map((entry) => entry.receipt.sessionId)).toEqual([leftSession])
        expect(right.map((entry) => entry.receipt.sessionId)).toEqual([rightSession])
      }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
    )
  })
})

// --- search -> load path: available index is reachable ---------------------------
describe("L0 catalog -> L1 search -> L2 load is reachable (available index non-empty)", () => {
  test("a known capability card is searchable, then its body loads through the kernel", async () => {
    const cards = capabilitySearch(
      capabilityCatalog,
      { query: "read source", intended_action: "read" },
      fullAuthorization,
    )
    expect(cards.some((card) => card.id === "deepagent.code-read")).toBe(true)

    const entry = findCapabilityBody("capability://deepagent.code-read@1.0.0-beta.0")
    expect(entry).toBeTruthy()

    const out = await load({
      request: {
        capabilityId: entry!.id,
        version: entry!.version,
        bodyHash: entry!.body_hash!,
        runtimeHash: "rt-catalog",
        permissionHash: "perm-catalog",
        bodyRef: entry!.body_ref,
        body: entry!.body,
        declaredDigest: entry!.body_hash!,
        catalogSnapshotId: "capability_catalog:local",
        requiredPermissions: entry!.required_permissions,
        grantedPermissions: entry!.required_permissions,
        requiredRuntimeFeatures: entry!.required_runtime_features,
      },
      identity: IDENTITY,
      contextEpoch: "epoch-search",
    })
    expect(out.state.state).toBe("loaded")
    expect(out.body).toBe(entry!.body)
  })
})

// --- observable store reset -------------------------------------------------------
describe("adapter is independent of the standalone kernel cache", () => {
  test("resetting standalone kernel state cannot alter a fresh durable store", async () => {
    await load({ request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-1" })
    resetCapabilityLoader()
    const again = await load({ request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-1" })
    expect(again.state.state).toBe("loaded")
  })
})

// --- W4 session scope: cross-session loads + durable per-session read-back ---
describe("session-scoped loads (W4)", () => {
  test("two different sessions loading the same body are BOTH loaded with the body", async () => {
    resetCapabilityLoader()
    const first = await load({ request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-1" })
    const second = await load({
      request: REQUEST,
      identity: { ...IDENTITY, sessionId: "session-2" },
      contextEpoch: "epoch-1",
    })
    expect(first.state.state).toBe("loaded")
    expect(second.state.state).toBe("loaded")
    expect(second.body).toBe("Read source body")
  })

  test("each session's durable receipts are filtered per session (snapshot restoration shape)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* sessionCapabilityLoad(db, { request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-1" })
        yield* sessionCapabilityLoad(db, {
          request: { ...REQUEST, capabilityId: "deepagent.code-edit" },
          identity: { sessionId: "session-1", activityId: "activity-1", turnId: "turn-1" },
          contextEpoch: "epoch-1",
        })
        yield* sessionCapabilityLoad(db, {
          request: REQUEST,
          identity: { sessionId: "session-2", activityId: "activity-2", turnId: "turn-2" },
          contextEpoch: "epoch-1",
        })
        const receiptsOne = yield* recordedCapabilityLoadsForSession(db, "session-1", REQUEST.catalogSnapshotId)
        expect(receiptsOne).toHaveLength(2)
        expect(receiptsOne.every((receipt) => receipt.sessionId === "session-1")).toBe(true)
        const receiptsTwo = yield* recordedCapabilityLoadsForSession(db, "session-2", REQUEST.catalogSnapshotId)
        expect(receiptsTwo).toHaveLength(1)
      }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
    )
  })

  test("W15 P4: durable receipts are ALSO filtered per catalog snapshot (mixed-epoch rows never leak into the restore)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* sessionCapabilityLoad(db, { request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-a" })
        // Same session, DIFFERENT catalog snapshot (a different Context Epoch): the row is a
        // mixed-epoch fact and must not fold into the CURRENT snapshot restore.
        yield* sessionCapabilityLoad(db, {
          request: { ...REQUEST, catalogSnapshotId: "capability_catalog:other" },
          identity: { sessionId: "session-1", activityId: "activity-1", turnId: "turn-1" },
          contextEpoch: "epoch-b",
        })
        const receipts = yield* recordedCapabilityLoadsForSession(db, "session-1", REQUEST.catalogSnapshotId)
        expect(receipts).toHaveLength(1)
        expect(receipts[0]!.catalogSnapshotId).toBe(REQUEST.catalogSnapshotId)
        const other = yield* recordedCapabilityLoadsForSession(db, "session-1", "capability_catalog:other")
        expect(other).toHaveLength(1)
        expect(other[0]!.catalogSnapshotId).toBe("capability_catalog:other")
      }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
    )
  })

  test("concurrent exact loads converge on one durable winner", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const outputs = yield* Effect.all(
          [
            sessionCapabilityLoad(db, { request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-1" }),
            sessionCapabilityLoad(db, { request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-1" }),
          ],
          { concurrency: "unbounded" },
        )
        expect(outputs.map((output) => output.state.state).toSorted()).toEqual(["already_loaded", "loaded"])
        expect(yield* recordedCapabilityLoadsForSession(db, "session-1", REQUEST.catalogSnapshotId)).toHaveLength(1)
      }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
    )
  })
})
