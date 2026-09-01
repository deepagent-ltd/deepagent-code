import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Database } from "@deepagent-code/core/database/database"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { Tools } from "@deepagent-code/core/tool/tools"
import { Tool } from "@deepagent-code/core/tool/tool"
import { builtinToolNames } from "@deepagent-code/core/tool/builtins"
import { RuntimeFeatures, UnknownRuntimeFeatureError } from "@deepagent-code/core/flag/runtime-features"
import { capabilityCatalog, capabilityCatalogSnapshotId } from "@deepagent-code/core/system-context/capability-catalog"
import { makeRuntimeAuthorizedSearchTool } from "@deepagent-code/core/system-context/capability-runtime-search"
import {
  makeCapabilityLoadTool,
  makeDomainPackLoadTool,
} from "@deepagent-code/core/system-context/capability-load-tool"
import {
  capabilityLoadFactOf,
  recordedCapabilityLoadsForSession,
  sessionCapabilityLoad,
  type CapabilityLoadRequest,
  type CapabilityLoadTurnIdentity,
} from "@deepagent-code/core/system-context/capability-load-adapter"
import { resetCapabilityLoader, recordedCapabilityLoads } from "@deepagent-code/core/system-context/capability-loader"
import { rebuildSnapshotFromReceipts } from "@deepagent-code/core/system-context/capability-snapshot"
import {
  assertInventoryMatchesRegistry,
  CatalogRegistryMismatchError,
  type CapabilityManifest,
} from "@deepagent-code/core/system-context/capability-manifest"
import { capabilityBodyFor } from "@deepagent-code/core/system-context/capability-bodies"

// W4 — Capability L2 production acceptance: session-scoped loads + durable
// session_capability_load writes/read-back (snapshot restoration closure), the
// production capability_load tool settle (budget gate + audit receipt + snapshot
// change), the runtime-authorized search snapshot id binding, RuntimeFeatures real
// values, and the inventory↔registry consistency gate.

const SESSION = SessionV2.ID.make("ses_l2_production")
const AGENT = AgentV2.ID.make("build")
const IDENTITY: CapabilityLoadTurnIdentity = {
  sessionId: SESSION,
  activityId: "activity-l2",
  turnId: "turn-l2",
}

const toolContext = (callID: string): Tool.Context => ({
  sessionID: SESSION,
  agent: AGENT,
  assistantMessageID: SessionMessage.ID.make("msg_l2_production"),
  toolCallID: callID,
})

/** Build the adapter request for a catalog capability (real body from the body lane). */
function requestFor(
  capabilityId: string,
  catalog: ReadonlyArray<CapabilityManifest> = capabilityCatalog,
): CapabilityLoadRequest {
  const manifest = catalog.find((entry) => entry.id === capabilityId)!
  const entry = capabilityBodyFor(manifest.id, manifest.version)
  return {
    capabilityId: manifest.id,
    version: manifest.version,
    bodyHash: entry?.body_hash ?? "",
    runtimeHash: "rt-l2",
    permissionHash: "perm-l2",
    bodyRef: manifest.body_ref,
    body: entry?.body,
    declaredDigest: entry?.body_hash,
    catalogSnapshotId: capabilityCatalogSnapshotId,
    requiredPermissions: manifest.required_permissions,
    grantedPermissions: manifest.required_permissions,
    requiredRuntimeFeatures: manifest.required_runtime_features,
  }
}

/** The layer used by the tool-settle cases: the Location tool registry + a real in-memory DB. */
const toolLayer = Layer.mergeAll(ToolRegistry.defaultLayer, Database.layerFromPath(":memory:"))

function registerLoadTools(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools
      .register({
        capability_load: makeCapabilityLoadTool({ db, turnIdentity: () => Effect.succeed(IDENTITY) }),
        domain_pack_load: makeDomainPackLoadTool({ db, turnIdentity: () => Effect.succeed(IDENTITY) }),
      })
      .pipe(Effect.orDie)
  })
}

function settleLoadCall(id: string, capabilityId: string) {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const materialized = yield* registry.materialize()
    return yield* materialized.settle({
      sessionID: SESSION,
      agent: AGENT,
      assistantMessageID: SessionMessage.ID.make("msg_l2_production"),
      call: {
        type: "tool-call",
        id,
        name: "capability_load",
        input: {
          schemaVersion: "capability-load-request.v1",
          capabilityId,
          catalogSnapshotId: capabilityCatalogSnapshotId,
          reason: "operation_guidance",
          expectedActions: ["read"],
        },
      },
    })
  })
}

