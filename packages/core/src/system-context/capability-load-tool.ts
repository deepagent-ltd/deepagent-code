export * as CapabilityLoadTool from "./capability-load-tool"

import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@deepagent-code/llm"
import { Tool } from "../tool/tool"
import { Tools } from "../tool/tools"
import {
  CapabilityLoadRequest,
  ContentLoadState,
  capabilityLoadReceiptDigest,
  type CapabilityLoadReceipt,
} from "../contract/capability-load"
import { Database } from "../database/database"
import { SessionSchema } from "../session/schema"
import { V2ProviderTurnReceiptTable } from "../session/runner/v2-provider-turn.sql"
import { RuntimeFeatures } from "../flag/runtime-features"
import { capabilityBodyFor } from "./capability-bodies"
import { capabilityCatalog, capabilityCatalogSnapshotId } from "./capability-catalog"
import { catalogPermissionHash, catalogRuntimeHash } from "./capability-snapshot"
import { capabilityCatalogDigest, type CapabilityManifest } from "./capability-manifest"
import {
  sessionCapabilityLoad,
  type CapabilityLoadRequest as AdapterLoadRequest,
  type CapabilityLoadTurnIdentity,
} from "./capability-load-adapter"

// W4 — the production `capability_load` / `domain_pack_load` tools (design §7.3-7.5,
// docs/core-v2.0-beta/v2.0-design.md §W4 步骤 4). The input is the FROZEN contract
// `CapabilityLoadRequest` (the model only names a capability / snapshot / reason / expected
// actions — never a path, URL or body). Execution resolves the manifest from the runtime
// catalog, binds the REAL session/activity/turn identity, runs the K2 kernel through the
// adapter (budget gate included: an over-limit body/turn settles as the typed frozen
// `budget_exceeded` state — the body is never returned) and persists the durable receipt
// (`session_capability_load`). The model-visible text is the L1 card (id/version/summary/
// entry tools) plus a bounded body preview — never the full body (design §7.3 L2 disclosure).
//
// The tools are authorized by the `capability.read` permission (Tool.withPermission) — load
// is disclosure/read; capability content is guidance, not permission (design §7.6), so the
// load tool never grants anything and never writes outside the receipt table.

/** The load tool's structured output: the frozen load state + a bounded body preview. */
export const CapabilityLoadToolOutput = Schema.Struct({
  state: ContentLoadState,
  body_preview: Schema.String.pipe(Schema.optional),
  token_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  byte_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  /** Byte-stable content digest of the durable receipt (loadedAt stripped) — audit binding. */
  receipt_digest: Schema.String.pipe(Schema.optional),
})
export type CapabilityLoadToolOutput = typeof CapabilityLoadToolOutput.Type

/** Tool construction options (defaults are the production wiring). */
export interface CapabilityLoadToolOptions {
  readonly db: Database.Interface["db"]
  readonly catalog?: ReadonlyArray<CapabilityManifest>
  /** Identity seam; the default resolves the session's latest provider turn (real activity/turn). */
  readonly turnIdentity?: (sessionID: SessionSchema.ID) => Effect.Effect<CapabilityLoadTurnIdentity>
}

/**
 * The default turn-identity seam: the session's latest `session_v2_provider_turn_receipt`
 * row IS the turn the model is executing in (the receipt is committed BEFORE the provider
 * dispatch, so an in-turn tool settle sees it). The fallback (no provider turn: the tool
 * invoked outside a runner turn) keeps the identity deterministic but non-prestigious —
 * the durable rows are session-scoped regardless, and a real turn re-derives the true one.
 */
export const makeDefaultCapabilityLoadTurnIdentity = (
  db: Database.Interface["db"],
): ((sessionID: SessionSchema.ID) => Effect.Effect<CapabilityLoadTurnIdentity>) => (sessionID) =>
  Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(V2ProviderTurnReceiptTable)
      .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
      .orderBy(V2ProviderTurnReceiptTable.created_at, V2ProviderTurnReceiptTable.request_ordinal)
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (!row) return { sessionId: sessionID, activityId: "", turnId: "" }
    return { sessionId: sessionID, activityId: row.activity_id, turnId: String(row.provider_turn_seq) }
  })

