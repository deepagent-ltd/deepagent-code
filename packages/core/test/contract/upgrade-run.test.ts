import { describe, expect, test } from "bun:test"
import {
  UpgradeRun,
  MigrationReceipt,
  UpgradeRunDecodeError,
  MigrationReceiptDecodeError,
  SkipMigrationError,
  InvalidTransitionError,
  decodeUpgradeRun,
  encodeUpgradeRun,
  decodeMigrationReceipt,
  encodeMigrationReceipt,
  validateUpgradeRun,
  validateMigrationReceipt,
  upgradeRunDigest,
  migrationReceiptDigest,
  migrationReceiptContentAddress,
  assertRunTransition,
  assertMigrationNotSkipped,
  canTransition,
} from "../../src/contract/upgrade-run"

function makeRun(overrides: Record<string, unknown> = {}): UpgradeRun {
  return decodeUpgradeRun({
    schemaVersion: "upgrade-run.v1",
    runId: "run-1",
    sourceRegistryDigest: "src-digest",
    targetRegistryDigest: "tgt-digest",
    sourceProtocol: { reader: "r1", writer: "w1" },
    targetProtocol: { reader: "r2", writer: "w2" },
    buildIdentity: "build-1",
    packageVersion: "2.0.0-beta.0",
    backupManifestRef: "backup://1",
    pendingMigrationIds: ["m-1", "m-2"],
    state: "applying",
    failureCode: undefined,
    appliedOrdinal: 1,
    totalMigrations: 2,
    startedAt: 0,
    completedAt: 0,
    ...overrides,
  })
}

function makeReceipt(overrides: Record<string, unknown> = {}): MigrationReceipt {
  return decodeMigrationReceipt({
    schemaVersion: "migration-receipt.v1",
    receiptId: "rec-1",
    migrationId: "m-1",
    contentHash: "sha256:body",
    ordinal: 1,
    buildIdentity: "build-1",
    packageVersion: "2.0.0-beta.0",
    bodyHash: "sha256:content",
    runId: "run-1",
    result: "applied",
    startedAt: 0,
    completedAt: 0,
    ...overrides,
  })
}

function runError(input: unknown): UpgradeRunDecodeError {
  try {
    decodeUpgradeRun(input)
  } catch (error) {
    if (error instanceof UpgradeRunDecodeError) return error
    throw error
  }
  throw new Error("expected decodeUpgradeRun to fail")
}

function receiptError(input: unknown): MigrationReceiptDecodeError {
  try {
    decodeMigrationReceipt(input)
  } catch (error) {
    if (error instanceof MigrationReceiptDecodeError) return error
    throw error
  }
  throw new Error("expected decodeMigrationReceipt to fail")
}

describe("upgrade run round-trip and digest", () => {
  test("upgrade run round-trips encode -> decode deterministically", () => {
    const run = makeRun()
    expect(decodeUpgradeRun(encodeUpgradeRun(run))).toEqual(run)
  })

  test("migration receipt round-trips encode -> decode deterministically", () => {
    const receipt = makeReceipt()
    expect(decodeMigrationReceipt(encodeMigrationReceipt(receipt))).toEqual(receipt)
  })

  test("upgrade run digest is byte-stable and independent of timestamps", () => {
    const a = makeRun()
    expect(upgradeRunDigest(a)).toEqual(upgradeRunDigest(a))
    expect(upgradeRunDigest(a)).toMatch(/^[0-9a-f]{64}$/)
    const withLaterStart = { ...(a as unknown as Record<string, unknown>), startedAt: 999999 } as unknown as UpgradeRun
    expect(upgradeRunDigest(withLaterStart)).toEqual(upgradeRunDigest(a))
  })

  test("upgrade run digest is canonical over JSON-equivalent key order", () => {
    const a = makeRun()
    const keys = Object.keys(a)
    const reordered: Record<string, unknown> = {}
    for (const key of keys.toReversed()) reordered[key] = (a as unknown as Record<string, unknown>)[key]
    expect(upgradeRunDigest(a)).toEqual(upgradeRunDigest(reordered as unknown as UpgradeRun))
  })

  test("migration receipt digest is byte-stable and timestamp-independent", () => {
    const a = makeReceipt()
    expect(migrationReceiptDigest(a)).toEqual(migrationReceiptDigest(a))
    const withLater = { ...(a as unknown as Record<string, unknown>), completedAt: 777777 } as unknown as MigrationReceipt
    expect(migrationReceiptDigest(withLater)).toEqual(migrationReceiptDigest(a))
  })

  test("content address is deterministic and content-sensitive", () => {
    const receipt = makeReceipt()
    expect(migrationReceiptContentAddress(receipt)).toEqual(migrationReceiptContentAddress(receipt))
    const changed = makeReceipt({ contentHash: "sha256:different" })
    expect(migrationReceiptContentAddress(changed)).not.toEqual(migrationReceiptContentAddress(receipt))
  })
})

describe("upgrade run negative shapes", () => {
  test("missing field -> typed error with exact path", () => {
    const input = makeRun() as unknown as { totalMigrations?: unknown }
    delete input.totalMigrations
    expect(runError(input).path).toEqual(["totalMigrations"])
  })

  test("extra field -> typed error with exact path", () => {
    const input = { ...(makeRun() as unknown as Record<string, unknown>), extra: true }
    expect(runError(input).path).toEqual(["extra"])
  })

  test("wrong type -> typed error with exact path", () => {
    const input = { ...(makeRun() as unknown as Record<string, unknown>), appliedOrdinal: "high" }
    expect(runError(input).path).toEqual(["appliedOrdinal"])
  })

  test("unknown enum value (state) -> typed error with exact path", () => {
    const input = { ...(makeRun() as unknown as Record<string, unknown>), state: "skipped" }
    expect(runError(input).path).toEqual(["state"])
  })

  test("missing nested field (protocol reader) -> typed error with exact path", () => {
    const input = makeRun() as unknown as { sourceProtocol: { reader?: unknown } }
    delete input.sourceProtocol!.reader
    expect(runError(input).path).toEqual(["sourceProtocol", "reader"])
  })

  test("version mismatch -> typed error with exact path", () => {
    const input = { ...(makeRun() as unknown as Record<string, unknown>), schemaVersion: "upgrade-run.v2" }
    expect(runError(input).path).toEqual(["schemaVersion"])
  })
})

