import { describe, expect, it } from "bun:test"
import { DebugAdapter } from "@/debug/adapter"

// D2 (S1-v3.5): GDB is contributed by the native/systems-programming domain
// pack — it must be available only when the pack has registered it, and absent
// otherwise. Core (the base set) stays clean. Probe is injected so the binary is
// treated as installed without touching the real system.

const installed = DebugAdapter.installedProbe(["gdb", "python3", "dlv", "lldb-dap"])

describe("D2 debug-adapter domain-pack GDB", () => {
  it("does not expose GDB before the domain pack registers it", () => {
    const registry = DebugAdapter.make(installed)
    expect(registry.has("gdb")).toBe(false)
    const res = registry.resolveById("gdb")
    expect(res.available).toBe(false)
    if (!res.available) expect(res.message).toContain("No debug adapter registered")
  })

  it("exposes GDB once the domain-pack hook registers it", () => {
    const registry = DebugAdapter.make(installed)
    DebugAdapter.registerGdb(registry)
    expect(registry.has("gdb")).toBe(true)

    const res = registry.resolveById("gdb")
    expect(res.available).toBe(true)
    if (res.available) {
      expect(res.spec.id).toBe("gdb")
      expect(res.spec.command).toContain("gdb")
      expect(res.spec.args).toEqual(["--interpreter=dap"])
      // GDB attaches via ptrace → declares the privilege for R0's gate.
      expect(res.spec.privileges.some((p) => p.kind === "ptrace")).toBe(true)
    }
  })

  it("supports the generic register() hook (a pack can add any adapter)", () => {
    const registry = DebugAdapter.make(installed)
    registry.register(DebugAdapter.GDB)
    expect(registry.has("gdb")).toBe(true)
    // C/C++ now resolves to lldb (base, registered first) and gdb is also listed.
    expect(registry.listForLanguage("cpp").map((a) => a.id)).toContain("gdb")
  })

  it("hides GDB again when the pack deactivates (unregister)", () => {
    const registry = DebugAdapter.make(installed)
    DebugAdapter.registerGdb(registry)
    expect(registry.has("gdb")).toBe(true)
    registry.unregister("gdb")
    expect(registry.has("gdb")).toBe(false)
    expect(registry.resolveById("gdb").available).toBe(false)
  })
})
