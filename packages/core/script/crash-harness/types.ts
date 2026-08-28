/**
 * C0-04 unified crash-point harness — shared vocabulary.
 *
 * The harness exposes three durable stores per scenario run, and judges
 * convergence from those stores ONLY (never from logs):
 *   - a fixture SQLite DB (with real WAL + transactions),
 *   - an external sentinel process's durable marker journal (fsync'd),
 *   - (tool-effect only) an append-only side-effect sink.
 *
 * These types carry no production imports; the harness is script+test only.
 */

/** POSIX signal used to reap a harness child. */
export type CrashSignal = "SIGTERM" | "SIGKILL"

/**
 * Deterministic verdict the restart oracle assigns after a kill + restart.
 *   - converged:    the durable stores agree on the intended final state.
 *   - divergent:    the stores provably contradict (e.g. sealed but not committed).
 *   - indeterminate: the stores cannot prove convergence (e.g. an unrecorded or
 *                    duplicate side effect with no idempotency proof).
 */
export type ScenarioOutcome = "converged" | "divergent" | "indeterminate"

/** The three fixture scenarios that are fully executable in this wave. */
export type ScenarioKind = "migration-receipt" | "tool-effect" | "terminal"

/** Sentinel journal marker phases. */
export type MarkerPhase = "begin" | "seal"

/** One durable record written by the external sentinel process. */
export interface SentinelMarker {
  /** Logical attempt id, stable across a crash + restart pair. */
  readonly attempt: string
  /** Marker phase (begin | seal). */
  readonly phase: MarkerPhase
  /** Epoch millis when the sentinel made it durable. */
  readonly at: number
}

/**
 * A single machine-readable crash point. Every crash point has a unique,
 * stable id of the form CRASH-<domain>-<nnn> where <domain> is one of the
 * design §15.2 commit boundaries and <nnn> is a zero-padded ordinal.
 */
export interface CrashPoint {
  readonly id: string
  readonly domain: string
  /** Short phase label inside the boundary, e.g. "commit-seal-gap". */
  readonly phase: string
  readonly description: string
  /** The fixture subject's suspend key used to stop right at this point. */
  readonly suspendKey: string
  /** True only when a runnable fixture scenario exists for this crash point (this wave: 3). */
  readonly fixture: boolean
  /** Deterministic oracle outcome at the exact boundary; only set for fixture crash points. */
  readonly expectedOutcome?: ScenarioOutcome
  /** Whether this is the "exact boundary" (the dangerous cross-store window) vs before it. */
  readonly exactBoundary: boolean
}

/** A design §15.2 commit-boundary domain with its crash points. */
export interface CrashDomain {
  readonly name: string
  readonly label: string
  readonly crashPoints: readonly CrashPoint[]
}

export interface RegistryValidation {
  readonly ok: boolean
  readonly issues: readonly string[]
}
