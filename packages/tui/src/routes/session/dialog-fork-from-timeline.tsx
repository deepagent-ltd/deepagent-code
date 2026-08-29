import { createMemo, onMount } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import type { TextPart } from "@deepagent-code/sdk"
import { Locale } from "../../util/locale"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useDialog, type DialogContext } from "../../ui/dialog"
import type { PromptInfo } from "../../component/prompt/history"
import { stripPromptPartIDs as strip } from "../../prompt/part"
import { requestSessionFork } from "../../util/session"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"

export function DialogForkFromTimeline(props: { sessionID: string; onMove: (messageID?: string) => void }) {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()
  const toast = useToast()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string | undefined>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const fullSession = {
      title: "Full session",
      value: undefined,
      onSelect: async (dialog: DialogContext) => {
        const intentKey = `${props.sessionID}:full`
        const forked = await requestSessionFork({
          key: intentKey,
          request: (intentID) => sdk.client.session.fork({ sessionID: props.sessionID, intentID }),
        })
        if ("error" in forked) {
          toast.show({ title: "Fork failed", message: errorMessage(forked.error), variant: "error", duration: 8000 })
          return
        }
        route.navigate({
          sessionID: forked.sessionID,
          type: "session",
        })
        dialog.clear()
      },
    } satisfies DialogSelectOption<string | undefined>
    const result = [] as DialogSelectOption<string | undefined>[]
    for (const message of messages) {
      if (message.role !== "user") continue
      const part = (sync.data.part[message.id] ?? []).find(
        (x) => x.type === "text" && !x.synthetic && !x.ignored,
      ) as TextPart
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: async (dialog) => {
          const intentKey = `${props.sessionID}:${message.id}`
          const forked = await requestSessionFork({
            key: intentKey,
            request: (intentID) =>
              sdk.client.session.fork({
                sessionID: props.sessionID,
                messageID: message.id,
                intentID,
              }),
          })
          if ("error" in forked) {
            toast.show({ title: "Fork failed", message: errorMessage(forked.error), variant: "error", duration: 8000 })
            return
          }
          const parts = sync.data.part[message.id] ?? []
          const prompt = parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(strip(part))
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          )
          route.navigate({
            sessionID: forked.sessionID,
            type: "session",
            prompt,
          })
          dialog.clear()
        },
      })
    }
    return [fullSession, ...result.reverse()]
  })

  return <DialogSelect onMove={(option) => props.onMove(option.value)} title="Fork session" options={options()} />
}
