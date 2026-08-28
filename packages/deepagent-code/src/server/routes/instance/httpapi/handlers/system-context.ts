import { createHash } from "node:crypto"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CapabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import { CapabilityLoader } from "@deepagent-code/core/system-context/capability-loader"
import { SystemContextApi } from "../groups/system-context"

// C6-02 system-context snapshot diagnostics (design §11.1 + §7.5). The endpoint
// reports whether the declared capability catalog snapshot digest still matches the
// frozen catalog (L0 hash consistency) and the recorded load receipts (identity +
// metrics, never a body).

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex")

export const systemContextHandlers = HttpApiBuilder.group(SystemContextApi, "system-context", (handlers) =>
  Effect.gen(function* () {
    const snapshot = CapabilityCatalog.capabilityCatalogSnapshot
    const recomputedDigest = CapabilityCatalog.capabilityCatalogDigestValue
    const l0Text = CapabilityCatalog.renderCapabilityCatalog()

    const getSnapshot = Effect.fn("SystemContextHttpApi.snapshot")(function* () {
      const loaded = CapabilityLoader.recordedCapabilityLoads()
      return {
        catalogSnapshotId: snapshot.id,
        catalogDigest: snapshot.digest,
        catalogDigestConsistent: recomputedDigest === snapshot.digest,
        l0LineCount: l0Text.split("\n").length,
        l0TextHash: sha256(l0Text),
        loadedCapabilityCount: loaded.length,
        loadedCapabilities: loaded.map((receipt) => ({
          capabilityId: receipt.capabilityId,
          bodyHash: receipt.bodyHash,
          state: receipt.state,
          tokenCount: receipt.tokenCount,
          byteCount: receipt.byteCount,
        })),
      }
    })

    return handlers.handle("snapshot", getSnapshot)
  }),
)
