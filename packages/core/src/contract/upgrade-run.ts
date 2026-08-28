export * as UpgradeRunContract from "./upgrade-run"

import { Schema } from "effect"
import { contentDigest } from "./digest"

// C0-02 Phase 1 - Upgrade run contract (freeze base)
// Design authority: docs/core-v2.0-beta/design.md §10.5 (upgrade run + content
// addressed migration receipt), plus worklist C1A-03 and C1A-04 notes (skip
// migration must be illegal in the contract).

/** Version matrix for the upgrade run contract. `run`/`receipt` are the schema versions. */
export const UpgradeRunVersion = {
  run: "upgrade-run.v1",
  receipt: "migration-receipt.v1",
  state: 1,
  completion: 1,
  result: 1,
  protocol: 1,
} as const

/**
 * Upgrade run state machine, frozen per design §10.5 (line 475):
 * planned -> backup_verified -> applying -> verifying -> ready, with any
 * failure entering `recovery_required`. There is no `skipped` state — skipping
 * a migration is a typed violation, never a legal transition (worklist C1A-04).
 *
 * SUCCESSOR NOTE: `recovery_required` is TERMINAL in this frozen contract. The
 * exit / recovery transitions out of `recovery_required` belong to the C1A
 * design and are intentionally not frozen here.
 */
export const UpgradeRunState = Schema.Literals([
  "planned",
  "backup_verified",
  "applying",
  "verifying",
  "ready",
  "recovery_required",
])
export type UpgradeRunState = typeof UpgradeRunState.Type

/**
 * Migration completion. Deliberately does not include `skipped` / `skipped_empty`:
 * a migration must always reach a real completion recorded via a content-addressed
 * receipt, so skipping a migration has no legal representation here.
 */
export const MigrationCompletion = Schema.Literals(["applied", "backfilled", "verify_failed", "rolled_back"])
export type MigrationCompletion = typeof MigrationCompletion.Type

/** Reader / writer protocol compatibility version (design §10.3, §10.5). */
export const SchemaProtocolVersion = Schema.Struct({
  reader: Schema.String,
  writer: Schema.String,
})
export type SchemaProtocolVersion = typeof SchemaProtocolVersion.Type

/**
 * Content-addressed migration receipt (design §10.5). Its identity is the
 * content hash + ordinal + run ID + binary build, so a skipped migration has no
 * receipt to commit. Timestamps are present for audit but excluded from the
 * content digest.
 */
