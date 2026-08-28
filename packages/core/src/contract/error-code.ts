export * as ErrorContract from "./error-code"

import { Schema } from "effect"
import { contentDigest } from "./digest"

// C0-03 - Stable error + correlation contract (freeze).
// Design authority: docs/core-v2.0-beta/design.md §11.1 (API), §14 (correlation),
// §1/§2 (typed fail-closed errors) and the worklist C0-03.
// Pure-new contract module: not imported by any production module this wave.

/** Version matrix for the error contract. 'schema' is the envelope schema version. */
export const ErrorVersion = {
  schema: "stable-error.v1",
  retryability: 1,
  httpStatus: 1,
  category: 1,
  registry: 1,
} as const

/**
 * Retryability classification. This is the AUTHORITY for retry decisions in
 * every client and server: a consumer must never infer retryability from the
 * human message. 'indeterminate' is for outcomes that are genuinely unknown
 * (e.g. network closed mid-request) - those must go through recovery, not
 * automatic retry of an unobserved effect.
 */
export const ErrorRetryability = Schema.Literals([
  "retryable",
  "not_retryable",
  "indeterminate",
])
export type ErrorRetryability = typeof ErrorRetryability.Type

/**
 * HTTP status mapping. Frozen to the design §11.1 surface:
 * 400 (invalid shape / validation), 403 (permission), 404 (not found / no such
 * recovery item), 409 (conflict / CAS lost / version mismatch), 410 (gone /
 * retention floor exceeded), 423 (locked / maintenance or blocked schema),
 * 503 (unavailable / provider unreachable / not ready). Anything else is
 * internal; no client may map a message to a status.
 */
export const ErrorHttpStatus = Schema.Literals([400, 403, 404, 409, 410, 423, 503])
export type ErrorHttpStatus = typeof ErrorHttpStatus.Type

/**
 * Error domain categories, aligned with the designed surfaces. An unknown
 * category is a typed decode error - extending the vocabulary requires a
 * successor version, never silent acceptance.
 */
export const ErrorCategory = Schema.Literals([
  "bootstrap",
  "migration",
  "backup_verify",
  "restore",
  "recovery",
  "provider",
  "model_route",
  "selection",
  "capability",
  "event",
  "cursor",
  "session",
  "permission",
  "validation",
  "conflict",
  "malformed",
  "internal",
  "unavailable",
  "not_found",
])
export type ErrorCategory = typeof ErrorCategory.Type

/** One stable error code with its frozen classification. */
export const ErrorCodeEntry = Schema.Struct({
  code: Schema.String,
  category: ErrorCategory,
  retryability: ErrorRetryability,
  httpStatus: ErrorHttpStatus,
  /** Language-neutral one-line meaning (documentation, not client logic). */
  meaning: Schema.String,
})
export type ErrorCodeEntry = typeof ErrorCodeEntry.Type

/**
 * The frozen seed registry (ErrorVersion.registry = 1).
 * Codes are grouped by domain; each entry's classification is the single
 * authority for client/server retry + HTTP mapping behavior. Codes are
 * SEEDED from the frozen W1 contracts' typed errors and the design risk
 * catalog (PRE-C1A-001..PRE-C5-001). New codes join via successor registry
 * version - the version is part of the registry identity (drift detectable).
 */
