import { createSignal, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogAlert } from "../ui/dialog-alert"
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

// W4-2 minimal face — the TUI's read-only wiki browser. Lists projectable pages
// (GET /deepagent/wiki/pages, sealed excluded); selection fetches the page body and shows it in
// the alert viewer. Editing stays GUI-only by plan ruling. Both routes are path-served and not
// in the generated SDK, hence the low-level request helper.
export function DialogWikiPages() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const i18n = useTuiI18n()

  const rawRequest = <T,>(options: { method: string; url: string }) =>
    (sdk.client as unknown as { client: { request<D>(o: typeof options): Promise<{ data?: D }> } }).client.request<T>(
      options,
    )

  const [pages, setPages] = createSignal<WikiPage[] | undefined>(undefined)

  onMount(() => {
    dialog.setSize("large")
    void rawRequest<{ pages: WikiPage[] }>({ method: "GET", url: "/deepagent/wiki/pages" })
      .then((result) => {
        setPages(result.data?.pages ?? [])
      })
      .catch((error: unknown) => {
        toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
        dialog.clear()
      })
  })

  const openPage = (page: WikiPage) => {
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
      footer: `${x.scope} · v${x.version}${x.editable ? ` · ${i18n.t("tui.wiki.editableGuiOnly")}` : ""}`,
    }))

  const byDocId = () => new Map((pages() ?? []).map((x) => [x.docId, x]))

  return (
    <DialogSelect
      title={i18n.t("tui.wiki.title")}
      options={options()}
      current={undefined}
      onSelect={(option) => {
        const page = byDocId().get(String(option.value))
        if (page) openPage(page)
      }}
    />
  )
}
