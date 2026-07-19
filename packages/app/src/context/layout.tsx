import { createStore, produce } from "solid-js/store"
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { useLocation } from "@solidjs/router"
import { createSimpleContext } from "@deepagent-code/ui/context"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useServerSync } from "./server-sync"
import { useServerSDK } from "./server-sdk"
import { ServerConnection, useServer } from "./server"
import { usePlatform } from "./platform"
import { Project } from "@deepagent-code/sdk/v2"
import { Persist, persisted, removePersisted } from "@/utils/persist"
import { decode64 } from "@/utils/base64"
import { same } from "@/utils/same"
import { createScrollPersistence, type SessionScroll } from "./layout-scroll"
import { createPathHelpers } from "./file/path"
import type { ProjectAvatarVariant } from "@deepagent-code/ui/v2/project-avatar-v2"
import { migrateLegacySessionStateKeys, ServerScope, SessionStateKey } from "@/utils/server-scope"
import {
  createSessionKeyReader,
  ensureSessionKey,
  isPanelOpen,
  movePanel,
  panelHost,
  pruneSessionKeys,
  revealPanel,
  toggleBottomPanel,
  togglePanel,
  toggledPanelMode,
  type PanelLocation,
  type PanelSessionState,
  type PanelTransitionInput,
  type PanelView,
} from "./layout-helpers"

export { createSessionKeyReader, ensureSessionKey, pruneSessionKeys }

export type { ProjectAvatarVariant }

const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
const DEFAULT_SIDEBAR_WIDTH = 344
const DEFAULT_FILE_TREE_WIDTH = 200
// Right panel width is stored as a fraction of the window width (ratio strategy) so it stays
// visually consistent across screen sizes / zoom levels. px is derived live from the current
// window width and clamped to [MIN_RIGHT_PANEL_PX, window * MAX_RIGHT_PANEL_RATIO].
const DEFAULT_RIGHT_PANEL_RATIO = 0.26
// T3.3 — the right panel remembers TWO widths, one per "bucket": WIDE panels (diff/files) want
// horizontal room; NARROW panels (subagent/im/oversight lists, browser, terminal-ish) read fine in a
// slimmer column. Each bucket keeps its own ratio so switching between a diff and a list does not drag
// one to the other's width. A slightly slimmer default for the narrow bucket.
const DEFAULT_RIGHT_PANEL_NARROW_RATIO = 0.2
const MIN_RIGHT_PANEL_PX = 300
const MAX_RIGHT_PANEL_RATIO = 0.6
// T3.2 — the always-on vertical icon rail is a fixed, non-resizable strip beside the content area.
export const RIGHT_PANEL_RAIL_PX = 44
export type RightPanelWidthBucket = "wide" | "narrow"
const FALLBACK_WINDOW_WIDTH = 1280
const DEFAULT_SESSION_WIDTH = 600
const DEFAULT_TERMINAL_HEIGHT = 280
export type AvatarColorKey = (typeof AVATAR_COLOR_KEYS)[number]

// ── Movable panel views ───────────────────────────────────────────────────────
// The three views that can live in the independent Bottom Panel or the session
// right panel. Other right-panel modes (DAP, PAP, review, files, ...) remain
// side-native and are deliberately excluded from this union.
export type DockPanelID = PanelView
export type DockLocation = PanelLocation
export const DOCK_PANEL_IDS: readonly DockPanelID[] = ["terminal", "debug-console", "problems"]
const DOCK_DEFAULT_LOCATION: Record<DockPanelID, DockLocation> = {
  terminal: "bottom",
  "debug-console": "bottom",
  problems: "bottom",
}

export function getAvatarColors(key?: string) {
  if (key && AVATAR_COLOR_KEYS.includes(key as AvatarColorKey)) {
    return {
      background: `var(--avatar-background-${key})`,
      foreground: `var(--avatar-text-${key})`,
    }
  }
  return {
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }
}

export function getProjectAvatarVariant(key?: string): ProjectAvatarVariant {
  if (key === "orange") return "orange"
  if (key === "pink") return "pink"
  if (key === "cyan") return "cyan"
  if (key === "purple") return "purple"
  if (key === "mint") return "cyan"
  if (key === "lime") return "green"
  return "gray"
}

type SessionTabs = {
  active?: string
  all: string[]
}

type SessionView = {
  scroll: Record<string, SessionScroll>
  reviewOpen?: string[]
  // U3/U4/U7: added "worktree" (isolated worktree diff/merge), "subagents" (child-session list),
  // "browser" (isolated WebContentsView).
  // T3.2: the "menu" mode is gone — an always-on icon rail replaced the full-panel menu list.
  rightPanelMode?:
    | "review"
    | "files"
    | "worktree"
    | "subagents"
    | "browser"
    | "mcp"
    | "plugins"
    | "profile"
    | "debug"
    | "im"
    | "oversight"
    // Movable panel views can also live in the side panel.
    | "terminal"
    | "debug-console"
    | "problems"
  bottomPanel?: {
    opened: boolean
    activeView?: DockPanelID
  }
  pendingMessage?: string
  pendingMessageAt?: number
  todoCollapsed?: boolean
}

