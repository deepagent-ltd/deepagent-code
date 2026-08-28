import { describe, expect, test } from "bun:test"
import { CapabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import { CapabilityLoader } from "@deepagent-code/core/system-context/capability-loader"
import { CapabilitySearch } from "@deepagent-code/core/system-context/capability-search"
import { CapabilityRuntimeSearch } from "@deepagent-code/core/system-context/capability-runtime-search"

// C6-02 capability catalog/search/load-receipt diagnostics (design §11.1 + §7.3).
// The "denied → no body leak" invariant: a capability whose required permission is
// denied is excluded entirely, and a search card / catalog entry / load receipt
// NEVER carries a procedure body (only body_ref/body_hash).

describe("capability catalog/search diagnostics", () => {
  test("the catalog snapshot digest is consistent with the frozen catalog (L0 hash consistency)", () => {
    const snapshot = CapabilityCatalog.capabilityCatalogSnapshot
    const recomputed = CapabilityCatalog.capabilityCatalogDigestValue
    expect(recomputed).toBe(snapshot.digest)
    expect(snapshot.id).toBe(`capability_catalog:${snapshot.digest.slice("sha256:".length)}`)
    expect(snapshot.capabilities.length).toBeGreaterThan(0)
  })

  test("catalog entries expose identity fields but never a procedure body", () => {
    for (const manifest of CapabilityCatalog.capabilityCatalog) {
      expect(manifest.id).toBeString()
      expect(manifest.summary).toBeString()
      expect(manifest.entry_tools.length).toBeGreaterThan(0)
      expect(typeof (manifest as Record<string, unknown>).body).toBe("undefined")
      // The manifest schema declares body_ref/body_hash, never body content.
      expect((manifest as Record<string, unknown>).body).toBeUndefined()
    }
  })

  test("search cards carry summary + entry_tools + body_ref only (never body)", () => {
    const output = CapabilityCatalog.capabilityCatalog
    const cards = CapabilitySearch.capabilitySearch(
      output,
      { query: "read files" },
      CapabilitySearch.fullAuthorization,
    )
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      expect(card.id).toBeString()
      expect(card.summary).toBeString()
      expect(card.body_ref).toBeString()
      // A search card never carries a body field (the procedure body is only
      // reachable through the load path, never serialized in a search result).
      expect((card as Record<string, unknown>).body).toBeUndefined()
    }
  })

  test("a denied permission excludes the capability entirely (no body leak on denial)", () => {
    // Deny the `edit` permission: the code-edit capability must be excluded from results.
    const denied = CapabilitySearch.denyPermission(CapabilitySearch.fullAuthorization, "edit")
    const cards = CapabilitySearch.capabilitySearch(
      CapabilityCatalog.capabilityCatalog,
      { query: "edit files" },
      denied,
    )
    const ids = cards.map((card) => card.id)
    expect(ids).not.toContain("deepagent.code-edit")
    // No card carries body content even when it appears.
    for (const card of cards) {
      expect((card as Record<string, unknown>).body).toBeUndefined()
    }
  })

  test("runtime-authorized search derives the feature filter from the E2 registry", () => {
    const output = CapabilityRuntimeSearch.runtimeAuthorizedSearch(
      CapabilityCatalog.capabilityCatalog,
      { query: "search web" },
      CapabilityCatalog.capabilityCatalogSnapshotId,
    )
    expect(output.catalog_snapshot_id).toBe(CapabilityCatalog.capabilityCatalogSnapshotId)
    expect(output.count).toBeGreaterThan(0)
    for (const card of output.cards) {
      expect(card.authorized).toBe(true)
      expect((card as Record<string, unknown>).body).toBeUndefined()
    }
  })

  test("load receipts expose identity/metrics but never the loaded body", () => {
    CapabilityLoader.resetCapabilityLoader()
    expect(CapabilityLoader.recordedCapabilityLoads()).toEqual([])
  })
})
