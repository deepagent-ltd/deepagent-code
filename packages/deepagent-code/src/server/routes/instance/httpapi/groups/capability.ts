import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { CapabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import { CapabilityLoader } from "@deepagent-code/core/system-context/capability-loader"
import { CapabilityManifest } from "@deepagent-code/core/system-context/capability-manifest"
import { CapabilitySearch } from "@deepagent-code/core/system-context/capability-search"
import { Authorization } from "../middleware/authorization"
import { ApiTypedError } from "../typed-error"
import { described } from "./metadata"

// C6-02 (design §11.1 + §7.3): capability catalog, L1 search and load-receipt
// diagnostics. The catalogue/identity fields (id/version/summary/entry_tools/
// body_ref/body_hash) are exposed, but NEVER a procedure body — a denied or
// disabled capability is excluded entirely and no body content is serializable by
// any of these endpoints (the "no body leak" invariant is asserted in the tests).

const root = "/capability"

export const CapabilityPaths = {
  catalog: `${root}/catalog`,
  search: `${root}/search`,
  loadReceipts: `${root}/loadReceipts`,
} as const

/** A catalog entry: manifest identity fields only (no body content). */
export const CapabilityCatalogEntrySchema = CapabilityManifest

const CapabilityCatalogSchema = Schema.Struct({
  schemaVersion: Schema.String,
  id: Schema.String,
  digest: Schema.String,
  capabilities: Schema.Array(CapabilityCatalogEntrySchema),
}).annotate({ identifier: "CapabilityCatalog" })

const CapabilitySearchPayload = Schema.Struct({
  query: Schema.String,
  intended_action: Schema.optional(Schema.String),
}).annotate({ identifier: "CapabilitySearchInput" })

export const LoadReceiptSchema = Schema.Struct({
  identity: Schema.String,
  capabilityId: Schema.String,
  version: Schema.String,
  bodyRef: Schema.String,
  bodyHash: Schema.String,
  runtimeHash: Schema.String,
  permissionHash: Schema.String,
  state: Schema.Literal("loaded"),
  tokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  byteCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "CapabilityLoadReceipt" })

const CapabilityLoadReceiptsSchema = Schema.Struct({
  receipts: Schema.Array(LoadReceiptSchema),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "CapabilityLoadReceipts" })

export const CapabilityApi = HttpApi.make("capability").add(
  HttpApiGroup.make("capability")
    .add(
      HttpApiEndpoint.get("catalog", CapabilityPaths.catalog, {
        success: described(CapabilityCatalogSchema, "Capability catalog snapshot"),
        error: ApiTypedError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "capability.catalog",
          summary: "Capability catalog snapshot",
          description:
            "Returns the capability catalog snapshot identity (id/digest) and per-manifest identity fields. Never serializes a procedure body; a body is only reachable through the load path (behind the permission gate).",
        }),
      ),
      HttpApiEndpoint.post("search", CapabilityPaths.search, {
        payload: CapabilitySearchPayload,
        success: described(CapabilitySearch.CapabilitySearchOutput, "L1 capability search cards"),
        error: ApiTypedError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "capability.search",
          summary: "Search the capability catalog",
          description:
            "Returns at most 5 authorized capability cards (summary + entry tools + body_ref), ranked by intent. Denied/disabled capabilities are excluded; no procedure body is ever present.",
        }),
      ),
      HttpApiEndpoint.get("loadReceipts", CapabilityPaths.loadReceipts, {
        success: described(CapabilityLoadReceiptsSchema, "Capability load receipts"),
        error: ApiTypedError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "capability.loadReceipts",
          summary: "Capability load receipts",
          description:
            "Returns the recorded capability load receipts (identity/bodyHash/tokenCount, never the body). A body is never serialized here.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "capability",
        description: "Capability catalog/search/loadReceipts HttpApi surface (C6-02).",
      }),
    )
    .middleware(Authorization),
)
