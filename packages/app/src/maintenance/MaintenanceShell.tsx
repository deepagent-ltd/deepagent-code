import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import type { MaintenanceClient } from "./maintenance-client"
import {
  initialShellState,
  isRestoreBusy,
  operationsForMode,
  reduceShell,
  restoreCanSubmit,
  restoreSelection,
  toOutcomeDiagnostics,
  type ShellAction,
  type ShellState,
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

export function MaintenanceShell(props: { client: MaintenanceClient }) {
  const [state, setState] = createSignal<ShellState>(initialShellState)
  const [busy, setBusy] = createSignal(false)
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
      restoreSelected: restoreSelection(s),
      restoreBusy: isRestoreBusy(s),
      restoreError: s.restore.status === "error" ? s.restore.stableCode : undefined,
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
          {view().mode === "blocked_schema" ? "The store is not writable (schema)." : view().mode === "read_only_recovery" ? "The store is in read-only recovery." : "Diagnostics"}
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
            <div class="mt-3 text-12-regular text-text-weak">Restore request recorded (dry-run status).</div>
          </Show>

          <Show when={view().restoreError}>
            <div class="mt-3 text-12-regular text-text-critical">Restore failed ({view().restoreError})</div>
          </Show>
        </section>
      </main>
    </div>
  )
}
