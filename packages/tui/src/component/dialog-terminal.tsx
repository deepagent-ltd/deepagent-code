import { createResource, createSignal, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogAlert } from "../ui/dialog-alert"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { Locale } from "../util/locale"

type PtyInfo = { id: string; title?: string; createdAt?: string }

// W4-4a — the TUI terminal face. The pty registry (create/list/remove) rides the typed SDK
// (/pty routes). Interactive attach is intentionally NOT inlined: the TUI already occupies the
// controlling terminal, so embedding a nested pty needs a pane infra the TUI does not have —
// the dialog surfaces the registry plus an attach hint (session-tab terminal semantics stay in
// the GUI/desktop shells which own a pty renderer).
export function DialogTerminal() {
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)

  const [items, { refetch }] = createResource(async () => {
    const result = await sdk.client.pty.list().catch(() => undefined)
    return ((result?.data ?? []) as PtyInfo[]) ?? []
  })

  const create = async () => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await sdk.client.pty.create({})
      if (result.error) throw result.error
      toast.show({ variant: "success", message: i18n.t("tui.terminal.created"), duration: 3000 })
      await refetch()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (ptyID: string) => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await sdk.client.pty.remove({ ptyID })
      if (result.error) throw result.error
      toast.show({ variant: "success", message: i18n.t("tui.terminal.removed"), duration: 3000 })
      await refetch()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const options = () =>
    (items.latest ?? []).map((item) => ({
      title: item.title || item.id,
      value: item.id,
      category: "PTY",
      footer: item.createdAt ? Locale.time(new Date(item.createdAt).getTime()) : "",
    }))

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={i18n.t("tui.terminal.title")}
      options={options()}
      current={undefined}
      onSelect={() => {}}
      actions={[
        {
          command: "terminal.create",
          title: i18n.t("tui.terminal.new"),
          onTrigger: () => {
            void create()
          },
        },
        {
          command: "terminal.attach",
          title: i18n.t("tui.terminal.attach"),
          onTrigger: () => {
            dialog.replace(() => (
              <DialogAlert title={i18n.t("tui.terminal.attach")} message={i18n.t("tui.terminal.attachHint")} />
            ))
          },
        },
        {
          command: "terminal.remove",
          title: i18n.t("tui.terminal.remove"),
          onTrigger: (option: { value: string }) => {
            void remove(String(option.value))
          },
        },
      ]}
    />
  )
}
