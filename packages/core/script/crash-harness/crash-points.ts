export * as CrashPoints from "./crash-points"

// C0-04 - crash-point registry (freeze).
// Every crash point has a unique stable id CRASH-<domain>-<nnn>, tied to one
// production commit boundary. The harness and the restart oracle classify a
// kill at a boundary as converged | indeterminate | divergent using the
// fixture DB + an external sentinel only (never logs).

export interface CrashPoint {
  readonly id: string
  readonly domain: string
  /** Human description of the boundary in the state machine. */
  readonly boundary: string
  /** What the oracle expects after a kill at this boundary then restart. */
  readonly expected: "converged" | "indeterminate" | "divergent"
}

export const CRASH_POINTS: readonly CrashPoint[] = [
  { id: "CRASH-migration-receipt-001", domain: "migration", boundary: "after migration body run, before receipt commit", expected: "indeterminate" },
  { id: "CRASH-migration-receipt-002", domain: "migration", boundary: "after update-run journal write, before body run", expected: "converged" },
  { id: "CRASH-session-admission-001", domain: "session", boundary: "after session_input insert, before activity create", expected: "converged" },
  { id: "CRASH-provider-attempt-001", domain: "provider", boundary: "after attempt receipt insert, before physical dispatch", expected: "converged" },
  { id: "CRASH-provider-attempt-002", domain: "provider", boundary: "after physical dispatch, before terminal update", expected: "indeterminate" },
  { id: "CRASH-tool-effect-001", domain: "tool", boundary: "after tool effect permit, before effect receipt", expected: "indeterminate" },
  { id: "CRASH-event-outbox-001", domain: "event", boundary: "after event insert into outbox, before publisher confirm", expected: "indeterminate" },
  { id: "CRASH-projector-001", domain: "projector", boundary: "after projection reads snapshot, before cursor advance", expected: "converged" },
  { id: "CRASH-recovery-command-001", domain: "recovery", boundary: "after recovery descriptor insert, before command execution", expected: "converged" },
] as const

export function crashPoint(id: string): CrashPoint | undefined {
  return CRASH_POINTS.find((point) => point.id === id)
}

export function assertUniqueCrashPointIds(): void {
  const ids = CRASH_POINTS.map((point) => point.id)
  if (new Set(ids).size !== ids.length) throw new Error("duplicate crash point id")
  for (const point of CRASH_POINTS) {
    if (!/^CRASH-[a-z0-9-]+-[0-9]{3}$/.test(point.id)) {
      throw new Error("crash point id shape violation: " + point.id)
    }
  }
}
