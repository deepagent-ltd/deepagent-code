import { createResource, createSignal, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

type Pack = { id: string; name: string; description?: string; version: string; risk: string; domains: string[]; builtin: boolean; pinned: boolean }

// W4-4b — the TUI packs face: full installed catalog (built-in + external) with pin/unpin.
export function DialogPacks() {
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)

  const [packs, { refetch }] = createResource(async () => {
    const result = await sdk.client.deepagent.packsAll().catch(() => undefined)
    return ((result?.data?.packs ?? []) as Pack[]) ?? []
  })

  const pin = async (packId: string, pinned: boolean) => {
    if (busy()) return
    setBusy(true)
    try {
      const result = pinned
        ? await sdk.client.deepagent.packsUnpin({ packId })
        : await sdk.client.deepagent.packsPin({ packId })
      if (result.error) throw result.error
      toast.show({ variant: "success", message: i18n.t(pinned ? "tui.packs.unpinned" : "tui.packs.pinned"), duration: 3000 })
      await refetch()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const options = () =>
    (packs.latest ?? []).map((pack) => ({
      title: `${pack.pinned ? "📌 " : ""}${pack.name}`,
      value: pack.id,
      category: pack.builtin ? "built-in" : "external",
      footer: [pack.version, pack.risk, pack.domains.join(","), pack.description ?? ""].filter(Boolean).join(" · ").slice(0, 120),
    }))

  const byId = () => new Map((packs.latest ?? []).map((pack) => [pack.id, pack]))

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={i18n.t("tui.packs.title")}
      options={options()}
      current={undefined}
      onSelect={() => {}}
      actions={[
        {
          command: "packs.pin.toggle",
          title: i18n.t("tui.packs.pinToggle"),
          onTrigger: (option: { value: string }) => {
            const pack = byId().get(String(option.value))
            if (pack) void pin(pack.id, pack.pinned)
          },
        },
      ]}
    />
  )
}
