export * as CapabilityLoadTool from "./capability-load-tool"

export const capabilityLoadName = "capability_load"
export const domainPackLoadName = "domain_pack_load"

import { desc, eq } from "drizzle-orm"
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
import { PermissionV2 } from "../permission"
import { capabilityBodyFor } from "./capability-bodies"
import { capabilityCatalog, capabilityCatalogSnapshotId } from "./capability-catalog"
import { catalogPermissionHash, catalogRuntimeHash } from "./capability-snapshot"
import { capabilityCatalogDigest, type CapabilityManifest } from "./capability-manifest"
import {
  sessionCapabilityLoad,
  type CapabilityLoadRequest as AdapterLoadRequest,
  type CapabilityLoadTurnIdentity,
} from "./capability-load-adapter"

// W4 — the production `capability_load` tool and the inactive `domain_pack_load` prototype (design §7.3-7.5,
// docs/core-v2.0-beta/v2.0-design.md §W4 步骤 4). The input is the FROZEN contract
// `CapabilityLoadRequest` (the model only names a capability / snapshot / reason / expected
// actions — never a path, URL or body). Execution resolves the manifest from the runtime
// catalog, binds the REAL session/activity/turn identity, runs the K2 kernel through the
// adapter (budget gate included: an over-limit body/turn settles as the typed frozen
// `budget_exceeded` state — the body is never returned) and persists the durable receipt
// (`session_capability_load`). The model-visible text is the L1 card (id/version/summary/
// entry tools) plus the exact hash- and budget-validated procedure body (design §7.3 L2 disclosure).
//
// The tools are authorized by the `capability.read` permission (Tool.withPermission) — load
// is disclosure/read; capability content is guidance, not permission (design §7.6), so the
// load tool never grants anything and never writes outside the receipt table.

/** The load tool's structured output: the frozen load state + exact validated L2 body on success. */
export const CapabilityLoadToolOutput = Schema.Struct({
  state: ContentLoadState,
  body: Schema.String.pipe(Schema.optional),
  token_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  byte_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  /** Byte-stable content digest of the durable receipt (loadedAt stripped) — audit binding. */
  receipt_digest: Schema.String.pipe(Schema.optional),
})
export type CapabilityLoadToolOutput = typeof CapabilityLoadToolOutput.Type

/**
 * The model-facing input surface: the frozen contract `CapabilityLoadRequest`
 * extended with an OPTIONAL `catalogSnapshotId`. W4.1 P0-2: the runtime snapshot id
 * never reaches the model-visible text (L0 render, L1 search cards and the load
 * text all omit it), so requiring the id made every production `capability_load`
 * settle as the typed `catalog_snapshot_mismatch`. The runtime is authoritative:
 * an omitted id binds the runtime snapshot (the receipt snapshot field and the
 * context epoch = the runtime id); an explicitly provided id is still strictly
 * checked against the runtime snapshot — a stale pin settles as the typed
 * mismatch (fail-closed, never silently re-targeted).
 */
export const CapabilityLoadToolInput = Schema.Struct({
  ...CapabilityLoadRequest.fields,
  catalogSnapshotId: Schema.String.pipe(Schema.optional),
})
export type CapabilityLoadToolInput = typeof CapabilityLoadToolInput.Type

/** Tool construction options (defaults are the production wiring). */
export interface CapabilityLoadToolOptions {
  readonly db: Database.Interface["db"]
  readonly catalog?: ReadonlyArray<CapabilityManifest>
  /** Identity seam; the default resolves the session's latest provider turn (real activity/turn). */
  readonly turnIdentity?: (sessionID: SessionSchema.ID) => Effect.Effect<CapabilityLoadTurnIdentity>
}

/**
 * The default turn-identity seam. CONTRACT (W4.1 P0-1): it resolves the session's
 * LATEST `session_v2_provider_turn_receipt` row (created_at desc, request_ordinal
 * desc as the deterministic tiebreak — a session accrues one row per dispatched
 * turn) — the receipt is committed BEFORE the provider dispatch, so an in-turn
 * tool settle sees the row of the turn the model is executing in. Taking the
 * EARLIEST row (the pre-fix ASC order) mis-bound the audit identity to turn 1 and
 * leaked the per-turn L2 budget across turns (turn1 loaded 2 bodies → turn2+
 * settled every load as budget_exceeded). The fallback (no provider turn: the tool
 * invoked outside a runner turn) keeps the identity deterministic but
 * non-prestigious — the durable rows are session-scoped regardless, and a real
 * turn re-derives the true one. This seam is the production default (used when
 * `turnIdentity` is not injected) and is exercised through
 * `packages/core/test/system-context/capability-l2-production.test.ts`.
 */
