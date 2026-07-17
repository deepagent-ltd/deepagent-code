import type {
  Config,
  McpLocalConfig,
  McpRemoteConfig,
  DeepAgentCodeClient,
  Path,
  Project,
  ProviderAuthResponse,
} from "@deepagent-code/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@deepagent-code/core/util/path"
import { batch, getOwner, onCleanup, onMount, untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { ServerSDK, useServerSDK } from "./server-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadAgentsQuery,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./global-sync/event-reducer"
import { clearSessionPrefetchDirectory } from "./global-sync/session-prefetch"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext } from "./directory-sync"
import { createSimpleContext, NormalizedProviderListResponse } from "@deepagent-code/ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { retry } from "@deepagent-code/core/util/retry"
import type { ServerScope } from "@/utils/server-scope"
import { persisted } from "@/utils/persist"
import { toggleMcp } from "./global-sync/mcp"
import type { SessionPlan, SessionPlanStep, SessionGoal } from "./global-sync/types"

export type { SessionPlan, SessionPlanStep, SessionGoal }

// True when `dir` is a filesystem root: posix "/" or a Windows drive/UNC root ("C:\", "C:/", "\\").
// Rooting an instance here is refused server-side (assertSafeInstanceRoot); we check on the client
// too so we never fire the doomed boot. Kept dependency-free (no node:path in the renderer).
function isFilesystemRootDir(dir: string): boolean {
  const trimmed = dir.trim()
  if (!trimmed) return false
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "")
  if (normalized === "") return true // was "/" or "\" (all separators)
  if (/^[A-Za-z]:$/.test(normalized)) return true // "C:" (drive root after trailing-slash strip)
  return false
}

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  // The live plan per session (goal + steps + progress) pushed by the `plan` tool's plan.updated
  // event. Persistent — survives a session going idle. This is the SINGLE source for the task dock;
  // the legacy `session_todo` cache was removed when task tracking unified onto the plan system.
  session_plan: {
    [sessionID: string]: SessionPlan
  }
  // V3.9 §D: the live Goal Loop status per session, pushed by the goal.updated event. Persistent like
  // session_plan so the status bar survives the session going idle between background ticks.
  session_goal: {
    [sessionID: string]: SessionGoal
  }
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

export const loadMcpQuery = (scope: ServerScope, directory: string, sdk: DeepAgentCodeClient) =>
  queryOptions({
    queryKey: [scope, directory, "mcp"] as const,
    queryFn: () => sdk.mcp.status().then((r) => r.data ?? {}),
  })

export const loadLspQuery = (scope: ServerScope, directory: string, sdk: DeepAgentCodeClient) =>
  queryOptions({
    queryKey: [scope, directory, "lsp"] as const,
    queryFn: () => sdk.lsp.status().then((r) => r.data ?? []),
  })

