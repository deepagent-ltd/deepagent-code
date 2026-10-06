import { createMemo, createEffect, onCleanup, Show, For } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { useLanguage } from "@/context/language"
import type { AgentDescriptor } from "./types"
import { createComposerDraft, type ComposerDraft } from "./composer-draft"

interface MessageComposerProps {
  onSend: (content: string, clientRequestID: string) => void | Promise<void>
  onTyping?: (typing: boolean) => void
  agents: AgentDescriptor[]
  disabled?: boolean
  draft?: ComposerDraft
  // §B3 file attachments — when provided, a paperclip button lets the user upload a file. The panel
  // owns the upload (uploadAttachment → file message) so the composer stays presentation-only.
  onAttach?: (file: File) => Promise<void>
  // Placeholder override (e.g. thread replies read "Reply in thread…").
  placeholder?: string
}

export function MessageComposer(props: MessageComposerProps) {
  const language = useLanguage()
  const draft = props.draft ?? createComposerDraft()
  const delivery = draft.state
  const setDelivery = draft.setState
  const content = () => draft.state.content
  const setContent = (value: string) =>
    draft.setState({
      content: value,
      ...(value !== delivery.requestContent ? { failed: false, requestID: "", requestContent: "" } : {}),
    })
  const [editor, setEditor] = createStore({
    showMentionMenu: false,
    mentionQuery: "",
    mentionPosition: { top: 0, left: 0 },
    selectedIndex: 0,
    uploading: false,
  })
  let textareaRef: HTMLTextAreaElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let typingActive = false
  let typingStopTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const handleFileSelected = async (e: Event & { currentTarget: HTMLInputElement }) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ""
    if (!file || !props.onAttach) return
    setEditor("uploading", true)
    try {
      await props.onAttach(file)
    } finally {
      setEditor("uploading", false)
    }
  }

  // Emit a throttled typing signal: "true" on first keystroke, "false" after a
  // short idle gap. Cleaned up on unmount.
  const signalTyping = () => {
    if (!props.onTyping) return
    if (!typingActive) {
      typingActive = true
      props.onTyping(true)
    }
    if (typingStopTimer) clearTimeout(typingStopTimer)
    typingStopTimer = setTimeout(() => {
      typingActive = false
      props.onTyping?.(false)
    }, 3000)
  }

  const stopTyping = () => {
    if (typingStopTimer) clearTimeout(typingStopTimer)
    if (typingActive) {
      typingActive = false
      props.onTyping?.(false)
    }
  }

  onCleanup(() => {
    disposed = true
    stopTyping()
  })

  // Filter agents based on mention query
  const filteredAgents = createMemo(() => {
    const query = editor.mentionQuery
    if (!query) return props.agents
    const lowerQuery = query.toLowerCase()
    return props.agents.filter(
      (agent) =>
        agent.id.toLowerCase().includes(lowerQuery) ||
        agent.displayName?.toLowerCase().includes(lowerQuery) ||
        agent.description?.toLowerCase().includes(lowerQuery),
    )
  })

  // Detect @ mentions and show autocomplete
  createEffect(() => {
    const currentContent = content()
    if (!textareaRef) return

    const cursorPos = textareaRef.selectionStart
    const textBeforeCursor = currentContent.slice(0, cursorPos)

    // Check if we're in a mention context
    const mentionMatch = textBeforeCursor.match(/@(\w*)$/)

    if (mentionMatch) {
      setEditor("mentionQuery", mentionMatch[1])
      setEditor("showMentionMenu", true)
      setEditor("selectedIndex", 0)

      // Calculate position for the dropdown
      const coords = getCaretCoordinates(textareaRef, cursorPos)
      setEditor("mentionPosition", {
        top: coords.top - textareaRef.scrollTop,
        left: coords.left,
      })
    } else {
      setEditor("showMentionMenu", false)
      setEditor("mentionQuery", "")
    }
  })

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return
    if (editor.showMentionMenu && filteredAgents().length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setEditor("selectedIndex", (prev) => (prev + 1) % filteredAgents().length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setEditor("selectedIndex", (prev) => (prev - 1 + filteredAgents().length) % filteredAgents().length)
        return
      }
      if (e.key === "Tab" || e.key === "Enter") {
        if (e.key === "Enter" && !e.shiftKey) {
          // Enter completes the selected mention; Shift+Enter keeps its newline behavior.
          e.preventDefault()
          insertMention(filteredAgents()[editor.selectedIndex])
          return
        }
        if (e.key === "Tab") {
          e.preventDefault()
          insertMention(filteredAgents()[editor.selectedIndex])
          return
        }
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setEditor("showMentionMenu", false)
        return
      }
    }

    // Normal message sending (Enter without Shift)
    if (e.key === "Enter" && !e.shiftKey && (!editor.showMentionMenu || filteredAgents().length === 0)) {
      e.preventDefault()
      void submit()
    }
  }

  const submit = async () => {
    if (!content().trim() || props.disabled || delivery.sending) return
    const sent = content()
    const requestID = delivery.requestID || crypto.randomUUID()
    setDelivery({ sending: true, failed: false, requestID, requestContent: sent })
    try {
      await props.onSend(sent, requestID)
      if (content() === sent) setContent("")
      setDelivery({ requestID: "", requestContent: "" })
      stopTyping()
    } catch {
      setDelivery("failed", true)
    } finally {
      setDelivery("sending", false)
      if (!disposed) textareaRef?.focus()
    }
  }

  const insertMention = (agent: AgentDescriptor) => {
    if (delivery.sending || !textareaRef) return

    const cursorPos = textareaRef.selectionStart
    const textBeforeCursor = content().slice(0, cursorPos)
    const textAfterCursor = content().slice(cursorPos)

    // Remove the partial mention and insert the full one
    const mentionMatch = textBeforeCursor.match(/@(\w*)$/)
    if (mentionMatch) {
      const beforeMention = textBeforeCursor.slice(0, mentionMatch.index)
      const newContent = `${beforeMention}@${agent.id} ${textAfterCursor}`
      setContent(newContent)

      // Set cursor position after the mention
      setTimeout(() => {
        if (disposed || !textareaRef) return
        const newCursorPos = beforeMention.length + agent.id.length + 2
        textareaRef.setSelectionRange(newCursorPos, newCursorPos)
        textareaRef.focus()
      }, 0)
    }

    setEditor("showMentionMenu", false)
  }

  return (
    <div class="relative shrink-0 border-t border-border-weaker-base p-3">
      <textarea
        ref={textareaRef}
        value={content()}
        onInput={(e) => {
          setContent(e.currentTarget.value)
          if (e.currentTarget.value.trim()) signalTyping()
          else stopTyping()
        }}
        onKeyDown={handleKeyDown}
        placeholder={props.placeholder ?? language.t("im.composer.placeholder")}
        aria-label={props.placeholder ?? language.t("im.composer.placeholder")}
        disabled={props.disabled}
        readOnly={delivery.sending}
        aria-busy={delivery.sending}
        class="w-full p-2.5 bg-surface-panel border border-border-weak-base rounded-md resize-none focus:outline-none focus:border-border-active text-13-regular text-text-base placeholder:text-text-weak"
        rows={3}
      />
      <Show when={delivery.failed}>
        <p role="alert" class="mt-1 text-12-regular text-text-critical">
          {language.t("im.composer.failed")}
        </p>
      </Show>

      <Show when={editor.showMentionMenu && filteredAgents().length > 0}>
        <div
          class="absolute left-3 right-3 min-w-0 bg-surface-raised-base border border-border-base rounded-lg shadow-lg max-h-60 overflow-y-auto z-50"
          style={{
            bottom: `calc(100% - ${editor.mentionPosition.top}px + 8px)`,
          }}
        >
          <For each={filteredAgents()}>
            {(agent, index) => (
              <button
                type="button"
                class={`w-full px-4 py-2 text-left hover:bg-surface-raised-base-hover ${
                  index() === editor.selectedIndex ? "bg-surface-raised-base-hover" : ""
                }`}
                onClick={() => insertMention(agent)}
                onMouseEnter={() => setEditor("selectedIndex", index())}
              >
                <div class="font-medium text-text-strong">@{agent.id}</div>
                <Show when={agent.description}>
                  <div class="text-xs text-text-weak truncate">{agent.description}</div>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="mt-2 flex items-center justify-between gap-2">
        <div class="min-w-0 text-11-regular text-text-weak">{language.t("im.composer.hint")}</div>
        <Show when={props.onAttach}>
          <input ref={fileInputRef} type="file" class="hidden" onChange={handleFileSelected} />
          <button
            type="button"
            class="shrink-0 flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50"
            disabled={props.disabled || editor.uploading || delivery.sending}
            onClick={() => fileInputRef?.click()}
            aria-label={language.t("im.composer.attach")}
          >
            {editor.uploading ? language.t("im.composer.uploading") : language.t("im.composer.attach")}
          </button>
        </Show>
        <Button
          class="shrink-0"
          variant="primary"
          size="small"
          disabled={props.disabled || delivery.sending || !content().trim()}
          onClick={() => void submit()}
        >
          {delivery.sending ? language.t("im.composer.sending") : language.t("im.composer.send")}
        </Button>
      </div>
    </div>
  )
}

// Helper function to get caret coordinates in textarea
function getCaretCoordinates(element: HTMLTextAreaElement, position: number) {
  const div = document.createElement("div")
  const style = getComputedStyle(element)

  // Copy styles
  Array.from({ length: style.length }, (_, index) => style.item(index)).forEach((property) =>
    div.style.setProperty(property, style.getPropertyValue(property)),
  )

  div.style.position = "absolute"
  div.style.visibility = "hidden"
  div.style.whiteSpace = "pre-wrap"
  div.style.wordWrap = "break-word"

  const text = element.value.substring(0, position)
  div.textContent = text

  const span = document.createElement("span")
  span.textContent = element.value.substring(position) || "."
  div.appendChild(span)

  document.body.appendChild(div)

  const rect = element.getBoundingClientRect()
  const spanRect = span.getBoundingClientRect()

  document.body.removeChild(div)

  return {
    top: spanRect.top - rect.top,
    left: spanRect.left - rect.left,
  }
}
