import { which } from "@deepagent-code/core/util/which"
import * as Log from "@deepagent-code/core/util/log"
import { PAP } from "@/profile/pap"
import { RuntimeBase } from "@/runtime/base"

import { NcuAdapter } from "./ncu"
import { NsysAdapter } from "./nsys"
import { RocprofAdapter } from "./rocprof"
import { VtuneAdapter } from "./vtune"
import { PerfAdapter } from "./perf"

// Re-export individual adapter factories and probes for convenience.
export * from "./ncu"
export * from "./nsys"
export * from "./rocprof"
export * from "./vtune"
export * from "./perf"

const log = Log.create({ service: "profile.adapter-registry" })

/**
 * P2A (S1-v3.5): profiler adapter registry.
 *
 * Mirrors `src/debug/adapter.ts` (`DebugAdapter.Registry`):
 *   - Declarative adapter registration / lookup.
 *   - Injectable binary probe (`BinaryProbe`) for testable capability detection.
 *   - Graceful-missing: missing binary or no GPU → clear message, NEVER Die.
 *   - Privilege declarations forwarded to R0's fail-closed gate.
 *
 * P3A (the `profile` tool) calls `resolve({ vendor?, domain? })` to auto-select
 * an adapter by hardware/language, or `resolveById("ncu")` to pick explicitly.
 * The returned `PAP.ProfileAdapter` implements collect→parse→normalize.
 *
 * Domain packs contribute adapters via `register()`:
 *   - CUDA pack: registers ncu + nsys
 *   - ROCm pack: registers rocprof
 *   - Intel pack: registers vtune
 *   - Core: registers perf (CPU-generic, available everywhere perf is installed)
 */
export namespace ProfileAdapterRegistry {
  // —— binary probe (injectable, mirrors DebugAdapter.BinaryProbe) ——————————

  /**
   * Locates a profiler executable on PATH. Pure detection — no spawn, no side
   * effects. Injected so tests can simulate "installed" / "missing" without
   * touching the real system.
   */
  export interface BinaryProbe {
    /** Resolve an executable to its absolute path, or null when absent. */
    readonly locate: (command: string) => string | null
  }

  /** Default probe: real PATH lookup via core's `which`. */
  export const defaultProbe: BinaryProbe = { locate: (command) => which(command) }

  /** Test probe: only the named commands are "installed"; everything else is missing. */
  export const installedProbe = (installed: Iterable<string>): BinaryProbe => {
    const set = new Set(installed)
    return { locate: (command) => (set.has(command) ? `/usr/local/bin/${command}` : null) }
  }

  /** Test probe: every binary is missing (for graceful-missing assertions). */
  export const missingProbe: BinaryProbe = { locate: () => null }

  // —— resolution result ————————————————————————————————————————————————————

  /**
   * The outcome of resolving an adapter. Either a `PAP.ProfileAdapter` ready for
   * collect→parse→normalize, or a graceful "not installed / not registered" report
   * carrying a clear install message — never an exception.
   */
  export type Resolution =
    | { readonly available: true; readonly adapter: PAP.ProfileAdapter }
    | { readonly available: false; readonly adapterId: string; readonly message: string }

  // —— registry ————————————————————————————————————————————————————————————

  /**
   * The adapter registry P3A (the `profile` tool) consumes.
   *
   * Auto-select by `{ vendor, domain }` or pick by id. Each registered adapter
   * was constructed with an injected `BinaryProbe`; the registry checks the binary
   * is present before returning it (graceful-missing if absent).
   *
   * The binary probe is injected at construction (mirrors `RuntimeBase.make(probe)`)
   * so capability detection is fully testable without real hardware.
   */
  export class Registry {
    private readonly adapters = new Map<string, PAP.ProfileAdapter>()

    constructor(private readonly probe: BinaryProbe) {}

    /** Register (or replace) an adapter. Domain-pack contribution hook. */
    register(adapter: PAP.ProfileAdapter): void {
      this.adapters.set(adapter.id, adapter)
    }

    /** Remove an adapter (e.g. when a domain pack deactivates). */
    unregister(id: string): void {
      this.adapters.delete(id)
    }

    /** Whether an adapter id is currently registered. */
    has(id: string): boolean {
      return this.adapters.has(id)
    }

    /** The adapter definition for an id, if registered. */
    get(id: string): PAP.ProfileAdapter | undefined {
      return this.adapters.get(id)
    }

    /** All registered adapters, in registration order. */
    list(): PAP.ProfileAdapter[] {
      return [...this.adapters.values()]
    }

    /**
     * All registered adapters matching vendor + domain criteria.
     * Either field may be omitted to match all.
     */
    listFor(criteria: { vendor?: PAP.Vendor; domain?: PAP.Domain }): PAP.ProfileAdapter[] {
      return this.list().filter((a) => {
        if (criteria.vendor && a.vendor !== criteria.vendor) return false
        if (criteria.domain && a.domain !== criteria.domain) return false
        return true
      })
    }

    /**
     * Check whether the profiler binary for an adapter is installed.
     * Maps adapter ids to their primary binary names.
     */
    private isBinaryPresent(adapterId: string): boolean {
      const binaryNames: Record<string, string[]> = {
        ncu: ["ncu"],
        nsys: ["nsys"],
        rocprof: ["rocprofv3", "rocprof"],
        vtune: ["vtune"],
        perf: ["perf"],
      }
      const names = binaryNames[adapterId] ?? [adapterId]
      return names.some((n) => this.probe.locate(n) !== null)
    }

