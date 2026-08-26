import { Schema } from "effect"
import type { RuntimeBase } from "@/runtime/base"

/**
 * D1 (S1-v3.5): shared types for the DAP (Debug Adapter Protocol) layer.
 *
 * This module is the contract surface between D1 (this DAP client + DebugService)
 * and D2 (the debug adapter registry: debugpy / delve / lldb / GDB). D2 owns the
 * concrete `AdapterSpec` values; D1 only consumes them. Keeping the type here lets
 * both sides import without a dependency cycle.
 *
 * Architecture铁律: DeepAgent is control-plane only. Nothing in this layer
 * reimplements a debugger — breakpoints / stepping / evaluation are all delegated
 * to the adapter process over standard DAP.
 */

/**
 * How D2 declares a debug adapter to the DebugService. The service spawns the
 * adapter from `command`/`args`, drives it over DAP, and asks R0 to enforce the
 * declared `privileges` (ptrace etc.) fail-closed before the session starts.
 */
export interface AdapterSpec {
  /** Stable adapter id, e.g. "debugpy" | "delve" | "lldb" | "gdb". */
  id: string
  /** Languages this adapter serves, e.g. ["python"] / ["c", "cpp", "rust"]. */
  languages: string[]
  /** Executable to spawn. */
  command: string
  /** Arguments passed to `command`. */
  args: string[]
  /** Privileges the adapter needs; handed to R0's fail-closed privilege gate. */
  privileges: RuntimeBase.PrivilegeSpec[]
  /** Transport to the adapter. D1 implements "stdio"; "socket" is reserved for D2+. */
  transport: "stdio" | "socket"
}

// —— DAP wire messages (Content-Length framed JSON; see DAP base protocol) ————

export interface DapRequest {
  seq: number
  type: "request"
  command: string
  arguments?: unknown
}

export interface DapResponse {
  seq: number
  type: "response"
  request_seq: number
  success: boolean
  command: string
  message?: string
  body?: any
}

export interface DapEvent {
  seq: number
  type: "event"
  event: string
  body?: any
}

export type DapMessage = DapRequest | DapResponse | DapEvent

// —— DebugService session state (finite + serializable, for frontend/audit) ————

/**
 * The finite session lifecycle. Transitions:
 *   initializing → initialized → configuring → running ⇄ stopped → terminated
 * with `exited` (adapter reported exit) and `failed` (error) as terminal states.
 */
export const SessionStatus = Schema.Literals([
  "initializing",
  "initialized",
  "configuring",
  "running",
  "stopped",
  "terminated",
  "exited",
  "failed",
])
export type SessionStatus = typeof SessionStatus.Type

export const SourceBreakpoints = Schema.Struct({
  source: Schema.String,
  lines: Schema.Array(Schema.Number),
})
export type SourceBreakpoints = typeof SourceBreakpoints.Type

/**
 * The serializable snapshot of a debug session. Plain JSON — no methods, no class
 * instances — so it can be shipped to the frontend and written to an audit/evidence
 * artifact verbatim (D4).
 */
export const SessionState = Schema.Struct({
  id: Schema.String,
  adapterId: Schema.String,
  status: SessionStatus,
  /** The thread the last `stopped` event referenced (DAP threadId). */
  threadId: Schema.optional(Schema.Number),
  /** Why the program last stopped (e.g. "breakpoint" | "step" | "exception"). */
  stoppedReason: Schema.optional(Schema.String),
  /** Breakpoints set this session, by source. */
  breakpoints: Schema.Array(SourceBreakpoints),
  /** Exit code if the adapter reported `exited`. */
  exitCode: Schema.optional(Schema.Number),
  /** Last error message if status is "failed". */
  error: Schema.optional(Schema.String),
  /** Isolation worktree directory the adapter ran in (undefined = main dir). */
  workdir: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type SessionState = typeof SessionState.Type