export const ERROR_CODE_REGISTRY: readonly ErrorCodeEntry[] = [
  // Database bootstrap / migration / backup / restore (C1A).
  { code: "database_open_failed", category: "bootstrap", retryability: "indeterminate", httpStatus: 503, meaning: "Database could not be opened; maintenance shell required." },
  { code: "database_preflight_failed", category: "bootstrap", retryability: "not_retryable", httpStatus: 423, meaning: "Read-only preflight rejected this store; migration must not run." },
  { code: "migration_receipt_missing_content_identity", category: "migration", retryability: "not_retryable", httpStatus: 409, meaning: "A migration receipt claims applied/backfilled without a content-addressed identity." },
  { code: "skip_migration_attempted", category: "migration", retryability: "not_retryable", httpStatus: 423, meaning: "Body write was skipped while a journal entry was written; blocked." },
  { code: "upgrade_run_invalid_transition", category: "migration", retryability: "not_retryable", httpStatus: 409, meaning: "Upgrade run state transition is not in the frozen matrix." },
  { code: "upgrade_run_recovery_required", category: "migration", retryability: "indeterminate", httpStatus: 423, meaning: "Upgrade run entered recovery_required; operator action needed." },
  { code: "migration_lease_conflict", category: "migration", retryability: "retryable", httpStatus: 409, meaning: "Another migration holds the lease; retry after backoff." },
  { code: "migration_lease_stale_token", category: "migration", retryability: "not_retryable", httpStatus: 423, meaning: "A stale migration token attempted to commit; blocked." },
  { code: "backup_integrity_failed", category: "backup_verify", retryability: "retryable", httpStatus: 503, meaning: "Backup verification failed; previous known-good retained." },
  { code: "backup_manifest_missing", category: "backup_verify", retryability: "not_retryable", httpStatus: 404, meaning: "Backup manifest could not be located." },
  { code: "restore_failed", category: "restore", retryability: "indeterminate", httpStatus: 503, meaning: "Verified restore could not complete; quarantine retained." },
  { code: "restore_target_not_quarantined", category: "restore", retryability: "not_retryable", httpStatus: 409, meaning: "Restore target was not quarantined before install." },
  // Provider / model / recovery (C1B, C2).
  { code: "provider_result_unknown", category: "provider", retryability: "indeterminate", httpStatus: 503, meaning: "Provider outcome unknown after network close; recovery required." },
  { code: "provider_recovery_no_baseline", category: "recovery", retryability: "not_retryable", httpStatus: 409, meaning: "Recovery has no committed baseline hash; must fork or coordinate." },
  { code: "recovery_baseline_hash_mismatch", category: "recovery", retryability: "not_retryable", httpStatus: 409, meaning: "Reconstructed baseline does not match the committed hash." },
  { code: "recovery_terminal_bridge_missing", category: "recovery", retryability: "not_retryable", httpStatus: 410, meaning: "Terminal bridge was not written; attempt is not settled." },
  { code: "recovery_active_descriptor_incomplete", category: "recovery", retryability: "indeterminate", httpStatus: 503, meaning: "A recovery descriptor is active but incomplete; coordination required." },
  { code: "model_protocol_compatible_fixed_by_default", category: "model_route", retryability: "not_retryable", httpStatus: 400, meaning: "Compatible models were fixed to Chat; explicit protocol selection required." },
  { code: "model_protocol_selection_required", category: "model_route", retryability: "not_retryable", httpStatus: 400, meaning: "Provider config lacks an explicit protocol/capability selection." },
  { code: "remote_compact_not_eligible", category: "model_route", retryability: "not_retryable", httpStatus: 400, meaning: "Remote compact requested on a non-Responses-capable route." },
  { code: "remote_compact_indeterminate", category: "model_route", retryability: "indeterminate", httpStatus: 503, meaning: "Remote compact outcome unknown; recovery receipt required." },
  // Selection / capability / event / cursor / session / permission.
  { code: "selection_v2_none_forbidden", category: "selection", retryability: "not_retryable", httpStatus: 409, meaning: "A V2 attempt carried the forbidden v2-none selection." },
  { code: "selection_validation_mismatch", category: "selection", retryability: "not_retryable", httpStatus: 409, meaning: "Selection validation drifted from the prepared attempt identity." },
  { code: "capability_load_no_production_caller", category: "capability", retryability: "not_retryable", httpStatus: 404, meaning: "Capability body requested without a production caller path." },
  { code: "capability_body_missing", category: "capability", retryability: "not_retryable", httpStatus: 404, meaning: "Capability body missing for a declared card." },
  { code: "capability_superseded", category: "capability", retryability: "not_retryable", httpStatus: 409, meaning: "Capability load was superseded by a newer snapshot." },
  { code: "capability_budget_exceeded", category: "capability", retryability: "not_retryable", httpStatus: 503, meaning: "Capability L0/L2 budget was exceeded." },
  { code: "event_envelope_unregistered", category: "event", retryability: "not_retryable", httpStatus: 400, meaning: "Event type is not registered in the publisher policy." },
  { code: "event_legacy_prompt_path", category: "event", retryability: "not_retryable", httpStatus: 410, meaning: "An event turn attempted the legacy SessionPrompt path." },
  { code: "im_double_write_attempted", category: "event", retryability: "not_retryable", httpStatus: 409, meaning: "IM wrote a second authority channel." },
  { code: "cursor_gap_exceeded", category: "cursor", retryability: "not_retryable", httpStatus: 410, meaning: "Cursor gap exceeded retention; bounded resync required." },
  { code: "session_input_reuse_conflict", category: "session", retryability: "not_retryable", httpStatus: 409, meaning: "Prompt message id reuse conflicts with an existing input." },
  { code: "session_activity_not_owned", category: "session", retryability: "not_retryable", httpStatus: 404, meaning: "Activity is not owned by the current process/local placement." },
  { code: "permission_denied", category: "permission", retryability: "not_retryable", httpStatus: 403, meaning: "Permission denied for this effect." },
  { code: "security_namespace_denied", category: "permission", retryability: "not_retryable", httpStatus: 403, meaning: "Security namespace denial." },
  // Generic.
  { code: "validation_failed", category: "validation", retryability: "not_retryable", httpStatus: 400, meaning: "Payload failed schema validation; expected/actual fields carry details." },
  { code: "exact_retry_mismatch", category: "conflict", retryability: "not_retryable", httpStatus: 409, meaning: "Exact retry identity does not match the original attempt." },
  { code: "malformed_payload", category: "malformed", retryability: "not_retryable", httpStatus: 400, meaning: "Malformed payload; decoding failed." },
  { code: "internal_error", category: "internal", retryability: "not_retryable", httpStatus: 503, meaning: "Internal error; report with correlation id." },
  { code: "resource_not_found", category: "not_found", retryability: "not_retryable", httpStatus: 404, meaning: "Requested resource does not exist." },
  { code: "service_unavailable", category: "unavailable", retryability: "retryable", httpStatus: 503, meaning: "Service temporarily unavailable." },
] as const

