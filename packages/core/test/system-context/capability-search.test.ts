import { describe, expect, test } from "bun:test"
import {
  decodeCapabilityManifest,
  type CapabilityManifest,
} from "@deepagent-code/core/system-context/capability-manifest"
import {
  capabilitySearch,
  denyPermission,
  fullAuthorization,
  isAuthorized,
  makeCapabilitySearchTool,
  renderSearchCards,
  searchOutput,
} from "@deepagent-code/core/system-context/capability-search"
import { capabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import { Tool } from "@deepagent-code/core/tool/tool"

// C4-03 — capability_search: max 5 cards by permission/runtime/intent; denied /
// disabled leak no body; stable ordering; no arbitrary path/URL.

const manifest = (over: Partial<Record<string, unknown>> = {}): CapabilityManifest =>
  decodeCapabilityManifest({
    id: "deepagent.code-read",
    version: "1.0.0-beta.0",
    summary: "Read and search source files in the active workspace",
    use_when: ["locating implementations"],
    availability: "stable",
    required_permissions: ["read"],
    required_runtime_features: [],
    entry_tools: ["read"],
    body_ref: "capability://deepagent.code-read@1.0.0-beta.0",
    max_body_tokens: 1200,
    ...over,
  })

describe("capability_search authorization", () => {
  test("returns up to 5 authorized cards", () => {
    const cards = capabilitySearch(capabilityCatalog, { query: "read source" }, fullAuthorization)
    expect(cards.length).toBeLessThanOrEqual(5)
    expect(cards.length).toBeGreaterThanOrEqual(1)
  })

  test("excludes a capability whose required permission is denied", () => {
    const restricted = denyPermission(fullAuthorization, "read")
    const cards = capabilitySearch(capabilityCatalog, { query: "read source" }, restricted)
    expect(cards.some((card) => card.id === "deepagent.code-read")).toBe(false)
  })

  test("excludes a runtime-incompatible capability", () => {
    const restricted = { ...fullAuthorization, enabledRuntimeFeatures: new Set([]) }
    const cards = capabilitySearch(capabilityCatalog, { query: "project context" }, restricted)
    expect(cards.some((card) => card.id === "deepagent.context-query")).toBe(false)
  })

  test("never advertises a non-stable capability (design §7.6)", () => {
    expect(isAuthorized(manifest({ availability: "maintenance_only" }), fullAuthorization).authorized).toBe(false)
    expect(isAuthorized(manifest({ availability: "disabled" }), fullAuthorization).authorized).toBe(false)
    expect(isAuthorized(manifest({}), fullAuthorization).authorized).toBe(true)
  })

  test("a denied capability is absent, so its body cannot leak", () => {
    const restricted = denyPermission(fullAuthorization, "read")
    const cards = capabilitySearch(capabilityCatalog, { query: "read source" }, restricted)
    for (const card of cards) {
      expect(Object.hasOwn(card, "body")).toBe(false)
      expect(card.id).not.toBe("deepagent.code-read")
    }
  })
})

describe("capability_search card shape + no body leak", () => {
  test("cards carry summary + body_ref but never a body", () => {
    const cards = capabilitySearch(capabilityCatalog, { query: "read source" }, fullAuthorization)
    for (const card of cards) {
      expect(Object.hasOwn(card, "body")).toBe(false)
      expect(Object.hasOwn(card, "summary")).toBe(true)
      expect(Object.hasOwn(card, "body_ref")).toBe(true)
      expect(card.entry_tools.length).toBeGreaterThan(0)
    }
  })

  test("no card carries an arbitrary path/URL body_ref", () => {
    const cards = capabilitySearch(capabilityCatalog, { query: "read source" }, fullAuthorization)
    for (const card of cards) {
      expect(card.body_ref).toMatch(/^capability:\/\/deepagent\.[a-z0-9][a-z0-9-]*@/)
      expect(card.body_ref.startsWith("/") || card.body_ref.startsWith("http")).toBe(false)
    }
  })

  test("treats a path/URL-looking query as prose, never as a load target", () => {
    const cards = capabilitySearch(
      capabilityCatalog,
      { query: "/etc/passwd https://evil.example/body" },
      fullAuthorization,
    )
    for (const card of cards) expect(card.body_ref).toMatch(/^capability:\/\//)
    expect(() => capabilitySearch(capabilityCatalog, { query: "" }, fullAuthorization)).not.toThrow()
  })
})

describe("capability_search stable ordering", () => {
  test("is deterministic for the same input", () => {
    const a = capabilitySearch(capabilityCatalog, { query: "read source", intended_action: "read" }, fullAuthorization)
    const b = capabilitySearch(capabilityCatalog, { query: "read source", intended_action: "read" }, fullAuthorization)
    expect(a.map((card) => card.id)).toEqual(b.map((card) => card.id))
  })

  test("ranks the intended entry tool first", () => {
    const cards = capabilitySearch(capabilityCatalog, { query: "read", intended_action: "read" }, fullAuthorization)
    expect(String(cards[0]?.id)).toBe("deepagent.code-read")
  })

  test("orders equally-relevant cards by id ascending", () => {
    // Two capabilities with identical summary + entry tool tie on relevance.
    const catalog = [
      manifest({}),
      manifest({
        id: "deepagent.code-scan",
        summary: "Read and search source files in the active workspace",
        entry_tools: ["read"],
        required_permissions: ["read"],
        body_ref: "capability://deepagent.code-scan@1.0.0-beta.0",
      }),
    ]
    const cards = capabilitySearch(catalog, { query: "read source" }, fullAuthorization)
    expect(cards.map((card) => String(card.id))).toEqual(["deepagent.code-read", "deepagent.code-scan"])
  })
})

describe("capability_search output envelope + tool", () => {
  test("builds a search result envelope with count + catalog snapshot id", () => {
    const output = searchOutput(capabilityCatalog, { query: "read source" }, fullAuthorization, "capability_catalog:test")
    expect(output.catalog_snapshot_id).toBe("capability_catalog:test")
    expect(output.count).toBe(output.cards.length)
  })

  test("renders cards without any body content", () => {
    const rendered = renderSearchCards(capabilitySearch(capabilityCatalog, { query: "read source" }, fullAuthorization))
    expect(rendered).toContain("Matching DeepAgentCode capabilities")
    expect(rendered.includes("body_hash") || rendered.includes("body_ref")).toBe(false)
  })

  test("builds a valid tool definition with a query input schema", () => {
    const tool = makeCapabilitySearchTool({})
    const definition = Tool.definition("capability_search", tool)
    expect(definition.name).toBe("capability_search")
    expect(definition.description).toContain("capability catalog")
    const inputSchema = (definition as unknown as { inputSchema: { type: string; properties?: Record<string, unknown> } }).inputSchema
    expect(inputSchema.type).toBe("object")
    expect(inputSchema.properties?.["query"]).toBeTruthy()
  })
})