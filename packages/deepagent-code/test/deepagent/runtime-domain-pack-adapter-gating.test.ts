import { describe, it, expect } from "bun:test"
import { DebugAdapter } from "../../src/debug/adapter"
import { ProfileAdapterRegistry } from "../../src/profile/adapters"

// RX (S1-v3.5): domain-pack adapter gating.
//
// Verifies that:
//   - Debug adapters (GDB) are absent before a domain pack registers them and
//     present after registration; removed again on unregister.
//   - Profile adapters (ncu/nsys — "CUDA pack") follow the same lifecycle via
//     ProfileAdapterRegistry.
//
// Uses injected probes so tests run without real GDB/ncu/nsys binaries.

// ——— debug adapter gating ————————————————————————————————————————————————————

describe("RX debug adapter domain-pack gating (DebugAdapter.Registry)", () => {
  it("base set contains debugpy/delve/lldb but NOT gdb", () => {
    const registry = DebugAdapter.make(DebugAdapter.installedProbe(["python3", "dlv", "lldb-dap"]))
    expect(registry.has("debugpy")).toBe(true)
    expect(registry.has("delve")).toBe(true)
    expect(registry.has("lldb")).toBe(true)
    // GDB is NOT in the base set — it requires a domain pack
    expect(registry.has("gdb")).toBe(false)
  })

  it("registerGdb makes GDB available", () => {
    const registry = DebugAdapter.make(DebugAdapter.installedProbe(["gdb"]))
    expect(registry.has("gdb")).toBe(false)  // not yet

    // Domain pack activates → registers GDB
    DebugAdapter.registerGdb(registry)

    expect(registry.has("gdb")).toBe(true)
    expect(registry.get("gdb")).toBeDefined()
    expect(registry.get("gdb")!.id).toBe("gdb")
  })

  it("GDB resolves to an AdapterSpec when the binary is present", () => {
    const registry = DebugAdapter.make(DebugAdapter.installedProbe(["gdb"]))
    DebugAdapter.registerGdb(registry)

    const resolution = registry.resolveById("gdb")
    expect(resolution.available).toBe(true)
    if (resolution.available) {
      expect(resolution.spec.id).toBe("gdb")
      expect(resolution.spec.command).toContain("gdb")
      expect(resolution.spec.args).toContain("--interpreter=dap")
    }
  })

  it("GDB resolves graceful-missing when the binary is absent", () => {
    const registry = DebugAdapter.make(DebugAdapter.missingProbe)
    DebugAdapter.registerGdb(registry)

    const resolution = registry.resolveById("gdb")
    expect(resolution.available).toBe(false)
    if (!resolution.available) {
      expect(resolution.message).toContain("gdb")
      // Must give an install hint, not just "not found"
      expect(resolution.message.length).toBeGreaterThan(10)
    }
  })

  it("unregister removes GDB from the registry", () => {
    const registry = DebugAdapter.make(DebugAdapter.installedProbe(["gdb"]))
    DebugAdapter.registerGdb(registry)
    expect(registry.has("gdb")).toBe(true)

    // Domain pack deactivates → unregisters GDB
    registry.unregister("gdb")

    expect(registry.has("gdb")).toBe(false)
    const resolution = registry.resolveById("gdb")
    expect(resolution.available).toBe(false)
    if (!resolution.available) {
      expect(resolution.message).toContain("No debug adapter registered with id")
    }
  })

  it("GDB adapter declares ptrace privilege (for R0 fail-closed gate)", () => {
    expect(DebugAdapter.GDB.privileges.some((p) => p.kind === "ptrace")).toBe(true)
  })

  it("registering multiple adapters then removing one leaves others intact", () => {
    const registry = DebugAdapter.make(DebugAdapter.installedProbe(["gdb", "python3", "dlv"]))
    DebugAdapter.registerGdb(registry)

    expect(registry.has("gdb")).toBe(true)
    expect(registry.has("debugpy")).toBe(true)
    expect(registry.has("delve")).toBe(true)

    registry.unregister("gdb")

    expect(registry.has("gdb")).toBe(false)
    // Base set still intact
    expect(registry.has("debugpy")).toBe(true)
    expect(registry.has("delve")).toBe(true)
  })
})

// ——— profile adapter gating ——————————————————————————————————————————————————

