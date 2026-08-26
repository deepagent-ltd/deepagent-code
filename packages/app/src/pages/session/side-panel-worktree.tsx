import { Component, createResource, createSignal, For, Show } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Button } from "@deepagent-code/ui/button"
import { showToast } from "@/utils/toast"

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

// U3 (S1 §P0): side-panel worktree view. Shows the CURRENT session's worktree: change count, the
// tracked+untracked diff, the committed branch summary, and merge-back / safe-remove actions. The
// session directory IS the worktree dir when the session runs in one; for the primary checkout the
// service reports it as not-a-worktree and the panel shows the empty state. Merge + remove are
// outward-facing writes and require explicit confirmation (the service is fail-closed regardless).
export const SidePanelWorktree: Component<{ onClose: () => void }> = (props) => {
  const sdk = useSDK()
  const language = useLanguage()
  const directory = () => sdk.directory

  const [busy, setBusy] = createSignal(false)

  const [data, { refetch }] = createResource(directory, async (dir) => {
    const [changes, diff, summary] = await Promise.all([
      sdk.client.worktree
        .changes({ directory: dir, worktreeRemoveInput: { directory: dir } })
        .then((x) => x.data)
        .catch(() => undefined),
      sdk.client.worktree
        .diff({ directory: dir, worktreeRemoveInput: { directory: dir } })
        .then((x) => x.data)
        .catch(() => undefined),
      sdk.client.worktree
        .summary({ directory: dir, worktreeRemoveInput: { directory: dir } })
        .then((x) => x.data)
        .catch(() => undefined),
    ])
    return { changes, diff, summary }
  })

  const merge = async () => {
    if (busy()) return
    if (!window.confirm(language.t("worktree.merge.confirm"))) return
    setBusy(true)
    try {
      const res = await sdk.client.worktree
        .merge({ directory: directory(), worktreeRemoveInput: { directory: directory() } })
        .then((x) => x.data)
      if (res?.merged) {
        showToast({ variant: "success", title: language.t("worktree.merge.done"), description: res.message })
      } else {
        showToast({ variant: "error", title: language.t("worktree.merge.conflict"), description: res?.message ?? "" })
      }
      await refetch()
    } catch (err) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: errMsg(err) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (force: boolean) => {
    if (busy()) return
    const prompt = force ? language.t("worktree.remove.confirmForce") : language.t("worktree.remove.confirm")
    if (!window.confirm(prompt)) return
    setBusy(true)
    try {
      await sdk.client.worktree.safeRemove({
        directory: directory(),
        worktreeSafeRemoveInput: { directory: directory(), force },
      })
      showToast({ variant: "success", title: language.t("worktree.remove.done"), description: "" })
      props.onClose()
    } catch (err) {
      // fail-closed: the service refuses when there is unmerged work — offer force in the message.
      showToast({ variant: "error", title: language.t("worktree.remove.refused"), description: errMsg(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="h-full w-full min-w-0 overflow-y-auto bg-background-base">
      <div class="sticky top-0 z-10 h-10 flex items-center justify-between px-3 bg-background-base">
        <span class="text-12-medium text-text">{language.t("worktree.title")}</span>
        <IconButton
          icon="close-small"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={props.onClose}
          aria-label={language.t("common.close")}
        />
      </div>

      <Show
        when={data()?.changes}
        fallback={
          <div class="flex-1 pb-64 flex items-center justify-center text-center">
            <div class="text-12-regular text-text-weak">{language.t("worktree.empty")}</div>
          </div>
        }
      >
        <div class="flex flex-col gap-3 px-3 py-2">
          <div class="flex flex-col gap-1 text-12-regular">
            <Show when={data()?.summary}>
              <div class="text-text-weak">
                {language.t("worktree.summary", {
                  base: data()!.summary!.base,
                  additions: data()!.summary!.additions,
                  deletions: data()!.summary!.deletions,
                  files: data()!.summary!.files,
                })}
              </div>
            </Show>
            <div class="text-text-weak">
              {language.t("worktree.changes", {
                uncommitted: data()!.changes!.uncommitted ?? "?",
                ahead: data()!.changes!.ahead ?? "?",
              })}
            </div>
          </div>

          <Show when={(data()?.diff?.entries.length ?? 0) > 0}>
            <div class="flex flex-col gap-0.5">
              <For each={data()!.diff!.entries}>
                {(e) => (
                  <div class="flex items-center justify-between gap-2 text-11-regular">
                    <span class="truncate" data-status={e.status}>
                      {e.file}
                    </span>
                    <span class="shrink-0 text-text-weaker">
                      <span class="text-text-success">+{e.additions}</span>{" "}
                      <span class="text-text-error">-{e.deletions}</span>
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="flex flex-col gap-2 pt-1">
            <Button variant="primary" disabled={busy()} onClick={merge}>
              {language.t("worktree.merge.action")}
            </Button>
            <Button variant="secondary" disabled={busy()} onClick={() => remove(false)}>
              {language.t("worktree.remove.action")}
            </Button>
          </div>
        </div>
      </Show>
    </div>
  )
}
