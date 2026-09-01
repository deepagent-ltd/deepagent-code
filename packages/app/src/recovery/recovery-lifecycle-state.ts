import type { RecoveryCommandResult } from "../maintenance/types"

// C6-11 — recovery/session dynamic lifecycle, modeled as a pure per-session state machine
// (fixture-testable, no DOM/server). Acceptance semantics:
//   - session switch: pending + inflight belong to the SESSION, never to the shell — switching
//     keeps the cursor and unfinished command; the dock re-renders from the per-session state.
//   - sleep/wake: wake resumes from the last cursor (idempotent refresh; no duplicate result).
//   - quit 中断 (dispose with an in-flight command): the in-flight result is discarded with the
//     disposal (typed notice), no zombie timers/loops survive.
//   - server 重连: paused → resume from the last cursor (no data loss, no feedback loop).
//   - cross-session isolation: one Session's blocked/queued command never locks another Session.
//   - real `session.execution.*` events (SessionEvent.Execution) drive a dedicated per-session
//     execution track (serial: one turn at a time; terminal event closes it, a missed start is
//     closed as superseded by the next started — never a stuck "running"). A terminal event with
//     NO open slot (the page mounted after `started`, or a stream gap) synthesizes the slot from
//     the terminal event itself, so a duplicated/missed window never silently drops an outcome.

export type RecoveryCommandRef = { readonly commandId: string; readonly attemptId: string }

export const EXECUTION_INTERRUPT_REASONS = ["user", "shutdown", "superseded"] as const
export type ExecutionInterruptReason = (typeof EXECUTION_INTERRUPT_REASONS)[number]

export type LifecycleEvent =
  | { type: "session-switch"; sessionID: string; cursor: number }
  | { type: "command-started"; sessionID: string; command: RecoveryCommandRef }
  | { type: "command-completed"; sessionID: string; commandId: string; result: RecoveryCommandResult }
  | { type: "command-failed"; sessionID: string; commandId: string; error: unknown }
  // Real `SessionEvent.Execution.*` events (core session/event.ts) mapped 1:1. The execution
  // track is per-session and serial (one turn at a time), kept separate from the recovery
  // command queue: `started` opens a typed execution slot, the terminal event closes it.
  | { type: "execution-started"; sessionID: string; timestamp: number }
  | { type: "execution-succeeded"; sessionID: string; timestamp: number }
  | { type: "execution-failed"; sessionID: string; timestamp: number; error: unknown }
  | { type: "execution-interrupted"; sessionID: string; timestamp: number; reason: ExecutionInterruptReason }
  | { type: "sleep" }
  | { type: "wake" }
  | { type: "disconnect" }
  | { type: "reconnect" }
  | { type: "quit" }

export type SessionExecutionRecord = {
  readonly ref: RecoveryCommandRef
  readonly state: "succeeded" | "failed" | "interrupted"
  readonly at: number
  readonly error?: unknown
  readonly reason?: ExecutionInterruptReason
  /** 1-based turn number (the serial execution counter). */
  readonly number: number
}

export type SessionExecutionSlot = {
  readonly ref: RecoveryCommandRef
  readonly startedAt: number
  /** 1-based turn number (the serial execution counter). */
  readonly number: number
}

export type ExecutionStatusView =
  | { readonly kind: "running"; readonly number: number }
  | { readonly kind: "terminal"; readonly state: "succeeded" | "failed" | "interrupted"; readonly number: number }

/** The dock-facing view of the current session's execution track (open turn wins; a closed turn
 * surfaces as the last terminal outcome). Undefined = no turn observed yet. */
export const executionStatusOf = (state: SessionLifecycleState): ExecutionStatusView | undefined => {
  if (state.execution) return { kind: "running", number: state.execution.number }
  if (state.lastExecution) return { kind: "terminal", state: state.lastExecution.state, number: state.lastExecution.number }
  return undefined
}

export type SessionLifecycleState = {
  readonly sessionID: string
  /** Last durable cursor seq (snapshot-at-watermark anchor). */
  readonly cursor: number
  readonly suspended: boolean
  readonly disconnected: boolean
  readonly queue: readonly RecoveryCommandRef[]
  readonly inflight?: RecoveryCommandRef
  readonly lastResult?: { readonly commandId: string; readonly result: RecoveryCommandResult }
  readonly lastError?: { readonly commandId: string; readonly error: unknown }
  /** A quit with an in-flight command surfaces this typed notice once. */
  readonly abandonedOnQuit?: { readonly commandId: string }
  /** Live `session.execution.*` turn: set by started, cleared by the terminal event. */
  readonly execution?: SessionExecutionSlot
  /** Last terminal execution turn outcome (succeeded/failed/interrupted). */
  readonly lastExecution?: SessionExecutionRecord
}

export type LifecycleSnapshot = {
  readonly suspended: boolean
  readonly disconnected: boolean
  readonly sessions: ReadonlyMap<string, SessionLifecycleState>
}