describe("session-scoped load: two sessions load the same body (W4 step 2)", () => {
  beforeEach(() => resetCapabilityLoader())

  test("two DIFFERENT sessions loading the same body are both 'loaded' with a non-empty body", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const first = yield* sessionCapabilityLoad(db, {
          request: requestFor("deepagent.code-read"),
          identity: IDENTITY,
          contextEpoch: "epoch-l2",
        })
        const second = yield* sessionCapabilityLoad(db, {
          request: requestFor("deepagent.code-read"),
          identity: { ...IDENTITY, sessionId: SessionV2.ID.make("ses_l2_other") },
          contextEpoch: "epoch-l2",
        })
        expect(first.state.state).toBe("loaded")
        expect(second.state.state).toBe("loaded")
        expect(first.body).toBeTruthy()
        expect(second.body).toBe(first.body)
        // Both are registered for the session-snapshot filter (one per session).
        expect(recordedCapabilityLoads()).toHaveLength(2)
      }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
    )
  })

  test("the SAME session retrying the exact same body is idempotent AND returns the body", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const first = yield* sessionCapabilityLoad(db, { request: requestFor("deepagent.code-read"), identity: IDENTITY, contextEpoch: "epoch-l2" })
        const retry = yield* sessionCapabilityLoad(db, { request: requestFor("deepagent.code-read"), identity: IDENTITY, contextEpoch: "epoch-l2" })
        expect(first.state.state).toBe("loaded")
        expect(retry.state.state).toBe("already_loaded")
        expect(retry.body).toBe(first.body)
      }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
    )
  })
})

describe("durable receipt: write table → NEW store instance (new DB connection) reads back (W4 step 3/§7.5 closure)", () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "w4-l2-capability-"))
    file = path.join(dir, "capability-l2.db")
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  test("a receipt written through one DB connection is read back by a NEW connection and rebuilds the same snapshot", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Connection A: load through the kernel (records the in-module receipt + the durable row).
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* sessionCapabilityLoad(db, { request: requestFor("deepagent.code-read"), identity: IDENTITY, contextEpoch: "epoch-l2" })
        }).pipe(Effect.provide(Database.layerFromPath(file)))
        // The in-memory snapshot facts at dispatch time (design §7.5: the snapshot is built
        // from the loaded hashes; bodies are not kept in the prefix). The kernel receipts are
        // folded to the session facts exactly like the runner does (llm.ts snapshot filter).
        const before = rebuildSnapshotFromReceipts(
          recordedCapabilityLoads().map((receipt) => ({ capabilityId: receipt.capabilityId, bodyHash: receipt.bodyHash })),
          capabilityCatalog,
        )

        // Simulated restart: the kernel store is gone, only the durable rows remain.
        resetCapabilityLoader()

        // Connection B: a NEW store/DB connection re-reads the durable receipt and the
        // snapshot is rebuilt to the SAME loaded facts (the §7.5 restoration closure).
        const after = yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          const receipts = yield* recordedCapabilityLoadsForSession(db, SESSION)
          expect(receipts).toHaveLength(1)
          expect(receipts[0]!.sessionId).toBe(SESSION)
          expect(receipts[0]!.bodyHash).toBe(requestFor("deepagent.code-read").bodyHash)
          return rebuildSnapshotFromReceipts(receipts.map(capabilityLoadFactOf), capabilityCatalog)
        }).pipe(Effect.provide(Database.layerFromPath(file)))

        expect(after.loadedCapabilities).toEqual(before.loadedCapabilities)
        expect(after.catalogSnapshotId).toBe(before.catalogSnapshotId)
      }),
    )
  })
})