/** A ready-to-register `capability_load` tool (W4 production entry, permission `capability.read`). */
export function makeCapabilityLoadTool(options: CapabilityLoadToolOptions): Tool.AnyTool {
  const { db } = options
  const catalog = options.catalog ?? capabilityCatalog
  const turnIdentity = options.turnIdentity ?? makeDefaultCapabilityLoadTurnIdentity(db)
  const snapshotId =
    options.catalog === undefined
      ? capabilityCatalogSnapshotId
      : `capability_catalog:${capabilityCatalogDigest(catalog).slice("sha256:".length)}`
  const runtimeHash = catalogRuntimeHash(catalog)
  const permissionHash = catalogPermissionHash(catalog)
  return Tool.withPermission(
    Tool.make({
      description:
        "Load the L2 procedure body of a DeepAgentCode capability (by capability id, from the current catalog snapshot) and receive its summary + a bounded body preview. Use after capability_search found a card for the intended action. Never used to load a path, URL or arbitrary content.",
      input: CapabilityLoadRequest,
      output: CapabilityLoadToolOutput,
      execute: (input, context) => {
        return Effect.gen(function* () {
          const manifest = catalog.find((entry) => entry.id === input.capabilityId)
          if (!manifest) return notFound("capability_unregistered")
          if (input.catalogSnapshotId !== snapshotId) return notFound("catalog_snapshot_mismatch")
          if (manifest.availability !== "stable") return disabledReason(disabledReasonOf(manifest.availability))
          if (!runtimeFeaturesEnabled(manifest)) return disabledReason("incompatible_runtime")
          const identity = yield* turnIdentity(context.sessionID)
          const entry = capabilityBodyFor(manifest.id, manifest.version)
          const request: AdapterLoadRequest = {
            capabilityId: manifest.id,
            version: manifest.version,
            bodyHash: entry?.body_hash ?? "",
            runtimeHash,
            permissionHash,
            bodyRef: manifest.body_ref,
            body: entry?.body,
            declaredDigest: entry?.body_hash,
            catalogSnapshotId: input.catalogSnapshotId,
            requiredPermissions: manifest.required_permissions,
            grantedPermissions: manifest.required_permissions,
            requiredRuntimeFeatures: manifest.required_runtime_features,
          }
          const out = yield* sessionCapabilityLoad(db, { request, identity, contextEpoch: input.catalogSnapshotId })
          return renderLoadOutput(out.state, out.body, out.receipt)
        }).pipe(Effect.mapError((error) => new ToolFailure({ message: messageOf(error) })))
      },
      toModelOutput: ({ output }) => [{ type: "text", text: renderLoadText(output, catalog) }],
    }),
    "capability.read",
  )
}

/**
 * A ready-to-register `domain_pack_load` tool (same shape as `capability_load`). Domain
 * packs are not active in this runtime wave: the tool always settles as the typed frozen
 * `not_found(domain_pack_not_active)` — never a fabricated pack. It is registered so the
 * model-facing surface is honest and stable; the pack lane lands the kernel path when packs
 * ship.
 */
export function makeDomainPackLoadTool(options: CapabilityLoadToolOptions): Tool.AnyTool {
  const turnIdentity = options.turnIdentity ?? makeDefaultCapabilityLoadTurnIdentity(options.db)
  return Tool.withPermission(
    Tool.make({
      description:
        "Load an active domain pack's L2 procedure body. Domain packs are not active in this build; the tool reports the typed not_found(domain_pack_not_active) state.",
      input: CapabilityLoadRequest,
      output: CapabilityLoadToolOutput,
      execute: (input, context) => {
        return Effect.gen(function* () {
          yield* turnIdentity(context.sessionID)
          return notFound("domain_pack_not_active")
        }).pipe(Effect.mapError((error) => new ToolFailure({ message: messageOf(error) })))
      },
      toModelOutput: ({ output }) => [{ type: "text", text: renderLoadText(output) }],
    }),
    "capability.read",
  )
}

/** Typed not-found outputs (frozen NotFoundReason union). */
function notFound(
  reasonCode: "capability_unregistered" | "catalog_snapshot_mismatch" | "domain_pack_not_active",
): CapabilityLoadToolOutput {
  return { state: { state: "not_found", reasonCode } }
}

