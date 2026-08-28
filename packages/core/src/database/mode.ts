export * as DatabaseMode from "./mode"

import { Context, Data } from "effect"
import type { BootstrapMode, BootstrapPhase, BootstrapState } from "./bootstrap"

// design §10.8 startup modes enforced at the BUSINESS layer (C1A-12):
//
//   - ready            : business admission + execution allowed.
//   - read_only_recovery: browse / search / export / backup / recovery-descriptor / maintenance
//                        allowed; provider + mutating tool REFUSED.
//   - blocked_schema   : shell / diagnostics / backup-restore guidance; business DB is NEVER mounted
//                        writable.
//
// The Bootstrap state machine already MODELS these modes; this module is the CORE typed enforcement
// so a business write path can never silently proceed when the store is not writable. The shell
// rendering (C6-05) is out of scope here. Every mode refusal carries a stable in-core code plus the
// frozen C0-03 wire code it maps to (consumed, never rewritten: src/contract/error-code.ts is
// read-only for this wave).

/** Stable in-core code for a mode refusal. */
export type ModeRefusedCode =
  | "ready"
  | "read_only_recovery_write_refused"
  | "read_only_recovery_provider_refused"
  | "blocked_schema_business_write_refused"

/** The frozen C0-03 wire code a mode refusal maps to (docs only; the registry is consumed, not changed). */
export type ModeRefusedWireCode = "permission_denied" | "service_unavailable"

export class DatabaseModeWriteRefused extends Data.TaggedError("Mode.DatabaseModeWriteRefused")<{
  readonly stableCode: ModeRefusedCode
  readonly wireCode: ModeRefusedWireCode
  readonly mode: BootstrapMode
  readonly phase: BootstrapPhase
}> {}

/** The mode snapshot a guard consults (produced by bootstrap and carried by the Database layer). */
export interface DatabaseModeSnapshot {
  readonly mode: BootstrapMode
  readonly ready: boolean
  readonly phase: BootstrapPhase
}

export class DatabaseModeContext extends Context.Service<
  DatabaseModeContext,
  DatabaseModeSnapshot
>()("@deepagent-code/core/database/DatabaseMode") {}

const fromState = (state: BootstrapState): DatabaseModeSnapshot => ({
  mode: state.mode,
  ready: state.ready,
  phase: state.phase,
})

const refuse = (snapshot: DatabaseModeSnapshot): DatabaseModeWriteRefused => {
  const blocked = snapshot.mode === "blocked_schema"
  return new DatabaseModeWriteRefused({
    stableCode: blocked ? "blocked_schema_business_write_refused" : "read_only_recovery_write_refused",
    wireCode: "service_unavailable",
    mode: snapshot.mode,
    phase: snapshot.phase,
  })
}

/**
 * THROW unless the store is writable (mode === 'ready' && ready). Call this at the top of every
 * business write path. In read_only_recovery / blocked_schema it refuses with a typed error so a
 * write can never silently proceed against a non-writable store (design §10.8).
 */
export const assertWritable = (snapshot: DatabaseModeSnapshot): void => {
  if (snapshot.mode !== "ready" || !snapshot.ready) throw refuse(snapshot)
}

/** `assertWritable` over a full BootstrapState. */
export const ensureReady = (state: BootstrapState): void => assertWritable(fromState(state))

/**
 * THROW unless provider / mutating-tool execution is allowed (mode === 'ready'). Call this before a
 * provider turn or mutating tool in a read_only_recovery / blocked_schema context. The refusal carries
 * the frozen C0-03 `permission_denied` wire code (a read-only maintenance store denies the effect).
 */
export const assertProviderAllowed = (snapshot: DatabaseModeSnapshot): void => {
  if (snapshot.mode !== "ready")
    throw new DatabaseModeWriteRefused({
      stableCode: "read_only_recovery_provider_refused",
      wireCode: "permission_denied",
      mode: snapshot.mode,
      phase: snapshot.phase,
    })
}

/** Snapshot from a BootstrapState (exposed for the Database layer to build its mode service). */
export const snapshotOf = (state: BootstrapState): DatabaseModeSnapshot => fromState(state)