function makeQueryOptionsApi(
  scope: ServerScope,
  serverSDK: () => DeepAgentCodeClient,
  sdkFor: (dir: PathKey) => DeepAgentCodeClient,
) {
  return {
    globalConfig: () => loadGlobalConfigQuery(scope, serverSDK()),
    projects: () => loadProjectsQuery(scope, serverSDK()),
    providers: (directory: PathKey | null) =>
      loadProvidersQuery(scope, directory, directory === null ? serverSDK() : sdkFor(directory)),
    path: (directory: PathKey | null) =>
      loadPathQuery(scope, directory, directory === null ? serverSDK() : sdkFor(directory)),
    agents: (directory: PathKey) => loadAgentsQuery(scope, directory, sdkFor(directory)),
    mcp: (directory: PathKey) => loadMcpQuery(scope, directory, sdkFor(directory)),
    lsp: (directory: PathKey) => loadLspQuery(scope, directory, sdkFor(directory)),
    sessions: (directory: PathKey) => ({ queryKey: [scope, directory, "loadSessions"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

export function createServerSyncContextInner(_serverSDK?: ServerSDK) {
  const serverSDK: ServerSDK = _serverSDK ?? useServerSDK()
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("ServerSync must be created within owner")

  const sdkCache = new Map<string, DeepAgentCodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = serverSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const queryOptionsApi = makeQueryOptionsApi(serverSDK.scope, () => serverSDK.client, sdkFor)

  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
    queries: [queryOptionsApi.globalConfig(), queryOptionsApi.providers(null), queryOptionsApi.path(null)],
  }))

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return !bootstrap.isPending
    },
    project: [],
    session_plan: {},
    session_goal: {},
    provider_auth: {},
    get path() {
      const EMPTY: Path = {
        home: "",
        data: "",
        cache: "",
        state: "",
        tmp: "",
        log: "",
        repos: "",
        config: "",
        worktree: "",
        directory: "",
        agent: {
          schemaVersion: "deepagent_generic_agent_runtime.v1",
          mode: "unavailable",
          agentMode: "general",
          implementation: "visible_skeleton",
          agentManaged: false,
          originalPathAllowed: true,
          providerExecutedToolPolicy: "deny_by_default",
          knowledgeEnabled: false,
          directories: {
            data: "",
            cache: "",
            state: "",
            tmp: "",
            runs: "",
            artifacts: "",
            output: "",
            log: "",
          },
          coverage: [],
        },
      }
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get provider() {
      const EMPTY = { all: new Map(), connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })

  const queryClient = useQueryClient()

  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: [serverSDK.scope, "bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        serverSDK: serverSDK.client,
        scope: serverSDK.scope,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  // Set/clear the live plan for a session.
  const setSessionPlan = (sessionID: string, plan: SessionPlan | undefined) => {
    if (!sessionID) return
    if (!plan) {
      setGlobalStore(
        "session_plan",
        produce((draft) => {
          delete draft[sessionID]
        }),
      )
      return
    }
    // The outer object is a single plan per session (not an array), so a key is meaningless at this
    // level — but reconcile applies `key` RECURSIVELY to the nested `steps[]` array, where the
    // identity field is `step_id`, not `plan_id`. With the wrong key every step resolves to
    // `key=undefined`, so reconcile can't match steps across updates and falls back to replacing
    // whole step objects by position (extra store-cell churn). NOTE: this does NOT drop status
    // changes — field values still land either way (verified), and the dock renders steps via
    // <Index> over plain objects re-created by the `planAsTodos` memo, so proxy identity is never
    // consumed by the render. Keying by `step_id` is the correct, minimal-diff choice (field-level
    // updates, stable identity) and is future-proof if the render ever switches to a keyed <For>.
    setGlobalStore("session_plan", sessionID, reconcile(plan, { key: "step_id" }))
  }

  // V3.9 §D: set/clear the live goal status for a session (mirrors setSessionPlan). The goal object is
  // a single record per session; reconcile keeps field-level updates minimal-diff.
  const setSessionGoal = (sessionID: string, goal: SessionGoal | undefined) => {
    if (!sessionID) return
    if (!goal) {
      setGlobalStore(
        "session_goal",
        produce((draft) => {
          delete draft[sessionID]
        }),
      )
      return
    }
    setGlobalStore("session_goal", sessionID, reconcile(goal))
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: [serverSDK.scope, "bootstrap"] }),
    bootstrapInstance,
  })

  const children = createChildStoreManager({
    owner,
    scope: serverSDK.scope,
    persist: persisted,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onMcp: (directory, setStore) => {
      void retry(() =>
        sdkFor(directory)
          .command.list()
          .then((x) => setStore("command", x.data ?? [])),
      ).catch((err) => {
        showToast({
          variant: "error",
          title: language.t("toast.project.reloadFailed.title", { project: getFilename(directory) }),
          description: formatServerError(err, language.t),
        })
      })
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      sessionMeta.delete(key)
      sdkCache.delete(key)
      clearProviderRev(serverSDK.scope, key)
      clearSessionPrefetchDirectory(serverSDK.scope, key)
    },
    translate: language.t,
    queryOptions: queryOptionsApi,
    global: {
      provider: globalStore.provider,
    },
  })

  async function loadSessions(directory: string, options?: { limit?: number }) {
    const key = directoryKey(directory)
    const pending = sessionLoads.get(key)
    if (pending) {
      await pending
      return loadSessions(directory, options)
    }

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(key)
    const retainedLimit = Math.max(store.limit, options?.limit ?? 0, meta?.limit ?? 0)
    if (meta && meta.limit >= retainedLimit) {
      const next = trimSessions(store.session, {
        limit: retainedLimit,
        permission: store.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
        cleanupDroppedSessionCaches(store, setStore, next)
      }
      children.unpin(key)
      return
    }

    const limit = Math.max(retainedLimit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        queryFn: () =>
          loadRootSessionsWithFallback({
            directory,
            limit,
            list: (query) => serverSDK.client.session.list(query),
          })
            .then((x) => {
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const limit = Math.max(store.limit, options?.limit ?? 0, sessionMeta.get(key)?.limit ?? 0)
              const childSessions = store.session.filter((s) => !!s.parentID)
              const sessions = trimSessions([...nonArchived, ...childSessions], {
                limit,
                permission: store.permission,
              })
              batch(() => {
                setStore(
                  "sessionTotal",
                  estimateRootSessionTotal({
                    count: nonArchived.length,
                    limit: x.limit,
                    limited: x.limited,
                  }),
                )
                setStore("session", reconcile(sessions, { key: "id" }))
                cleanupDroppedSessionCaches(store, setStore, sessions)
              })
              sessionMeta.set(key, { limit })
            })
            .catch((err) => {
              console.error("Failed to load sessions", err)
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(key)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    const key = directoryKey(directory)
    if (!key) return
    // Fail-closed against a filesystem-root directory. The server refuses to boot an instance
    // rooted at "/" (assertSafeInstanceRoot — it would make the file-tool permission boundary the
    // whole disk), so a stored session/route pointing at "/" would otherwise trigger an endless
    // boot→fail→retry storm surfacing only as "unexpected server error". Mirror the guard here so
    // the doomed request is never sent and the user gets a clear reason instead. Legacy "/" data
    // (pre-guard) is the only way to reach this now that the boot path rejects it.
    if (isFilesystemRootDir(directory)) {
      showToast({
        variant: "error",
        title: language.t("toast.project.rootRefused.title"),
        description: language.t("toast.project.rootRefused.description"),
      })
      return
    }
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        scope: serverSDK.scope,
        mcp: children.mcp(key),
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
        queryClient,
      })
    })

    booting.set(key, promise)
    void promise.finally(() => {
      booting.delete(key)
      children.unpin(key)
    })
    return promise
  }

  const unsub = serverSDK.event.listen((e) => {
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const recent = bootingRoot || Date.now() - bootedAt < 1500

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (event.type === "server.connected" || event.type === "global.disposed") {
        if (recent) return
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
        }
      }
      return
    }

    const existing = children.children[key]
    if (!existing) return
    children.mark(key)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: queue.push,
      setSessionPlan,
      setSessionGoal,
      retainedLimit: sessionMeta.get(key)?.limit,
      vcsCache: children.vcsCache.get(key),
      loadLsp: () => {
        void queryClient.fetchQuery(queryOptionsApi.lsp(key))
      },
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void serverSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void serverSDK.event.start()
      }, 0)
    }
  })

  const projectApi = {
    loadSessions,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  // Refresh the cached provider lists (global + every directory scope) and re-run bootstrap.
  // Shared by config updates and by disconnect flows that change provider state on the backend
  // (e.g. auth.remove + global.dispose) but don't go through updateConfig — without this the
  // connected-provider list would not re-render after disconnecting a built-in provider.
  const refreshProviders = () => {
    bootstrap.refetch()
    queryClient.invalidateQueries({ queryKey: [serverSDK.scope, null, "providers"] })
    queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
    })
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => serverSDK.client.global.config.update({ config }),
    onSuccess: () => {
      // Invalidate all provider queries so newly configured custom providers
      // appear immediately in the available provider list across all directories.
      refreshProviders()
    },
  }))

  const updateMcpConfig = async (
    directory: string,
    input: { name: string; config: McpLocalConfig | McpRemoteConfig },
  ) => {
    const key = directoryKey(directory)
    const sdk = sdkFor(key)
    await updateConfigMutation.mutateAsync({
      ...globalStore.config,
      mcp: {
        ...(globalStore.config.mcp ?? {}),
        [input.name]: input.config,
      },
    })
    await queryClient.refetchQueries(queryOptionsApi.globalConfig())
    if (input.config.enabled === false) await sdk.mcp.disconnect({ name: input.name })
    else await sdk.mcp.connect({ name: input.name })
    await queryClient.refetchQueries(queryOptionsApi.mcp(key))
  }

  const removeMcpConfig = async (directory: string, name: string) => {
    const key = directoryKey(directory)
    const sdk = sdkFor(key)
    await sdk.mcp.disconnect({ name }).catch(() => {})
    const nextMcp = { ...(globalStore.config.mcp ?? {}) }
    delete nextMcp[name]
    await updateConfigMutation.mutateAsync({
      ...globalStore.config,
      mcp: nextMcp,
    })
    await queryClient.refetchQueries(queryOptionsApi.globalConfig())
    await queryClient.refetchQueries(queryOptionsApi.mcp(key))
  }

  // M1 (S1-v3.4): list the preset MCP catalog (metadata only; nothing is connected).
  const listMcpCatalog = async (directory: string) => {
    const sdk = sdkFor(directoryKey(directory))
    return (await sdk.mcp.catalog()).data ?? []
  }

  // M1 (S1-v3.4): enable a preset catalog entry. The backend instantiates + connects it in-memory and
  // returns the concrete name+config; we PERSIST that to cfg.mcp (so it survives restart, like manual
  // add) and refetch config + mcp status so the new server appears in the list.
  const enableMcpCatalogEntry = async (
    directory: string,
    input: { id: string; params: Record<string, string | string[]>; credentialRefs: Record<string, string> },
  ) => {
    const key = directoryKey(directory)
    const sdk = sdkFor(key)
    const res = await sdk.mcp.catalogEnable(input)
    const enabled = res.data
    if (enabled?.name && enabled.config) {
      // Persist the instantiated config to the global config so it is durable across restarts.
      await updateConfigMutation.mutateAsync({
        ...globalStore.config,
        mcp: {
          ...(globalStore.config.mcp ?? {}),
          [enabled.name]: enabled.config,
        },
      })
    }
    await queryClient.refetchQueries(queryOptionsApi.globalConfig())
    await queryClient.refetchQueries(queryOptionsApi.mcp(key))
  }

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    disableMcp: children.disableMcp,
    queryOptions: queryOptionsApi,
    // bootstrap,
    updateConfig: updateConfigMutation.mutateAsync,
    refreshProviders,
    project: projectApi,
    plan: {
      set: setSessionPlan,
    },
    goal: {
      set: setSessionGoal,
    },
    mcp: {
      toggle: async (directory: string, name: string) => {
        const key = directoryKey(directory)
        const sdk = sdkFor(key)
        const status = children.child(key, { bootstrap: false })[0].mcp[name].status
        await toggleMcp({
          status,
          connect: async () => {
            await sdk.mcp.connect({ name })
          },
          disconnect: async () => {
            await sdk.mcp.disconnect({ name })
          },
          authenticate: async () => {
            await sdk.mcp.auth.authenticate({ name })
          },
          refresh: async () => {
            await queryClient.refetchQueries(queryOptionsApi.mcp(key))
          },
        })
      },
      add: async (directory: string, input: { name: string; config: McpLocalConfig | McpRemoteConfig }) => {
        await updateMcpConfig(directory, input)
      },
      update: updateMcpConfig,
      remove: removeMcpConfig,
      catalog: listMcpCatalog,
      catalogEnable: enableMcpCatalogEntry,
    },
  }
}

export function createServerSyncContext(_serverSDK?: ServerSDK) {
  const inner = createServerSyncContextInner(_serverSDK)
  return Object.assign(inner, {
    createDirSyncContext: createRefCountMap(
      (dir) => createDirSyncContext(dir, inner, _serverSDK),
      (dir) => inner.disableMcp(dir),
      directoryKey,
    ),
  })
}

export const { use: useServerSync, provider: ServerSyncProvider } = createSimpleContext({
  name: "ServerSync",
  gate: false,
  init: (props: { server?: ServerConnection.Any }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    const conn = props.server ?? server.current
    if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
    const ctx = global.createServerCtx(conn)

    return ctx.sync
  },
})

export function useQueryOptions() {
  return useServerSync().queryOptions
}
