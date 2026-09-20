import { describe, expect, test } from "bun:test"
import type { CapabilityCatalog, CapabilityLoadReceipts, SystemContextSnapshot } from "@deepagent-code/sdk/client"
import { availabilityKey, catalogRows, receiptRows, snapshotRow } from "./capability-panel-model"

// C6-09 — capability panel model (mock endpoint data): L0 catalog rows derive name/description/
// availability; load receipts derive identity + metrics; absent payloads derive the empty state.

const catalogCapability: CapabilityCatalog["capabilities"][number] = {
  id: "code.context_query",
  version: "1.2.0",
  summary: "Query code context with intent",
  use_when: ["planning"],
  availability: "stable",
  required_permissions: ["context.read"],
  required_runtime_features: ["context_federation_v2"],
  entry_tools: ["context_query"],
  body_ref: "cap/code-context.md",
  max_body_tokens: 2000,
}

const catalog = (capabilities: CapabilityCatalog["capabilities"]): CapabilityCatalog => ({
  schemaVersion: "capability-catalog.v1",
  id: "catalog-1",
  digest: "digest-abc",
  capabilities,
})

const receipt = (): CapabilityLoadReceipts["receipts"][number] => ({
  identity: "identity-1",
  capabilityId: "code.context_query",
  version: "1.2.0",
  bodyRef: "cap/code-context.md",
  bodyHash: "hash-1",
  runtimeHash: "rt-1",
  permissionHash: "perm-1",
  state: "loaded",
  tokenCount: 512,
  byteCount: 4096,
})

const snapshot = (): SystemContextSnapshot => ({
  catalogSnapshotId: "snap-1",
  catalogDigest: "digest-abc",
  catalogDigestConsistent: true,
  l0LineCount: 42,
  l0TextHash: "l0-1",
  loadedCapabilityCount: 1,
  loadedCapabilities: [],
})

describe("catalogRows (L0)", () => {
  test("derives id/version/summary/availability/entry tools rows", () => {
    const rows = catalogRows(catalog([catalogCapability, { ...catalogCapability, id: "legacy.sync", availability: "maintenance_only" }]))
    expect(rows).toHaveLength(2)

    expect(rows[0]).toEqual({
      id: "code.context_query",
      version: "1.2.0",
      summary: "Query code context with intent",
      availability: "stable",
      availabilityKey: "settings.capabilities.availability.stable",
      entryTools: ["context_query"],
    })
    expect(rows[1]?.availabilityKey).toBe("settings.capabilities.availability.maintenance_only")
  })

  test("maps every availability value to a stable label key", () => {
    expect(availabilityKey("stable")).toBe("settings.capabilities.availability.stable")
    expect(availabilityKey("maintenance_only")).toBe("settings.capabilities.availability.maintenance_only")
    expect(availabilityKey("disabled")).toBe("settings.capabilities.availability.disabled")
    expect(availabilityKey("unavailable")).toBe("settings.capabilities.availability.unavailable")
    expect(availabilityKey("future_mode")).toBe("future_mode") // unknown values pass through raw
  })

  test("empty catalog derives zero rows (empty state)", () => {
    expect(catalogRows(catalog([]))).toEqual([])
    expect(catalogRows(undefined)).toEqual([])
  })
})

describe("receiptRows (load receipts)", () => {
  test("derives identity + metrics rows from the receipts payload", () => {
    const rows = receiptRows({ receipts: [receipt()], count: 1 })
    expect(rows).toEqual([
      {
        capabilityId: "code.context_query",
        version: "1.2.0",
        bodyRef: "cap/code-context.md",
        bodyHash: "hash-1",
        tokenCount: 512,
        byteCount: 4096,
      },
    ])
  })

  test("absent receipts derive zero rows (empty state)", () => {
    expect(receiptRows(undefined)).toEqual([])
    expect(receiptRows({ receipts: [], count: 0 })).toEqual([])
  })
})

describe("snapshotRow (system-context snapshot)", () => {
  test("derives the digest diagnostics row", () => {
    expect(snapshotRow(snapshot())).toEqual({
      catalogSnapshotId: "snap-1",
      catalogDigest: "digest-abc",
      catalogDigestConsistent: true,
      l0LineCount: 42,
    })
  })

  test("absent snapshot derives no row (unavailable state)", () => {
    expect(snapshotRow(undefined)).toBeUndefined()
  })
})