export class MigrationReceipt extends Schema.Class<MigrationReceipt>("UpgradeRun.MigrationReceipt")({
  schemaVersion: Schema.Literal(UpgradeRunVersion.receipt),
  receiptId: Schema.String,
  migrationId: Schema.String,
  contentHash: Schema.String,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  buildIdentity: Schema.String,
  packageVersion: Schema.String,
  bodyHash: Schema.String,
  runId: Schema.String,
  result: MigrationCompletion,
  startedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  completedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

/**
 * Upgrade run (design §10.5). Tracks the source/target registry digests, the
 * reader/writer protocol compatibility, the binary and package identity, the
 * backup manifest, the pending migration set and the run state.
 */
export class UpgradeRun extends Schema.Class<UpgradeRun>("UpgradeRun.UpgradeRun")({
  schemaVersion: Schema.Literal(UpgradeRunVersion.run),
  runId: Schema.String,
  sourceRegistryDigest: Schema.String,
  targetRegistryDigest: Schema.String,
  sourceProtocol: SchemaProtocolVersion,
  targetProtocol: SchemaProtocolVersion,
  buildIdentity: Schema.String,
  packageVersion: Schema.String,
  backupManifestRef: Schema.String.pipe(Schema.optional),
  pendingMigrationIds: Schema.Array(Schema.String),
  state: UpgradeRunState,
  failureCode: Schema.String.pipe(Schema.optional),
  appliedOrdinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalMigrations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  startedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  completedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

/**
 * Canonical content-addressed receipt ID derived from the immutable receipt
 * fields (content hash, ordinal, run id, build identity). Two identical receipts
 * share an ID; a receipt whose identity fields changed is a different receipt.
 */
export const migrationReceiptContentAddress = (receipt: MigrationReceipt): string =>
  contentDigest({
    migrationId: receipt.migrationId,
    contentHash: receipt.contentHash,
    ordinal: receipt.ordinal,
    runId: receipt.runId,
    buildIdentity: receipt.buildIdentity,
    packageVersion: receipt.packageVersion,
    bodyHash: receipt.bodyHash,
  })

/** Allowed state transitions; anything else is an illegal/immutable transition. */
export const ALLOWED_TRANSITIONS: Readonly<Record<UpgradeRunState, readonly UpgradeRunState[]>> = {
  planned: ["backup_verified"],
  backup_verified: ["applying", "recovery_required"],
  applying: ["verifying", "recovery_required"],
  verifying: ["ready", "recovery_required"],
  ready: [],
  recovery_required: [],
}

/** Whether `from -> to` is an allowed transition under the frozen trigger rules. */
export const canTransition = (from: UpgradeRunState, to: UpgradeRunState): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to)

/** Typed error for an illegal / immutable state transition. */
export class InvalidTransitionError extends Schema.TaggedErrorClass<InvalidTransitionError>()(
  "UpgradeRun.InvalidTransitionError",
  { from: UpgradeRunState, to: UpgradeRunState },
) {}

/** Typed violation: a skip migration is not a legal contract value (worklist C1A-04). */
export class SkipMigrationError extends Schema.TaggedErrorClass<SkipMigrationError>()(
  "UpgradeRun.SkipMigrationError",
  { reason: Schema.String },
) {}

/** Throws `InvalidTransitionError` if `from -> to` is not allowed. */
export const assertRunTransition = (from: UpgradeRunState, to: UpgradeRunState): void => {
  if (!canTransition(from, to)) throw new InvalidTransitionError({ from, to })
}

/**
 * Enforce that a migration was genuinely executed (not skipped). `verify_failed`
 * and `rolled_back` are genuine, content-addressed completions and never count
 * as a skip. Only a receipt that claims applied/backfilled without a
 * content-addressed identity is the write of a skipped migration (worklist
 * C1A-04); that throws the typed `SkipMigrationError`.
 */
export const assertMigrationNotSkipped = (receipt: MigrationReceipt): void => {
  if (receipt.result === "verify_failed" || receipt.result === "rolled_back") return
  if (
    receipt.contentHash.trim() === "" ||
    receipt.bodyHash.trim() === "" ||
    receipt.migrationId.trim() === "" ||
    receipt.runId.trim() === "" ||
    receipt.ordinal < 1
  ) {
    throw new SkipMigrationError({ reason: "migration_receipt_missing_content_identity" })
  }
}

/** Typed decode error carrying the offending JSON path (UpgradeRun). */
export class UpgradeRunDecodeError extends Schema.TaggedErrorClass<UpgradeRunDecodeError>()(
  "UpgradeRun.DecodeError",
  { message: Schema.String, path: Schema.Array(Schema.String) },
) {}

/** Typed decode error carrying the offending JSON path (MigrationReceipt). */
export class MigrationReceiptDecodeError extends Schema.TaggedErrorClass<MigrationReceiptDecodeError>()(
  "UpgradeRun.ReceiptDecodeError",
  { message: Schema.String, path: Schema.Array(Schema.String) },
) {}

export type UpgradeRunValidation =
  | { readonly ok: true; readonly value: UpgradeRun }
  | { readonly ok: false; readonly error: UpgradeRunDecodeError }

export type MigrationReceiptValidation =
  | { readonly ok: true; readonly value: MigrationReceipt }
  | { readonly ok: false; readonly error: MigrationReceiptDecodeError }

function extractErrorPath(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error)
  const atIndex = message.indexOf("\n  at ")
  if (atIndex === -1) return []
  const lineStart = atIndex + 6
  const lineEnd = message.indexOf("\n", lineStart)
  const tail = lineEnd === -1 ? message.slice(lineStart) : message.slice(lineStart, lineEnd)
  const segments: string[] = []
  const re = /\[([^\]]*)\]/g
  let current: RegExpExecArray | null
  while ((current = re.exec(tail)) !== null) {
    const raw = current[1]!
    segments.push(raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw)
  }
  return segments
}

/** Decode an UpgradeRun. Extra properties are rejected. */
export const decodeUpgradeRun = (input: unknown): UpgradeRun => {
  try {
    return Schema.decodeUnknownSync(UpgradeRun, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new UpgradeRunDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) })
  }
}

/** Encode an UpgradeRun to its schema-derived JSON shape. */
export const encodeUpgradeRun = (value: UpgradeRun): UpgradeRun => Schema.encodeSync(UpgradeRun)(value)

/** Non-throwing validation of an UpgradeRun. */
export const validateUpgradeRun = (input: unknown): UpgradeRunValidation => {
  try {
    return { ok: true, value: Schema.decodeUnknownSync(UpgradeRun, { onExcessProperty: "error" })(input) }
  } catch (error) {
    return {
      ok: false,
      error: new UpgradeRunDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) }),
    }
  }
}

/** Decode a MigrationReceipt. Extra properties are rejected. */
export const decodeMigrationReceipt = (input: unknown): MigrationReceipt => {
  try {
    return Schema.decodeUnknownSync(MigrationReceipt, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new MigrationReceiptDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) })
  }
}

/** Encode a MigrationReceipt to its schema-derived JSON shape. */
export const encodeMigrationReceipt = (value: MigrationReceipt): MigrationReceipt => Schema.encodeSync(MigrationReceipt)(value)

/** Non-throwing validation of a MigrationReceipt. */
export const validateMigrationReceipt = (input: unknown): MigrationReceiptValidation => {
  try {
    return { ok: true, value: Schema.decodeUnknownSync(MigrationReceipt, { onExcessProperty: "error" })(input) }
  } catch (error) {
    return {
      ok: false,
      error: new MigrationReceiptDecodeError({ message: error instanceof Error ? error.message : String(error), path: extractErrorPath(error) }),
    }
  }
}

/** Byte-stable canonical content digest of an UpgradeRun (timestamp-independent). */
export const upgradeRunDigest = (value: UpgradeRun): string => contentDigest(value)

/** Byte-stable canonical content digest of a MigrationReceipt (timestamp-independent). */
export const migrationReceiptDigest = (value: MigrationReceipt): string => contentDigest(value)