describe("migration receipt negative shapes", () => {
  test("missing field -> typed error with exact path", () => {
    const input = makeReceipt() as unknown as { ordinal?: unknown }
    delete input.ordinal
    expect(receiptError(input).path).toEqual(["ordinal"])
  })

  test("extra field -> typed error with exact path", () => {
    const input = { ...(makeReceipt() as unknown as Record<string, unknown>), extra: true }
    expect(receiptError(input).path).toEqual(["extra"])
  })

  test("unknown enum value (result skipped) -> typed error with exact path", () => {
    const input = { ...(makeReceipt() as unknown as Record<string, unknown>), result: "skipped" }
    expect(receiptError(input).path).toEqual(["result"])
  })

  test("wrong type -> typed error with exact path", () => {
    const input = { ...(makeReceipt() as unknown as Record<string, unknown>), ordinal: "first" }
    expect(receiptError(input).path).toEqual(["ordinal"])
  })

  test("version mismatch -> typed error with exact path", () => {
    const input = { ...(makeReceipt() as unknown as Record<string, unknown>), schemaVersion: "migration-receipt.v2" }
    expect(receiptError(input).path).toEqual(["schemaVersion"])
  })
})

describe("skip migration is illegal", () => {
  test("result skipped is never a legal value", () => {
    const input = { ...(makeReceipt() as unknown as Record<string, unknown>), result: "skipped" }
    expect(receiptError(input).path).toEqual(["result"])
  })

  test("assertMigrationNotSkipped throws a typed violation for empty content identity", () => {
    const receipt = makeReceipt({ contentHash: "" })
    expect(() => assertMigrationNotSkipped(receipt)).toThrow(SkipMigrationError)
  })

  test("assertMigrationNotSkipped accepts a genuine receipt", () => {
    expect(() => assertMigrationNotSkipped(makeReceipt())).not.toThrow()
  })

  test("assertMigrationNotSkipped accepts verify_failed (genuine completion, not a skip)", () => {
    expect(() => assertMigrationNotSkipped(makeReceipt({ result: "verify_failed" }))).not.toThrow()
  })

  test("assertMigrationNotSkipped accepts rolled_back (genuine completion, not a skip)", () => {
    expect(() => assertMigrationNotSkipped(makeReceipt({ result: "rolled_back" }))).not.toThrow()
  })

  test("assertMigrationNotSkipped rejects a genuine skip with the skip reason", () => {
    const receipt = makeReceipt({ bodyHash: "", result: "applied" })
    try {
      assertMigrationNotSkipped(receipt)
      throw new Error("expected SkipMigrationError")
    } catch (error) {
      expect(error).toBeInstanceOf(SkipMigrationError)
      expect((error as SkipMigrationError).reason).toEqual("migration_receipt_missing_content_identity")
    }
  })
})

describe("immutable transition trigger rules", () => {
  test("allowed transitions follow design §10.5", () => {
    expect(canTransition("planned", "backup_verified")).toBe(true)
    expect(canTransition("backup_verified", "applying")).toBe(true)
    expect(canTransition("backup_verified", "recovery_required")).toBe(true)
    expect(canTransition("applying", "verifying")).toBe(true)
    expect(canTransition("applying", "recovery_required")).toBe(true)
    expect(canTransition("verifying", "ready")).toBe(true)
    expect(canTransition("verifying", "recovery_required")).toBe(true)
  })

  test("backward / terminal / failure-forward transitions are rejected", () => {
    // backward transition
    expect(canTransition("verifying", "planned")).toBe(false)
    expect(() => assertRunTransition("verifying", "planned")).toThrow(InvalidTransitionError)
    // ready is terminal in the frozen contract
    expect(canTransition("ready", "applying")).toBe(false)
    expect(canTransition("ready", "verifying")).toBe(false)
    expect(canTransition("ready", "recovery_required")).toBe(false)
    expect(() => assertRunTransition("ready", "applying")).toThrow(InvalidTransitionError)
    // recovery_required is terminal in the frozen contract (C1A owns the exit)
    expect(canTransition("recovery_required", "applying")).toBe(false)
    expect(canTransition("recovery_required", "ready")).toBe(false)
    expect(() => assertRunTransition("recovery_required", "applying")).toThrow(InvalidTransitionError)
  })
})

describe("validate (non-throwing)", () => {
  test("valid run -> ok true; invalid -> ok false with path", () => {
    const ok = validateUpgradeRun(makeRun())
    expect(ok.ok).toBe(true)
    const bad = validateUpgradeRun({ ...(makeRun() as unknown as Record<string, unknown>), state: "bogus" })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.path).toEqual(["state"])
  })

  test("valid receipt -> ok true; invalid -> ok false with path", () => {
    const ok = validateMigrationReceipt(makeReceipt())
    expect(ok.ok).toBe(true)
    const bad = validateMigrationReceipt({ ...(makeReceipt() as unknown as Record<string, unknown>), result: "skipped" })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.path).toEqual(["result"])
  })
})
