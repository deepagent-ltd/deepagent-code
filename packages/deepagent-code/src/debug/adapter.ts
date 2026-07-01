import { which } from "@deepagent-code/core/util/which"
import * as Log from "@deepagent-code/core/util/log"
import { RuntimeBase } from "@/runtime/base"
import type { AdapterSpec } from "./types"

const log = Log.create({ service: "debug.adapter" })

/**
 * D2 (S1-v3.5): the debug-adapter registry.
 *
 * Mirrors the LSP server registry (`lsp/server.ts`): a declarative adapter
 * `Info` definition + an on-demand "resolve the binary, build the launch spec"
 * step, with graceful-missing handling (binary absent → a clear "please install
 * X" message, NEVER a thrown Die — exactly how `lsp/server.ts` returns
 * `undefined` and logs "please install …").
 *
 * D1 owns the concrete `AdapterSpec` shape and consumes it in
 * `DebugService.start`; D2 PRODUCES those specs. D2 never speaks DAP and never
 * spawns anything itself — it only declares how to spawn and resolves the binary
 * location (control-plane only).
 *
 * Base set ships with core: debugpy (Python), delve (Go), lldb (C/C++/Rust/
 * Swift). Domain-pack adapters (e.g. GDB for a native/systems-programming pack)
 * register through `register()` when the pack activates, so the common core
 * stays clean and an adapter is only visible while its pack is active.
 */
export namespace DebugAdapter {
  // —— binary probe (injectable, mirrors RuntimeBase.make(probe)) ——————————————

  /**
   * Locates an adapter executable on PATH. Pure detection — no spawn, no side
   * effects. Injected so tests can simulate "installed" / "missing" without
   * touching the real system, exactly like R0 injects its `PrivilegeProbe`.
   */
  export interface BinaryProbe {
    /** Resolve an executable to its absolute path, or null when absent. Mirrors `which`. */
    readonly locate: (command: string) => string | null
  }

  /** Default probe: real PATH lookup via core's `which` (same as `lsp/server.ts`). */
  export const defaultProbe: BinaryProbe = { locate: (command) => which(command) }

  /** Test probe: only the named commands are "installed"; everything else is missing. */
  export const installedProbe = (installed: Iterable<string>): BinaryProbe => {
    const set = new Set(installed)
    return { locate: (command) => (set.has(command) ? `/usr/bin/${command}` : null) }
  }

  /** Test probe: every binary is missing (for graceful-missing assertions). */
  export const missingProbe: BinaryProbe = { locate: () => null }

  // —— adapter definition (declarative, mirrors lsp/server.ts `Info`) ———————————

  export interface Info {
    /** Stable adapter id, e.g. "debugpy" | "delve" | "lldb" | "gdb". */
    id: string
    /** Languages this adapter serves, lowercase, e.g. ["python"] / ["c","cpp","rust"]. */
    languages: string[]
    /** Privileges the adapter needs; declared here, enforced by R0's fail-closed gate. */
    privileges: RuntimeBase.PrivilegeSpec[]
    /** Transport to the adapter. D1 implements "stdio"; "socket" is reserved. */
    transport: "stdio" | "socket"
    /** Human-readable install guidance, surfaced when the binary is missing. */
    install: string
    /**
     * Resolve how to launch this adapter using the injected probe. Returns the
     * command + args, or `undefined` when the binary is not installed — the
     * registry then reports graceful-missing (no Die), same as an LSP server
     * `spawn` returning `undefined`.
     */
    spawn(probe: BinaryProbe): { command: string; args: string[] } | undefined
  }

  // —— base set (ships with core) ——————————————————————————————————————————————

  /**
   * Python — debugpy's DAP adapter, launched as `python -m debugpy.adapter`.
   * Pure-Python debugging needs no special OS privilege.
   */
  export const Debugpy: Info = {
    id: "debugpy",
    languages: ["python"],
    privileges: [],
    transport: "stdio",
    install: "Install debugpy: `pip install debugpy` (run inside the project's interpreter/venv).",
    spawn(probe) {
      const python = probe.locate("python3") ?? probe.locate("python")
      if (!python) return undefined
      return { command: python, args: ["-m", "debugpy.adapter"] }
    },
  }

  /**
   * Go — Delve in DAP mode (`dlv dap`). Delve manages its own tracing backend;
   * no ptrace privilege is declared at the DeepAgent layer.
   */
  export const Delve: Info = {
    id: "delve",
    languages: ["go"],
    privileges: [],
    transport: "stdio",
    install: "Install Delve: `go install github.com/go-delve/delve/cmd/dlv@latest` (provides `dlv dap`).",
    spawn(probe) {
      const dlv = probe.locate("dlv")
      if (!dlv) return undefined
      return { command: dlv, args: ["dap"] }
    },
  }

  /**
   * C / C++ / Rust / Swift — LLVM's `lldb-dap` (formerly `lldb-vscode`). Native
   * attach/inspection goes through ptrace, declared for R0's fail-closed gate.
   */
  export const Lldb: Info = {
    id: "lldb",
    languages: ["c", "cpp", "rust", "swift"],
    privileges: [{ kind: "ptrace", reason: "lldb attaches to and inspects the debuggee process via ptrace" }],
    transport: "stdio",
    install: "Install LLVM/LLDB providing `lldb-dap` (e.g. `brew install llvm`, or your distro's lldb package).",
    spawn(probe) {
      const bin = probe.locate("lldb-dap") ?? probe.locate("lldb-vscode")
      if (!bin) return undefined
      return { command: bin, args: [] }
    },
  }

