import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { MaintenanceClient } from "./maintenance-client"
import {
  initialShellState,
  isRestoreBusy,
  migrationPhaseViews,
  migrationProgress,
  operationsForMode,
  reduceShell,
  restoreCanSubmit,
  restoreSelection,
  toOutcomeDiagnostics,
  type ShellAction,
  type ShellState,
  type ShellViewMode,
} from "./maintenance-shell-state"
import { MaintenanceDiagnostics } from "./MaintenanceDiagnostics"

// C6-05 desktop maintenance shell (design §11.3 §10.8). It is driven entirely by
// the pure `reduceShell` state machine; the component only dispatches actions and
// maps the resulting view to markup. It never reads a raw SQL/path/credential —
// diagnostics render through `MaintenanceDiagnostics` (stable-code only).
//
// The shell is shown only for the non-ready bootstrap modes; the `BootstrapGate`
// renders the normal app when mode === "ready". The client is injected for tests
// (fixture/in-memory only, no live network).

export function MaintenanceShell(props: {
  client: MaintenanceClient
  /** Forced view mode (the gate's migration-in-progress decision overrides bootstrap mode). */
  mode?: ShellViewMode
  /** Notified when a rendered migration chain settles (completed or vanished) so the gate can show the app. */
  onMigrationSettled?: () => void
}) {
  const [state, setState] = createSignal<ShellState>(initialShellState)
  const [busy, setBusy] = createSignal(false)
  const [migrationBusy, setMigrationBusy] = createSignal(false)
  const language = useLanguage()
  const dispatch = (action: ShellAction) => setState((prev) => reduceShell(prev, action))
  const ops = () => operationsForMode(state().mode)

  // Narrow the union once into a plain view so JSX never touches a union member.
  const view = createMemo(() => {
    const s = state()
    return {
      mode: s.mode,
      bootError: s.bootError,
      diagnostics: s.diagnostics,
      backups: s.backups,
      backupListError: s.backupListError,
      verifyStatus: s.verify.status,
      verifyResult: s.verify.status === "verified" ? s.verify.result : undefined,
      verifyReason: s.verify.status === "verified" && s.verify.result.ok === false ? s.verify.result.reason : undefined,
      restoreStatus: s.restore.status,
      restoreOutcome: s.restore.status === "completed" ? s.restore.result?.status : undefined,
      restoreSelected: restoreSelection(s),
      restoreBusy: isRestoreBusy(s),
      restoreError: s.restore.status === "error" ? s.restore.stableCode : undefined,
      migration: s.migration,
      // Derived once here so the JSX below never touches the union members.
      migrationPhases: s.migration.status === "idle" || s.migration.status === "unavailable" ? [] : migrationPhaseViews(s.migration.journal),
      migrationProgress: s.migration.status === "idle" || s.migration.status === "unavailable" ? undefined : migrationProgress(s.migration.journal),
      migrationUnavailableCode: s.migration.status === "unavailable" ? s.migration.stableCode : undefined,
      migrationGuidance: s.migration.status === "failed" ? s.migration.journal.failure?.recoveryGuidance : undefined,
    }
  })

  const loadBackups = async () => {
    const result = await props.client.listBackups()
    if ("error" in result) dispatch({ type: "backupsFailed", stableCode: result.error.data.code })
    else if ("failure" in result) dispatch({ type: "backupsFailed", stableCode: "network_unreachable" })
    else dispatch({ type: "backupsLoaded", backups: result.data.backups })
  }

  createEffect(() => {
    void (async () => {
      // W-02 M-6: the gate may force the migration-in-progress mode (a READY store with an
      // orchestrated chain running); that mode renders progress instead of the backup surface.
      if (props.mode === "migration_in_progress") {
        dispatch({ type: "bootstrapLoaded", mode: props.mode, diagnostics: toOutcomeDiagnostics(undefined) })
        return
      }
      const outcome = await props.client.bootstrapStatus()
      if (outcome.kind === "ready") {
        dispatch({ type: "bootstrapLoaded", mode: "ready", diagnostics: toOutcomeDiagnostics(outcome.state.diagnostics) })
      } else if (outcome.kind === "read_only_recovery" || outcome.kind === "blocked_schema") {
        dispatch({
          type: "bootstrapLoaded",
          mode: outcome.kind,
          diagnostics: toOutcomeDiagnostics(outcome.state.diagnostics),
        })
        void loadBackups()
      } else {
        dispatch({ type: "bootstrapFailed", stableCode: "bootstrap_unreachable" })
      }
    })()
  })

  // W-02 M-6 — poll the orchestration journal while the migration view is up. Phase progress
  // (journal.currentPhase / phases[].state, including stop_after staged invocations) updates live;
  // failure.recoveryGuidance renders verbatim once the chain stops. The poll NEVER blocks the
  // shell: an unreachable status endpoint degrades to a stable code, and a settled chain hands
  // control back to the gate.
  const pollMigration = async () => {
    const result = await props.client.migrationStatus()
    if ("data" in result) {
      dispatch({ type: "migrationLoaded", journal: result.data.journal })
      if (result.data.journal === undefined || result.data.journal.status === "completed") props.onMigrationSettled?.()
    } else if ("error" in result) {
      dispatch({ type: "migrationFailed", stableCode: result.error.data.code })
    } else {
      dispatch({ type: "migrationFailed", stableCode: "network_unreachable" })
    }
  }
  createEffect(() => {
    if (state().mode !== "migration_in_progress") return
    void pollMigration()
    const timer = setInterval(() => void pollMigration(), 1500)
    onCleanup(() => clearInterval(timer))
  })

  const resumeMigration = async () => {
    if (migrationBusy()) return
    setMigrationBusy(true)
    // Re-running the chain resumes idempotently from the failed phase (M-2 semantics).
    await props.client.runMigration()
    setMigrationBusy(false)
    void pollMigration()
  }

  const verify = async (manifestPath: string) => {
    dispatch({ type: "verifyStart" })
    const result = await props.client.verifyBackup(manifestPath)
    if ("error" in result) dispatch({ type: "verifyFailed", stableCode: result.error.data.code })
    else if ("failure" in result) dispatch({ type: "verifyFailed", stableCode: "network_unreachable" })
    else dispatch({ type: "verifyResolved", result: result.data })
  }

  const restore = async () => {
    const selection = restoreSelection(state())
    if (!selection || !restoreCanSubmit(state())) return
    if (busy()) return
    setBusy(true)
    dispatch({ type: "restoreConfirm" })
    const result = await props.client.restoreBackup({ backup_manifest_ref: selection.filePath, dry_run: false })
    setBusy(false)
    if ("error" in result) {
      const code = result.error.data.code
      const status = result.error.data.httpStatus
      if (code === "restore_target_not_quarantined" || status === 409) {
        dispatch({ type: "restoreBusy", result: { status: "dry_run", inProgress: true, message: "restore already in progress" } })
      } else {
        dispatch({ type: "restoreFailed", stableCode: code })
      }
      return
    }
    if ("failure" in result) {
      dispatch({ type: "restoreFailed", stableCode: "network_unreachable" })
      return
    }
    dispatch({ type: "restoreCompleted", result: result.data })
  }

  return (
    <div class="flex min-h-dvh flex-col bg-background-base text-text-base">
      <header class="border-b border-border-weak-base px-6 py-4">
        <div class="text-14-medium text-text-strong">Database maintenance</div>
        <div class="mt-1 text-12-regular text-text-weak">
          {view().mode === "blocked_schema"
            ? "The store is not writable (schema)."
            : view().mode === "read_only_recovery"
              ? "The store is in read-only recovery."
              : view().mode === "migration_in_progress"
                ? language.t("maintenance.migration.title")
                : "Diagnostics"}
        </div>
      </header>

      <main class="mx-auto w-full max-w-3xl flex-1 px-6 py-6">
        <Show when={view().bootError}>
          <div class="mb-4 rounded-md border border-border-critical-base bg-surface-raised-base p-4">
            <div class="text-13-medium text-text-critical">Bootstrap could not be read ({view().bootError})</div>
            <div class="mt-1 text-12-regular text-text-weak">Retry when the local server is reachable.</div>
          </div>
        </Show>

        <section class="mb-6 rounded-md border border-border-weak-base p-4">
          <h2 class="text-13-medium text-text-strong">Diagnostics (stable code only)</h2>
          <div class="mt-2">
            <MaintenanceDiagnostics entries={view().diagnostics} />
          </div>
        </section>

        <section class="mb-6 rounded-md border border-border-weak-base p-4">
          <h2 class="text-13-medium text-text-strong">Operation state</h2>
          <ul class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-12-regular text-text-weak">
            <li>Browse: {ops().browse ? "allowed" : "disabled"}</li>
            <li>Write: <Show when={ops().write} fallback="disabled">allowed</Show></li>
            <li>Live run: {ops().live ? "allowed" : "disabled"}</li>
            <li>Backup: {ops().backup ? "allowed" : "disabled"}</li>
            <li>Export evidence: {ops().export ? "allowed" : "disabled"}</li>
          </ul>
        </section>

        <Show when={view().mode === "migration_in_progress"}>
          <section class="mb-6 rounded-md border border-border-weak-base p-4" data-testid="migration-progress">
            <div class="flex items-center justify-between">
              <h2 class="text-13-medium text-text-strong">{language.t("maintenance.migration.title")}</h2>
              <span class="text-12-regular text-text-weak">
                <Show when={view().migration.status === "active"} fallback={<span data-testid="migration-headline">
                  {view().migration.status === "completed"
                    ? language.t("maintenance.migration.completed.title")
                    : view().migration.status === "failed"
                      ? language.t("maintenance.migration.failed.title")
                      : view().migration.status === "unavailable"
                        ? `${language.t("maintenance.migration.unavailable")} (${view().migrationUnavailableCode})`
                        : language.t("maintenance.migration.pending")}
                </span>}>
                  <span data-testid="migration-headline">
                    {language.t("maintenance.migration.progress", {
                      done: view().migrationProgress?.done ?? 0,
                      total: view().migrationProgress?.total ?? 0,
                    })}
                  </span>
                </Show>
              </span>
            </div>
            <ol class="mt-3 flex flex-col gap-1" data-testid="migration-phases">
              <For each={view().migrationPhases}>
                {(phase) => (
                  <li class="flex items-center justify-between gap-3 text-12-regular">
                    <span class={phase.state === "pending" ? "text-text-weak" : "text-text-strong"}>
                      {language.t(`maintenance.migration.phase.${phase.phase}`)}
                    </span>
                    <span
                      class={
                        phase.state === "completed"
                          ? "text-text-success"
                          : phase.state === "failed"
                            ? "text-text-critical"
                            : phase.state === "running"
                              ? "text-text-warning"
                              : "text-text-weak"
                      }
                    >
                      {language.t(`maintenance.migration.state.${phase.state}`)}
                    </span>
                  </li>
                )}
              </For>
            </ol>
            <Show when={view().migration.status === "failed"}>
              <div class="mt-3 rounded-md border border-border-critical-base bg-surface-raised-base p-3" data-testid="migration-guidance">
                <div class="text-12-medium text-text-critical">{language.t("maintenance.migration.failed.title")}</div>
                <div class="mt-1 text-11-regular text-text-weak">
                  {/* The journal's user-readable recovery guidance renders verbatim (M-6). */}
                  {view().migrationGuidance}
                </div>
                <button
                  type="button"
                  class="mt-2 text-12-regular underline disabled:opacity-50"
                  disabled={migrationBusy()}
                  onClick={() => void resumeMigration()}
                >
                  {migrationBusy() ? language.t("maintenance.migration.resuming") : language.t("maintenance.migration.resume")}
                </button>
              </div>
            </Show>
          </section>
        </Show>

        <section class="rounded-md border border-border-weak-base p-4">
          <div class="flex items-center justify-between">
            <h2 class="text-13-medium text-text-strong">Backups</h2>
            <button type="button" class="text-12-regular underline" onClick={() => void loadBackups()}>
              Refresh
            </button>
          </div>
          <Show when={view().backupListError}>
            <div class="mt-2 text-12-regular text-text-critical">List failed ({view().backupListError})</div>
          </Show>
          <Show when={view().backups !== null} fallback={<div class="mt-2 text-12-regular text-text-weak">No backup list</div>}>
            <ul class="mt-2 flex flex-col gap-2">
              <For each={view().backups ?? []}>
                {(backup) => (
                  <li class="flex items-center justify-between gap-3 rounded-md border border-border-weak-base px-3 py-2">
                    <div class="min-w-0">
                      <div class="truncate text-12-regular text-text-strong">{backup.fileName}</div>
                      <div class="truncate text-11-regular text-text-weak">{backup.sha256}</div>
                    </div>
                    <div class="flex shrink-0 gap-2">
                      <button type="button" class="text-12-regular underline" onClick={() => void verify(backup.filePath)}>
                        Verify
                      </button>
                      <button
                        type="button"
                        class="text-12-regular underline"
                        disabled={!ops().restore || isRestoreBusy(state())}
                        onClick={() => dispatch({ type: "restoreSelect", backup })}
                      >
                        Restore
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <Show when={view().verifyStatus === "verified"}>
            <div class="mt-3 text-12-regular text-text-weak">
              Verify: {view().verifyResult?.ok === true ? "verified" : "failed"} ({view().verifyReason ?? "ok"})
            </div>
          </Show>

          <Show when={view().restoreStatus === "confirming"}>
            <div class="mt-3 rounded-md border border-border-warning-base bg-surface-raised-base p-3">
              <div class="text-12-regular text-text-strong">Restore from «{view().restoreSelected?.fileName}»?</div>
              <div class="mt-1 text-11-regular text-text-weak">
                The current store is quarantined and replaced by the selected backup. This is explicit and irreversible once verified.
              </div>
              <div class="mt-2 flex gap-2">
                <button type="button" class="text-12-regular underline" onClick={() => dispatch({ type: "restoreCancel" })}>
                  Cancel
                </button>
                <button type="button" class="text-12-regular underline" disabled={busy()} onClick={() => void restore()}>
                  {busy() ? "Restoring…" : "Confirm restore"}
                </button>
              </div>
            </div>
          </Show>

          <Show when={view().restoreBusy}>
            <div class="mt-3 text-12-regular text-text-warning">
              {view().restoreStatus === "busy" ? "A restore is already in progress." : "Restore in progress…"}
            </div>
          </Show>

          <Show when={view().restoreStatus === "completed"}>
            <div class="mt-3 text-12-regular text-text-weak">
              {view().restoreOutcome === "restored"
                ? "Restore succeeded: the store was replaced and the pre-restore store is retained in the quarantine."
                : "Restore request recorded (dry-run status)."}
            </div>
          </Show>

          <Show when={view().restoreError}>
            <div class="mt-3 text-12-regular text-text-critical">Restore failed ({view().restoreError})</div>
          </Show>
        </section>
      </main>
    </div>
  )
}
