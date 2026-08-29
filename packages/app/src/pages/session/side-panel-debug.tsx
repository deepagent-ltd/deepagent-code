/**
 * SidePanelDebug — V3.7 Phase 4.3/4.5 DAP 调试可视化面板
 *
 * 挂载到右侧工作面板 "debug" 模式。状态来自共享 DebugContext（Phase 4.5）：
 *   - 无会话时显示"启动调试"表单（P1-3）
 *   - 有会话时：SessionBar → ControlBar → StackView → VariableTree → WatchInput
 *
 * SSE 订阅、断点、输出等均由 DebugContext 统一持有，本面板只读+调方法。
 */
import { For, Match, Show, Switch, createResource, createSignal, type Component } from "solid-js"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Icon } from "@deepagent-code/ui/icon"
import { useLanguage } from "@/context/language"
import { useDebug, type Scope, type StackFrame, type Variable, type SessionState } from "@/context/debug"

// ── helpers ──────────────────────────────────────────────────────────────────

const statusColor = (s: SessionState["status"]) => {
  if (s === "running") return "text-green-400"
  if (s === "stopped") return "text-amber-400"
  if (s === "terminated" || s === "exited" || s === "failed") return "text-text-weak"
  return "text-blue-400"
}

const statusLabel = (s: SessionState["status"]) => {
  const map: Record<string, string> = {
    initializing: "初始化中",
    initialized: "已初始化",
    configuring: "配置中",
    running: "运行中",
    stopped: "已暂停",
    terminated: "已终止",
    exited: "已退出",
    failed: "失败",
  }
  return map[s] ?? s
}

// Built-in adapter whitelist (matches the D2 registry base set).
const ADAPTERS = [
  { id: "debugpy", label: "Python (debugpy)" },
  { id: "delve", label: "Go (delve)" },
  { id: "lldb", label: "C/C++/Rust (lldb)" },
  { id: "gdb", label: "C/C++ (gdb)" },
]

// ── VariableRow ──────────────────────────────────────────────────────────────

