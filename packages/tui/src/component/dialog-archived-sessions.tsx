import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { Locale } from "../util/locale"
import { createResource, createSignal, onMount } from "solid-js"

// W2-4 — archived sessions browser, mirroring the app's dialog-archived-sessions. Reads the
// global experimental list (archived=true), supports restore (archived=null) and a
// two-trigger delete confirm in the DialogSelect action style of DialogSessionList.
export function DialogArchivedSessions() {
  const dialog = useDialog()
  const route = useRoute()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const toast = useToast()
  const [toDelete, setToDelete] = createSignal<string>()

  const [items, { refetch }] = createResource(async () => {
    const result = await sdk.client.experimental.session.list({ archived: true, roots: true, limit: 200 })
    if (result.error) throw result.error
    return (result.data ?? []).toSorted((a, b) => b.time.updated - a.time.updated)
  })

  const options = () =>
    (items.latest ?? []).map((x) => ({
      title: toDelete() === x.id ? "Press delete again to confirm" : x.title,
      bg: toDelete() === x.id ? theme.error : undefined,
      value: x.id,
      category: "Archived",
      footer: `${x.preview?.trim() || Locale.time(x.time.updated)} · ${x.directory}`,
    }))

  const removeLocal = () => {
    refetch()
  }

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title="Archived sessions"
      options={options()}
      current={undefined}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={(option) => {
        // Archived rows are not directly enterable; restoring first returns them to the list.
        void option
      }}
      actions={[
        {
          command: "session.archive.list",
          title: "restore",
          onTrigger: async (option: { value: string }) => {
            const session = (items.latest ?? []).find((item) => item.id === option.value)
            try {
              const result = await sdk.client.session.update({
                sessionID: option.value,
                directory: session?.directory,
                time: { archived: null },
              })
              if (result.error) throw result.error
              await sync.session.refresh()
              toast.show({ variant: "success", message: "Session restored", duration: 3000 })
              setToDelete(undefined)
              removeLocal()
            } catch (error) {
              toast.show({
                variant: "error",
                title: "Failed to restore session",
                message: errorMessage(error),
              })
            }
          },
        },
        {
          command: "session.delete",
          title: "delete",
          onTrigger: async (option: { value: string }) => {
            if (toDelete() !== option.value) {
              setToDelete(option.value)
              return
            }
            const session = (items.latest ?? []).find((item) => item.id === option.value)
            try {
              const result = await sdk.client.session.delete({
                sessionID: option.value,
                directory: session?.directory,
              })
              if (result.error) throw result.error
              if (route.data.type === "session" && route.data.sessionID === option.value) {
                route.navigate({ type: "home" })
              }
              toast.show({ variant: "success", message: "Session deleted", duration: 3000 })
              setToDelete(undefined)
              removeLocal()
            } catch (error) {
              toast.show({
                variant: "error",
                title: "Failed to delete session",
                message: errorMessage(error),
              })
              setToDelete(undefined)
            }
          },
        },
      ]}
    />
  )
}
