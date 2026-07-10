import { Popover as Kobalte } from "@kobalte/core/popover"
import { type Component, type ComponentProps, createMemo, type JSX, Show, type ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import { List, type ListRef } from "@deepagent-code/ui/list"

/**
 * Composer collaboration-mode selector.
 *
 * Replaces the old label-only <Select> mode switcher with a LARGE popup (mirroring the model
 * picker) where each mode is a bold title + a dimmed one-line description. It lists the primary
 * agents (auto / loop / design — subagents and hidden agents are already filtered out by
 * local.agent.list()), marks the active one with a trailing check, and switches on select.
 *
 * The mode is SESSION-scoped: local.agent.set(name) persists per session via the model-selection
 * store. The command.agent.cycle keybind (local.agent.move) remains the keyboard way to cycle; this
 * popup is an additional pointer/keyboard way to pick.
 */

type Agent = ReturnType<ReturnType<typeof useLocal>["agent"]["list"]>[number]
type Dismiss = "escape" | "outside" | "select"
type ModeName = "auto" | "loop" | "design"

const MODE_LABEL_KEY = {
  auto: "composer.mode.auto",
  loop: "composer.mode.loop",
  design: "composer.mode.design",
} as const

const MODE_DESC_KEY = {
  auto: "composer.mode.auto.desc",
  loop: "composer.mode.loop.desc",
  design: "composer.mode.design.desc",
} as const

const isModeName = (name: string): name is ModeName => name in MODE_LABEL_KEY

/**
 * The localized display label for a mode name — used both by the popup rows and the composer trigger
 * (so the closed trigger shows "自动/目标/设计", not the raw agent name). Falls back to the raw name
 * for custom primary agents that have no composer.mode.* key.
 */
export const useModeLabel = () => {
  const language = useLanguage()
  return (name: string | undefined): string => {
    if (!name) return language.t("command.agent.cycle")
    if (isModeName(name)) {
      const label = language.t(MODE_LABEL_KEY[name])
      if (label) return label
    }
    return name
  }
}

type ModeSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">

export function ModeSelector(props: {
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModeSelectorTriggerProps
  onClose?: (cause: "escape" | "select") => void
}) {
  const local = useLocal()
  const language = useLanguage()

  const [store, setStore] = createStore<{ open: boolean; dismiss: Dismiss | null }>({
    open: false,
    dismiss: null,
  })

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  const modes = createMemo(() => local.agent.list())

  const modeLabel = useModeLabel()
  const title = (agent: Agent) => modeLabel(agent.name)

  const description = (agent: Agent) => {
    if (isModeName(agent.name)) {
      const desc = language.t(MODE_DESC_KEY[agent.name])
      if (desc) return desc
    }
    return agent.description ?? ""
  }

  let listRef: ListRef | undefined

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          class="w-80 max-h-96 flex flex-col p-2 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden
            [&_[data-slot=list-item][data-selected=true]]:!bg-surface-interactive-base
            [&_[data-slot=list-item][data-selected=true]]:rounded-md
            [&_[data-slot=list-item][data-selected=true]_span]:!text-on-interactive-base
            [&_[data-slot=list-item][data-selected=true]_[data-slot=list-item-selected-icon]_[data-component=icon]]:!text-icon-on-interactive-base"
          onKeyDown={(event) => listRef?.onKeyDown(event)}
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("command.agent.cycle")}</Kobalte.Title>
          <List
            ref={(ref) => (listRef = ref)}
            class="flex-1 min-h-0 p-1 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
            key={(agent) => agent.name}
            items={modes()}
            current={local.agent.current()}
            onSelect={(agent) => {
              if (!agent) return
              local.agent.set(agent.name)
              close("select")
            }}
          >
            {(agent) => (
              // flex-1 + text-left so the content is left-aligned and the check (a sibling the List
              // renders after this) keeps its own slot on the right instead of being pushed flush to
              // the frame. pr-2 reserves breathing room before the check.
              <div class="flex flex-1 min-w-0 flex-col gap-0.5 pr-2 text-left">
                <span class="text-13-medium text-text-base capitalize">{title(agent)}</span>
                <Show when={description(agent)}>
                  <span class="text-11-regular text-text-weaker whitespace-normal leading-snug">{description(agent)}</span>
                </Show>
              </div>
            )}
          </List>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
