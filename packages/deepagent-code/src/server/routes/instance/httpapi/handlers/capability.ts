import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@deepagent-code/core/database/database"
import { CapabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import { CapabilityLoadAdapter } from "@deepagent-code/core/system-context/capability-load-adapter"
import { CapabilityRuntimeSearch } from "@deepagent-code/core/system-context/capability-runtime-search"
import { InstanceState } from "@/effect/instance-state"
import { InstanceHttpApi } from "../api"
import { CapabilityApi } from "../groups/capability"

// C6-02 capability handlers (design §11.1 + §7.3). Every endpoint surfaces identity /
// summary / entry-point fields, never a procedure body. Search authorization is
// derived from the runtime-feature registry (C4-07) and the product permission
// inventory, so a denied/disabled capability is excluded before it can appear.

export const capabilityHandlers = HttpApiBuilder.group(InstanceHttpApi, "capability", (handlers) =>
  Effect.gen(function* () {
    const snapshot = CapabilityCatalog.capabilityCatalogSnapshot
    const catalog = CapabilityCatalog.capabilityCatalog
    const snapshotId = CapabilityCatalog.capabilityCatalogSnapshotId
    const database = yield* Database.Service

    const getCatalog = Effect.fn("CapabilityHttpApi.catalog")(function* () {
      return snapshot
    })

    const searchCapabilities = Effect.fn("CapabilityHttpApi.search")(function* (ctx: {
      payload: { query: string; intended_action?: string }
    }) {
      return CapabilityRuntimeSearch.runtimeAuthorizedSearch(
        catalog,
        {
          query: ctx.payload.query,
          ...(ctx.payload.intended_action ? { intended_action: ctx.payload.intended_action } : {}),
        },
        snapshotId,
      )
    })

    const getLoadReceipts = Effect.fn("CapabilityHttpApi.loadReceipts")(function* () {
      const receipts = yield* CapabilityLoadAdapter.recordedCapabilityLoadsForDirectory(
        database.db,
        (yield* InstanceState.context).directory,
      )
      const mapped = receipts.map((entry) => ({
        identity: entry.identity,
        capabilityId: entry.capabilityId,
        version: entry.receipt.version,
        bodyRef: entry.receipt.bodyRef,
        bodyHash: entry.receipt.bodyHash,
        runtimeHash: entry.receipt.runtimeHash,
        permissionHash: entry.receipt.permissionHash,
        state: "loaded" as const,
        tokenCount: entry.receipt.tokenCount,
        byteCount: entry.receipt.byteCount,
      }))
      return { receipts: mapped, count: mapped.length }
    })

    return handlers
      .handle("catalog", getCatalog)
      .handle("search", searchCapabilities)
      .handle("loadReceipts", getLoadReceipts)
  }),
)
