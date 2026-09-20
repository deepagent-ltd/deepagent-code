import { createSignal, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

type WikiPage = {
  docId: string
  type: string
  title: string
  scope: string
  editable: boolean
  version: number
}

// W4-2 full face — the TUI wiki browser with editing. Listing + page view ride the read-only
// paths; editable pages (knowledge/strategy/methodology/memory) open the multi-line editor and
// POST /deepagent/wiki/edit with the editor identity the evidence-gate requires. The edit is
// append-only (server versions it); expected failures surface as DeepAgentPromotionError with
// the reason — no outbound links, or a previously-rejected (type, summary) fingerprint.
export function DialogWikiPages() {
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const toast = useToast()

  const rawRequest = <T,>(options: { method: string; url: string; body?: unknown }) =>
    (sdk.client as unknown as { client: { request<D>(o: typeof options): Promise<{ data?: T; error?: unknown }> } }).client.request<T>(options)

  const [pages, setPages] = createSignal<WikiPage[] | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)

  const reload = () =>
    rawRequest<{ pages: WikiPage[] }>({ method: "GET", url: "/deepagent/wiki/pages" })
      .then((result) => {
        setPages(result.data?.pages ?? [])
      })
      .catch((error: unknown) => {
        toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
        dialog.clear()
      })

  onMount(() => {
    dialog.setSize("large")
    void reload()
  })

  const editPage = async (page: WikiPage) => {
    if (busy() || !page.editable) return
    setBusy(true)
    try {
      const current = await rawRequest<{ markdown: string }>({
        method: "GET",
        url: `/deepagent/wiki/page?docId=${encodeURIComponent(page.docId)}&scope=${encodeURIComponent(page.scope)}`,
      })
      if (current.error) throw current.error
      const edited = await DialogPrompt.show(dialog, `${i18n.t("tui.wiki.editTitle")} — ${page.title}`, {
        value: current.data?.markdown ?? "",
      })
      if (edited === null) return
      if (edited.trim() === (current.data?.markdown ?? "").trim()) {
        toast.show({ variant: "info", message: i18n.t("tui.wiki.unchanged"), duration: 3000 })
        return
      }
      const result = await rawRequest<{ version: number }>({
        method: "POST",
        url: "/deepagent/wiki/edit",
        body: {
          docId: page.docId,
          scope: page.scope,
          body: edited,
          editor: { id: "tui-user" },
        },
      })
      if (result.error) throw result.error
      toast.show({ variant: "success", message: i18n.t("tui.wiki.saved"), duration: 4000 })
      await reload()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  const viewPage = (page: WikiPage) => {
    void rawRequest<{ markdown: string }>({
      method: "GET",
      url: `/deepagent/wiki/page?docId=${encodeURIComponent(page.docId)}&scope=${encodeURIComponent(page.scope)}`,
    })
      .then((result) => {
        const markdown = result.data?.markdown ?? i18n.t("tui.wiki.emptyPage")
        dialog.replace(() => <DialogAlert title={page.title} message={markdown} />)
      })
      .catch((error: unknown) => {
        toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
      })
  }

  const options = () =>
    (pages() ?? []).map((x) => ({
      title: x.title,
      value: x.docId,
      category: x.type,
      footer: `${x.scope} · v${x.version}${x.editable ? ` · ${i18n.t("tui.wiki.editable")}` : ""}`,
    }))

  const byDocId = () => new Map((pages() ?? []).map((x) => [x.docId, x]))

  return (
    <DialogSelect
      title={i18n.t("tui.wiki.title")}
      options={options()}
      current={undefined}
      onSelect={(option) => {
        const page = byDocId().get(String(option.value))
        if (page) viewPage(page)
      }}
      actions={[
        {
          command: "wiki.page.edit",
          title: i18n.t("tui.wiki.edit"),
          disabled: (option) => !option || !byDocId().get(String(option.value))?.editable,
          onTrigger: (option: { value: string }) => {
            const page = byDocId().get(String(option.value))
            if (page) void editPage(page)
          },
        },
      ]}
    />
  )
}
