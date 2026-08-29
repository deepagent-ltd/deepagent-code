import type { BootstrapDiagnostics, BackupVerify, RestoreStatus } from "./types"
import { type DiagnosticEntry, diagnosticEntries, containsSensitiveValue } from "./maintenance-diagnostics"

// C6-05: the desktop maintenance shell is a small, pure state machine that maps a
// bootstrap snapshot (+ backup/verify/restore outcomes) into a renderable view.
// Keeping it pure means the "no overlap / no deadlock" guarantees are unit-testable:
//   - one mode at a time (the mode switch never overlaps two views);
//   - no double restore submit (a restore already in-progress/busy is rejected);
//   - sensitive diagnostics never reach the renderable state (see diagnostics.ts).

export type ShellViewMode = "ready" | "read_only_recovery" | "blocked_schema"

export interface ShellBackupItem {
  fileName: string
  filePath: string
  sizeBytes: number
  sha256: string
  createdAt: number
}

export interface ShellOperations {
  browse: boolean
  search: boolean
  export: boolean
  backup: boolean
  descriptors: boolean
  restore: boolean
  write: boolean
  live: boolean
}

export type VerifyStatus =
  | { status: "idle" }
  | { status: "verifying" }
  | { status: "verified"; result: BackupVerify }
  | { status: "error"; stableCode: string }

export type RestoreStatusState =
  | { status: "idle" }
  | { status: "confirming"; selected: ShellBackupItem }
  | { status: "in_progress"; selected: ShellBackupItem }
  | { status: "busy"; selected: ShellBackupItem; result: RestoreStatus }
  | { status: "completed"; result: RestoreStatus }
  | { status: "error"; stableCode: string }

export interface ShellState {
  mode: ShellViewMode | null
  bootError: string | null
  diagnostics: readonly DiagnosticEntry[]
  backups: readonly ShellBackupItem[] | null
  backupListError: string | null
  verify: VerifyStatus
  restore: RestoreStatusState
}

export const initialShellState: ShellState = {
  mode: null,
  bootError: null,
  diagnostics: [],
  backups: null,
  backupListError: null,
  verify: { status: "idle" },
  restore: { status: "idle" },
}

export type ShellAction =
  | { type: "bootstrapLoaded"; mode: ShellViewMode; diagnostics: OutcomeDiagnostics }
  | { type: "bootstrapFailed"; stableCode: string }
  | { type: "backupsLoaded"; backups: readonly ShellBackupItem[] }
  | { type: "backupsFailed"; stableCode: string }
  | { type: "verifyStart" }
  | { type: "verifyResolved"; result: BackupVerify }
  | { type: "verifyFailed"; stableCode: string }
  | { type: "restoreSelect"; backup: ShellBackupItem }
  | { type: "restoreCancel" }
  | { type: "restoreConfirm" }
  | { type: "restoreBusy"; result: RestoreStatus }
  | { type: "restoreCompleted"; result: RestoreStatus }
  | { type: "restoreFailed"; stableCode: string }
  | { type: "reset" }

/**
 * Diagnostics carrier from a bootstrap snapshot. The reducer stores ONLY the safe
 * renderable entries, never the raw object (which may carry a path/credential in
 * `message`). `sensitive` records whether the source object had a sensitive value
 * so the shell can surface "stable code only" without leaking it.
 */
export interface OutcomeDiagnostics {
  entries: readonly DiagnosticEntry[]
  sensitive: boolean
}

/** Build a safe diagnostics outcome from a raw diagnostics object. */
export function toOutcomeDiagnostics(raw: BootstrapDiagnostics | undefined): OutcomeDiagnostics {
  return {
    entries: diagnosticEntries(raw),
    sensitive: containsSensitiveValue(raw),
  }
}

/** The operations a given bootstrap mode exposes (design §11.3 §10.8). */
export function operationsForMode(mode: ShellViewMode | null): ShellOperations {
  switch (mode) {
    case "ready":
      return { browse: true, search: true, export: true, backup: true, descriptors: true, restore: true, write: true, live: true }
    case "read_only_recovery":
      // Read-only recovery allows copy/export/backup/descriptors; write/live are disabled.
      return { browse: true, search: true, export: true, backup: true, descriptors: true, restore: true, write: false, live: false }
    case "blocked_schema":
      // Schema blocker: diagnostics + backup/restore guidance; business DB not writable.
      return { browse: true, search: true, export: true, backup: true, descriptors: true, restore: true, write: false, live: false }
    default:
      return { browse: false, search: false, export: false, backup: false, descriptors: false, restore: false, write: false, live: false }
  }
}

/** A restore request is in flight or the server reports a restore already running. */
export function isRestoreBusy(state: ShellState): boolean {
  return state.restore.status === "in_progress" || state.restore.status === "busy"
}

/** The selected restore source, if the restore flow is at/in past selection. */
export function restoreSelection(state: ShellState): ShellBackupItem | undefined {
  const restore = state.restore
  return restore.status === "confirming" || restore.status === "in_progress" || restore.status === "busy" ? restore.selected : undefined
}

/** True when a restore request may be submitted (permission + not busy + a target chosen). */
export function restoreCanSubmit(state: ShellState): boolean {
  return operationsForMode(state.mode).restore && state.restore.status === "confirming" && typeof state.restore.selected === "object"
}

export function reduceShell(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case "bootstrapLoaded":
      return { ...state, mode: action.mode, bootError: null, diagnostics: action.diagnostics.entries }
    case "bootstrapFailed":
      return { ...state, mode: null, bootError: action.stableCode, diagnostics: [] }
    case "backupsLoaded":
      return { ...state, backups: action.backups, backupListError: null }
    case "backupsFailed":
      return { ...state, backups: null, backupListError: action.stableCode }
    case "verifyStart":
      return { ...state, verify: { status: "verifying" } }
    case "verifyResolved":
      return { ...state, verify: { status: "verified", result: action.result } }
    case "verifyFailed":
      return { ...state, verify: { status: "error", stableCode: action.stableCode } }
    case "restoreSelect":
      // Selecting a new target always clears any prior in-flight/busy marker.
      return { ...state, restore: { status: "confirming", selected: action.backup } }
    case "restoreCancel":
      return { ...state, restore: { status: "idle" } }
    case "restoreConfirm":
      // No double submit: confirming -> in_progress only when not already running.
      if (state.restore.status !== "confirming") return state
      return { ...state, restore: { status: "in_progress", selected: state.restore.selected } }
    // A 409 restore-target-not-quarantined bumps the shell into a busy state; the
    // user is never allowed to double submit from busy. A busy state always follows
    // a selection, so if none is present the transition is a no-op (invalid input).
    case "restoreBusy": {
      const selected = restoreSelection(state)
      if (!selected) return state
      return { ...state, restore: { status: "busy", selected, result: action.result } }
    }
    case "restoreCompleted":
      return { ...state, restore: { status: "completed", result: action.result } }
    case "restoreFailed":
      return { ...state, restore: { status: "error", stableCode: action.stableCode } }
    case "reset":
      return initialShellState
  }
}