type TabHandoff = {
  scope: ServerScope
  dir: string
  id: string
  at: number
}

export type LocalProject = Partial<Project> & { worktree: string; expanded: boolean }

export type ReviewDiffStyle = "unified" | "split"

export type LayoutRoute =
  | { type: "home" }
  | { type: "dir-new-sesssion"; dir: string; dirBase64: string; server?: ServerConnection.Key }
  | { type: "session"; dir: string; dirBase64: string; sessionId: string; server?: ServerConnection.Key }

function nextSessionTabsForOpen(current: SessionTabs | undefined, tab: string): SessionTabs {
  const all = current?.all ?? []
  if (tab === "review") return { all: all.filter((x) => x !== "review"), active: tab }
  if (tab === "context") return { all: [tab, ...all.filter((x) => x !== tab)], active: tab }
  if (!all.includes(tab)) return { all: [...all, tab], active: tab }
  return { all, active: tab }
}

const sessionPath = (key: string) => {
  const dir = SessionStateKey.route(key).split("/")[0]
  if (!dir) return
  const root = decode64(dir)
  if (!root) return
  return createPathHelpers(() => root)
}

const normalizeSessionTab = (path: ReturnType<typeof createPathHelpers> | undefined, tab: string) => {
  if (!tab.startsWith("file://")) return tab
  if (!path) return tab
  return path.tab(tab)
}

const normalizeSessionTabList = (path: ReturnType<typeof createPathHelpers> | undefined, all: string[]) => {
  const seen = new Set<string>()
  return all.flatMap((tab) => {
    const value = normalizeSessionTab(path, tab)
    if (seen.has(value)) return []
    seen.add(value)
    return [value]
  })
}

const normalizeStoredSessionTabs = (key: string, tabs: SessionTabs) => {
  const path = sessionPath(key)
  return {
    all: normalizeSessionTabList(path, tabs.all),
    active: tabs.active ? normalizeSessionTab(path, tabs.active) : tabs.active,
  }
}

const currentRoute = (pathname: string): LayoutRoute => {
  const parts = pathname.split("/").filter(Boolean)
  if (parts.length === 0) return { type: "home" }

  const dirBase64 = parts[0]
  const dir = decode64(dirBase64)
  if (!dir) return { type: "home" }

  if (parts[1] !== "session") return { type: "home" }

  const id = parts[2]
  if (id) return { type: "session", dir, dirBase64, sessionId: id }
  return { type: "dir-new-sesssion", dir, dirBase64 }
}

type SessionRightPanelMode = NonNullable<SessionView["rightPanelMode"]>

