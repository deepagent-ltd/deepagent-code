import { describe, expect, test } from "bun:test"
import {
  CapabilityBudget,
  DeepAgentCodeToolInventory,
  assertCapabilityCatalogConsistent,
  assertCapabilityManifestConsistent,
  capabilityCatalogDigest,
  capabilityManifestSignature,
  decodeCapabilityManifest,
  manifestCoherence,
  type CapabilityManifest,
} from "@deepagent-code/core/system-context/capability-manifest"
import {
  assertFirstBatchConsistent,
  capabilityCatalog,
  capabilityCatalogDigestValue,
  capabilityCatalogSnapshotId,
  catalogSchemaVersion,
} from "@deepagent-code/core/system-context/capability-catalog"

// C4-01 — machine-readable capability manifest: schema, signature, digest, the
// ToolRegistry/flags/policy/App consistency gate, and the first batch coherence.

const validManifest = {
  id: "deepagent.code-read",
  version: "2.0.0-beta.0",
  summary: "Read and search source files in the active workspace",
  use_when: ["locating implementations", "tracing references"],
  availability: "stable",
  required_permissions: ["read", "glob", "grep"],
  required_runtime_features: [],
  entry_tools: ["read", "glob", "grep"],
  body_ref: "capability://deepagent.code-read@2.0.0-beta.0",
  max_body_tokens: 1200,
}

describe("CapabilityManifest schema", () => {
  test("decodes a valid manifest into a branded capability id", () => {
    const manifest = decodeCapabilityManifest(validManifest)
    expect(String(manifest.id)).toBe("deepagent.code-read")
    expect(manifest.availability).toBe("stable")
    expect(manifest.required_permissions).toEqual(["read", "glob", "grep"])
    expect(String(manifest.body_ref)).toBe("capability://deepagent.code-read@2.0.0-beta.0")
  })

  test("rejects an unknown field (decode is strict)", () => {
    expect(() => decodeCapabilityManifest({ ...validManifest, extra: true })).toThrow()
  })

  test("rejects a non-namespaced capability id", () => {
    expect(() => decodeCapabilityManifest({ ...validManifest, id: "context-query" })).toThrow()
  })

  test("rejects a capability id with a dot (the deepagent.* namespace is hyphenated)", () => {
    expect(() => decodeCapabilityManifest({ ...validManifest, id: "deepagent.code.read" })).toThrow()
  })

  test("rejects a body_ref that is an arbitrary path or URL", () => {
    expect(() => decodeCapabilityManifest({ ...validManifest, body_ref: "/etc/passwd" })).toThrow()
    expect(() => decodeCapabilityManifest({ ...validManifest, body_ref: "https://example.com/body" })).toThrow()
  })

  test("rejects a body_ref that names a different capability", () => {
    expect(() =>
      decodeCapabilityManifest({ ...validManifest, body_ref: "capability://deepagent.shell-execute@2.0.0-beta.0" }),
    ).toThrow()
  })

  test("accepts an absent body_hash (body authored by the C4-09 body lane)", () => {
    const manifest = decodeCapabilityManifest(validManifest)
    expect(manifest.body_hash).toBeUndefined()
  })

  test("accepts a well-formed body_hash", () => {
    const manifest = decodeCapabilityManifest({ ...validManifest, body_hash: "sha256:" + "a".repeat(64) })
    expect(String(manifest.body_hash)).toBe("sha256:" + "a".repeat(64))
  })

  test("rejects a malformed body_hash", () => {
    expect(() => decodeCapabilityManifest({ ...validManifest, body_hash: "md5:abc" })).toThrow()
    expect(() => decodeCapabilityManifest({ ...validManifest, body_hash: "sha256:nothex" })).toThrow()
  })

  test("rejects an empty summary and empty use_when phrase", () => {
    expect(() => decodeCapabilityManifest({ ...validManifest, summary: "   " })).toThrow()
  })
})

describe("CapabilityManifest signature + digest", () => {
  test("produces a sha256-prefixed manifest signature deterministically", () => {
    const manifest = decodeCapabilityManifest(validManifest)
    const signature = capabilityManifestSignature(manifest)
    expect(signature).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(capabilityManifestSignature(manifest)).toBe(signature)
  })

  test("changes the signature when the manifest content changes", () => {
    const a = decodeCapabilityManifest(validManifest)
    const b = decodeCapabilityManifest({ ...validManifest, summary: "A different summary" })
    expect(capabilityManifestSignature(a)).not.toBe(capabilityManifestSignature(b))
  })

  test("is byte-stable over reordered catalogs", () => {
    const a = decodeCapabilityManifest(validManifest)
    const b = decodeCapabilityManifest({ ...validManifest, id: "deepagent.code-edit", body_ref: "capability://deepagent.code-edit@2.0.0-beta.0" })
    const catalogA = [b, a]
    const catalogB = [a, b]
    expect(capabilityCatalogDigest(catalogA)).toBe(capabilityCatalogDigest(catalogB))
  })

  test("changes the catalog digest when catalog content changes", () => {
    const a = decodeCapabilityManifest(validManifest)
    const b = decodeCapabilityManifest({ ...validManifest, summary: "Different" })
    expect(capabilityCatalogDigest([a])).not.toBe(capabilityCatalogDigest([b]))
  })
})

