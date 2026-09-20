import { createHash } from "node:crypto"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@deepagent-code/core/database/database"
import { CapabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import { CapabilityLoadAdapter } from "@deepagent-code/core/system-context/capability-load-adapter"
import { InstanceState } from "@/effect/instance-state"
import { InstanceHttpApi } from "../api"
import { SystemContextApi } from "../groups/system-context"

// C6-02 system-context snapshot diagnostics (design §11.1 + §7.5). The endpoint
// reports whether the declared capability catalog snapshot digest still matches the
// frozen catalog (L0 hash consistency) and the recorded load receipts (identity +
// metrics, never a body).

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex")

export const systemContextHandlers = HttpApiBuilder.group(InstanceHttpApi, "system-context", (handlers) =>
  Effect.gen(function* () {
    const snapshot = CapabilityCatalog.capabilityCatalogSnapshot
    const recomputedDigest = CapabilityCatalog.capabilityCatalogDigestValue
    const l0Text = CapabilityCatalog.renderCapabilityCatalog()
    const database = yield* Database.Service

    const getSnapshot = Effect.fn("SystemContextHttpApi.snapshot")(function* () {
      const loaded = yield* CapabilityLoadAdapter.recordedCapabilityLoadsForDirectory(
        database.db,
        (yield* InstanceState.context).directory,
      )
      return {
        catalogSnapshotId: snapshot.id,
        catalogDigest: snapshot.digest,
        catalogDigestConsistent: recomputedDigest === snapshot.digest,
        l0LineCount: l0Text.split("\n").length,
        l0TextHash: sha256(l0Text),
        loadedCapabilityCount: loaded.length,
        loadedCapabilities: loaded.map((entry) => ({
          capabilityId: entry.capabilityId,
          bodyHash: entry.receipt.bodyHash,
          state: entry.receipt.state.state,
          tokenCount: entry.receipt.tokenCount,
          byteCount: entry.receipt.byteCount,
        })),
      }
    })

    return handlers.handle("snapshot", getSnapshot)
  }),
)