const VariableRow: Component<{ variable: Variable; depth: number; sessionId: string }> = (props) => {
  const debug = useDebug()
  const [expanded, setExpanded] = createSignal(false)
  const [children, setChildren] = createSignal<Variable[]>([])
  const [loading, setLoading] = createSignal(false)

  const hasChildren = () => props.variable.variablesReference > 0

  const toggle = async () => {
    if (!hasChildren()) return
    const next = !expanded()
    setExpanded(next)
    if (next && children().length === 0) {
      setLoading(true)
      try {
        setChildren(await debug.loadVariables(props.sessionId, props.variable.variablesReference))
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <>
      <button
        type="button"
        class="w-full flex items-center gap-1 px-2 py-0.5 text-left hover:bg-surface-base rounded-sm"
        style={{ "padding-left": `${8 + props.depth * 16}px` }}
        onClick={toggle}
        aria-expanded={expanded()}
      >
        <Show when={hasChildren()} fallback={<span class="w-3.5 shrink-0" aria-hidden />}>
          <Icon name={expanded() ? "arrow-undo-down" : "arrow-right"} size="small" class="text-icon-weak shrink-0" />
        </Show>
        <span class="text-11-medium text-text-base shrink-0 mr-1">{props.variable.name}</span>
        <span class="text-11-regular text-text-weak truncate min-w-0">{props.variable.value}</span>
        <Show when={props.variable.type}>
          <span class="text-11-regular text-text-weaker shrink-0 ml-1">: {props.variable.type}</span>
        </Show>
      </button>
      <Show when={loading()}>
        <div class="px-4 py-0.5 text-11-regular text-text-weak" style={{ "padding-left": `${24 + props.depth * 16}px` }}>加载中…</div>
      </Show>
      <Show when={expanded() && !loading()}>
        <For each={children()}>
          {(child) => <VariableRow variable={child} depth={props.depth + 1} sessionId={props.sessionId} />}
        </For>
      </Show>
    </>
  )
}

const VariableTreeLoader: Component<{ sessionId: string; scope: Scope }> = (props) => {
  const debug = useDebug()
  const [vars] = createResource(
    () => ({ sessionId: props.sessionId, ref: props.scope.variablesReference }),
    ({ sessionId, ref }) => debug.loadVariables(sessionId, ref),
  )
  return (
    <Switch>
      <Match when={vars.loading}><div class="px-5 py-0.5 text-11-regular text-text-weak">加载中…</div></Match>
      <Match when={vars.error}><div class="px-5 py-0.5 text-11-regular text-red-400">加载失败</div></Match>
      <Match when={vars()}>
        {(list) => <For each={list()}>{(v) => <VariableRow variable={v} depth={1} sessionId={props.sessionId} />}</For>}
      </Match>
    </Switch>
  )
}

// ── StartForm (P1-3: human launch entry) ─────────────────────────────────────

const StartForm: Component = () => {
  const debug = useDebug()
  const [adapter, setAdapter] = createSignal(ADAPTERS[0]!.id)
  const [program, setProgram] = createSignal("")
  const [argsText, setArgsText] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  const submit = async () => {
    if (!program().trim()) return
    setBusy(true)
    setError(undefined)
    const args = argsText().trim() ? argsText().trim().split(/\s+/) : undefined
    const res = await debug.start({ adapter: adapter(), program: program().trim(), ...(args ? { args } : {}) })
    setBusy(false)
    if (!res.ok) setError(res.error ?? "启动失败")
  }

  return (
    <div class="p-3 flex flex-col gap-2">
      <div class="text-11-medium text-text-weak uppercase tracking-wide">启动调试</div>
      <label class="text-11-regular text-text-weak">
        调试器
        <select
          class="w-full mt-0.5 text-12-regular bg-surface-base border border-border-weak-base rounded px-2 py-1 text-text-strong"
          value={adapter()}
          onChange={(e) => setAdapter(e.currentTarget.value)}
        >
          <For each={ADAPTERS}>{(a) => <option value={a.id}>{a.label}</option>}</For>
        </select>
      </label>
      <label class="text-11-regular text-text-weak">
        程序路径
        <input
          class="w-full mt-0.5 bg-surface-base border border-border-weak-base rounded px-2 py-1 text-12-regular text-text-strong outline-none focus:border-border-strong-base placeholder:text-text-weaker"
          placeholder="src/main.py"
          value={program()}
          onInput={(e) => setProgram(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit() }}
        />
      </label>
      <label class="text-11-regular text-text-weak">
        参数（可选）
        <input
          class="w-full mt-0.5 bg-surface-base border border-border-weak-base rounded px-2 py-1 text-12-regular text-text-strong outline-none focus:border-border-strong-base placeholder:text-text-weaker"
          placeholder="--flag value"
          value={argsText()}
          onInput={(e) => setArgsText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit() }}
        />
      </label>
      <button
        type="button"
        class="mt-1 h-8 rounded-md bg-surface-base-active hover:bg-surface-raised-base-hover text-12-medium text-text-strong disabled:opacity-50"
        disabled={busy() || !program().trim()}
        onClick={submit}
      >
        {busy() ? "启动中…" : "启动调试会话"}
      </button>
      <Show when={error()}>
        {(e) => <div class="text-11-regular text-red-400 break-all">{e()}</div>}
      </Show>
    </div>
  )
}

// ── SidePanelDebug (main export) ─────────────────────────────────────────────

export const SidePanelDebug: Component<{
  onClose: () => void
  onNavigate?: (file: string, line: number) => void
}> = (props) => {
  const debug = useDebug()
  const language = useLanguage()

  const sessions = () => debug.state.sessions
  const activeSession = () => sessions().find((s) => s.id === debug.state.activeSessionId)
  const isStopped = () => activeSession()?.status === "stopped"
  const isActive = () => {
    const s = activeSession()?.status
    return s === "running" || s === "stopped"
  }

  const [watchExpr, setWatchExpr] = createSignal("")
  const [watchResult, setWatchResult] = createSignal<string | undefined>(undefined)

  const doEvaluate = async () => {
    const expr = watchExpr().trim()
    const id = debug.state.activeSessionId
    if (!expr || !id) return
    setWatchResult(await debug.evaluate(id, expr, debug.state.selectedFrameId))
  }

  const selectFrame = (frame: StackFrame) => {
    void debug.selectFrame(frame.id)
    if (props.onNavigate && frame.source?.path && frame.line !== undefined) {
      props.onNavigate(frame.source.path, frame.line - 1) // DAP 1-based → editor 0-based
    }
  }

  return (
    <div class="h-full w-full min-w-0 flex flex-col overflow-hidden bg-background-base">
      <div class="shrink-0 h-10 flex items-center justify-between px-3 border-b border-border-weaker-base">
        <span class="text-12-medium text-text">调试</span>
        <IconButton
          icon="close-small"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={props.onClose}
          aria-label={language.t("common.close")}
        />
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto">
        {/* No sessions → start form (P1-3) */}
        <Show when={sessions().length === 0}>
          <StartForm />
        </Show>

        <Show when={sessions().length > 0}>
          {/* SessionBar */}
          <div class="px-3 py-2 border-b border-border-weaker-base">
            <Show when={sessions().length > 1}>
              <select
                class="w-full mb-1.5 text-12-regular bg-surface-base border border-border-weak-base rounded px-2 py-0.5 text-text-strong"
                value={debug.state.activeSessionId ?? ""}
                onChange={(e) => debug.setActive(e.currentTarget.value)}
                aria-label="选择调试会话"
              >
                <For each={sessions()}>{(s) => <option value={s.id}>{s.adapterId} — {s.id.slice(0, 8)}</option>}</For>
              </select>
            </Show>
            <Show when={activeSession()}>
              {(s) => (
                <div class="flex items-center gap-2">
                  <span class={`text-11-medium ${statusColor(s().status)}`}>{statusLabel(s().status)}</span>
                  <span class="text-11-regular text-text-weaker truncate flex-1 min-w-0">{s().adapterId} · {s().id.slice(0, 8)}</span>
                  <Show when={s().stoppedReason}>
                    <span class="text-11-regular text-amber-400 shrink-0">{s().stoppedReason}</span>
                  </Show>
                </div>
              )}
            </Show>
          </div>

          {/* ControlBar */}
          <div class="px-2 py-1 flex items-center gap-0.5 border-b border-border-weaker-base" role="toolbar" aria-label="调试控制">
            <IconButton icon="check" variant="ghost" size="small" class="h-7 w-7 rounded-md" disabled={!isStopped()}
              onClick={() => debug.state.activeSessionId && void debug.continue(debug.state.activeSessionId)} aria-label="继续" title="继续 (F5)" />
            <IconButton icon="arrow-right" variant="ghost" size="small" class="h-7 w-7 rounded-md" disabled={!isStopped()}
              onClick={() => debug.state.activeSessionId && void debug.step(debug.state.activeSessionId, "next")} aria-label="单步跳过" title="单步跳过 (F10)" />
            <IconButton icon="enter" variant="ghost" size="small" class="h-7 w-7 rounded-md" disabled={!isStopped()}
              onClick={() => debug.state.activeSessionId && void debug.step(debug.state.activeSessionId, "stepIn")} aria-label="单步进入" title="单步进入 (F11)" />
            <IconButton icon="arrow-up" variant="ghost" size="small" class="h-7 w-7 rounded-md" disabled={!isStopped()}
              onClick={() => debug.state.activeSessionId && void debug.step(debug.state.activeSessionId, "stepOut")} aria-label="单步退出" title="单步退出 (Shift+F11)" />
            <div class="flex-1" />
            <IconButton icon="close-small" variant="ghost" size="small" class="h-7 w-7 rounded-md text-red-400" disabled={!isActive()}
              onClick={() => debug.state.activeSessionId && void debug.terminate(debug.state.activeSessionId)} aria-label="终止调试" title="终止调试" />
          </div>

          {/* StackView */}
          <Show when={debug.state.frames.length > 0}>
            <div class="border-b border-border-weaker-base">
              <div class="px-3 py-1.5 text-11-medium text-text-weak uppercase tracking-wide">调用栈</div>
              <div role="list" aria-label="调用栈">
                <For each={debug.state.frames}>
                  {(frame) => (
                    <button type="button" role="listitem"
                      class="w-full flex items-center gap-2 px-3 py-1 text-left hover:bg-surface-base"
                      classList={{ "bg-surface-base-active": debug.state.selectedFrameId === frame.id }}
                      onClick={() => selectFrame(frame)}
                      aria-pressed={debug.state.selectedFrameId === frame.id}
                    >
                      <span class="text-11-medium text-text-base truncate min-w-0 flex-1">{frame.name}</span>
                      <Show when={frame.source?.path}>
                        {(p) => <span class="text-11-regular text-text-weaker truncate shrink-0 max-w-[50%]">{p().split("/").at(-1)}:{frame.line}</span>}
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* VariableTree */}
          <Show when={debug.state.scopes.length > 0}>
            <div class="border-b border-border-weaker-base">
              <div class="px-3 py-1.5 text-11-medium text-text-weak uppercase tracking-wide">变量</div>
              <Show when={debug.state.activeSessionId}>
                {(id) => (
                  <For each={debug.state.scopes}>
                    {(scope) => (
                      <div>
                        <div class="px-3 py-0.5 text-11-medium text-text-weak">{scope.name}</div>
                        <VariableTreeLoader sessionId={id()} scope={scope} />
                      </div>
                    )}
                  </For>
                )}
              </Show>
            </div>
          </Show>

          {/* WatchInput */}
          <div class="px-3 py-2">
            <div class="text-11-medium text-text-weak mb-1 uppercase tracking-wide">监视表达式</div>
            <div class="flex gap-1">
              <input
                class="flex-1 min-w-0 bg-surface-base border border-border-weak-base rounded px-2 py-0.5 text-12-regular text-text-strong outline-none focus:border-border-strong-base placeholder:text-text-weaker"
                placeholder="输入表达式…"
                value={watchExpr()}
                onInput={(e) => setWatchExpr(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void doEvaluate() }}
                disabled={!isStopped()}
                aria-label="监视表达式"
              />
              <IconButton icon="check" variant="ghost" size="small" class="h-7 w-7 shrink-0 rounded-md"
                onClick={doEvaluate} disabled={!isStopped() || !watchExpr().trim()} aria-label="求值" />
            </div>
            <Show when={watchResult()}>
              {(r) => <div class="mt-1 text-11-regular text-text-base bg-surface-base rounded px-2 py-1 break-all">{r()}</div>}
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