describe("capability_load tool settle: budget gate + audit receipt + snapshot change (W4 step 4)", () => {
  beforeEach(() => resetCapabilityLoader())

  test("a settled load is 'loaded', persists an audit receipt, and grows the snapshot loadedCapabilities", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* registerLoadTools(db)
        const settlement = yield* settleLoadCall("call-load-1", "deepagent.code-read")

        // Model-visible text: the card + a bounded preview (never the full body).
        expect(settlement.result.type).toBe("text")
        const text = String(settlement.result.value)
        expect(text).toContain("Body preview:")
        expect(text).toContain("deepagent.code-read")

        // Durable audit receipt in session_capability_load.
        const receipts = yield* recordedCapabilityLoadsForSession(db, SESSION)
        expect(receipts).toHaveLength(1)
        expect(receipts[0]!.state.state).toBe("loaded")
        expect(receipts[0]!.bodyHash).toBe(requestFor("deepagent.code-read").bodyHash)
        expect(receipts[0]!.resultHash).toBeTruthy()

        // Snapshot change: the loaded capability is now part of the epoch's loadedCapabilities
        // (folded to the session facts exactly like the runner does).
        const snapshot = rebuildSnapshotFromReceipts(
          recordedCapabilityLoads().map((receipt) => ({ capabilityId: receipt.capabilityId, bodyHash: receipt.bodyHash })),
          capabilityCatalog,
        )
        expect(snapshot.loadedCapabilities).toContainEqual(capabilityLoadFactOf(receipts[0]!))
      }).pipe(Effect.provide(toolLayer), Effect.scoped),
    )
  })

  test("the per-turn budget gate settles as typed budget_exceeded (no receipt for the rejected body)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* registerLoadTools(db)
        yield* settleLoadCall("call-load-a", "deepagent.code-read")
        yield* settleLoadCall("call-load-b", "deepagent.code-edit")
        // The 3rd distinct L2 body in the same turn is over the frozen per-turn cap.
        const third = yield* settleLoadCall("call-load-c", "deepagent.shell-execute")
        expect(third.result.type).toBe("text")
        expect(String(third.result.value)).toContain("budget")
        // Only the two actually-loaded bodies have durable rows.
        const receipts = yield* recordedCapabilityLoadsForSession(db, SESSION)
        expect(receipts).toHaveLength(2)
      }).pipe(Effect.provide(toolLayer), Effect.scoped),
    )
  })

  test("both load tools carry the capability.read permission", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const loadTool = makeCapabilityLoadTool({ db, turnIdentity: () => Effect.succeed(IDENTITY) })
        const packTool = makeDomainPackLoadTool({ db, turnIdentity: () => Effect.succeed(IDENTITY) })
        expect(Tool.permission(loadTool, "capability_load")).toBe("capability.read")
        expect(Tool.permission(packTool, "domain_pack_load")).toBe("capability.read")
      }).pipe(Effect.provide(Database.layerFromPath(":memory:"))),
    ))

  test("domain_pack_load settles as the typed not_found(domain_pack_not_active)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* registerLoadTools(db)
        const registry = yield* ToolRegistry.Service
        const materialized = yield* registry.materialize()
        const settlement = yield* materialized.settle({
          sessionID: SESSION,
          agent: AGENT,
          assistantMessageID: SessionMessage.ID.make("msg_l2_production"),
          call: {
            type: "tool-call",
            id: "call-pack",
            name: "domain_pack_load",
            input: {
              schemaVersion: "capability-load-request.v1",
              capabilityId: "deepagent.skill-guidance",
              catalogSnapshotId: capabilityCatalogSnapshotId,
              reason: "domain_knowledge_required",
              expectedActions: ["skill"],
            },
          },
        })
        expect(settlement.result.type).toBe("text")
        expect(String(settlement.result.value)).toContain("domain_pack_not_active")
      }).pipe(Effect.provide(toolLayer), Effect.scoped),
    ))
})

describe("runtime-authorized search binds the REAL catalog snapshot id (W4 step 5)", () => {
  test("makeRuntimeAuthorizedSearchTool() outputs the runtime catalog snapshot id (no placeholder)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tool = makeRuntimeAuthorizedSearchTool()
        const settlement = yield* Tool.settle(
          tool,
          {
            type: "tool-call",
            id: "call-search-snapshot",
            name: "capability_search",
            input: { query: "read source" },
          },
          toolContext("call-search-snapshot"),
        )
        const structured = settlement.structured as { catalog_snapshot_id?: unknown }
        expect(structured.catalog_snapshot_id).toBe(capabilityCatalogSnapshotId)
        expect(String(structured.catalog_snapshot_id)).not.toContain("local")
      }),
    ))
})