/** Typed disabled outputs (frozen DisabledReason union). */
function disabledReason(reasonCode: "maintenance_only" | "disabled" | "unavailable" | "incompatible_runtime"): CapabilityLoadToolOutput {
  return { state: { state: "disabled", reasonCode } }
}

/** The frozen `disabled` reasons map 1:1 from availability (never advertise an unusable capability). */
function disabledReasonOf(availability: CapabilityManifest["availability"]): "maintenance_only" | "disabled" | "unavailable" {
  if (availability === "maintenance_only" || availability === "disabled" || availability === "unavailable") return availability
  return "disabled"
}

/** Runtime-compatibility: every manifest-required feature must be enabled (unknown → fail-closed false). */
function runtimeFeaturesEnabled(manifest: CapabilityManifest): boolean {
  return manifest.required_runtime_features.every((feature) => {
    try {
      return RuntimeFeatures.enabled(feature)
    } catch {
      return false
    }
  })
}

function renderLoadOutput(
  state: ContentLoadState,
  body: string | undefined,
  receipt: CapabilityLoadReceipt,
): CapabilityLoadToolOutput {
  if (state.state === "loaded" || state.state === "already_loaded") {
    const preview = bodyPreview(body ?? "")
    return {
      state,
      ...(preview === undefined ? {} : { body_preview: preview }),
      token_count: state.state === "loaded" ? state.tokenCount : receipt.tokenCount,
      byte_count: state.state === "loaded" ? state.byteCount : receipt.byteCount,
      receipt_digest: capabilityLoadReceiptDigest(receipt),
    }
  }
  return { state }
}

/** Bounded deterministic body preview (first line, capped) — never the full body. */
function bodyPreview(body: string): string | undefined {
  if (body.length === 0) return undefined
  const head = body.split("\n")[0] ?? body.slice(0, 80)
  const limit = 240
  return head.length > limit ? `${head.slice(0, limit)}…` : head
}

function renderLoadText(
  output: CapabilityLoadToolOutput,
  catalog: ReadonlyArray<CapabilityManifest> = capabilityCatalog,
): string {
  const state = output.state
  switch (state.state) {
    case "loaded": {
      const card = cardLine(catalog, state.bodyRef)
      return card === undefined
        ? `Loaded capability ${state.bodyRef} (${state.tokenCount} tokens, ${state.byteCount} bytes).`
        : `${card}\nBody preview: ${output.body_preview ?? "(none)"} (${state.tokenCount} tokens, ${state.byteCount} bytes).`
    }
    case "already_loaded":
      return `Capability ${state.bodyRef} is already loaded in this session; body preview below (${output.token_count ?? 0} tokens).`
    case "denied":
      return `Capability load denied: ${state.reasonCode}.`
    case "disabled":
      return `Capability is not loadable: ${state.reasonCode}.`
    case "incompatible":
      return `Capability is incompatible with this runtime (required: ${state.runtimeRequired}, found: ${state.runtimeFound}).`
    case "not_found":
      return `Capability not found: ${state.reasonCode}.`
    case "budget_exceeded":
      return `Capability load exceeded the L2 budget: requested ${state.requestedTokens} tokens, limit ${state.limitTokens} (level ${state.level}).`
  }
}

/** The L1 card line for a capability (id — summary, entry tools) — the model-visible Card. */
function cardLine(catalog: ReadonlyArray<CapabilityManifest>, bodyRef: string): string | undefined {
  const id = bodyRef.replace(/^capability:\/\//, "").split("@")[0]
  const manifest = catalog.find((entry) => entry.id === id)
  if (!manifest) return undefined
  return `${manifest.id} (${manifest.version}) — ${manifest.summary}. Entry: ${manifest.entry_tools.join(", ")}.`
}

function messageOf(error: unknown): string {
  if (error instanceof ToolFailure) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/** Production registration: register both load tools into the Location tool registry. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const { db } = yield* Database.Service
    yield* tools
      .register({
        capability_load: makeCapabilityLoadTool({ db }),
        domain_pack_load: makeDomainPackLoadTool({ db }),
      })
      .pipe(Effect.orDie)
  }),
)
