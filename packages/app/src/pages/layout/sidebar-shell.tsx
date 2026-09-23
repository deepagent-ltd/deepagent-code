import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { DragDropProvider, DragOverlay, SortableProvider, closestCenter, type DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragXAxis, FixedDragDropSensors } from "@/utils/solid-dnd"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@deepagent-code/ui/tooltip"
import { type LocalProject } from "@/context/layout"

export const SidebarContent = (props: {
  mobile?: boolean
  opened: Accessor<boolean>
  aimMove: (event: MouseEvent) => void
  projects: Accessor<LocalProject[]>
  renderProject: (project: Accessor<LocalProject>) => JSX.Element
  handleDragStart: (event: unknown) => void
  handleDragEnd: () => void
  handleDragOver: (event: DragEvent) => void
  openProjectLabel: JSX.Element
  openProjectKeybind: Accessor<string | undefined>
  onOpenProject: () => void
  renderProjectOverlay: () => JSX.Element
  settingsLabel: Accessor<string>
  settingsKeybind: Accessor<string | undefined>
  onOpenSettings: () => void
  historyLabel: Accessor<string>
  onOpenHistory: () => void
  knowledgeLabel: Accessor<string>
  onOpenKnowledge: () => void
  reviewPending?: Accessor<boolean>
  archivedLabel: Accessor<string>
  onOpenArchived: () => void
  renderPanel: () => JSX.Element
}): JSX.Element => {
  const expanded = createMemo(() => !!props.mobile || props.opened())
  const placement = () => (props.mobile ? "bottom" : "right")
  let panel: HTMLDivElement | undefined

  createEffect(() => {
    const el = panel
    if (!el) return
    if (expanded()) {
      el.removeAttribute("inert")
      return
    }
    el.setAttribute("inert", "")
  })

  return (
    <div class="flex h-full w-full min-w-0 overflow-hidden">
      <div
        data-component="sidebar-rail"
        class="w-16 shrink-0 bg-background-base flex flex-col items-center overflow-hidden"
        onMouseMove={props.aimMove}
      >
        <div class="flex-1 min-h-0 w-full">
          <DragDropProvider
            onDragStart={props.handleDragStart}
            onDragEnd={props.handleDragEnd}
            onDragOver={props.handleDragOver}
            collisionDetector={closestCenter}
          >
            <FixedDragDropSensors />
            <ConstrainDragXAxis />
            <div class="h-full w-full flex flex-col items-center gap-3 px-3 py-3 overflow-y-auto no-scrollbar">
              <SortableProvider ids={props.projects().map((p) => p.worktree)}>
                {/* Keep component identity on worktree; project objects are rebuilt by list(). */}
                <For each={props.projects().map((p) => p.worktree)}>
                  {(worktree) => {
                    const initial = props.projects().find((p) => p.worktree === worktree)!
                    const project = createMemo(() => props.projects().find((p) => p.worktree === worktree) ?? initial)
                    return props.renderProject(project)
                  }}
                </For>
              </SortableProvider>
              <Tooltip
                placement={placement()}
                value={
                  <div class="flex items-center gap-2">
                    <span>{props.openProjectLabel}</span>
                    <Show when={!props.mobile && !!props.openProjectKeybind()}>
                      <span class="text-icon-base text-12-medium">{props.openProjectKeybind()}</span>
                    </Show>
                  </div>
                }
              >
                <IconButton
                  icon="folder-add-left"
                  variant="ghost"
                  size="large"
                  onClick={props.onOpenProject}
                  aria-label={typeof props.openProjectLabel === "string" ? props.openProjectLabel : undefined}
                />
              </Tooltip>
            </div>
            <DragOverlay>{props.renderProjectOverlay()}</DragOverlay>
          </DragDropProvider>
        </div>
        <div class="shrink-0 w-full pt-3 pb-6 flex flex-col items-center gap-2">
          <Tooltip placement={placement()} value={props.historyLabel()}>
            <IconButton
              icon="history"
              variant="ghost"
              size="large"
              onClick={props.onOpenHistory}
              aria-label={props.historyLabel()}
            />
          </Tooltip>
          <Tooltip placement={placement()} value={props.archivedLabel()}>
            <IconButton
              icon="archive"
              variant="ghost"
              size="large"
              onClick={props.onOpenArchived}
              aria-label={props.archivedLabel()}
            />
          </Tooltip>
          <Tooltip placement={placement()} value={props.knowledgeLabel()}>
            <div class="relative">
              <IconButton
                icon="knowledge-check"
                variant="ghost"
                size="large"
                onClick={props.onOpenKnowledge}
                aria-label={props.knowledgeLabel()}
              />
              <Show when={props.reviewPending?.()}>
                <span class="absolute top-1 right-1 size-2 rounded-full bg-text-interactive-base ring-2 ring-background-base" />
              </Show>
            </div>
          </Tooltip>
          <TooltipKeybind placement={placement()} title={props.settingsLabel()} keybind={props.settingsKeybind() ?? ""}>
            <IconButton
              icon="settings-gear"
              variant="ghost"
              size="large"
              onClick={props.onOpenSettings}
              aria-label={props.settingsLabel()}
            />
          </TooltipKeybind>
        </div>
      </div>

      <div
        ref={(el) => {
          panel = el
        }}
        classList={{ "flex-1 flex h-full min-h-0 min-w-0 overflow-hidden": true, "pointer-events-none": !expanded() }}
        aria-hidden={!expanded()}
      >
        {props.renderPanel()}
      </div>
    </div>
  )
}
