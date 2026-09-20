import { createResource, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogAlert } from "../ui/dialog-alert"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

type DebugSession = { id: string; adapterId: string; status: string; threadId?: string; stoppedReason?: string }

// W4-4b — the TUI debug (DAP) face: session registry with per-session stack inspection. Live
// stepping/variables ride the same SDK surface; the SSE event stream subscription stays GUI-side
// (single-subscription semantics), the TUI refreshes on demand.
export function DialogDebug() {
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const toast = useToast()

  const [sessions, { refetch }] = createResource(async () => {
    const result = await sdk.client.debug.sessions().catch(() => undefined)
    return ((result?.data ?? []) as DebugSession[]) ?? []
  })

  const showStack = async (sessionId: string) => {
    try {
      const result = await sdk.client.debug.stack({ sessionId })
      if (result.error) throw result.error
      const frames = (result.data?.frames ?? []) as { id: number; name: string; file?: string; line?: number }[]
      dialog.replace(() => (
        <DialogSelect
          title={`${i18n.t("tui.debug.stack")} — ${sessionId.slice(0, 12)}`}
          options={frames.map((frame) => ({
            title: `#${frame.id} ${frame.name}`,
            value: String(frame.id),
            category: "Frames",
            footer: `${frame.file ?? ""}${frame.line ? `:${frame.line}` : ""}`,
          }))}
          current={undefined}
          onSelect={() => {}}
          actions={[
            {
              command: "debug.back",
              title: i18n.t("tui.reviews.back"),
              onTrigger: () => {
                void refetch()
                dialog.replace(() => <DialogDebug />)
              },
            },
          ]}
        />
      ))
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
    }
  }

  const options = () =>
    (sessions.latest ?? []).map((session) => ({
      title: `${session.id.slice(0, 16)} · ${session.adapterId}`,
      value: session.id,
      category: session.status,
      footer: session.stoppedReason ?? "",
    }))

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={i18n.t("tui.debug.title")}
      options={options()}
      current={undefined}
      onSelect={(option) => {
        void showStack(String(option.value))
      }}
    />
  )
}
