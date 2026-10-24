import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo } from "solid-js"
import { useSync } from "./sync"
import { useEvent } from "./event"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { readJson, writeJsonAtomic } from "../util/persistence"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute } from "./route"
import { useKV } from "./kv"
import { useProject } from "./project"
import { configuredCollaborationMode } from "@deepagent-code/core/session/collaboration-mode"
import { useTuiI18n } from "./i18n"
import { mcpConnectionBlocked } from "../util/mcp-status"
import type { Agent } from "@deepagent-code/sdk"

export type LocalTheme = {
  secondary: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  primary: RGBA
  error: RGBA
  info: RGBA
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

export function recentModels(
  model: { providerID: string; modelID: string },
  recent: { providerID: string; modelID: string }[],
) {
  const seen = new Set<string>()
  return [model, ...recent]
    .filter((item) => {
      const key = `${item.providerID}/${item.modelID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
    .map((item) => ({ providerID: item.providerID, modelID: item.modelID }))
}

/** A pending or unavailable list cannot select an Agent or authorize composer actions. */
export function createAgentSelection(input: {
  agents: () => Agent[] | undefined
  loading: () => boolean
  preferred?: () => string | undefined
  scope?: () => string
  selected?: () => string | undefined
  save?: (name: string) => void
  warn: (message: string) => void
}) {
  const agents = createMemo(
    () => input.agents()?.filter((agent) => agent.mode !== "subagent" && !agent.hidden) ?? [],
    [],
  )
  const [store, setStore] = createStore<{ current: Record<string, string | undefined> }>({ current: {} })
  const status = () =>
    input.loading()
      ? ("loading" as const)
      : !Array.isArray(input.agents())
        ? ("unavailable" as const)
        : (agents() ?? []).length
          ? ("ready" as const)
          : ("empty" as const)
  const list = () => (status() === "ready" ? (agents() ?? []) : [])
  const current = () => {
    const preferred = input.preferred?.()
    const name = preferred === "build" && !list().some((agent) => agent.name === "build") ? "auto" : preferred
    return (
      list().find((agent) => agent.name === (input.selected?.() ?? store.current[input.scope?.() ?? "default"])) ??
      list().find((agent) => agent.name === name) ??
      list().at(0)
    )
  }
  return {
    status,
    list,
    current,
    reset(scope: string) {
      setStore("current", scope, undefined)
    },
    set(name: string) {
      if (status() !== "ready") {
        input.warn(
          status() === "loading" ? "Agents are still loading" : "Agent list is unavailable. Reconnect to retry.",
        )
        return false
      }
      if (!list().some((agent) => agent.name === name)) {
        input.warn(`Agent not found: ${name}`)
        return false
      }
      setStore("current", input.scope?.() ?? "default", name)
      input.save?.(name)
      return true
    },
    move(direction: 1 | -1) {
      const selected = current()
      if (!selected) return false
      const values = list()
      const index = values.findIndex((agent) => agent.name === selected.name)
      const next = values[(index + direction + values.length) % values.length]
      if (!next) return false
      setStore("current", input.scope?.() ?? "default", next.name)
      input.save?.(next.name)
      return true
    },
  }
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const theme = useTheme().theme
    const route = useRoute()
    const kv = useKV()
    const project = useProject()
    const paths = useTuiPaths()
    const i18n = useTuiI18n()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((x) => x.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    function createAgent() {
      const sessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)
      const effective = () => {
        const id = sessionID()
        if (!id) return
        const session = sync.session.get(id)
        return sync.data.message[id]?.findLast((message) => message.role === "user")?.agent ?? session?.agent
      }
      const selectionKey = () =>
        JSON.stringify([
          sdk.url,
          project.instance.path().directory,
          sessionID() ? (sync.session.get(sessionID()!)?.workspaceID ?? null) : null,
          sessionID() ?? "new-session",
        ])
      const selection = createAgentSelection({
        agents: () => sync.data.agent,
        loading: () => sync.status === "loading" || !kv.ready,
        scope: selectionKey,
        selected: () => (kv.get("agent_selection.v2", {}) as Record<string, string>)[selectionKey()],
        preferred: () =>
          sessionID() ? (effective() ?? "auto") : configuredCollaborationMode(sync.data.config.default_agent),
        save: (name) =>
          kv.set("agent_selection.v2", {
            ...(kv.get("agent_selection.v2", {}) as Record<string, string>),
            [selectionKey()]: name,
          }),
        warn: (message) => toast.show({ variant: "warning", message, duration: 3000 }),
      })
      const visibleAgents = createMemo(() => sync.data.agent?.filter((x) => !x.hidden) ?? [], [])
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        ...selection,
        effective() {
          return sync.data.agent?.find((agent) => agent.name === effective())
        },
        promote(session: { id: string; workspaceID?: string }) {
          if (sessionID()) return
          const previous = selectionKey()
          const selected = selection.current()?.name
          const saved = { ...(kv.get("agent_selection.v2", {}) as Record<string, string>) }
          delete saved[previous]
          if (selected)
            saved[
              JSON.stringify([sdk.url, project.instance.path().directory, session.workspaceID ?? null, session.id])
            ] = selected
          selection.reset(previous)
          kv.set("agent_selection.v2", saved)
        },
        color(name: string) {
          const visible = visibleAgents() ?? []
          const index = visible.findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visible[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    }

    const agent = createAgent()

    function createModel() {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
      })

      const filePath = path.join(paths.state, "model.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          recent: modelStore.recent,
          favorite: modelStore.favorite,
          variant: modelStore.variant,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const value = x as Record<string, unknown>
          if (Array.isArray(value.recent)) setModelStore("recent", value.recent)
          if (Array.isArray(value.favorite)) setModelStore("favorite", value.favorite)
          if (typeof value.variant === "object" && value.variant !== null)
            setModelStore("variant", value.variant as Record<string, string | undefined>)
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const args = useArgs()
      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        if (sync.data.config.model) {
          const { providerID, modelID } = parseModel(sync.data.config.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const currentModel = createMemo(() => {
        const a = agent.current()
        if (!a) return undefined
        return (
          getFirstValidModel(
            () => a && modelStore.model[a.name],
            () => a && a.model,
            fallbackModel,
          ) ?? undefined
        )
      })

      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            if (agent.status() !== "ready")
              return {
                provider: agent.status() === "loading" ? "Loading agents" : "Agent data unavailable",
                model: agent.status() === "loading" ? "Waiting for current Agent list" : "Reconnect to retry",
                reasoning: false,
              }
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((x) => x.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...val })
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: i18n.t("tui.local.addFavoriteModelHint"),
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...next })
          setModelStore("recent", recentModels(next, modelStore.recent))
          save()
        },
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const a = agent.current()
            if (!a) return
            setModelStore("model", a.name, model)
            if (options?.recent) {
              setModelStore("recent", recentModels(model, modelStore.recent))
              save()
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          selected() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key]
          },
          current() {
            const v = this.selected()
            if (!v) return undefined
            if (!this.list().includes(v)) return undefined
            return v
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((x) => x.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            setModelStore("variant", key, value ?? "default")
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    }

    const model = createModel()

    function createSession() {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const filePath = path.join(paths.state, "session.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void writeJsonAtomic(filePath, {
          pinned: sessionStore.pinned,
        })
      }

      readJson<unknown>(filePath)
        .then((x) => {
          if (!x || typeof x !== "object") return
          const pinned = (x as Record<string, unknown>).pinned
          if (Array.isArray(pinned))
            setSessionStore(
              "pinned",
              pinned.filter((item): item is string => typeof item === "string"),
            )
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const event = useEvent()

      const slots = createMemo(() => {
        const existing = new Set(sync.data.session.filter((x) => x.parentID === undefined).map((x) => x.id))
        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)
      })

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((x) => x !== sessionID),
            )
          }
          save()
        })
      }

      event.on("session.deleted", (evt) => {
        prune(evt.properties.info.id)
      })

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    }

    const session = createSession()

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (!status || mcpConnectionBlocked(status)) throw new Error(i18n.t("tui.mcp.connection.recoveryRequired"))
        if (sdk.mcpOperator) {
          const prepared = await sdk.mcpOperator.prepare(name)
          try {
            await sdk.mcpOperator.send({
              ticket: prepared.ticket,
              action:
                status.status === "connected"
                  ? "disconnect"
                  : status.status === "needs_auth"
                    ? "authenticate"
                    : "connect",
            })
          } finally {
            await sdk.mcpOperator.release(prepared.ticket)
          }
          return
        }
        if (status.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else if (status.status === "needs_auth") {
          await sdk.client.mcp.auth.authenticate({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    createEffect(() => {
      const value = agent.current()
      if (!value?.model) return
      if (isModelValid(value.model)) return
      toast.show({
        variant: "warning",
        message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
        duration: 3000,
      })
    })

    const result = {
      model,
      agent,
      mcp,
      session,
    }
    return result
  },
})
