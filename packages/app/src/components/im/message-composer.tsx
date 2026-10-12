import { createMemo, createEffect, onCleanup, Show, For } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { useLanguage } from "@/context/language"
import type { AgentDescriptor } from "./types"
import { createComposerDraft, type ComposerDraft } from "./composer-draft"
import { parseDacCommand } from "./personal-command"

interface MessageComposerProps {
  onSend: (content: string, clientRequestID: string) => void | Promise<void>
  onDac?: (text: string, delivery: "queue" | "steer") => boolean | void | Promise<boolean | void>
  onTyping?: (typing: boolean) => void
  agents: AgentDescriptor[]
  disabled?: boolean
  draft?: ComposerDraft
  // The panel persists uploads in its attachment draft; selecting files never sends a message.
  onAttach?: (files: readonly File[]) => Promise<void>
  hasAttachments?: boolean
  attachmentLimit?: number
  attachmentBusy?: boolean
  sendDisabled?: boolean
  // Placeholder override (e.g. thread replies read "Reply in thread…").
  placeholder?: string
}

export function MessageComposer(props: MessageComposerProps) {
  const language = useLanguage()
  const draft = props.draft ?? createComposerDraft()
  const delivery = draft.state
  const setDelivery = draft.setState
  const content = () => draft.state.content
  const privateCommand = () => parseDacCommand(content()) !== undefined
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
    dacDelivery: "queue" as "queue" | "steer",
  })
  let textareaRef: HTMLTextAreaElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let typingActive = false
  let typingStopTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const handleFileSelected = async (e: Event & { currentTarget: HTMLInputElement }) => {
    const files = Array.from(e.currentTarget.files ?? [])
    e.currentTarget.value = ""
    if (!files.length || !props.onAttach || editor.uploading || delivery.sending) return
    setEditor("uploading", true)
    try {
      await props.onAttach(files)
    } finally {
      if (!disposed) setEditor("uploading", false)
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
    if (delivery.sending) setDelivery({ sending: false, failed: true })
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
    if (
      (!content().trim() && !props.hasAttachments) ||
      props.disabled ||
      props.sendDisabled ||
      delivery.sending ||
      props.attachmentBusy
    )
      return
    const sent = content()
    const command = parseDacCommand(sent)
    if (command !== undefined) {
      if (!props.onDac || props.hasAttachments) return
      const accepted = await props.onDac(command, editor.dacDelivery)
      if (accepted === false) return
      if (!disposed && content() === sent) setContent("")
      return
    }
    const requestID = delivery.requestID || crypto.randomUUID()
    setDelivery({ sending: true, failed: false, requestID, requestContent: sent })
    try {
      await props.onSend(sent, requestID)
      if (disposed) return
      if (content() === sent) setContent("")
      setDelivery({ requestID: "", requestContent: "" })
      stopTyping()
    } catch {
      if (!disposed) setDelivery("failed", true)
    } finally {
      if (!disposed) {
        setDelivery("sending", false)
        textareaRef?.focus()
      }
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
      <Show when={props.onDac && /^\/(?:d(?:a(?:c)?)?)?$/.test(content())}>
        <Button
          size="small"
          variant="ghost"
          onClick={() => {
            void props.onDac?.("", "queue")
          }}
        >
          {language.t("im.dac.activate")}
        </Button>
      </Show>
      <Show when={props.onDac && parseDacCommand(content()) !== undefined}>
        <div class="flex items-center gap-2 text-11-regular text-text-weak">
          <span>{language.t("im.dac.private")}</span>
          <select
            aria-label={language.t("im.dac.delivery")}
            value={editor.dacDelivery}
            onChange={(event) => setEditor("dacDelivery", event.currentTarget.value === "steer" ? "steer" : "queue")}
          >
            <option value="queue">{language.t("im.dac.queue")}</option>
            <option value="steer">{language.t("im.dac.steer")}</option>
          </select>
        </div>
      </Show>
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
      <Show when={privateCommand() && props.hasAttachments}>
        <p role="alert" class="mt-1 text-12-regular text-text-weak">
          {language.t("im.dac.attachments")}
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
          <input ref={fileInputRef} type="file" multiple class="hidden" onChange={handleFileSelected} />
          <button
            type="button"
            class="shrink-0 flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50"
            disabled={
              props.disabled ||
              editor.uploading ||
              delivery.sending ||
              props.attachmentBusy ||
              privateCommand() ||
              props.attachmentLimit === 0
            }
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
          disabled={
            props.disabled ||
            props.sendDisabled ||
            delivery.sending ||
            props.attachmentBusy ||
            (privateCommand() && (!!props.hasAttachments || !props.onDac)) ||
            (!content().trim() && !props.hasAttachments)
          }
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