export const makeDefaultCapabilityLoadTurnIdentity =
  (db: Database.Interface["db"]): ((sessionID: SessionSchema.ID) => Effect.Effect<CapabilityLoadTurnIdentity>) =>
  (sessionID) =>
    Effect.gen(function* () {
      const row = yield* db
        .select()
        .from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
        .orderBy(desc(V2ProviderTurnReceiptTable.created_at), desc(V2ProviderTurnReceiptTable.request_ordinal))
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
        "Load the exact hash- and budget-validated L2 procedure body of a DeepAgentCode capability from the current catalog snapshot. Use after capability_search found a card for the intended action. Never used to load a path, URL or arbitrary content.",
      input: CapabilityLoadToolInput,
      output: CapabilityLoadToolOutput,
      execute: (input, context) => {
        return Effect.gen(function* () {
          const manifest = catalog.find((entry) => entry.id === input.capabilityId)
          if (!manifest) return notFound("capability_unregistered")
          // W4.1 P0-2: server-authoritative snapshot id — the model cannot know the
          // runtime snapshot id (it is never rendered into a model-visible surface),
          // so an omitted input binds the RUNTIME snapshot for execution, the receipt
          // snapshot field and the context epoch. An explicit id is still validated
          // strictly: a stale pin settles as the typed mismatch, never re-targeted.
          const resolvedSnapshotId = input.catalogSnapshotId ?? snapshotId
          if (resolvedSnapshotId !== snapshotId) return notFound("catalog_snapshot_mismatch")
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
            catalogSnapshotId: resolvedSnapshotId,
            requiredPermissions: manifest.required_permissions,
            grantedPermissions: manifest.required_permissions,
            requiredRuntimeFeatures: manifest.required_runtime_features,
          }
          const out = yield* sessionCapabilityLoad(db, { request, identity, contextEpoch: resolvedSnapshotId })
          if ((out.state.state === "loaded" || out.state.state === "already_loaded") && out.body === undefined) {
            return yield* Effect.fail(
              new ToolFailure({ message: "Capability load succeeded without its validated body" }),
            )
          }
          return renderLoadOutput(out.state, out.body, out.receipt)
        }).pipe(
          Effect.mapError(
            (error) => PermissionV2.permissionToolFailure(error) ?? new ToolFailure({ message: messageOf(error) }),
          ),
        )
      },
      toModelOutput: ({ output }) => [{ type: "text", text: renderLoadText(output, catalog) }],
    }),
    "capability.read",
  )
}

/**
 * The production `domain_pack_load` tool lives in `domain-pack-load-tool.ts` (registered
 * from `tool/builtins.ts`); this module only owns the shared `domainPackLoadName` wire
 * constant. The inactive prototype was removed in the V2.0.1 WS3 chain repair.
 */

/** Typed not-found outputs (frozen NotFoundReason union). */
function notFound(
  reasonCode: "capability_unregistered" | "catalog_snapshot_mismatch" | "domain_pack_not_active",
): CapabilityLoadToolOutput {
  return { state: { state: "not_found", reasonCode } }
}

/** Typed disabled outputs (frozen DisabledReason union). */
function disabledReason(
  reasonCode: "maintenance_only" | "disabled" | "unavailable" | "incompatible_runtime",
): CapabilityLoadToolOutput {
  return { state: { state: "disabled", reasonCode } }
}

/** The frozen `disabled` reasons map 1:1 from availability (never advertise an unusable capability). */
function disabledReasonOf(
  availability: CapabilityManifest["availability"],
): "maintenance_only" | "disabled" | "unavailable" {
  if (availability === "maintenance_only" || availability === "disabled" || availability === "unavailable")
    return availability
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
    return {
      state,
      ...(body === undefined ? {} : { body }),
      token_count: state.state === "loaded" ? state.tokenCount : receipt.tokenCount,
      byte_count: state.state === "loaded" ? state.byteCount : receipt.byteCount,
      receipt_digest: capabilityLoadReceiptDigest(receipt),
    }
  }
  return { state }
}

function renderLoadText(
  output: CapabilityLoadToolOutput,
  catalog: ReadonlyArray<CapabilityManifest> = capabilityCatalog,
): string {
  const state = output.state
  switch (state.state) {
    case "loaded": {
      const card = cardLine(catalog, state.bodyRef)
      return `${card ?? `Loaded capability ${state.bodyRef}.`}\nProcedure body:\n${output.body ?? ""}\n(${state.tokenCount} tokens, ${state.byteCount} bytes).`
    }
    case "already_loaded": {
      const card = cardLine(catalog, state.bodyRef)
      return `${card ?? `Capability ${state.bodyRef} is already loaded in this session.`}\nProcedure body:\n${output.body ?? ""}\n(${output.token_count ?? 0} tokens).`
    }
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

/** Production registration: only register capabilities that have an executable authority. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const { db } = yield* Database.Service
    yield* tools
      .register({
        [capabilityLoadName]: makeCapabilityLoadTool({ db }),
      })
      .pipe(Effect.orDie)
  }),
)