    /**
     * Resolve a `PAP.ProfileAdapter` by adapter id.
     * Missing binary → graceful `{ available:false, message }` (logged at info), never a throw.
     */
    resolveById(id: string): Resolution {
      const adapter = this.get(id)
      if (!adapter) {
        const message = `No profiler adapter registered with id "${id}".`
        log.info(message)
        return { available: false, adapterId: id, message }
      }
      if (!this.isBinaryPresent(id)) {
        const message = buildMissingMessage(id)
        log.info(message)
        return { available: false, adapterId: id, message }
      }
      return { available: true, adapter }
    }

    /**
     * Resolve the best adapter for a vendor + domain combination.
     * Picks the first registered adapter matching both criteria whose binary is present.
     * Graceful-missing when none is found or no binary present.
     */
    resolve(criteria: { vendor?: PAP.Vendor; domain?: PAP.Domain }): Resolution {
      const candidates = this.listFor(criteria)
      if (!candidates.length) {
        const message = `No profiler adapter registered for vendor="${criteria.vendor ?? "*"}" domain="${criteria.domain ?? "*"}".`
        log.info(message)
        return { available: false, adapterId: `${criteria.vendor ?? "*"}/${criteria.domain ?? "*"}`, message }
      }
      for (const adapter of candidates) {
        if (this.isBinaryPresent(adapter.id)) {
          return { available: true, adapter }
        }
      }
      const ids = candidates.map((a) => a.id).join(", ")
      const message = `Profiler binaries for [${ids}] are not installed. ${buildMissingMessage(candidates[0]!.id)}`
      log.info(message)
      return { available: false, adapterId: candidates[0]!.id, message }
    }

    /**
     * Enumerate all available (binary-present) adapters.
     * Useful for P3A's "which profilers can I use right now?" capability check.
     */
    available(): PAP.ProfileAdapter[] {
      return this.list().filter((a) => this.isBinaryPresent(a.id))
    }

    /**
     * Aggregate privilege declarations from all registered adapters.
     * P3A passes these to R0's privilege gate before dispatching a collect operation.
     */
    privilegesFor(adapterId: string): readonly RuntimeBase.PrivilegeSpec[] {
      return this.adapters.get(adapterId)?.privileges ?? []
    }
  }

  // —— install guidance ————————————————————————————————————————————————————

  const INSTALL_GUIDANCE: Record<string, string> = {
    ncu: "Install NVIDIA Nsight Compute: https://developer.nvidia.com/nsight-compute (part of CUDA Toolkit).",
    nsys: "Install NVIDIA Nsight Systems: https://developer.nvidia.com/nsight-systems (part of CUDA Toolkit).",
    rocprof: "Install ROCm profiling: `sudo apt install rocprofiler-sdk` or see https://rocm.docs.amd.com.",
    vtune: "Install Intel VTune Profiler (Intel oneAPI Base Toolkit): https://www.intel.com/content/www/us/en/developer/tools/oneapi/vtune-profiler.html.",
    perf: "Install Linux perf: `sudo apt install linux-perf` or `sudo apt install linux-tools-$(uname -r)`.",
  }

  function buildMissingMessage(adapterId: string): string {
    const guidance = INSTALL_GUIDANCE[adapterId] ?? `Install the profiler tool for adapter "${adapterId}".`
    return `Profiler "${adapterId}" is not available: binary not found on PATH. ${guidance}`
  }

  // —— base set (adapters that ship with core) ————————————————————————————

  /**
   * Build a registry pre-loaded with all five built-in adapters (ncu/nsys/rocprof/vtune/perf).
   * The probe controls binary detection; defaults to real PATH lookup.
   *
   * Domain packs may add their own adapters after construction via `register()`.
   */
  export const make = (probe: BinaryProbe = defaultProbe): Registry => {
    const registry = new Registry(probe)
    // Each adapter is constructed with its own BinaryProbe adapter derived from the registry probe.
    // We mirror the debug adapter pattern: each adapter class accepts a BinaryProbe at construction.
    const adapterProbe = {
      locate: (cmd: string) => probe.locate(cmd),
    }
    registry.register(new NcuAdapter(adapterProbe))
    registry.register(new NsysAdapter(adapterProbe))
    registry.register(new RocprofAdapter(adapterProbe))
    registry.register(new VtuneAdapter(adapterProbe))
    registry.register(new PerfAdapter(adapterProbe))
    return registry
  }

  // —— domain-pack contribution hooks ——————————————————————————————————————

  /**
   * CUDA domain-pack hook: register ncu + nsys on pack activation.
   * Equivalent to calling `registry.register(ncu)` + `registry.register(nsys)`.
   */
  export const registerCudaAdapters = (registry: Registry, probe: BinaryProbe = defaultProbe): void => {
    registry.register(new NcuAdapter(probe))
    registry.register(new NsysAdapter(probe))
  }

  /**
   * ROCm domain-pack hook: register rocprofv3 on pack activation.
   */
  export const registerRocmAdapters = (registry: Registry, probe: BinaryProbe = defaultProbe): void => {
    registry.register(new RocprofAdapter(probe))
  }

  /**
   * Intel domain-pack hook: register VTune on pack activation.
   */
  export const registerIntelAdapters = (registry: Registry, probe: BinaryProbe = defaultProbe): void => {
    registry.register(new VtuneAdapter(probe))
  }
}
