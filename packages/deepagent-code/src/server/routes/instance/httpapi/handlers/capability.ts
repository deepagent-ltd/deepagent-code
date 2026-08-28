import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CapabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import { CapabilityLoader } from "@deepagent-code/core/system-context/capability-loader"
import { CapabilityRuntimeSearch } from "@deepagent-code/core/system-context/capability-runtime-search"
import { CapabilityApi } from "../groups/capability"

// C6-02 capability handlers (design §11.1 + §7.3). Every endpoint surfaces identity /
// summary / entry-point fields, never a procedure body. Search authorization is
// derived from the runtime-feature registry (C4-07) and the product permission
// inventory, so a denied/disabled capability is excluded before it can appear.

export const capabilityHandlers = HttpApiBuilder.group(CapabilityApi, "capability", (handlers) =>
  Effect.gen(function* () {
    const snapshot = CapabilityCatalog.capabilityCatalogSnapshot
    const catalog = CapabilityCatalog.capabilityCatalog
    const snapshotId = CapabilityCatalog.capabilityCatalogSnapshotId

    const getCatalog = Effect.fn("CapabilityHttpApi.catalog")(function* () {
      return snapshot
    })

    const searchCapabilities = Effect.fn("CapabilityHttpApi.search")(function* (ctx: {
      payload: { query: string; intended_action?: string }
    }) {
      return CapabilityRuntimeSearch.runtimeAuthorizedSearch(
        catalog,
        { query: ctx.payload.query, ...(ctx.payload.intended_action ? { intended_action: ctx.payload.intended_action } : {}) },
        snapshotId,
      )
    })

    const getLoadReceipts = Effect.fn("CapabilityHttpApi.loadReceipts")(function* () {
      const receipts = CapabilityLoader.recordedCapabilityLoads()
      const mapped = receipts.map((receipt) => ({
        identity: receipt.identity,
        capabilityId: receipt.capabilityId,
        version: receipt.version,
        bodyRef: receipt.bodyRef,
        bodyHash: receipt.bodyHash,
        runtimeHash: receipt.runtimeHash,
        permissionHash: receipt.permissionHash,
        state: "loaded" as const,
        tokenCount: receipt.tokenCount,
        byteCount: receipt.byteCount,
      }))
      return { receipts: mapped, count: mapped.length }
    })

    return handlers
      .handle("catalog", getCatalog)
      .handle("search", searchCapabilities)
      .handle("loadReceipts", getLoadReceipts)
  }),
)
