import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { CapabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import { CapabilityLoader } from "@deepagent-code/core/system-context/capability-loader"
import { Authorization } from "../middleware/authorization"
import { ApiTypedError } from "../typed-error"
import { described } from "./metadata"

// C6-02 system-context diagnostics (design §11.1 + §7.5): the capability/system
// context snapshot is exposed as a read-only diagnostic. It reports the L0 catalog
// hash consistency (whether the declared snapshot digest still matches the frozen
// catalog) and the recorded capability load receipts — NEVER a procedure body.

const root = "/system-context"

export const SystemContextPaths = {
  snapshot: `${root}/snapshot`,
} as const

/** A loaded capability receipt surface: identity + metrics, never the body. */
const SystemContextLoadedCapabilitySchema = Schema.Struct({
  capabilityId: Schema.String,
  bodyHash: Schema.String,
  state: Schema.String,
  tokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  byteCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "SystemContextLoadedCapability" })

const SystemContextSnapshotSchema = Schema.Struct({
  catalogSnapshotId: Schema.String,
  catalogDigest: Schema.String,
  catalogDigestConsistent: Schema.Boolean,
  l0LineCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  l0TextHash: Schema.String,
  loadedCapabilityCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  loadedCapabilities: Schema.Array(SystemContextLoadedCapabilitySchema),
}).annotate({ identifier: "SystemContextSnapshot" })

export const SystemContextApi = HttpApi.make("system-context").add(
  HttpApiGroup.make("system-context")
    .add(
      HttpApiEndpoint.get("snapshot", SystemContextPaths.snapshot, {
        success: described(SystemContextSnapshotSchema, "System context snapshot diagnostics"),
        error: ApiTypedError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "system-context.snapshot",
          summary: "System context snapshot diagnostics",
          description:
            "Reports whether the capability catalog snapshot digest is still consistent with the frozen catalog, the L0 catalog line count/hash, and the recorded capability load receipts (identity/metrics only, never a body).",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "system-context",
        description: "System context snapshot diagnostics HttpApi surface (C6-02).",
      }),
    )
    .middleware(Authorization),
)