export const { use: useLayout, provider: LayoutProvider } = createSimpleContext({
  name: "Layout",
  gate: false,
  init: () => {
    const serverSdk = useServerSDK()
    const serverSync = useServerSync()
    const server = useServer()
    const platform = usePlatform()
    const location = useLocation()
    const route = createMemo(() => {
      const value = currentRoute(location.pathname)
      if (value.type === "home") return value
      return { ...value, server: server.key }
    })

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)

    const migrate = (value: unknown) => {
      if (!isRecord(value)) return value

      const sidebar = value.sidebar
      const migratedSidebar = (() => {
        if (!isRecord(sidebar)) return sidebar
        if (typeof sidebar.workspaces !== "boolean") return sidebar
        return {
          ...sidebar,
          workspaces: {},
          workspacesDefault: sidebar.workspaces,
        }
      })()

      const review = value.review
      const fileTree = value.fileTree
      const migratedFileTree = (() => {
        if (!isRecord(fileTree)) return fileTree
        if (fileTree.tab === "changes" || fileTree.tab === "all") return fileTree

        const width = typeof fileTree.width === "number" ? fileTree.width : DEFAULT_FILE_TREE_WIDTH
        return {
          ...fileTree,
          opened: true,
          width: width === 260 ? DEFAULT_FILE_TREE_WIDTH : width,
          tab: "changes",
        }
      })()

      const migratedReview = (() => {
        if (!isRecord(review)) return review
        if (typeof review.panelOpened === "boolean") return review

        const opened = isRecord(fileTree) && typeof fileTree.opened === "boolean" ? fileTree.opened : true
        return {
          ...review,
          panelOpened: opened,
        }
      })()

      const sessionTabs = migrateLegacySessionStateKeys(value.sessionTabs)
      const sessionView = migrateLegacySessionStateKeys(value.sessionView)
      const migratedSessionTabs = (() => {
        if (!isRecord(sessionTabs)) return sessionTabs

        let changed = false
        const next = Object.fromEntries(
          Object.entries(sessionTabs).map(([key, tabs]) => {
            if (!isRecord(tabs) || !Array.isArray(tabs.all)) return [key, tabs]

            const current = {
              all: tabs.all.filter((tab): tab is string => typeof tab === "string"),
              active: typeof tabs.active === "string" ? tabs.active : undefined,
            }
            const normalized = normalizeStoredSessionTabs(key, current)
            if (current.all.length !== tabs.all.length) changed = true
            if (!same(current.all, normalized.all) || current.active !== normalized.active) changed = true
            if (tabs.active !== undefined && typeof tabs.active !== "string") changed = true
            return [key, normalized]
          }),
        )

        if (!changed) return sessionTabs
        return next
      })()

      // rightPanel moved from a fixed px width to a window-width ratio. Convert the legacy
      // { width: px } shape into { ratio } using the current window width.
      const rightPanel = value.rightPanel
      const migratedRightPanel = (() => {
        if (!isRecord(rightPanel)) return rightPanel
        if (typeof rightPanel.ratio === "number") return rightPanel
        if (typeof rightPanel.width !== "number") return rightPanel
        const w = typeof window === "undefined" ? 1280 : window.innerWidth
        const ratio = w > 0 ? rightPanel.width / w : DEFAULT_RIGHT_PANEL_RATIO
        return { ratio }
      })()

      if (
        migratedSidebar === sidebar &&
        migratedReview === review &&
        migratedFileTree === fileTree &&
        migratedSessionTabs === value.sessionTabs &&
        migratedRightPanel === rightPanel &&
        sessionView === value.sessionView
      ) {
        return value
      }

      return {
        ...value,
        sidebar: migratedSidebar,
        review: migratedReview,
        fileTree: migratedFileTree,
        sessionTabs: migratedSessionTabs,
        rightPanel: migratedRightPanel,
        sessionView,
      }
    }

    const target = Persist.serverGlobal(serverSdk.scope, "layout", ["layout.v6"])
    const [store, setStore, _, ready] = persisted(
      { ...target, migrate },
      createStore({
        sidebar: {
          opened: false,
          width: DEFAULT_SIDEBAR_WIDTH,
          workspaces: {} as Record<string, boolean>,
          workspacesDefault: false,
        },
        terminal: {
          height: DEFAULT_TERMINAL_HEIGHT,
          opened: false,
        },
        // Dock-panel location (global, matching terminal.opened's global scope). Each movable panel
        // (terminal / debug-console) remembers whether it lives in the bottom dock or the right side
        // panel. Absent entries fall back to DOCK_DEFAULT_LOCATION at read time, so an older store with
        // no `dock` field keeps working with no migration.
        dock: {
          location: {} as Record<DockPanelID, DockLocation>,
        },
        review: {
          diffStyle: "split" as ReviewDiffStyle,
          panelOpened: true,
        },
        fileTree: {
          opened: false,
          width: DEFAULT_FILE_TREE_WIDTH,
          tab: "changes" as "changes" | "all",
        },
        rightPanel: {
          // `ratio` = the WIDE bucket (legacy field name, kept so the existing migration keeps working);
          // `narrowRatio` = the NARROW bucket (T3.3). An older store without narrowRatio falls back to
          // the default at read time.
          ratio: DEFAULT_RIGHT_PANEL_RATIO,
          narrowRatio: DEFAULT_RIGHT_PANEL_NARROW_RATIO,
        },
        session: {
          width: DEFAULT_SESSION_WIDTH,
        },
        mobileSidebar: {
          opened: false,
        },
        sessionTabs: {} as Record<string, SessionTabs>,
        sessionView: {} as Record<string, SessionView>,
        handoff: {
          tabs: undefined as TabHandoff | undefined,
        },
      }),
    )

    // Reactive viewport width is used by both resizable panel geometry and the
    // side-host reachability guard for movable views.
    const [windowWidth, setWindowWidth] = createSignal(typeof window === "undefined" ? 1280 : window.innerWidth)
    if (typeof window !== "undefined") {
      const onResize = () => setWindowWidth(window.innerWidth)
      window.addEventListener("resize", onResize)
      onCleanup(() => window.removeEventListener("resize", onResize))
    }

    const MAX_SESSION_KEYS = 50
    const PENDING_MESSAGE_TTL_MS = 2 * 60 * 1000
    const usage = {
      active: undefined as string | undefined,
      pruned: false,
      used: new Map<string, number>(),
    }

    const SESSION_STATE_KEYS = [
      { key: "prompt", legacy: "prompt", version: "v2" },
      { key: "terminal", legacy: "terminal", version: "v1" },
      { key: "file-view", legacy: "file", version: "v1" },
    ] as const

    const dropSessionState = (keys: string[]) => {
      for (const key of keys) {
        const scope = SessionStateKey.scope(key)
        const parts = SessionStateKey.route(key).split("/")
        const dir = parts[0]
        const session = parts[1]
        if (!dir) continue

        for (const entry of SESSION_STATE_KEYS) {
          const target = session
            ? Persist.serverSession(scope, dir, session, entry.key)
            : Persist.serverWorkspace(scope, dir, entry.key)
          void removePersisted(target, platform)

          if (scope !== ServerScope.local) continue
          const legacyKey = `${dir}/${entry.legacy}${session ? "/" + session : ""}.${entry.version}`
          void removePersisted({ key: legacyKey }, platform)
        }
      }
    }

    function prune(keep?: string) {
      const drop = pruneSessionKeys({
        keep,
        max: MAX_SESSION_KEYS,
        used: usage.used,
        view: Object.keys(store.sessionView),
        tabs: Object.keys(store.sessionTabs),
      })
      if (drop.length === 0) return

      setStore(
        produce((draft) => {
          for (const key of drop) {
            delete draft.sessionView[key]
            delete draft.sessionTabs[key]
          }
        }),
      )

      scroll.drop(drop)
      dropSessionState(drop)

      for (const key of drop) {
        usage.used.delete(key)
      }
    }

    function touch(sessionKey: string) {
      usage.active = sessionKey
      usage.used.set(sessionKey, Date.now())

      if (!ready()) return
      if (usage.pruned) return

      usage.pruned = true
      prune(sessionKey)
    }

    const scroll = createScrollPersistence({
      debounceMs: 250,
      getSnapshot: (sessionKey) => store.sessionView[sessionKey]?.scroll,
      onFlush: (sessionKey, next) => {
        const current = store.sessionView[sessionKey]
        const keep = usage.active ?? sessionKey
        if (!current) {
          setStore("sessionView", sessionKey, { scroll: next })
          prune(keep)
          return
        }

        setStore("sessionView", sessionKey, "scroll", (prev) => ({ ...prev, ...next }))
        prune(keep)
      },
    })

    const ensureKey = (key: string) => ensureSessionKey(key, touch, (sessionKey) => scroll.seed(sessionKey))

    createEffect(() => {
      if (!ready()) return
      if (usage.pruned) return
      const active = usage.active
      if (!active) return
      usage.pruned = true
      prune(active)
    })

    onMount(() => {
      const flush = () => batch(() => scroll.flushAll())
      const handleVisibility = () => {
        if (document.visibilityState !== "hidden") return
        flush()
      }

      makeEventListener(window, "pagehide", flush)
      makeEventListener(document, "visibilitychange", handleVisibility)

      onCleanup(() => {
        scroll.dispose()
      })
    })

    const [colors, setColors] = createStore<Record<string, AvatarColorKey>>({})
    const colorRequested = new Map<string, AvatarColorKey>()

    function pickAvailableColor(used: Set<string>): AvatarColorKey {
      const available = AVATAR_COLOR_KEYS.filter((c) => !used.has(c))
      if (available.length === 0) return AVATAR_COLOR_KEYS[Math.floor(Math.random() * AVATAR_COLOR_KEYS.length)]
      return available[Math.floor(Math.random() * available.length)]
    }

    function enrich(project: { worktree: string; expanded: boolean }) {
      const [childStore] = serverSync.child(project.worktree, { bootstrap: false })
      const projectID = childStore.project
      const metadata = projectID
        ? serverSync.data.project.find((x) => x.id === projectID)
        : serverSync.data.project.find((x) => x.worktree === project.worktree)

      // Preserve local icon override from per-workspace localStorage cache (childStore.icon).
      // Without this, different subdirectories of the same git repo would share the same
      // icon from the database instead of using their individual overrides.
      const base = { ...metadata, ...project }
      if (childStore.icon) {
        return { ...base, icon: { ...base.icon, override: childStore.icon } }
      }
      return base
    }

    const roots = createMemo(() => {
      const map = new Map<string, string>()
      for (const project of serverSync.data.project) {
        const sandboxes = project.sandboxes ?? []
        for (const sandbox of sandboxes) {
          map.set(sandbox, project.worktree)
        }
      }
      return map
    })

    const rootFor = (directory: string) => {
      const map = roots()
      if (map.size === 0) return directory

      const visited = new Set<string>()
      const chain = [directory]

      while (chain.length) {
        const current = chain[chain.length - 1]
        if (!current) return directory

        const next = map.get(current)
        if (!next) return current

        if (visited.has(next)) return directory
        visited.add(next)
        chain.push(next)
      }

      return directory
    }

    createEffect(() => {
      const projects = server.projects.list()
      const seen = new Set(projects.map((project) => project.worktree))

      batch(() => {
        for (const project of projects) {
          const root = rootFor(project.worktree)
          if (root === project.worktree) continue

          server.projects.close(project.worktree)

          if (!seen.has(root)) {
            server.projects.open(root)
            seen.add(root)
          }

          if (project.expanded) server.projects.expand(root)
        }
      })
    })

    const enriched = createMemo(() => server.projects.list().map(enrich))
    const list = createMemo(() => {
      const projects = enriched()
      return projects.map((project) => {
        const color = project.icon?.color ?? colors[project.worktree]
        if (!color) return project
        const icon = project.icon ? { ...project.icon, color } : { color }
        return { ...project, icon }
      })
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return
      if (!serverSync.ready) return

      for (const project of projects) {
        if (!project.id) continue
        if (project.id === "global") continue
        serverSync.project.icon(project.worktree, project.icon?.override)
      }
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return

      for (const project of projects) {
        if (project.icon?.color) colorRequested.delete(project.worktree)
      }

      const used = new Set<string>()
      for (const project of projects) {
        const color = project.icon?.color ?? colors[project.worktree]
        if (color) used.add(color)
      }

      for (const project of projects) {
        if (project.icon?.color || project.icon?.override || project.icon?.url) continue
        const worktree = project.worktree
        const existing = colors[worktree]
        const color = existing ?? pickAvailableColor(used)
        if (!existing) {
          used.add(color)
          setColors(worktree, color)
        }
        if (!project.id) continue

        const requested = colorRequested.get(worktree)
        if (requested === color) continue
        colorRequested.set(worktree, color)

        if (project.id === "global") {
          serverSync.project.meta(worktree, { icon: { color } })
          continue
        }

        void serverSdk.client.project
          .update({ projectID: project.id, directory: worktree, icon: { color } })
          .catch(() => {
            if (colorRequested.get(worktree) === color) colorRequested.delete(worktree)
          })
      }
    })

    let sessionFrame: number | undefined
    let sessionTimer: number | undefined

    onMount(() => {
      sessionFrame = requestAnimationFrame(() => {
        sessionFrame = undefined
        sessionTimer = window.setTimeout(() => {
          sessionTimer = undefined
          void Promise.all(
            server.projects.list().map((project) => {
              return serverSync.project.loadSessions(project.worktree)
            }),
          )
        }, 0)
      })
    })

    onCleanup(() => {
      if (sessionFrame !== undefined) cancelAnimationFrame(sessionFrame)
      if (sessionTimer !== undefined) window.clearTimeout(sessionTimer)
    })

    return {
      route,
      ready,
      handoff: {
        tabs: createMemo(() => store.handoff?.tabs),
        setTabs(dir: string, id: string) {
          setStore("handoff", "tabs", { scope: server.scope(), dir, id, at: Date.now() })
        },
        clearTabs() {
          if (!store.handoff?.tabs) return
          setStore("handoff", "tabs", undefined)
        },
      },
      projects: {
        list,
        open(directory: string) {
          const root = rootFor(directory)
          if (server.projects.list().find((x) => x.worktree === root)) return
          void serverSync.project.loadSessions(root)
          server.projects.open(root)
        },
        close(directory: string) {
          server.projects.close(directory)
        },
        expand(directory: string) {
          server.projects.expand(directory)
        },
        collapse(directory: string) {
          server.projects.collapse(directory)
        },
        move(directory: string, toIndex: number) {
          server.projects.move(directory, toIndex)
        },
      },
      sidebar: {
        opened: createMemo(() => store.sidebar.opened),
        open() {
          setStore("sidebar", "opened", true)
        },
        close() {
          setStore("sidebar", "opened", false)
        },
        toggle() {
          setStore("sidebar", "opened", (x) => !x)
        },
        width: createMemo(() => store.sidebar.width),
        resize(width: number) {
          setStore("sidebar", "width", width)
        },
        workspaces(directory: string) {
          return () => store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
        },
        setWorkspaces(directory: string, value: boolean) {
          setStore("sidebar", "workspaces", directory, value)
        },
        toggleWorkspaces(directory: string) {
          const current = store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
          setStore("sidebar", "workspaces", directory, !current)
        },
      },
      terminal: {
        height: createMemo(() => store.terminal.height),
        resize(height: number) {
          setStore("terminal", "height", height)
        },
      },
      dock: {
        // Deprecated compatibility metadata. New UI must use view(session).panel;
        // only locations and the shared Bottom Panel dimension remain global.
        location(id: DockPanelID): DockLocation {
          return store.dock?.location?.[id] ?? DOCK_DEFAULT_LOCATION[id]
        },
        setLocation(id: DockPanelID, location: DockLocation) {
          if (!store.dock) {
            setStore("dock", { location: { [id]: location } as Record<DockPanelID, DockLocation> })
            return
          }
          setStore("dock", "location", id, location)
        },
        move(id: DockPanelID) {
          const current = store.dock?.location?.[id] ?? DOCK_DEFAULT_LOCATION[id]
          const next: DockLocation = current === "bottom" ? "side" : "bottom"
          if (!store.dock) {
            setStore("dock", { location: { [id]: next } as Record<DockPanelID, DockLocation> })
            return
          }
          setStore("dock", "location", id, next)
        },
        bottomCount: createMemo(
          () => DOCK_PANEL_IDS.filter((id) => (store.dock?.location?.[id] ?? DOCK_DEFAULT_LOCATION[id]) === "bottom").length,
        ),
      },
      review: {
        diffStyle: createMemo(() => store.review?.diffStyle ?? "split"),
        setDiffStyle(diffStyle: ReviewDiffStyle) {
          if (!store.review) {
            setStore("review", { diffStyle, panelOpened: true })
            return
          }
          setStore("review", "diffStyle", diffStyle)
        },
      },
      fileTree: {
        opened: createMemo(() => store.fileTree?.opened ?? true),
        width: createMemo(() => store.fileTree?.width ?? DEFAULT_FILE_TREE_WIDTH),
        tab: createMemo(() => store.fileTree?.tab ?? "changes"),
        setTab(tab: "changes" | "all") {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_FILE_TREE_WIDTH, tab })
            return
          }
          setStore("fileTree", "tab", tab)
        },
        open() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", true)
        },
        close() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: false, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", false)
        },
        toggle() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", (x) => !x)
        },
        resize(width: number) {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width, tab: "changes" })
            return
          }
          setStore("fileTree", "width", width)
        },
      },
      rightPanel: {
        // Stored value is a ratio of the window width; px is derived live from the current window
        // width and clamped so the panel stays proportional across screens and can stretch with the
        // window (no fixed 720px ceiling). T3.3: the ratio is per-BUCKET (wide/narrow) so each panel
        // family remembers its own width.
        maxWidth: createMemo(() => Math.round(windowWidth() * MAX_RIGHT_PANEL_RATIO)),
        minWidth: MIN_RIGHT_PANEL_PX,
        // Fixed, non-resizable icon-rail strip beside the content area (T3.2).
        railWidth: RIGHT_PANEL_RAIL_PX,
        // Called inside a tracking scope (JSX / createMemo), so reading store.rightPanel + windowWidth()
        // here is reactive without wrapping in its own memo. Defaults to the wide bucket for callers
        // that don't care (e.g. the shared session-width calc).
        width: (bucket: RightPanelWidthBucket = "wide") => {
          const ratio =
            bucket === "narrow"
              ? store.rightPanel?.narrowRatio ?? DEFAULT_RIGHT_PANEL_NARROW_RATIO
              : store.rightPanel?.ratio ?? DEFAULT_RIGHT_PANEL_RATIO
          const max = Math.max(MIN_RIGHT_PANEL_PX, Math.round(windowWidth() * MAX_RIGHT_PANEL_RATIO))
          return Math.min(max, Math.max(MIN_RIGHT_PANEL_PX, Math.round(windowWidth() * ratio)))
        },
        resize(width: number, bucket: RightPanelWidthBucket = "wide") {
          const ratio = windowWidth() > 0 ? width / windowWidth() : DEFAULT_RIGHT_PANEL_RATIO
          const field = bucket === "narrow" ? "narrowRatio" : "ratio"
          if (!store.rightPanel) {
            setStore("rightPanel", field === "narrowRatio" ? { narrowRatio: ratio } : { ratio })
            return
          }
          setStore("rightPanel", field, ratio)
        },
      },
      session: {
        width: createMemo(() => store.session?.width ?? DEFAULT_SESSION_WIDTH),
        resize(width: number) {
          if (!store.session) {
            setStore("session", { width })
            return
          }
          setStore("session", "width", width)
        },
      },
      mobileSidebar: {
        opened: createMemo(() => store.mobileSidebar?.opened ?? false),
        show() {
          setStore("mobileSidebar", "opened", true)
        },
        hide() {
          setStore("mobileSidebar", "opened", false)
        },
        toggle() {
          setStore("mobileSidebar", "opened", (x) => !x)
        },
      },
      pendingMessage: {
        set(sessionKey: string, messageID: string) {
          const at = Date.now()
          touch(sessionKey)
          const current = store.sessionView[sessionKey]
          if (!current) {
            setStore("sessionView", sessionKey, {
              scroll: {},
              pendingMessage: messageID,
              pendingMessageAt: at,
            })
            prune(usage.active ?? sessionKey)
            return
          }

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              draft.pendingMessage = messageID
              draft.pendingMessageAt = at
            }),
          )
        },
        consume(sessionKey: string) {
          const current = store.sessionView[sessionKey]
          const message = current?.pendingMessage
          const at = current?.pendingMessageAt
          if (!message || !at) return

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              delete draft.pendingMessage
              delete draft.pendingMessageAt
            }),
          )

          if (Date.now() - at > PENDING_MESSAGE_TTL_MS) return
          return message
        },
      },
      view(sessionKey: string | Accessor<string>) {
        const key = createSessionKeyReader(sessionKey, ensureKey)
        const s = createMemo(() => store.sessionView[key()] ?? { scroll: {} })
        const reviewPanelOpened = createMemo(() => store.review?.panelOpened ?? true)
        const rightPanelMode = createMemo(() => store.sessionView[key()]?.rightPanelMode)
        const bottomPanel = createMemo(() => {
          const current = store.sessionView[key()]
          // One-way compatibility migration from the pre-panel global terminal flag.
          if (current?.bottomPanel) return current.bottomPanel
          if (store.terminal?.opened) return { opened: true, activeView: "terminal" as DockPanelID }
          return { opened: false } as PanelSessionState<SessionRightPanelMode>["bottomPanel"]
        })
        const panelLocations = createMemo(
          () =>
            Object.fromEntries(
              DOCK_PANEL_IDS.map((id) => [id, store.dock?.location?.[id] ?? DOCK_DEFAULT_LOCATION[id]]),
            ) as Record<DockPanelID, DockLocation>,
        )
        const sideAvailable = createMemo(() => windowWidth() >= 768)

        function commitPanel(next: PanelSessionState<SessionRightPanelMode>) {
          const session = key()
          const current = store.sessionView[session]
          const bottom = next.bottomPanel
          if (!current) {
            setStore("sessionView", session, { scroll: {}, bottomPanel: bottom, rightPanelMode: next.rightPanelMode })
            return
          }
          setStore(
            "sessionView",
            session,
            produce((draft) => {
              draft.bottomPanel = bottom
              draft.rightPanelMode = next.rightPanelMode
            }),
          )
        }

        function panelInput(): PanelTransitionInput<SessionRightPanelMode> {
          return {
            locations: panelLocations(),
            sideAvailable: sideAvailable(),
            state: { bottomPanel: bottomPanel(), rightPanelMode: rightPanelMode() },
          }
        }

        function setRightPanelMode(next: SessionView["rightPanelMode"]) {
          const session = key()
          const current = store.sessionView[session]
          if (!current) {
            setStore("sessionView", session, { scroll: {}, rightPanelMode: next })
            return
          }

          if (current.rightPanelMode === next) return
          setStore("sessionView", session, "rightPanelMode", next)
        }

        function setTerminalOpened(next: boolean) {
          const current = store.terminal
          if (!current) {
            setStore("terminal", { height: DEFAULT_TERMINAL_HEIGHT, opened: next })
            return
          }

          const value = current.opened ?? false
          if (value === next) return
          setStore("terminal", "opened", next)
        }

        function setReviewPanelOpened(next: boolean) {
          const current = store.review
          if (!current) {
            setStore("review", { diffStyle: "split" as ReviewDiffStyle, panelOpened: next })
            return
          }

          const value = current.panelOpened ?? true
          if (value === next) return
          setStore("review", "panelOpened", next)
        }

        return {
          scroll(tab: string) {
            return scroll.scroll(key(), tab)
          },
          setScroll(tab: string, pos: SessionScroll) {
            scroll.setScroll(key(), tab, pos)
          },
          todoCollapsed: {
            get: () => s().todoCollapsed ?? false,
            set(collapsed: boolean) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, { scroll: {}, todoCollapsed: collapsed })
              } else {
                setStore("sessionView", session, "todoCollapsed", collapsed)
              }
            },
          },
          terminal: {
            // Legacy adapter for existing non-panel callers. New UI must use panel.
            opened: createMemo(() => bottomPanel().opened && bottomPanel().activeView === "terminal"),
            open() {
              commitPanel(revealPanel(panelInput(), "terminal"))
            },
            close() {
              commitPanel(togglePanel(panelInput(), "terminal"))
            },
            toggle() {
              commitPanel(togglePanel(panelInput(), "terminal"))
            },
          },
          panel: {
            locations: panelLocations,
            sideAvailable,
            bottom: {
              opened: createMemo(() => bottomPanel().opened),
              activeView: createMemo(() => bottomPanel().activeView),
              toggle() {
                commitPanel(toggleBottomPanel(panelInput()))
              },
            },
            location(view: DockPanelID) {
              return panelHost(panelLocations()[view], sideAvailable())
            },
            viewsAt(location: DockLocation) {
              return DOCK_PANEL_IDS.filter((view) => panelHost(panelLocations()[view], sideAvailable()) === location)
            },
            reveal(view: DockPanelID) {
              commitPanel(revealPanel(panelInput(), view))
            },
            toggle(view: DockPanelID) {
              commitPanel(togglePanel(panelInput(), view))
            },
            move(view: DockPanelID, target: DockLocation) {
              const input = panelInput()
              const moved = movePanel(input, view, target)
              if (moved.locations[view] === input.locations[view] && moved.state === input.state) return
              if (!store.dock) {
                setStore("dock", { location: moved.locations })
              } else {
                setStore("dock", "location", view, moved.locations[view])
              }
              commitPanel(moved.state)
            },
          },
          reviewPanel: {
            opened: reviewPanelOpened,
            open() {
              setReviewPanelOpened(true)
            },
            close() {
              setReviewPanelOpened(false)
            },
            toggle() {
              setReviewPanelOpened(!reviewPanelOpened())
            },
          },
          rightPanel: {
            mode: rightPanelMode,
            opened: createMemo(() => isPanelOpen(rightPanelMode())),
            open(mode: NonNullable<SessionView["rightPanelMode"]>) {
              setRightPanelMode(mode)
            },
            close() {
              setRightPanelMode(undefined)
            },
            toggle(mode: NonNullable<SessionView["rightPanelMode"]>) {
              setRightPanelMode(toggledPanelMode(rightPanelMode(), mode))
            },
          },
          review: {
            open: createMemo(() => s().reviewOpen ?? []),
            setOpen(open: string[]) {
              const session = key()
              const next = Array.from(new Set(open))
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, {
                  scroll: {},
                  reviewOpen: next,
                })
                return
              }

              if (same(current.reviewOpen, next)) return
              setStore("sessionView", session, "reviewOpen", next)
            },
            openPath(path: string) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, {
                  scroll: {},
                  reviewOpen: [path],
                })
                return
              }

              if (!current.reviewOpen) {
                setStore("sessionView", session, "reviewOpen", [path])
                return
              }

              if (current.reviewOpen.includes(path)) return
              setStore("sessionView", session, "reviewOpen", current.reviewOpen.length, path)
            },
            closePath(path: string) {
              const session = key()
              const current = store.sessionView[session]?.reviewOpen
              if (!current) return

              const index = current.indexOf(path)
              if (index === -1) return
              setStore(
                "sessionView",
                session,
                "reviewOpen",
                produce((draft) => {
                  if (!draft) return
                  draft.splice(index, 1)
                }),
              )
            },
            togglePath(path: string) {
              const session = key()
              const current = store.sessionView[session]?.reviewOpen
              if (!current || !current.includes(path)) {
                this.openPath(path)
                return
              }

              this.closePath(path)
            },
          },
        }
      },
      tabs(sessionKey: string | Accessor<string>) {
        const key = createSessionKeyReader(sessionKey, ensureKey)
        const path = createMemo(() => sessionPath(key()))
        const tabs = createMemo(() => store.sessionTabs[key()] ?? { all: [] })
        const normalize = (tab: string) => normalizeSessionTab(path(), tab)
        const normalizeAll = (all: string[]) => normalizeSessionTabList(path(), all)
        return {
          tabs,
          active: createMemo(() => tabs().active),
          all: createMemo(() => tabs().all.filter((tab) => tab !== "review")),
          setActive(tab: string | undefined) {
            const session = key()
            const next = tab ? normalize(tab) : tab
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: [], active: next })
            } else {
              setStore("sessionTabs", session, "active", next)
            }
          },
          setAll(all: string[]) {
            const session = key()
            const next = normalizeAll(all).filter((tab) => tab !== "review")
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: next, active: undefined })
            } else {
              setStore("sessionTabs", session, "all", next)
            }
          },
          async open(tab: string) {
            const session = key()
            const next = nextSessionTabsForOpen(store.sessionTabs[session], normalize(tab))
            setStore("sessionTabs", session, next)
          },
          close(tab: string) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return

            if (tab === "review") {
              if (current.active !== tab) return
              setStore("sessionTabs", session, "active", current.all[0])
              return
            }

            const all = current.all.filter((x) => x !== tab)
            if (current.active !== tab) {
              setStore("sessionTabs", session, "all", all)
              return
            }

            const index = current.all.findIndex((f) => f === tab)
            const next = current.all[index - 1] ?? current.all[index + 1] ?? all[0]
            batch(() => {
              setStore("sessionTabs", session, "all", all)
              setStore("sessionTabs", session, "active", next)
            })
          },
          move(tab: string, to: number) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return
            const index = current.all.findIndex((f) => f === tab)
            if (index === -1) return
            setStore(
              "sessionTabs",
              session,
              "all",
              produce((opened) => {
                opened.splice(to, 0, opened.splice(index, 1)[0])
              }),
            )
          },
        }
      },
    }
  },
})
