import { describe, expect, it } from "bun:test"
import { DebugAdapter } from "@/debug/adapter"
import type { AdapterSpec } from "@/debug/types"

// D2 (S1-v3.5): the base set (debugpy / delve / lldb) is discoverable and each
// produces a valid AdapterSpec. We mock the existence probe (mirroring how R0
// injects its privilege probe) so the test never depends on a real binary.

// A probe reporting every base-set binary as installed.
const allInstalled = DebugAdapter.installedProbe([
  "python3",
  "python",
  "dlv",
  "lldb-dap",
  "lldb-vscode",
])

const isValidSpec = (spec: AdapterSpec) => {
  expect(typeof spec.id).toBe("string")
  expect(spec.id.length).toBeGreaterThan(0)
  expect(Array.isArray(spec.languages)).toBe(true)
  expect(spec.languages.length).toBeGreaterThan(0)
  expect(typeof spec.command).toBe("string")
  expect(spec.command.length).toBeGreaterThan(0)
  expect(Array.isArray(spec.args)).toBe(true)
  expect(Array.isArray(spec.privileges)).toBe(true)
  expect(spec.transport).toBe("stdio")
}

describe("D2 debug-adapter base set", () => {
  it("registers debugpy / delve / lldb out of the box", () => {
    const registry = DebugAdapter.make(allInstalled)
    expect(registry.has("debugpy")).toBe(true)
    expect(registry.has("delve")).toBe(true)
    expect(registry.has("lldb")).toBe(true)
    // GDB is a domain-pack adapter, not part of the base set.
    expect(registry.has("gdb")).toBe(false)
  })

  it("resolves a base adapter by id into a valid AdapterSpec", () => {
    const registry = DebugAdapter.make(allInstalled)
    for (const id of ["debugpy", "delve", "lldb"]) {
      const res = registry.resolveById(id)
      expect(res.available).toBe(true)
      if (res.available) {
        expect(res.spec.id).toBe(id)
        isValidSpec(res.spec)
      }
    }
  })

  it("resolves an adapter by language", () => {
    const registry = DebugAdapter.make(allInstalled)
    const py = registry.resolve("python")
    expect(py.available).toBe(true)
    if (py.available) expect(py.spec.id).toBe("debugpy")

    const go = registry.resolve("go")
    expect(go.available).toBe(true)
    if (go.available) expect(go.spec.id).toBe("delve")

    // lldb serves several systems languages; lookup is case-insensitive.
    for (const lang of ["c", "cpp", "rust", "swift", "CPP"]) {
      const res = registry.resolve(lang)
      expect(res.available).toBe(true)
      if (res.available) expect(res.spec.id).toBe("lldb")
    }
  })

  it("declares the ptrace privilege on lldb (handed to R0's gate)", () => {
    const registry = DebugAdapter.make(allInstalled)
    const res = registry.resolveById("lldb")
    expect(res.available).toBe(true)
    if (res.available) {
      expect(res.spec.privileges.some((p) => p.kind === "ptrace")).toBe(true)
    }
    // Pure-Python debugging needs no OS privilege.
    const py = registry.resolveById("debugpy")
    if (py.available) expect(py.spec.privileges.length).toBe(0)
  })

  it("builds debugpy as `python -m debugpy.adapter`", () => {
    const registry = DebugAdapter.make(allInstalled)
    const res = registry.resolveById("debugpy")
    expect(res.available).toBe(true)
    if (res.available) {
      expect(res.spec.command).toContain("python")
      expect(res.spec.args).toEqual(["-m", "debugpy.adapter"])
    }
  })

  it("builds delve as `dlv dap`", () => {
    const registry = DebugAdapter.make(allInstalled)
    const res = registry.resolveById("delve")
    expect(res.available).toBe(true)
    if (res.available) expect(res.spec.args).toEqual(["dap"])
  })
})