describe("RX profile adapter domain-pack gating (ProfileAdapterRegistry)", () => {
  it("empty registry has no adapters", () => {
    const registry = new ProfileAdapterRegistry.Registry(ProfileAdapterRegistry.missingProbe)
    expect(registry.list().length).toBe(0)
    expect(registry.has("ncu")).toBe(false)
    expect(registry.has("perf")).toBe(false)
  })

  it("make() pre-loads all five built-in adapters", () => {
    const registry = ProfileAdapterRegistry.make(ProfileAdapterRegistry.missingProbe)
    // All five registered (though binaries are missing — that's checked at resolve time)
    expect(registry.has("ncu")).toBe(true)
    expect(registry.has("nsys")).toBe(true)
    expect(registry.has("rocprof")).toBe(true)
    expect(registry.has("vtune")).toBe(true)
    expect(registry.has("perf")).toBe(true)
  })

  it("registerCudaAdapters registers ncu + nsys on a blank registry", () => {
    const probe = ProfileAdapterRegistry.installedProbe(["ncu", "nsys"])
    const registry = new ProfileAdapterRegistry.Registry(probe)
    expect(registry.has("ncu")).toBe(false)
    expect(registry.has("nsys")).toBe(false)

    // CUDA domain pack activates
    ProfileAdapterRegistry.registerCudaAdapters(registry, probe)

    expect(registry.has("ncu")).toBe(true)
    expect(registry.has("nsys")).toBe(true)
  })

  it("ncu resolves as available when binary is installed", () => {
    const probe = ProfileAdapterRegistry.installedProbe(["ncu"])
    const registry = new ProfileAdapterRegistry.Registry(probe)
    ProfileAdapterRegistry.registerCudaAdapters(registry, probe)

    const resolution = registry.resolveById("ncu")
    expect(resolution.available).toBe(true)
    if (resolution.available) {
      expect(resolution.adapter.id).toBe("ncu")
      expect(resolution.adapter.vendor).toBe("nvidia")
      expect(resolution.adapter.domain).toBe("gpu_kernel")
    }
  })

  it("ncu resolves graceful-missing when binary absent", () => {
    const registry = new ProfileAdapterRegistry.Registry(ProfileAdapterRegistry.missingProbe)
    ProfileAdapterRegistry.registerCudaAdapters(registry, ProfileAdapterRegistry.missingProbe)

    const resolution = registry.resolveById("ncu")
    expect(resolution.available).toBe(false)
    if (!resolution.available) {
      expect(resolution.message).toContain("ncu")
    }
  })

  it("unregister removes ncu from the registry", () => {
    const probe = ProfileAdapterRegistry.installedProbe(["ncu", "nsys"])
    const registry = new ProfileAdapterRegistry.Registry(probe)
    ProfileAdapterRegistry.registerCudaAdapters(registry, probe)
    expect(registry.has("ncu")).toBe(true)

    // Domain pack deactivates → unregister ncu
    registry.unregister("ncu")

    expect(registry.has("ncu")).toBe(false)
    expect(registry.has("nsys")).toBe(true)  // nsys still present
  })

  it("registerRocmAdapters registers rocprof", () => {
    const probe = ProfileAdapterRegistry.installedProbe(["rocprofv3"])
    const registry = new ProfileAdapterRegistry.Registry(probe)
    expect(registry.has("rocprof")).toBe(false)

    ProfileAdapterRegistry.registerRocmAdapters(registry, probe)

    expect(registry.has("rocprof")).toBe(true)
    const r = registry.resolveById("rocprof")
    expect(r.available).toBe(true)
    if (r.available) {
      expect(r.adapter.vendor).toBe("amd")
    }
  })

  it("unregistered adapter resolves to graceful-missing with a clear message", () => {
    const registry = new ProfileAdapterRegistry.Registry(ProfileAdapterRegistry.missingProbe)
    const resolution = registry.resolveById("vtune")
    expect(resolution.available).toBe(false)
    if (!resolution.available) {
      expect(resolution.adapterId).toBe("vtune")
      expect(resolution.message).toContain("vtune")
    }
  })

  it("ncu adapter declares gpu_performance_counter privilege (for R0 gate)", () => {
    const probe = ProfileAdapterRegistry.installedProbe(["ncu"])
    const registry = ProfileAdapterRegistry.make(probe)
    const ncu = registry.get("ncu")!
    expect(ncu.privileges.some((p) => p.kind === "gpu_performance_counter")).toBe(true)
  })

  it("cross-domain: CUDA and ROCm adapters coexist in the same registry", () => {
    const probe = ProfileAdapterRegistry.installedProbe(["ncu", "nsys", "rocprofv3"])
    const registry = new ProfileAdapterRegistry.Registry(probe)
    ProfileAdapterRegistry.registerCudaAdapters(registry, probe)
    ProfileAdapterRegistry.registerRocmAdapters(registry, probe)

    expect(registry.has("ncu")).toBe(true)
    expect(registry.has("nsys")).toBe(true)
    expect(registry.has("rocprof")).toBe(true)

    // Can resolve each independently
    expect(registry.resolveById("ncu").available).toBe(true)
    expect(registry.resolveById("rocprof").available).toBe(true)
  })
})
