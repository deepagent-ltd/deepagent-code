/**
 * DebugContext — 共享调试状态 (V3.7 Phase 4.5)
 *
 * 把 DebugPanel、编辑器断点 gutter、Debug Console 三处连到同一份状态和
 * 同一条 SSE 流。单一 /debug/events 订阅（含 auth_token），事件写入 store，
 * 各消费方从 store 读，不再各自订阅。
 */
import { createSimpleContext } from "@deepagent-code/ui/context"
import { createStore, produce } from "solid-js/store"
import { onCleanup } from "solid-js"
import { useServerSDK } from "./server-sdk"
import { useServer } from "./server"
import { authTokenFromCredentials } from "@/utils/server"

// ── Types (mirror DebugService.SessionState for the frontend) ─────────────────

export interface SourceBreakpoints { source: string; lines: number[] }
export interface SessionState {
  id: string
  adapterId: string
  status: "initializing" | "initialized" | "configuring" | "running" | "stopped" | "terminated" | "exited" | "failed"
  threadId?: number
  stoppedReason?: string
  breakpoints: SourceBreakpoints[]
  exitCode?: number
  error?: string
  workdir?: string
  createdAt: number
  updatedAt: number
}
export interface StackFrame { id: number; name: string; source?: { path?: string }; line?: number; column?: number }
export interface Scope { name: string; variablesReference: number; expensive: boolean }
export interface Variable { name: string; value: string; type?: string; variablesReference: number }
export interface OutputLine { category: string; text: string; ts: number }

const MAX_OUTPUT_LINES = 5000

interface DebugStoreState {
  sessions: SessionState[]
  activeSessionId: string | undefined
  frames: StackFrame[]
  selectedFrameId: number | undefined
  scopes: Scope[]
  /** path(normalized) → set of 0-based breakpoint lines */
  breakpoints: Record<string, number[]>
  /** current paused location (editor green arrow) */
  pausedLocation: { file: string; line: number } | undefined
  /** Debug Console output (ring buffer) */
  output: OutputLine[]
}