  /** The adapters that ship with the common core (no domain pack required). */
  export const BASE_SET: readonly Info[] = [Debugpy, Delve, Lldb]

  // —— domain-pack contributed adapters ————————————————————————————————————————

  /**
   * GDB — `gdb --interpreter=dap` (GDB 14+). Contributed by a native/systems-
   * programming domain pack, NOT part of the base set: it is only visible after
   * a pack calls `register(GDB)` (see `registerGdb`). Like lldb, it declares the
   * ptrace privilege for R0.
   */
  export const GDB: Info = {
    id: "gdb",
    languages: ["c", "cpp", "rust"],
    privileges: [{ kind: "ptrace", reason: "gdb attaches to and inspects the debuggee process via ptrace" }],
    transport: "stdio",
    install: "Install GDB 14 or newer (provides `gdb --interpreter=dap`).",
    spawn(probe) {
      const gdb = probe.locate("gdb")
      if (!gdb) return undefined
      return { command: gdb, args: ["--interpreter=dap"] }
    },
  }

  // —— resolution result ————————————————————————————————————————————————————————

  /**
   * The outcome of resolving an adapter. Either an `AdapterSpec` ready for
   * `DebugService.start`, or a graceful "not installed / not registered" report
   * carrying a clear install message — never an exception.
   */
  export type Resolution =
    | { readonly available: true; readonly spec: AdapterSpec }
    | { readonly available: false; readonly adapterId: string; readonly message: string }

  // —— registry —————————————————————————————————————————————————————————————————

  /**
   * The adapter registry D3 (the `debug` tool) consumes. Pick an adapter by
   * language (or id), get back an `AdapterSpec` to hand to `DebugService.start`,
   * or a graceful-missing result. The binary probe is injected at construction
   * (mirrors `RuntimeBase.make(probe)`) so capability detection is testable.
   */
  export class Registry {
    private readonly adapters = new Map<string, Info>()
    constructor(private readonly probe: BinaryProbe) {}

    /** Domain-pack contribution hook: add (or replace) an adapter. Core stays clean. */
    register(info: Info): void {
      this.adapters.set(info.id, info)
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
    get(id: string): Info | undefined {
      return this.adapters.get(id)
    }

    /** All registered adapter definitions, in registration order. */
    list(): Info[] {
      return [...this.adapters.values()]
    }

    /** The first registered adapter serving a language, if any. */
    forLanguage(language: string): Info | undefined {
      const lang = language.toLowerCase()
      return this.list().find((a) => a.languages.includes(lang))
    }

    /** All registered adapters serving a language (e.g. both lldb and gdb for "cpp"). */
    listForLanguage(language: string): Info[] {
      const lang = language.toLowerCase()
      return this.list().filter((a) => a.languages.includes(lang))
    }

    /**
     * Capability/existence probe + spec build for one definition. Missing binary
     * → graceful `{ available:false, message }` (logged at info), never a throw.
     */
    private build(info: Info): Resolution {
      const launch = info.spawn(this.probe)
      if (!launch) {
        const message = `Debug adapter "${info.id}" is not available. ${info.install}`
        // Graceful missing — mirror lsp/server.ts's "please install …"; do NOT Die.
        log.info(message)
        return { available: false, adapterId: info.id, message }
      }
      return {
        available: true,
        spec: {
          id: info.id,
          languages: [...info.languages],
          command: launch.command,
          args: [...launch.args],
          privileges: info.privileges,
          transport: info.transport,
        },
      }
    }

    /** Resolve an `AdapterSpec` by adapter id. */
    resolveById(id: string): Resolution {
      const info = this.get(id)
      if (!info) {
        const message = `No debug adapter registered with id "${id}".`
        log.info(message)
        return { available: false, adapterId: id, message }
      }
      return this.build(info)
    }

    /** Resolve an `AdapterSpec` for a language (picks the first matching adapter). */
    resolve(language: string): Resolution {
      const info = this.forLanguage(language)
      if (!info) {
        const message = `No debug adapter registered for language "${language}".`
        log.info(message)
        return { available: false, adapterId: language, message }
      }
      return this.build(info)
    }
  }

  /**
   * Build a registry pre-loaded with the base set (debugpy/delve/lldb). Pass a
   * probe to control binary detection (defaults to real PATH lookup). Domain
   * packs add their adapters afterwards via `register()` / `registerGdb()`.
   */
  export const make = (probe: BinaryProbe = defaultProbe): Registry => {
    const registry = new Registry(probe)
    for (const info of BASE_SET) registry.register(info)
    return registry
  }

  /**
   * Domain-pack hook for the native/systems-programming pack: register GDB on
   * activation. Equivalent to `registry.register(DebugAdapter.GDB)`; provided as
   * a named entry point so a pack does not need to import the definition itself.
   */
  export const registerGdb = (registry: Registry): void => registry.register(GDB)
}
