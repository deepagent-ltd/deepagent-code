import { createResource, createSignal, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

// W4-4b — the TUI worktree face: pending changes (diff entries), merge back, fail-closed
// removal. Mirrors the GUI side panel semantics: the directory routes the request; removal
// refuses unmerged work unless forced.
export function DialogWorktree() {
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)

  const directory = () => sdk.directory ?? ""

  const [diff, { refetch }] = createResource(async () => {
    const result = await sdk.client.worktree
      .diff({ directory: directory(), worktreeRemoveInput: { directory: directory() } })
      .catch(() => undefined)
    return result?.data
  })

  const merge = async () => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await sdk.client.worktree.merge({
        directory: directory(),
        worktreeRemoveInput: { directory: directory() },
      })
      if (result.error) throw result.error
      const data = result.data
      toast.show({
        variant: data?.merged ? "success" : "warning",
        message: data?.message ?? i18n.t("tui.worktree.merged"),
        duration: 5000,
      })
      await refetch()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (force: boolean) => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await sdk.client.worktree.safeRemove({
        directory: directory(),
        worktreeSafeRemoveInput: { directory: directory(), force },
      })
      if (result.error) throw result.error
      toast.show({ variant: "success", message: i18n.t("tui.worktree.removed"), duration: 4000 })
      await refetch()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const options = () =>
    (diff.latest?.entries ?? []).map((entry) => ({
      title: entry.file,
      value: entry.file,
      category: entry.status,
      footer: `+${Number(entry.additions)} -${Number(entry.deletions)}`,
    }))

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={i18n.t("tui.worktree.title")}
      options={options()}
      current={undefined}
      onSelect={() => {}}
      actions={[
        {
          command: "worktree.merge",
          title: i18n.t("tui.worktree.merge"),
          onTrigger: () => {
            void merge()
          },
        },
        {
          command: "worktree.remove",
          title: i18n.t("tui.worktree.remove"),
          onTrigger: () => {
            void (async () => {
              const confirmed = await DialogConfirm.show(
                dialog,
                i18n.t("tui.worktree.remove"),
                i18n.t("tui.worktree.removeConfirm"),
              )
              if (confirmed) void remove(false)
            })()
          },
        },
      ]}
    />
  )
}
