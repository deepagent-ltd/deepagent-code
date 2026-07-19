import { createSignal, createMemo, createEffect, onCleanup, Show, For } from "solid-js"
import type { AgentDescriptor } from "./types"

interface MessageComposerProps {
  onSend: (content: string) => void
  onTyping?: (typing: boolean) => void
  agents: AgentDescriptor[]
  disabled?: boolean
}

export function MessageComposer(props: MessageComposerProps) {
  const [content, setContent] = createSignal("")
  const [showMentionMenu, setShowMentionMenu] = createSignal(false)
  const [mentionQuery, setMentionQuery] = createSignal("")
  const [mentionPosition, setMentionPosition] = createSignal({ top: 0, left: 0 })
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  let textareaRef: HTMLTextAreaElement | undefined
  let typingActive = false
  let typingStopTimer: ReturnType<typeof setTimeout> | undefined

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

  onCleanup(stopTyping)

  // Filter agents based on mention query
  const filteredAgents = createMemo(() => {
    const query = mentionQuery()
    if (!query) return props.agents
    const lowerQuery = query.toLowerCase()
    return props.agents.filter((agent) =>
      agent.id.toLowerCase().includes(lowerQuery) ||
      agent.displayName?.toLowerCase().includes(lowerQuery) ||
      agent.description?.toLowerCase().includes(lowerQuery)
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
      setMentionQuery(mentionMatch[1])
      setShowMentionMenu(true)
      setSelectedIndex(0)

      // Calculate position for the dropdown
      const coords = getCaretCoordinates(textareaRef, cursorPos)
      setMentionPosition({
        top: coords.top - textareaRef.scrollTop,
        left: coords.left,
      })
    } else {
      setShowMentionMenu(false)
      setMentionQuery("")
    }
  })

  const handleKeyDown = (e: KeyboardEvent) => {
    if (showMentionMenu() && filteredAgents().length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((prev) => (prev + 1) % filteredAgents().length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((prev) => (prev - 1 + filteredAgents().length) % filteredAgents().length)
        return
      }
      if (e.key === "Tab" || e.key === "Enter") {
        if (e.key === "Enter" && !e.shiftKey) {
          // Only handle Tab and Shift+Enter for mention completion
          e.preventDefault()
          insertMention(filteredAgents()[selectedIndex()])
          return
        }
        if (e.key === "Tab") {
          e.preventDefault()
          insertMention(filteredAgents()[selectedIndex()])
          return
        }
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setShowMentionMenu(false)
        return
      }
    }

    // Normal message sending (Enter without Shift)
    if (e.key === "Enter" && !e.shiftKey && !showMentionMenu()) {
      e.preventDefault()
      if (content().trim() && !props.disabled) {
        props.onSend(content())
        setContent("")
        stopTyping()
      }
    }
  }

  const insertMention = (agent: AgentDescriptor) => {
    if (!textareaRef) return

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
        if (!textareaRef) return
        const newCursorPos = beforeMention.length + agent.id.length + 2
        textareaRef.setSelectionRange(newCursorPos, newCursorPos)
        textareaRef.focus()
      }, 0)
    }

    setShowMentionMenu(false)
  }

  return (
    <div class="relative border-t border-border-base p-4">
      <textarea
        ref={textareaRef}
        value={content()}
        onInput={(e) => {
          setContent(e.currentTarget.value)
          if (e.currentTarget.value.trim()) signalTyping()
          else stopTyping()
        }}
        onKeyDown={handleKeyDown}
        placeholder="Type a message... Use @ to mention agents"
        disabled={props.disabled}
        class="w-full p-3 bg-surface-base border border-border-base rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-accent-base text-text-base placeholder:text-text-weak"
        rows={3}
      />

      <Show when={showMentionMenu() && filteredAgents().length > 0}>
        <div
          class="absolute bg-surface-raised-base border border-border-base rounded-lg shadow-lg max-h-60 overflow-y-auto z-50"
          style={{
            bottom: `calc(100% - ${mentionPosition().top}px + 8px)`,
            left: `${mentionPosition().left}px`,
            "min-width": "250px",
          }}
        >
          <For each={filteredAgents()}>
            {(agent, index) => (
              <button
                type="button"
                class={`w-full px-4 py-2 text-left hover:bg-surface-raised-base-hover ${
                  index() === selectedIndex() ? "bg-surface-raised-base-hover" : ""
                }`}
                onClick={() => insertMention(agent)}
                onMouseEnter={() => setSelectedIndex(index())}
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

      <div class="mt-2 text-xs text-text-weak">
        Press <kbd class="px-1 py-0.5 bg-surface-raised-base border border-border-base rounded">Enter</kbd> to
        send, <kbd class="px-1 py-0.5 bg-surface-raised-base border border-border-base rounded">Shift+Enter</kbd>{" "}
        for new line
      </div>
    </div>
  )
}

// Helper function to get caret coordinates in textarea
function getCaretCoordinates(element: HTMLTextAreaElement, position: number) {
  const div = document.createElement("div")
  const style = getComputedStyle(element)

  // Copy styles
  for (const prop of style) {
    // @ts-ignore
    div.style[prop] = style[prop]
  }

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
