import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionRequest, QuestionRequest, Todo } from "@deepagent-code/sdk/v2"
import { useParams } from "@solidjs/router"
import { showToast } from "@/utils/toast"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"
import { planStepTodoStatus, todoState } from "./session-composer-state-model"

export { planStepTodoStatus, todoState }

const idle = { type: "idle" as const }

export function createSessionComposerState(options?: { closeMs?: number | (() => number) }) {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const language = useLanguage()
  const permission = usePermission()

  const questionRequest = createMemo((): QuestionRequest | undefined => {
    return sessionQuestionRequest(sync.data.session, sync.data.question, params.id)
  })

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    return sessionPermissionRequest(sync.data.session, sync.data.permission, params.id, (item) => {
      return !permission.autoResponds(item, sdk.directory)
    })
  })

  const blocked = createMemo(() => {
    const id = params.id
    if (!id) return false
    return !!permissionRequest() || !!questionRequest()
  })

  // U2: when a persistent plan exists for this session, the dock renders the PLAN's steps (mapped to
  // the Todo shape the dock already knows) instead of the transient per-turn todos. The plan is
  // durable — it survives the session going idle, unlike todos (see clear() guard below).
  const plan = createMemo(() => {
    const id = params.id
    if (!id) return undefined
    return serverSync.data.session_plan[id]
  })

  const planAsTodos = createMemo((): Todo[] => {
    const p = plan()
    if (!p) return []
    return p.steps.map((s, i) => ({
      id: s.step_id || `step_${i}`,
      content: s.title,
      status: planStepTodoStatus(s.status),
      priority: "medium",
    })) as unknown as Todo[]
  })

  // Task tracking is unified onto the plan system — the dock renders the plan's steps (mapped to
  // the Todo shape it already knows). The legacy per-turn `todowrite` track was removed because it
  // shadowed the plan here (a plan with >0 steps unconditionally won), so todo-based progress
  // reports were never visible. There is now a single source: the persistent plan.
  const todos = createMemo((): Todo[] => {
    const id = params.id
    if (!id) return []
    return planAsTodos()
  })

  // True when this session is driven by a persistent plan — clear() must NOT wipe it on idle.
  const hasPlan = createMemo(() => (plan()?.steps.length ?? 0) > 0)

  const done = createMemo(
    () => todos().length > 0 && todos().every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  )

  // U2: a session with a persistent plan stays "live" for dock purposes even when idle, so the plan
  // panel remains visible (the FSM treats not-live + todos as "clear", which we don't want for plans).
  const live = createMemo(() => sync.data.session_working(params.id ?? "") || blocked() || hasPlan())

  const [store, setStore] = createStore({
    responding: undefined as string | undefined,
    dock: todos().length > 0 && live(),
    closing: false,
    opening: false,
  })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()
    if (!perm) return false
    return store.responding === perm.id
  })

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()
    if (!perm) return
    if (store.responding === perm.id) return

    setStore("responding", perm.id)
    sdk.client.permission
      .respond({ sessionID: perm.sessionID, permissionID: perm.id, response })
      .catch((err: unknown) => {
        const description = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description })
      })
      .finally(() => {
        setStore("responding", (id) => (id === perm.id ? undefined : id))
      })
  }

  let timer: number | undefined
  let raf: number | undefined

  const closeMs = () => {
    const value = options?.closeMs
    if (typeof value === "function") return Math.max(0, value())
    if (typeof value === "number") return Math.max(0, value)
    return 400
  }

  const scheduleClose = () => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      setStore({ dock: false, closing: false })
      timer = undefined
    }, closeMs())
  }

  // The task dock is now driven exclusively by the persistent plan (session_plan), which must NOT
  // be wiped on idle. Since the dock's todos come only from the plan, `todos().length > 0` implies
  // `hasPlan()`, so the FSM's "clear" state (count > 0 && !live) is unreachable and this is a no-op
  // guard kept for clarity — there is no transient per-turn todo cache left to clear.
  const clear = () => {}

  createEffect(
    on(
      () => [todos().length, done(), live()] as const,
      ([count, complete, active]) => {
        if (raf) cancelAnimationFrame(raf)
        raf = undefined

        const next = todoState({
          count,
          done: complete,
          live: active,
        })

        if (next === "hide") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ dock: false, closing: false, opening: false })
          return
        }

        if (next === "clear") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          clear()
          return
        }

        if (next === "open") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          const hidden = !store.dock || store.closing
          setStore({ dock: true, closing: false })
          if (hidden) {
            setStore("opening", true)
            raf = requestAnimationFrame(() => {
              setStore("opening", false)
              raf = undefined
            })
            return
          }
          setStore("opening", false)
          return
        }

        setStore({ dock: true, opening: false, closing: true })
        if (!timer) scheduleClose()
      },
    ),
  )

  onCleanup(() => {
    if (!timer) return
    window.clearTimeout(timer)
  })

  onCleanup(() => {
    if (!raf) return
    cancelAnimationFrame(raf)
  })

  return {
    blocked,
    questionRequest,
    permissionRequest,
    permissionResponding,
    decide,
    todos,
    dock: () => store.dock,
    closing: () => store.closing,
    opening: () => store.opening,
  }
}

export type SessionComposerState = ReturnType<typeof createSessionComposerState>
