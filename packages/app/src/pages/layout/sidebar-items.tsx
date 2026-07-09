import type { Session } from "@deepagent-code/sdk/v2/client"
import { Avatar } from "@deepagent-code/ui/avatar"
import { Icon } from "@deepagent-code/ui/icon"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { InlineInput } from "@deepagent-code/ui/inline-input"
import { ContextMenu } from "@deepagent-code/ui/context-menu"
import { Spinner } from "@deepagent-code/ui/spinner"
import { Tooltip } from "@deepagent-code/ui/tooltip"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { getFilename } from "@deepagent-code/core/util/path"
import { Binary } from "@deepagent-code/core/util/binary"
import { A } from "@solidjs/router"
import { type Accessor, createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { produce } from "solid-js/store"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { getAvatarColors, type LocalProject, useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { formatSessionTime } from "@/utils/session-time"
import { showToast } from "@/utils/toast"
import { DialogDeleteSession } from "./sidebar-delete-session"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import {
  directChildSessions,
  getProjectAvatarSource,
  hasProjectPermissions,
  MAX_SESSION_TREE_LEVEL,
} from "./helpers"

export const ProjectIcon = (props: {
  project: LocalProject
  class?: string
  notify?: boolean
  working?: boolean
}): JSX.Element => {
  const serverSync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  const dirs = createMemo(() => [props.project.worktree, ...(props.project.sandboxes ?? [])])
  const unseenCount = createMemo(() =>
    dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const hasError = createMemo(() => dirs().some((directory) => notification.project.unseenHasError(directory)))
  const hasPermissions = createMemo(() =>
    dirs().some((directory) => {
      const [store] = serverSync.child(directory, { bootstrap: false })
      return hasProjectPermissions(store.permission, (item) => !permission.autoResponds(item, directory))
    }),
  )
  const notify = createMemo(() => props.notify && (hasPermissions() || unseenCount() > 0))
  const name = createMemo(() => props.project.name || getFilename(props.project.worktree))

  return (
    <div class={`relative size-8 shrink-0 rounded ${props.class ?? ""}`}>
      <div class="size-full rounded overflow-clip">
        <Avatar
          fallback={name()}
          src={getProjectAvatarSource(props.project.id, props.project.icon)}
          {...getAvatarColors(props.project.icon?.color)}
          class="size-full rounded"
          classList={{ "badge-mask": notify() }}
        />
      </div>
      <Show when={notify()}>
        <div
          classList={{
            "absolute top-px right-px size-1.5 rounded-full z-10": true,
            "bg-surface-warning-strong": hasPermissions(),
            "bg-icon-critical-base": !hasPermissions() && hasError(),
            "bg-text-interactive-base": !hasPermissions() && !hasError(),
          }}
        />
      </Show>
      <Show when={props.working}>
        <div class="absolute bottom-px right-px size-3 rounded-full bg-background-base z-10 flex items-center justify-center">
          <Spinner class="size-[9px]" />
        </div>
      </Show>
    </div>
  )
}

export type SessionItemProps = {
  session: Session
  list: Session[]
  navList?: Accessor<Session[]>
  slug: string
  mobile?: boolean
  dense?: boolean
  showTooltip?: boolean
  showChild?: boolean
  level?: number
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
}

const SessionRow = (props: {
  session: Session
  slug: string
  mobile?: boolean
  dense?: boolean
  tint: Accessor<string | undefined>
  isWorking: Accessor<boolean>
  hasPermissions: Accessor<boolean>
  hasError: Accessor<boolean>
  unseenCount: Accessor<number>
  clearHoverProjectSoon: () => void
  sidebarOpened: Accessor<boolean>
  warmPress: () => void
  warmFocus: () => void
  editing: Accessor<boolean>
  onStartRename: () => void
  onSaveRename: (next: string) => void
  onCancelRename: () => void
}): JSX.Element => {
  const language = useLanguage()
  const title = () => sessionTitle(props.session.title)
  const time = createMemo(() => {
    const t = props.session.time
    const at = t.updated ?? t.created
    if (typeof at !== "number") return ""
    return formatSessionTime(at, language.intl())
  })

  const [draft, setDraft] = createSignal("")
  const beginRename = (event: MouseEvent) => {
    // Double-click the title to rename in place; suppress the link navigation the dblclick would fire.
    event.preventDefault()
    event.stopPropagation()
    setDraft(title() ?? "")
    props.onStartRename()
  }
  const commit = () => props.onSaveRename(draft().trim())

  return (
    <A
      href={`/${props.slug}/session/${props.session.id}`}
      class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onPointerDown={props.warmPress}
      onFocus={props.warmFocus}
      onClick={(event) => {
        if (props.editing()) {
          event.preventDefault()
          return
        }
        if (props.sidebarOpened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <Show when={props.isWorking() || props.hasPermissions() || props.hasError() || props.unseenCount() > 0}>
        <div
          class="shrink-0 size-6 flex items-center justify-center"
          style={{ color: props.tint() ?? "var(--icon-interactive-base)" }}
        >
          <Switch>
            <Match when={props.isWorking()}>
              <Spinner class="size-[15px]" />
            </Match>
            <Match when={props.hasPermissions()}>
              <div class="size-1.5 rounded-full bg-surface-warning-strong" />
            </Match>
            <Match when={props.hasError()}>
              <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
            </Match>
            <Match when={props.unseenCount() > 0}>
              <div class="size-1.5 rounded-full bg-text-interactive-base" />
            </Match>
          </Switch>
        </div>
      </Show>
      <Show
        when={props.editing()}
        fallback={
          <span class="text-14-regular text-text-strong min-w-0 flex-1 truncate" onDblClick={beginRename}>
            {title()}
          </span>
        }
      >
        <InlineInput
          ref={(el) => {
            requestAnimationFrame(() => {
              if (!el.isConnected) return
              el.focus()
              el.select()
            })
          }}
          value={draft()}
          class="text-14-regular text-text-strong min-w-0 flex-1 rounded-[6px] pl-1 -ml-1"
          style={{ "--inline-input-shadow": "var(--shadow-xs-border-select)" }}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onClick={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter") {
              event.preventDefault()
              commit()
              return
            }
            if (event.key === "Escape") {
              event.preventDefault()
              props.onCancelRename()
            }
          }}
          onBlur={commit}
        />
      </Show>
      <Show when={time() && !props.editing()}>
        <span
          class="shrink-0 text-12-regular text-text-weaker tabular-nums transition-opacity group-hover/session:opacity-0 group-focus-within/session:opacity-0"
          aria-hidden="true"
        >
          {time()}
        </span>
      </Show>
    </A>
  )
}

export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const layout = useLayout()
  const language = useLanguage()
  const notification = useNotification()
  const permission = usePermission()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const dialog = useDialog()
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const [sessionStore, setSessionStore] = serverSync.child(props.session.directory)

  const [editing, setEditing] = createSignal(false)
  // The context menu defers opening the rename editor until it has closed (via onCloseAutoFocus), so
  // focus lands on the input rather than being stolen back by the menu teardown.
  let pendingRename = false

  const startRename = () => setEditing(true)
  const cancelRename = () => setEditing(false)
  const saveRename = (next: string) => {
    setEditing(false)
    const current = sessionTitle(props.session.title) ?? ""
    if (!next || next === current) return
    // Optimistic: patch the per-directory store immediately, then persist. Roll back on failure.
    const previous = props.session.title
    setSessionStore(
      produce((draft) => {
        const match = Binary.search(draft.session, props.session.id, (s) => s.id)
        if (match.found) draft.session[match.index].title = next
      }),
    )
    void serverSDK.client.session
      .update({ directory: props.session.directory, sessionID: props.session.id, title: next })
      .catch((err: unknown) => {
        setSessionStore(
          produce((draft) => {
            const match = Binary.search(draft.session, props.session.id, (s) => s.id)
            if (match.found) draft.session[match.index].title = previous
          }),
        )
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }
  const deleteSession = () => dialog.show(() => <DialogDeleteSession session={props.session} />)
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.session.id, (item) => {
      return !permission.autoResponds(item, props.session.directory)
    })
  })
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    return sessionStore.session_working(props.session.id)
  })

  const tint = createMemo(() => messageAgentColor(sessionStore.message[props.session.id], sessionStore.agent))
  const tooltip = createMemo(() => props.showTooltip ?? (props.mobile || !props.sidebarExpanded()))
  const level = createMemo(() => props.level ?? 0)
  // Folder-style nesting: show ALL direct children (subagents + forks) under this row, capped at the
  // same depth as the backend fork limit. Stops descending past the cap so a corrupted lineage chain
  // can't recurse without bound.
  const childSessions = createMemo(() => {
    if (!props.showChild) return []
    if (level() >= MAX_SESSION_TREE_LEVEL) return []
    return directChildSessions(sessionStore.session, props.session.id)
  })

  const warm = (span: number, priority: "high" | "low") => {
    const nav = props.navList?.()
    const list = nav?.some((item) => item.id === props.session.id && item.directory === props.session.directory)
      ? nav
      : props.list

    props.prefetchSession(props.session, priority)

    const idx = list.findIndex((item) => item.id === props.session.id && item.directory === props.session.directory)
    if (idx === -1) return

    for (let step = 1; step <= span; step++) {
      const next = list[idx + step]
      if (next) props.prefetchSession(next, step === 1 ? "high" : priority)

      const prev = list[idx - step]
      if (prev) props.prefetchSession(prev, step === 1 ? "high" : priority)
    }
  }

  const item = (
    <SessionRow
      session={props.session}
      slug={props.slug}
      mobile={props.mobile}
      dense={props.dense}
      tint={tint}
      isWorking={isWorking}
      hasPermissions={hasPermissions}
      hasError={hasError}
      unseenCount={unseenCount}
      clearHoverProjectSoon={props.clearHoverProjectSoon}
      sidebarOpened={layout.sidebar.opened}
      warmPress={() => warm(2, "high")}
      warmFocus={() => warm(2, "high")}
      editing={editing}
      onStartRename={startRename}
      onSaveRename={saveRename}
      onCancelRename={cancelRename}
    />
  )

  return (
    <>
      <ContextMenu
        onOpenChange={(open) => {
          // When the context menu closes and a rename was requested from the menu item, open the
          // inline editor after the menu's focus-return animation finishes (onCloseAutoFocus fires).
          if (!open && pendingRename) {
            pendingRename = false
            // Small rAF so the focus truly leaves the closed menu before we set editing state.
            requestAnimationFrame(startRename)
          }
        }}
      >
        <ContextMenu.Trigger
          as="div"
          data-session-id={props.session.id}
          class="group/session relative w-full min-w-0 rounded-md cursor-default pr-3 transition-colors hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[[data-expanded]]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active"
          style={{ "padding-left": `${8 + (props.level ?? 0) * 16}px` }}
        >
          <div class="flex min-w-0 items-center gap-1">
            <div class="min-w-0 flex-1">
              <Show
                when={!tooltip()}
                fallback={
                  <Tooltip
                    placement={props.mobile ? "bottom" : "right"}
                    value={sessionTitle(props.session.title)}
                    gutter={10}
                    class="min-w-0 w-full"
                  >
                    {item}
                  </Tooltip>
                }
              >
                {item}
              </Show>
            </div>

            <Show when={!props.level}>
              <div
                class="shrink-0 overflow-hidden transition-[width,opacity]"
                classList={{
                  "w-6 opacity-100 pointer-events-auto": !!props.mobile,
                  "w-0 opacity-0 pointer-events-none": !props.mobile,
                  "group-hover/session:w-6 group-hover/session:opacity-100 group-hover/session:pointer-events-auto": true,
                  "group-focus-within/session:w-6 group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto": true,
                }}
              >
                <Tooltip value={language.t("common.archive")} placement="top">
                  <IconButton
                    icon="archive"
                    variant="ghost"
                    class="size-6 rounded-md"
                    aria-label={language.t("common.archive")}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      void props.archiveSession(props.session)
                    }}
                  />
                </Tooltip>
              </div>
            </Show>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content>
            <ContextMenu.Item
              onSelect={() => {
                // Defer rename to onCloseAutoFocus so focus isn't stolen back by menu teardown.
                pendingRename = true
              }}
            >
              <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Item onSelect={() => void props.archiveSession(props.session)}>
              <ContextMenu.ItemLabel>{language.t("common.archive")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={deleteSession}>
              <ContextMenu.ItemLabel>{language.t("common.delete")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu>
      <Show when={childSessions().length > 0}>
        <div class="w-full">
          <For each={childSessions()}>
            {(child) => <SessionItem {...props} session={child} list={childSessions()} level={level() + 1} />}
          </For>
        </div>
      </Show>
    </>
  )
}