describe("RuntimeFeatures.enabled mirrors the flip-flag table (W4 step 6)", () => {
  afterEach(() => {
    delete process.env["DEEPAGENT_CODE_EVENT_V2_ADMISSION"]
    delete process.env["DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE"]
    delete process.env["DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION"]
    delete process.env["DEEPAGENT_CODE_CONTEXT_QUERY_TOOLS_V2"]
  })

  test("event.v2.admission: unset defaults ON (W0.1 table) and the defined values follow flipFlagValueOn", () => {
    delete process.env["DEEPAGENT_CODE_EVENT_V2_ADMISSION"]
    expect(RuntimeFeatures.enabled("event.v2.admission")).toBe(true)
    process.env["DEEPAGENT_CODE_EVENT_V2_ADMISSION"] = "false"
    expect(RuntimeFeatures.enabled("event.v2.admission")).toBe(false)
    process.env["DEEPAGENT_CODE_EVENT_V2_ADMISSION"] = "0"
    expect(RuntimeFeatures.enabled("event.v2.admission")).toBe(false)
    process.env["DEEPAGENT_CODE_EVENT_V2_ADMISSION"] = ""
    expect(RuntimeFeatures.enabled("event.v2.admission")).toBe(false)
    process.env["DEEPAGENT_CODE_EVENT_V2_ADMISSION"] = "true"
    expect(RuntimeFeatures.enabled("event.v2.admission")).toBe(true)
  })

  test("event.v2.im_single_write defaults ON and follows its env", () => {
    delete process.env["DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE"]
    expect(RuntimeFeatures.enabled("event.v2.im_single_write")).toBe(true)
    process.env["DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE"] = "false"
    expect(RuntimeFeatures.enabled("event.v2.im_single_write")).toBe(false)
  })

  test("context_federation_v2 defaults OFF in core and follows the W3.1 federation gate env", () => {
    delete process.env["DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION"]
    expect(RuntimeFeatures.enabled("context_federation_v2")).toBe(false)
    process.env["DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION"] = "true"
    expect(RuntimeFeatures.enabled("context_federation_v2")).toBe(true)
  })

  test("context_query_tools_v2 defaults OFF (no consumer this wave) and follows its opt-in env", () => {
    delete process.env["DEEPAGENT_CODE_CONTEXT_QUERY_TOOLS_V2"]
    expect(RuntimeFeatures.enabled("context_query_tools_v2")).toBe(false)
    process.env["DEEPAGENT_CODE_CONTEXT_QUERY_TOOLS_V2"] = "TRUE"
    expect(RuntimeFeatures.enabled("context_query_tools_v2")).toBe(true)
  })

  test("an unknown feature still throws the typed UnknownRuntimeFeatureError", () => {
    expect(() => RuntimeFeatures.enabled("context_federation_v9")).toThrow(UnknownRuntimeFeatureError)
  })
})

describe("inventory ↔ registry consistency gate (W4 step 7)", () => {
  test("current HEAD (post W3.5 maintenance_only) passes the gate — context_query is no longer advertised", () => {
    expect(() => assertInventoryMatchesRegistry(builtinToolNames, capabilityCatalog)).not.toThrow()
  })

  test("pre-W3.5 catalog advertising context_query without a registry entry still throws", () => {
    const preW35Catalog = capabilityCatalog.map((manifest) =>
      manifest.id === "deepagent.context-query" ? { ...manifest, availability: "stable" as const } : manifest,
    )
    let missing: ReadonlyArray<string> = []
    try {
      assertInventoryMatchesRegistry(builtinToolNames, preW35Catalog)
      throw new Error("expected the gate to throw for a stable context_query before W3.5")
    } catch (error) {
      if (error instanceof CatalogRegistryMismatchError) missing = error.missing
      else throw error
    }
    expect(missing).toEqual(["context_query"])
  })

  test("a stable manifest advertising a tool that is not registered still throws (parametrized catalog)", () => {
    const badCatalog = capabilityCatalog.map((manifest) =>
      manifest.id === "deepagent.code-read" ? { ...manifest, entry_tools: ["no_such_tool", ...manifest.entry_tools] } : manifest,
    )
    expect(() => assertInventoryMatchesRegistry(builtinToolNames, badCatalog)).toThrow(CatalogRegistryMismatchError)
  })
})
