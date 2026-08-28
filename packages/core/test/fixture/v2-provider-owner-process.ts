import { eq, inArray } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { SessionProviderOwner } from "../../src/context-federation/provider-owner"
import { Database } from "../../src/database/database"
import { ProjectV2 } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { SessionSchema } from "../../src/session/schema"
import { SessionTable } from "../../src/session/sql"
import { PreparedProviderTurn } from "../../src/session/runner/prepared-provider-turn"
import { V2ProviderTurn } from "../../src/session/runner/v2-provider-turn"
import { V2ProviderTurnReceiptTable } from "../../src/session/runner/v2-provider-turn.sql"
import { Hash } from "../../src/util/hash"

const [mode, filename, marker, receiptID] = process.argv.slice(2)
if (!mode || !filename || !marker)
  throw new Error("usage: v2-provider-owner-process <dispatch|recover> <db> <marker> [receipt]")

const database = Database.layerFromPath(filename)
const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
const ownerToken = mode === "dispatch" ? "v2-release-process-a" : "v2-release-process-b"
const turns = V2ProviderTurn.layerWith({ ownerToken, leaseMs: 300 }).pipe(
  Layer.provide(owners),
  Layer.provide(database),
)
const layer = Layer.mergeAll(database, owners, turns)
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
    yield* service.seal(receipt, prepared, {
      wireHash,
      bodyHash: Hash.sha256("v2-release-body"),
      bodyLength: 1,
      contentType: "application/json",
    })
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