export const NewSessionItem = (props: {
  slug: string
  mobile?: boolean
  dense?: boolean
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
}): JSX.Element => {
  const layout = useLayout()
  const language = useLanguage()
  const label = language.t("command.session.new")
  const tooltip = () => props.mobile || !props.sidebarExpanded()
  const item = (
    <A
      href={`/${props.slug}/session`}
      end
      class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onClick={() => {
        if (layout.sidebar.opened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div class="shrink-0 size-6 flex items-center justify-center">
        <Icon name="new-session" size="small" class="text-icon-weak" />
      </div>
      <span class="text-14-regular text-text-strong min-w-0 flex-1 truncate">{label}</span>
    </A>
  )

  return (
    <div class="group/session relative w-full min-w-0 rounded-md cursor-default transition-colors pl-2 pr-3 hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active">
      <Show
        when={!tooltip()}
        fallback={
          <Tooltip placement={props.mobile ? "bottom" : "right"} value={label} gutter={10} class="min-w-0 w-full">
            {item}
          </Tooltip>
        }
      >
        {item}
      </Show>
    </div>
  )
}

export const SessionSkeleton = (props: { count?: number }): JSX.Element => {
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  return (
    <div class="flex flex-col gap-1">
      <For each={items}>
        {() => <div class="h-8 w-full rounded-md bg-surface-raised-base opacity-60 animate-pulse" />}
      </For>
    </div>
  )
}