describe("CapabilityManifest consistency gate", () => {
  test("passes a coherent manifest against the product inventory", () => {
    const manifest = decodeCapabilityManifest(validManifest)
    expect(manifestCoherence(manifest, DeepAgentCodeToolInventory).violations).toEqual([])
    expect(() => assertCapabilityManifestConsistent(manifest, DeepAgentCodeToolInventory)).not.toThrow()
  })

  test("flags an unknown entry tool", () => {
    const manifest = decodeCapabilityManifest({ ...validManifest, entry_tools: ["mystery_tool"] })
    const { violations } = manifestCoherence(manifest, DeepAgentCodeToolInventory)
    expect(violations.some((v) => v.includes("unknown entry tool"))).toBe(true)
  })

  test("flags an unknown permission", () => {
    const manifest = decodeCapabilityManifest({ ...validManifest, required_permissions: ["god.permission"] })
    const { violations } = manifestCoherence(manifest, DeepAgentCodeToolInventory)
    expect(violations.some((v) => v.includes("unknown permission"))).toBe(true)
  })

  test("flags an unknown runtime feature", () => {
    const manifest = decodeCapabilityManifest({ ...validManifest, required_runtime_features: ["time_travel_v9"] })
    const { violations } = manifestCoherence(manifest, DeepAgentCodeToolInventory)
    expect(violations.some((v) => v.includes("unknown runtime feature"))).toBe(true)
  })

  test("flags a body budget above the frozen L2 single-body cap", () => {
    const manifest = decodeCapabilityManifest({ ...validManifest, max_body_tokens: 2000 })
    const { violations } = manifestCoherence(manifest, DeepAgentCodeToolInventory)
    expect(violations.some((v) => v.includes("exceeds L2 cap"))).toBe(true)
    expect(CapabilityBudget.l2SingleMaxTokens).toBe(1200)
  })

  test("flags a body_ref that does not name the capability", () => {
    // decode() rejects the mismatch fail-closed (see the schema test above); the
    // consistency gate independently flags it for reporting when a manifest is
    // constructed shallowly (e.g. loaded from an untrusted/older source).
    const manifest = {
      ...validManifest,
      body_ref: "capability://deepagent.shell-execute@2.0.0-beta.0",
    } as unknown as CapabilityManifest
    const { violations } = manifestCoherence(manifest, DeepAgentCodeToolInventory)
    expect(violations.some((v) => v.includes("does not name"))).toBe(true)
  })

  test("flags duplicate capability ids at the catalog level", () => {
    const a = decodeCapabilityManifest(validManifest)
    expect(() => assertCapabilityCatalogConsistent([a, a], DeepAgentCodeToolInventory)).toThrow(/duplicate capability ids/)
  })
})

describe("C4-01 first batch", () => {
  test("passes the product consistency gate", () => {
    expect(() => assertFirstBatchConsistent()).not.toThrow()
  })

  test("has unique, hyphen-namespaced ids and per-capability body_refs", () => {
    const ids = capabilityCatalog.map((manifest) => manifest.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const manifest of capabilityCatalog) {
      expect(manifest.id).toMatch(/^deepagent.[a-z0-9][a-z0-9-]*$/)
      expect(String(manifest.body_ref)).toBe(`capability://${String(manifest.id)}@${manifest.version}`)
    }
  })

  test("freezes a deterministic catalog snapshot identity", () => {
    expect(catalogSchemaVersion).toBe("capability-catalog.v1")
    expect(capabilityCatalogSnapshotId).toBe(`capability_catalog:${capabilityCatalogDigestValue.slice("sha256:".length)}`)
    expect(capabilityCatalogDigestValue).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("keeps the first batch under the frozen L0 budget", () => {
    // The manifest ids/summaries are the source; the rendered L0 stays small.
    expect(CapabilityBudget.l0MaxTokens).toBe(700)
    expect(CapabilityBudget.l0MaxBytes).toBe(4096)
  })
})