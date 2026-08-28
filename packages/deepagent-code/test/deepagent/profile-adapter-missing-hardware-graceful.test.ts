import { describe, it, expect } from "bun:test"
import { PAP } from "@/profile/pap"
import { ProfileAdapterRegistry } from "@/profile/adapters/index"
import { NcuAdapter, missingNcuProbe } from "@/profile/adapters/ncu"
import { NsysAdapter, missingNsysProbe } from "@/profile/adapters/nsys"
import { RocprofAdapter, missingRocprofProbe } from "@/profile/adapters/rocprof"
import { VtuneAdapter, missingVtuneProbe } from "@/profile/adapters/vtune"
import { PerfAdapter, missingPerfProbe } from "@/profile/adapters/perf"

/**
 * P2A graceful-missing tests.
 *
 * When a profiler binary is not installed (or no matching hardware is present),
 * adapters MUST:
 *   - Reject collect() with a clear Error message (not a Die/thrown panic).
 *   - NEVER throw an unhandled exception.
 *   - The registry must return { available: false, message } (not throw).
 *
 * §P2A spec requirement (c): "No corresponding hardware / tool not installed →
 * graceful prompt, never throw Die."
 */
describe("profile adapter graceful-missing: no GPU / tool not installed", () => {
  // —— ncu ——
  describe("ncu adapter (NVIDIA Nsight Compute)", () => {
    it("collect() rejects with a clear message when ncu binary is missing", async () => {
      const adapter = new NcuAdapter(missingNcuProbe)
      const target: PAP.ProfileTarget = { command: "./matmul" }
      let error: Error | undefined
      try {
        await adapter.collect(target)
      } catch (e) {
        error = e as Error
      }
      expect(error).toBeDefined()
      expect(error).toBeInstanceOf(Error)
      // Must mention what is missing — not a cryptic Die.
      expect(error!.message).toContain("ncu")
      expect(error!.message.toLowerCase()).toContain("not installed")
    })
  })

  // —— nsys ——
  describe("nsys adapter (NVIDIA Nsight Systems)", () => {
    it("collect() rejects with a clear message when nsys binary is missing", async () => {
      const adapter = new NsysAdapter(missingNsysProbe)
      const target: PAP.ProfileTarget = { command: "./cuda_app" }
      let error: Error | undefined
      try {
        await adapter.collect(target)
      } catch (e) {
        error = e as Error
      }
      expect(error).toBeDefined()
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toContain("nsys")
      expect(error!.message.toLowerCase()).toContain("not installed")
    })
  })

  // —— rocprof ——
  describe("rocprof adapter (AMD rocprofv3)", () => {
    it("collect() rejects with a clear message when rocprofv3 binary is missing", async () => {
      const adapter = new RocprofAdapter(missingRocprofProbe)
      const target: PAP.ProfileTarget = { command: "./hip_app" }
      let error: Error | undefined
      try {
        await adapter.collect(target)
      } catch (e) {
        error = e as Error
      }
      expect(error).toBeDefined()
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toContain("rocprofv3")
      expect(error!.message.toLowerCase()).toContain("not installed")
    })
  })

  // —— vtune ——
  describe("vtune adapter (Intel VTune)", () => {
    it("collect() rejects with a clear message when vtune binary is missing", async () => {
      const adapter = new VtuneAdapter(missingVtuneProbe)
      const target: PAP.ProfileTarget = { command: "./my_app" }
      let error: Error | undefined
      try {
        await adapter.collect(target)
      } catch (e) {
        error = e as Error
      }
      expect(error).toBeDefined()
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toContain("vtune")
      expect(error!.message.toLowerCase()).toContain("not installed")
    })
  })

  // —— perf ——
  describe("perf adapter (Linux perf)", () => {
    it("collect() rejects with a clear message when perf binary is missing", async () => {
      const adapter = new PerfAdapter(missingPerfProbe)
      const target: PAP.ProfileTarget = { command: "./bench" }
      let error: Error | undefined
      try {
        await adapter.collect(target)
      } catch (e) {
        error = e as Error
      }
      expect(error).toBeDefined()
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toContain("perf")
      expect(error!.message.toLowerCase()).toContain("not installed")
    })
  })

  // —— registry: all binaries missing ——
  describe("ProfileAdapterRegistry with all binaries missing", () => {
    const registry = ProfileAdapterRegistry.make(ProfileAdapterRegistry.missingProbe)

    it("resolveById('ncu') returns { available: false } with install guidance", () => {
      const result = registry.resolveById("ncu")
      expect(result.available).toBe(false)
      if (!result.available) {
        expect(result.message).toBeDefined()
        expect(result.message.length).toBeGreaterThan(0)
        // Should mention the adapter and how to install.
        expect(result.message.toLowerCase()).toMatch(/ncu|nvidia|nsight/)
      }
    })

    it("resolveById('nsys') returns { available: false } with message", () => {
      const result = registry.resolveById("nsys")
      expect(result.available).toBe(false)
      if (!result.available) {
        expect(result.message).toMatch(/nsys|nvidia/i)
      }
    })

    it("resolveById('rocprof') returns { available: false } with message", () => {
      const result = registry.resolveById("rocprof")
      expect(result.available).toBe(false)
      if (!result.available) {
        expect(result.message).toMatch(/rocprof|amd|rocm/i)
      }
    })

    it("resolveById('vtune') returns { available: false } with message", () => {
      const result = registry.resolveById("vtune")
      expect(result.available).toBe(false)
      if (!result.available) {
        expect(result.message).toMatch(/vtune|intel/i)
      }
    })

    it("resolveById('perf') returns { available: false } with message", () => {
      const result = registry.resolveById("perf")
      expect(result.available).toBe(false)
      if (!result.available) {
        expect(result.message).toMatch(/perf/i)
      }
    })

    it("resolve({ vendor: 'nvidia', domain: 'gpu_kernel' }) returns { available: false } (no GPU)", () => {
      const result = registry.resolve({ vendor: "nvidia", domain: "gpu_kernel" })
      expect(result.available).toBe(false)
      if (!result.available) {
        expect(result.message.length).toBeGreaterThan(0)
      }
    })

    it("resolve({ domain: 'cpu_sampling' }) returns { available: false } (perf not installed)", () => {
      const result = registry.resolve({ domain: "cpu_sampling" })
      expect(result.available).toBe(false)
    })

    it("available() returns empty array when all binaries are missing", () => {
      expect(registry.available()).toHaveLength(0)
    })

    it("resolveById('unknown') returns { available: false } gracefully", () => {
      const result = registry.resolveById("unknown-profiler")
      expect(result.available).toBe(false)
      if (!result.available) {
        expect(result.message).toContain("unknown-profiler")
      }
    })

    it("no exception is thrown for any resolution attempt", () => {
      // All of these must be graceful — no throws.
      expect(() => registry.resolveById("ncu")).not.toThrow()
      expect(() => registry.resolveById("nsys")).not.toThrow()
      expect(() => registry.resolveById("rocprof")).not.toThrow()
      expect(() => registry.resolveById("vtune")).not.toThrow()
      expect(() => registry.resolveById("perf")).not.toThrow()
      expect(() => registry.resolve({ vendor: "nvidia", domain: "gpu_kernel" })).not.toThrow()
      expect(() => registry.resolve({ vendor: "amd" })).not.toThrow()
      expect(() => registry.resolve({ domain: "cpu_hotspot" })).not.toThrow()
    })
  })

  // —— registry: selected binary installed ——
  describe("ProfileAdapterRegistry with only 'perf' installed", () => {
    const probe = ProfileAdapterRegistry.installedProbe(["perf"])
    const registry = ProfileAdapterRegistry.make(probe)

    it("resolveById('perf') returns { available: true }", () => {
      const result = registry.resolveById("perf")
      expect(result.available).toBe(true)
      if (result.available) {
        expect(result.adapter.id).toBe("perf")
      }
    })

    it("resolveById('ncu') returns { available: false } (binary not installed)", () => {
      const result = registry.resolveById("ncu")
      expect(result.available).toBe(false)
    })

    it("resolve({ domain: 'cpu_sampling' }) returns the perf adapter", () => {
      const result = registry.resolve({ domain: "cpu_sampling" })
      expect(result.available).toBe(true)
      if (result.available) {
        expect(result.adapter.id).toBe("perf")
        expect(result.adapter.domain).toBe("cpu_sampling")
      }
    })

    it("resolve({ vendor: 'nvidia' }) returns { available: false } (no NVIDIA tools)", () => {
      const result = registry.resolve({ vendor: "nvidia" })
      expect(result.available).toBe(false)
    })

    it("available() lists only perf", () => {
      const avail = registry.available()
      expect(avail).toHaveLength(1)
      expect(avail[0]!.id).toBe("perf")
    })
  })

  // —— privilege declarations ——
  describe("privilege declarations for R0 fail-closed gate", () => {
    it("ncu declares gpu_performance_counter privilege", () => {
      const adapter = new NcuAdapter(missingNcuProbe)
      expect(adapter.privileges.some((p) => p.kind === "gpu_performance_counter")).toBe(true)
    })

    it("nsys declares gpu_performance_counter privilege", () => {
      const adapter = new NsysAdapter(missingNsysProbe)
      expect(adapter.privileges.some((p) => p.kind === "gpu_performance_counter")).toBe(true)
    })

    it("rocprof declares rocm_profiling privilege", () => {
      const adapter = new RocprofAdapter(missingRocprofProbe)
      expect(adapter.privileges.some((p) => p.kind === "rocm_profiling")).toBe(true)
    })

    it("vtune declares no special privilege (userspace profiling)", () => {
      const adapter = new VtuneAdapter(missingVtuneProbe)
      // VTune hardware mode may need some privilege, but basic hotspot sampling
      // is user-space. No R0 privilege declared.
      expect(adapter.privileges).toHaveLength(0)
    })

    it("perf declares perf_event_paranoid privilege", () => {
      const adapter = new PerfAdapter(missingPerfProbe)
      const spec = adapter.privileges.find((p) => p.kind === "perf_event_paranoid")
      expect(spec).toBeDefined()
      expect(spec!.maxParanoid).toBeDefined()
      expect(spec!.maxParanoid).toBeLessThanOrEqual(2)
    })

    it("registry.privilegesFor('ncu') returns ncu privileges", () => {
      const registry = ProfileAdapterRegistry.make(ProfileAdapterRegistry.missingProbe)
      const privs = registry.privilegesFor("ncu")
      expect(privs.some((p) => p.kind === "gpu_performance_counter")).toBe(true)
    })
  })
})