const CODE_IDS = new Set(ERROR_CODE_REGISTRY.map((entry) => entry.code))

/**
 * The wire error envelope (design §11.1): code, resource, correlation_id,
 * retryability, expected/actual where applicable. 'message' is explicitly
 * NON-AUTHORITATIVE: a client must decide from 'code' + 'retryability' +
 * 'httpStatus', never by parsing the message.
 */
export const ErrorEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(ErrorVersion.schema),
  code: Schema.String,
  category: ErrorCategory,
  retryability: ErrorRetryability,
  httpStatus: ErrorHttpStatus,
  resource: Schema.String,
  correlationId: Schema.String,
  message: Schema.String,
  expected: Schema.String.pipe(Schema.optional),
  actual: Schema.String.pipe(Schema.optional),
})
export type ErrorEnvelope = typeof ErrorEnvelope.Type

/** Typed failure used by servers/SDK to carry a frozen error envelope. */
export class ErrorEnvelopeDecodeError extends Schema.TaggedErrorClass<ErrorEnvelopeDecodeError>()(
  "error",
  {
    path: Schema.String,
    summary: Schema.String,
    registryVersion: Schema.Literal(ErrorVersion.registry),
  },
) {}

/** Known stable codes that have been registered in the current registry. */
export function isRegisteredCode(code: string): boolean {
  return CODE_IDS.has(code)
}

/** Stable set-valued lookup used by servers for classification. */
export function codeMeta(code: string): Readonly<ErrorCodeEntry> | undefined {
  return ERROR_CODE_REGISTRY.find((entry) => entry.code === code)
}

/** A decode attempt failed; the envelope was rejected (typed). */
export function decodeErrorEnvelope(input: unknown): ErrorEnvelope {
  try {
    const envelope = Schema.decodeUnknownSync(ErrorEnvelope)(input, { onExcessProperty: "error" })
    if (!CODE_IDS.has(envelope.code)) {
      throw new Error('unregistered code at ["code"]')
    }
    return envelope
  } catch (error) {
    const { path, summary } = describeError(error)
    throw new ErrorEnvelopeDecodeError({ path, summary, registryVersion: ErrorVersion.registry })
  }
}

function describeError(error: unknown): { path: string; summary: string } {
  const e = error as { path?: unknown; message?: string }
  const path = Array.isArray(e.path) ? JSON.stringify(e.path) : typeof e.path === "string" ? e.path : ""
  return { path, summary: typeof e.message === "string" ? e.message : "decode failed" }
}

export function encodeErrorEnvelope(envelope: ErrorEnvelope): string {
  return JSON.stringify(Schema.decodeUnknownSync(ErrorEnvelope)(envelope))
}

/** Byte-stable digest of the envelope (content identity; volatile keys stripped). */
export function errorEnvelopeDigest(envelope: ErrorEnvelope): string {
  return contentDigest(envelope)
}

/** Byte-stable digest of the registry (drift detection; registry version included). */
export function registryDigest(): string {
  return contentDigest({ version: ErrorVersion.registry, codes: ERROR_CODE_REGISTRY })
}