/** Internal mutable state; exported views are always the readonly shapes above. */
type MutableSession = {
  sessionID: string
  cursor: number
  suspended: boolean
  disconnected: boolean
  queue: RecoveryCommandRef[]
  inflight?: RecoveryCommandRef
  lastResult?: { commandId: string; result: RecoveryCommandResult }
  lastError?: { commandId: string; error: unknown }
  abandonedOnQuit?: { commandId: string }
  execution?: SessionExecutionSlot
  lastExecution?: SessionExecutionRecord
  executionSeq: number
}

export const createRecoveryLifecycle = () => {
  const sessions = new Map<string, MutableSession>()
  let suspended = false
  let disconnected = false

  const read = (sessionID: string): MutableSession => {
    const existing = sessions.get(sessionID)
    if (existing) return existing
    const created: MutableSession = {
      sessionID,
      cursor: 0,
      suspended: false,
      disconnected: false,
      queue: [],
      executionSeq: 0,
    }
    sessions.set(sessionID, created)
    return created
  }

  const onEvent = (event: LifecycleEvent) => {
    switch (event.type) {
      case "session-switch": {
        read(event.sessionID).cursor = event.cursor
        return
      }
      case "command-started": {
        const state = read(event.sessionID)
        if (state.inflight) {
          // Serial per session: a started command while one is in flight is queued, never dropped.
          state.queue.push(event.command)
          return
        }
        state.inflight = event.command
        return
      }
      case "command-completed": {
        const state = read(event.sessionID)
        const inFlight = state.inflight
        state.lastResult = { commandId: event.commandId, result: event.result }
        if (inFlight?.commandId === event.commandId) {
          state.inflight = state.queue.shift()
        }
        return
      }
      case "command-failed": {
        const state = read(event.sessionID)
        state.lastError = { commandId: event.commandId, error: event.error }
        if (state.inflight?.commandId === event.commandId) state.inflight = undefined
        return
      }
      case "execution-started": {
        const state = read(event.sessionID)
        // A started event while a turn is still open means the previous turn was superseded
        // without its own terminal event (stream gap) — close it as interrupted, never leak.
        if (state.execution) {
          state.lastExecution = {
            ref: state.execution.ref,
            state: "interrupted",
            at: event.timestamp,
            reason: "superseded",
            number: state.execution.number,
          }
        }
        state.executionSeq += 1
        state.execution = {
          ref: { commandId: `execution:${state.executionSeq}`, attemptId: `${event.sessionID}:execution:${state.executionSeq}` },
          startedAt: event.timestamp,
          number: state.executionSeq,
        }
        return
      }
      case "execution-succeeded": {
        const state = read(event.sessionID)
        const closed = closeExecutionSlot(state, event.timestamp)
        state.lastExecution = { ref: closed.ref, state: "succeeded", at: event.timestamp, number: closed.number }
        return
      }
      case "execution-failed": {
        const state = read(event.sessionID)
        const closed = closeExecutionSlot(state, event.timestamp)
        state.lastExecution = {
          ref: closed.ref,
          state: "failed",
          at: event.timestamp,
          error: event.error,
          number: closed.number,
        }
        return
      }
      case "execution-interrupted": {
        const state = read(event.sessionID)
        const closed = closeExecutionSlot(state, event.timestamp)
        state.lastExecution = {
          ref: closed.ref,
          state: "interrupted",
          at: event.timestamp,
          reason: event.reason,
          number: closed.number,
        }
        return
      }
      case "sleep":
        suspended = true
        return
      case "wake":
        // Idempotent resume: state is preserved; the caller re-runs refresh()/resync; the
        // per-session cursors stay unchanged so a re-drain cannot re-deliver results.
        suspended = false
        return
      case "disconnect":
        disconnected = true
        return
      case "reconnect":
        disconnected = false
        return
      case "quit":
        for (const state of sessions.values()) {
          if (state.inflight) {
            state.abandonedOnQuit = { commandId: state.inflight.commandId }
            state.inflight = undefined
            state.queue.length = 0
          }
          // A running execution turn is discarded with the disposal (no zombie slot; the
          // terminal event for it either already arrived or never will).
          state.execution = undefined
        }
        return
    }
  }

  const snapshot = (): LifecycleSnapshot => ({
    suspended,
    disconnected,
    sessions: new Map(sessions),
  })

  return { onEvent, snapshot }
}

export type RecoveryLifecycle = ReturnType<typeof createRecoveryLifecycle>

/** The `started` slot a terminal event closes. When no slot is open the `started` was missed
 * (the page mounted while the turn was in flight, or a stream gap): synthesize the slot from the
 * terminal event itself so the outcome is recorded — never silently dropped (W9.5). The
 * synthesized `startedAt` anchors at the terminal timestamp because the real start is unknown;
 * the terminal event then closes it in the same step, so no fake "running" state is visible. */
function closeExecutionSlot(state: MutableSession, timestamp: number): { readonly ref: RecoveryCommandRef; readonly number: number } {
  if (state.execution) {
    const ref = state.execution.ref
    const number = state.execution.number
    state.execution = undefined
    return { ref, number }
  }
  state.executionSeq += 1
  const ref = {
    commandId: `execution:${state.executionSeq}`,
    attemptId: `${state.sessionID}:execution:${state.executionSeq}`,
  }
  return { ref, number: state.executionSeq }
}