export const { use: useDebug, provider: DebugProvider } = createSimpleContext({
  name: "Debug",
  gate: false,
  init: () => {
    const sdk = useServerSDK()
    const server = useServer()

    const [state, setState] = createStore<DebugStoreState>({
      sessions: [],
      activeSessionId: undefined,
      frames: [],
      selectedFrameId: undefined,
      scopes: [],
      breakpoints: {},
      pausedLocation: undefined,
      output: [],
    })

    // ── data loading ──────────────────────────────────────────────────────────

    const loadSessions = async () => {
      const res = await sdk.client.debug.sessions()
      const data = res.data as { sessions?: SessionState[] } | null
      const list = data?.sessions ?? []
      setState("sessions", list)
      if (!state.activeSessionId && list.length > 0) setState("activeSessionId", list[0].id)
    }

    const loadStack = async (sessionId: string) => {
      const res = await sdk.client.debug.stack({ sessionId })
      const data = res.data as { frames?: StackFrame[] } | null
      const frames = data?.frames ?? []
      setState("frames", frames)
      setState("selectedFrameId", frames[0]?.id)
      const top = frames[0]
      if (top) {
        void loadScopes(sessionId, top.id)
        // Update paused location for the editor green arrow
        if (top.source?.path && top.line !== undefined) {
          setState("pausedLocation", { file: top.source.path, line: top.line - 1 }) // DAP line is 1-based
        }
      }
    }

    const loadScopes = async (sessionId: string, frameId: number) => {
      const res = await sdk.client.debug.scopes({ sessionId, frameId })
      const data = res.data as { scopes?: Scope[] } | null
      setState("scopes", data?.scopes ?? [])
    }

    // ── SSE (single subscription) ───────────────────────────────────────────

    let sseSource: EventSource | undefined
    const connectStream = () => {
      sseSource?.close()
      const url = sdk.client.debug.eventsUrl({})
      const full = new URL(`${sdk.url}${url}`)
      const conn = server.current
      if (conn?.http?.password) {
        full.searchParams.set(
          "auth_token",
          authTokenFromCredentials({ username: conn.http.username, password: conn.http.password }),
        )
      }
      const es = new EventSource(full.toString())
      sseSource = es

      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { type: string; data: Record<string, unknown> }
          const { type, data } = msg
          const sid = data.sessionId as string | undefined

          if (type === "debug.updated") {
            setState("sessions", (s) => s.id === sid, produce((s) => {
              s.status = data.status as SessionState["status"]
              s.updatedAt = Date.now()
            }))
          } else if (type === "debug.stopped") {
            setState("sessions", (s) => s.id === sid, produce((s) => {
              s.status = "stopped"
              s.stoppedReason = data.reason as string
              s.threadId = data.threadId as number | undefined
              s.updatedAt = Date.now()
            }))
            if (sid && sid === state.activeSessionId) void loadStack(sid)
          } else if (type === "debug.output") {
            const line: OutputLine = {
              category: (data.category as string) ?? "stdout",
              text: (data.output as string) ?? "",
              ts: Date.now(),
            }
            setState("output", produce((out) => {
              out.push(line)
              if (out.length > MAX_OUTPUT_LINES) out.splice(0, out.length - MAX_OUTPUT_LINES)
            }))
          } else if (type === "debug.terminated") {
            setState("sessions", (s) => s.id === sid, produce((s) => {
              s.status = "terminated"
              s.updatedAt = Date.now()
            }))
            if (sid && sid === state.activeSessionId) {
              setState("frames", [])
              setState("scopes", [])
              setState("pausedLocation", undefined)
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    // Connect immediately; load current sessions.
    connectStream()
    void loadSessions()

    onCleanup(() => sseSource?.close())

    // ── actions ────────────────────────────────────────────────────────────

    const start = async (input: { adapter: string; program: string; args?: string[]; cwd?: string }) => {
      try {
        const res = await sdk.client.debug.start({
          adapter: input.adapter,
          program: input.program,
          ...(input.args ? { args: input.args } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
        })
        const data = res.data as { sessionId?: string; error?: string; message?: string } | null
        if (!data || data.error) {
          return { ok: false, error: data?.message ?? data?.error ?? "start failed" }
        }
        await loadSessions()
        if (data.sessionId) {
          setState("activeSessionId", data.sessionId)
          // V3.7 #6: flush any breakpoints set BEFORE this session existed
          // ("set breakpoints first, then start") to the freshly-created adapter.
          const sid = data.sessionId
          await Promise.all(
            Object.entries(state.breakpoints)
              .filter(([, lines]) => lines.length > 0)
              .map(([file, lines]) =>
                (sdk.client.debug.breakpoints({
                  sessionId: sid,
                  file,
                  breakpoints: lines.map((line) => ({ line: line + 1 })),
                }) as Promise<unknown>).catch(() => undefined),
              ),
          )
        }
        return { ok: true, sessionId: data.sessionId }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    }

    const terminate = async (sessionId: string) => {
      await (sdk.client.debug.terminate({ sessionId }) as Promise<unknown>).catch(() => undefined)
      await loadSessions()
    }

    const setActive = (sessionId: string) => {
      setState("activeSessionId", sessionId)
      setState("frames", [])
      setState("scopes", [])
    }

    const doContinue = async (sessionId: string) => {
      await (sdk.client.debug.continue({ sessionId }) as Promise<unknown>).catch(() => undefined)
      await loadSessions()
    }

    const step = async (sessionId: string, kind: "next" | "stepIn" | "stepOut") => {
      await (sdk.client.debug.step({ sessionId, kind }) as Promise<unknown>).catch(() => undefined)
      await loadSessions()
    }

    const selectFrame = async (frameId: number) => {
      const sid = state.activeSessionId
      if (!sid) return
      setState("selectedFrameId", frameId)
      await loadScopes(sid, frameId)
    }

    const loadVariables = async (sessionId: string, variablesReference: number): Promise<Variable[]> => {
      const res = await sdk.client.debug.variables({ sessionId, variablesReference })
      const data = res.data as { variables?: Variable[] } | null
      return data?.variables ?? []
    }

    const evaluate = async (sessionId: string, expression: string, frameId?: number): Promise<string> => {
      try {
        const res = await sdk.client.debug.evaluate({ sessionId, expression, ...(frameId !== undefined ? { frameId } : {}) })
        // V3.7 review P2: show the `.result` field, not the whole DAP body.
        const data = res.data as { result?: unknown } | null
        const r = data?.result
        return typeof r === "string" ? r : JSON.stringify(r ?? null)
      } catch {
        return "(evaluation error)"
      }
    }

    // ── breakpoints (optimistic local + sync to adapter) ─────────────────────

    const breakpointsFor = (file: string): Set<number> => new Set(state.breakpoints[file] ?? [])

    const syncBreakpoints = async (file: string) => {
      const sid = state.activeSessionId
      if (!sid) return // no live session — local-only until one starts
      const lines = state.breakpoints[file] ?? []
      await (sdk.client.debug.breakpoints({
        sessionId: sid,
        file,
        breakpoints: lines.map((line) => ({ line: line + 1 })), // DAP is 1-based
      }) as Promise<unknown>).catch(() => undefined)
    }

    const toggleBreakpoint = async (file: string, line: number) => {
      // optimistic local update — editor gutter reflects immediately
      setState("breakpoints", produce((bp) => {
        const cur = bp[file] ?? []
        const idx = cur.indexOf(line)
        if (idx >= 0) cur.splice(idx, 1)
        else cur.push(line)
        bp[file] = cur
      }))
      await syncBreakpoints(file)
    }

    return {
      state,
      start,
      terminate,
      setActive,
      continue: doContinue,
      step,
      selectFrame,
      loadStack,
      loadVariables,
      evaluate,
      toggleBreakpoint,
      breakpointsFor,
    }
  },
})
