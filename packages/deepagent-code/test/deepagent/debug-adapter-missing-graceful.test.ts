import { describe, expect, it } from "bun:test"
import { DebugAdapter } from "@/debug/adapter"

// D2 (S1-v3.5): when an adapter binary is missing, the registry reports a clear
// "please install X" message and NEVER throws Die — mirroring how lsp/server.ts
// returns undefined and logs "please install …" for a missing server.

describe("D2 debug-adapter graceful missing", () => {
  it("reports a clear install message instead of throwing when a binary is absent", () => {
    const registry = DebugAdapter.make(DebugAdapter.missingProbe)
    // The adapter is still registered (declared), it's just not installed.
    expect(registry.has("debugpy")).toBe(true)

    // resolveById must not throw — it returns a graceful result.
    let res: ReturnType<typeof registry.resolveById> | undefined
    expect(() => {
      res = registry.resolveById("debugpy")
    }).not.toThrow()
    expect(res!.available).toBe(false)
    if (res && !res.available) {
      expect(res.adapterId).toBe("debugpy")
      expect(res.message).toContain("not available")
      expect(res.message.toLowerCase()).toContain("install")
    }
  })

  it("resolves-by-language gracefully when the binary is missing", () => {
    const registry = DebugAdapter.make(DebugAdapter.missingProbe)
    let res: ReturnType<typeof registry.resolve> | undefined
    expect(() => {
      res = registry.resolve("go")
    }).not.toThrow()
    expect(res!.available).toBe(false)
    if (res && !res.available) {
      expect(res.message.toLowerCase()).toContain("delve")
    }
  })

  it("carries the per-adapter install hint for each base adapter", () => {
    const registry = DebugAdapter.make(DebugAdapter.missingProbe)
    const debugpy = registry.resolveById("debugpy")
    if (!debugpy.available) expect(debugpy.message).toContain("debugpy")
    const delve = registry.resolveById("delve")
    if (!delve.available) expect(delve.message).toContain("dlv")
    const lldb = registry.resolveById("lldb")
    if (!lldb.available) expect(lldb.message.toLowerCase()).toContain("lldb")
  })

  it("a partially-installed environment resolves only what exists", () => {
    // Only python is installed: debugpy resolves, delve/lldb are gracefully missing.
    const registry = DebugAdapter.make(DebugAdapter.installedProbe(["python3"]))
    expect(registry.resolveById("debugpy").available).toBe(true)
    expect(registry.resolveById("delve").available).toBe(false)
    expect(registry.resolveById("lldb").available).toBe(false)
  })
})
