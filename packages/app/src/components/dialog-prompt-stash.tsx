import { Component, createMemo, For, Show } from "solid-js"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog } from "@deepagent-code/ui/dialog"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import type { StashEntry } from "@/pages/session/prompt-stash"

function relativeTime(timestamp: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  const diffSeconds = Math.floor((Date.now() - timestamp) / 1000)
  if (diffSeconds < 60) return rtf.format(-diffSeconds, "second")
  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) return rtf.format(-diffMinutes, "minute")
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return rtf.format(-diffHours, "hour")
  return rtf.format(-Math.floor(diffHours / 24), "day")
}

// W3-2 — parity with the TUI DialogStash: most-recent-first list of stashed composer drafts;
// selecting one restores it into the composer, the trash button removes the entry.
export const DialogPromptStash: Component<{ entries: () => readonly StashEntry[]; onRestore: (entry: StashEntry) => void; onRemove: (index: number) => void }> =
  (props) => {
    const language = useLanguage()
    const dialog = useDialog()
    const prompt = usePrompt()

    const entries = createMemo(() => props.entries().slice().reverse())
    // Reverse-view indices map back to store order (oldest-first) for removal.
    const storeIndex = (viewIndex: number) => props.entries().length - 1 - viewIndex

    const restore = (entry: StashEntry) => {
      props.onRestore(entry)
      const text = entry.prompt
        .filter((p): p is Extract<typeof p, { content: string }> => "content" in p)
        .map((p) => p.content)
        .join("")
      prompt.set(entry.prompt, text.length)
      dialog.close()
    }

    return (
      <Dialog title={language.t("dialog.stash.title")}>
        <div class="flex flex-col gap-1 p-3 min-w-80 max-h-96 overflow-y-auto">
          <Show
            when={entries().length > 0}
            fallback={<div class="py-8 text-center text-12-regular text-text-weak">{language.t("dialog.stash.empty")}</div>}
          >
            <For each={entries()}>
              {(entry, index) => {
                const text = entry.prompt.map((p) => ("content" in p ? p.content : "")).join("")
                const firstLine = text.split("\n")[0]?.trim() ?? ""
                return (
                  <div class="group flex items-center gap-2 rounded-md px-2 py-2 hover:bg-background-stronger">
                    <button
                      type="button"
                      class="min-w-0 flex-1 text-left"
                      onClick={() => restore(entry)}
                      title={language.t("dialog.stash.restore")}
                    >
                      <div class="truncate text-12-medium text-text">{firstLine || language.t("dialog.stash.noText")}</div>
                      <div class="text-11-regular text-text-weak">{relativeTime(entry.timestamp, language.intl())}</div>                    </button>
                    <IconButton
                      icon="trash"
                      size="small"
                      variant="ghost"
                      class="shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={() => props.onRemove(storeIndex(index()))}
                      aria-label={language.t("common.delete")}
                      title={language.t("common.delete")}
                    />
                  </div>
                )
              }}
            </For>
          </Show>
        </div>
      </Dialog>
    )
  }
