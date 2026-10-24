import { createEffect, For, Show } from "solid-js"
import { IconButton } from "@deepagent-code/ui/icon-button"
import type { WorkPanelView } from "@/context/work-panel-state"
import { useLanguage } from "@/context/language"

export function WorkPanelTabs(props: {
  tabs: WorkPanelView[]
  active?: string
  expanded: boolean
  compact?: boolean
  title: (view: WorkPanelView) => string
  focus: (id: string) => void
  close: (id: string) => void
  home: () => void
  expand: () => void
  hide: () => void
}) {
  const language = useLanguage()
  const text = (key: string) => language.t(`workPanel.${key}` as Parameters<typeof language.t>[0])
  return (
    <div
      class="flex h-11 min-w-0 shrink-0 items-center gap-1 px-2"
      data-slot="work-panel-tabs"
      data-compact={props.compact ? "true" : undefined}
      onPointerDown={(event) => {
        event.currentTarget.querySelectorAll<HTMLElement>("[data-work-panel-keyboard-focus]").forEach((tab) => {
          delete tab.dataset.workPanelKeyboardFocus
        })
      }}
    >
      <Show
        when={!props.compact}
        fallback={
          <>
            <IconButton
              icon="chevron-left"
              size="small"
              variant="ghost"
              aria-label={text("returnMain")}
              onClick={() => {
                props.hide()
                document.querySelector<HTMLElement>('[data-component="prompt-input"][contenteditable="true"]')?.focus()
              }}
            />
            <span class="min-w-0 truncate px-2 text-12-medium">{language.t("session.tab.im")}</span>
          </>
        }
      >
        <div
          class="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          role="tablist"
          aria-label={text("openViews")}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              if (document.activeElement instanceof HTMLElement) {
                delete document.activeElement.dataset.workPanelKeyboardFocus
              }
              return
            }
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            if (index < 0) return
            event.preventDefault()
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length
            const tab = buttons[next]
            if (!tab) return
            tab.dataset.workPanelKeyboardFocus = "true"
            tab.focus()
            tab.click()
          }}
        >
          <For each={props.tabs}>
            {(tab) => (
              <div
                class="flex min-w-0 max-w-44 shrink-0 items-center rounded-md"
                classList={{ "bg-surface-raised-base": props.active === tab.id }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={props.active === tab.id}
                  tabIndex={props.active === tab.id ? 0 : -1}
                  class="min-w-0 truncate rounded-md px-2 py-1.5 text-12-regular hover:bg-surface-raised-base-hover"
                  title={props.title(tab)}
                  onBlur={(event) => delete event.currentTarget.dataset.workPanelKeyboardFocus}
                  onClick={() => props.focus(tab.id)}
                >
                  {props.title(tab)}
                </button>
                <IconButton
                  icon="close-small"
                  size="small"
                  variant="ghost"
                  class="size-5 shrink-0"
                  aria-label={`${text("closeView")}: ${props.title(tab)}`}
                  onClick={() => props.close(tab.id)}
                />
              </div>
            )}
          </For>
        </div>
        <Show when={props.tabs.length > 2}>
          <select
            class="w-7 shrink-0 rounded-md bg-transparent text-12-regular"
            aria-label={text("openViews")}
            ref={(select) =>
              createEffect(() => {
                // Synchronize after For has inserted the active option.
                select.value = props.tabs.find((tab) => tab.id === props.active)?.id ?? ""
              })
            }
            onChange={(event) => props.focus(event.currentTarget.value)}
          >
            <For each={props.tabs}>{(tab) => <option value={tab.id}>{props.title(tab)}</option>}</For>
          </select>
        </Show>
        <IconButton icon="plus" size="small" variant="ghost" aria-label={text("home")} onClick={props.home} />
        <IconButton
          icon={props.expanded ? "collapse" : "expand"}
          size="small"
          variant="ghost"
          aria-label={text(props.expanded ? "restore" : "expand")}
          onClick={props.expand}
        />
        <IconButton
          icon="close-small"
          size="small"
          variant="ghost"
          aria-label={language.t("session.sidePanel.toggle")}
          onClick={props.hide}
        />
      </Show>
    </div>
  )
}
