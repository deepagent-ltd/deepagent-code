import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import path from "path"
import { LSP } from "@/lsp/lsp"
import { LSPResolve } from "@/lsp/resolve"
import { DebugAdapter } from "@/debug/adapter"
import { DebugService } from "@/debug/service"
import { RuntimeBase } from "@/runtime/base"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./debug.txt"
import * as Log from "@deepagent-code/core/util/log"
import { Identifier } from "@/id/id"

const log = Log.create({ service: "tool.debug" })

/**
 * D3 (S1-v3.5): the `debug` Agent tool — symbol-driven DAP entry point.
 *
 * Agents address code by symbol name + intent; coordinates are resolved
 * internally (LSPResolve) and hidden, matching the code_intel philosophy.
 *
 * Control-plane only: this tool orchestrates a debug session but implements no
 * debugging itself. It routes EVERY operation through `DebugService` (D1: the
 * finite session state machine + EventV2 bridge + adapter-process lifecycle) and
 * `RuntimeBase` (R0: fail-closed privilege gate, approve-once, worktree isolation).
 * There is no local session Map and no local approval Set — the service owns
 * session state (with a finalizer that tears down orphaned adapter processes) and
 * R0 owns approval/privilege state (one instance per session).
 *
 * D4 evidence: the serializable `SessionState` snapshot is available in the tool
 * result metadata (and registered as DEBUG_SESSION.json, evidence_kind:"debug_session",
 * in agent-gateway.ts) — no live handles ever leak into it.
 */

const intents = ["start", "break_at", "step", "continue", "stack", "inspect", "eval", "stop"] as const
type Intent = (typeof intents)[number]

const stepKinds = ["next", "stepIn", "stepOut"] as const

export const Parameters = Schema.Struct({
  intent: Schema.Literals(intents).annotate({
    description: "What to do: start a debug session, set a breakpoint, step, continue, inspect stack/vars, eval an expression, or stop.",
  }),
  target: Schema.optional(Schema.String).annotate({
    description: "For intent:start — the command or test to run under the debugger, e.g. 'python -m pytest test_foo.py'.",
  }),
  symbol: Schema.optional(Schema.String).annotate({
    description: "For intent:break_at — symbol name to break at (resolved via LSP, no raw line numbers needed).",
  }),
  condition: Schema.optional(Schema.String).annotate({
    description: "For intent:break_at — optional conditional expression for the breakpoint.",
  }),
  expression: Schema.optional(Schema.String).annotate({
    description: "For intent:eval — expression to evaluate in the current frame.",
  }),
  frame: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "For intent:inspect/eval — stack frame index (0 = innermost). Default: 0.",
  }),
  language: Schema.optional(Schema.String).annotate({
    description: "For intent:start — programming language to select the adapter, e.g. 'python'. Auto-detected from target when omitted.",
  }),
  session_id: Schema.optional(Schema.String).annotate({
    description: "Multi-session: identifier for this debug session. Auto-generated when omitted.",
  }),
  step_kind: Schema.optional(Schema.Literals(stepKinds)).annotate({
    description: "For intent:step — 'next' (step over, default), 'stepIn', or 'stepOut'.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

/** Pick a display language from the target command (best-effort heuristic). */
function inferLanguage(target: string): string {
  // Order + word boundaries matter: the old `includes("go ")` matched the "go r" in
  // "car`go r`un" and shadowed Rust. Check the most specific signals first and anchor
  // each keyword on a word/extension boundary so substrings don't cross-match.
  if (/\bcargo\b|\brust\b|\brustc\b|\.rs\b/.test(target)) return "rust"
  if (/\bpython[0-9.]*\b|\bpytest\b|\.py\b/.test(target)) return "python"
  if (/\.(c|cpp|cc|cxx|h|hpp)\b/.test(target)) return "cpp"
  if (/\bgo\b|\bdlv\b|\.go\b/.test(target)) return "go"
  if (/\bswift\b|\.swift\b/.test(target)) return "swift"
  return "unknown"
}

function renderFrames(frames: any[]): string {
  if (!frames.length) return "No stack frames."
  return frames
    .slice(0, 10)
    .map((f: any, i: number) => {
      const src = f.source?.name ?? f.source?.path ?? "?"
      const line = f.line ?? "?"
      return `  Frame #${i}: ${f.name ?? "?"} at ${src}:${line}`
    })
    .join("\n")
}

function renderVariables(vars: any[], label: string): string {
  if (!vars.length) return `No variables in ${label}.`
  const lines = vars.slice(0, 20).map((v: any) => `  ${v.name ?? "?"}: ${String(v.value ?? "?").slice(0, 120)}`)
  const extra = vars.length > 20 ? `\n  … ${vars.length - 20} more (see DEBUG_SESSION.json evidence)` : ""
  return lines.join("\n") + extra
}

export const DebugTool = Tool.define(
  "debug",
  Effect.gen(function* () {
    // Consume the D1/R0 infrastructure directly (registry layer provides both).
    const lsp = yield* LSP.Service
    const debug = yield* DebugService.Service
    const base = yield* RuntimeBase.Service
    const adapterRegistry = DebugAdapter.make()

    /**
     * Resolve the session id to operate on. Explicit `session_id` wins; otherwise
     * reuse the most-recently-updated live session (matches debug.txt: "omit to use
     * the first/only live session"). Returns undefined when none exists.
     */
    const resolveSessionId = (explicit: string | undefined) =>
      Effect.gen(function* () {
        if (explicit) return explicit
        const sessions = yield* debug.list()
        if (sessions.length === 0) return undefined
        const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]!
        return latest.id
      })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context

          // ── start ─────────────────────────────────────────────────────────────
          if (args.intent === "start") {
            if (!args.target)
              return { title: "debug: error", metadata: {}, output: "`target` is required for intent:start." }
            const target = args.target

            const language = args.language ?? inferLanguage(target)
            const resolution = adapterRegistry.resolve(language)
            if (!resolution.available) {
              return {
                title: "debug: adapter unavailable",
                metadata: { available: false },
                output: resolution.message,
              }
            }

            // A caller-chosen id, or a fresh ascending one for a brand-new session.
            const sessionId = args.session_id ?? Identifier.ascending("tool")

            // Run the launch inside an isolated worktree (R0 U3). DebugService.start
            // performs the R0 gate (privilege fail-closed → approve-once) internally,
            // spawns the adapter, and drives launch → initialized → configurationDone.
            const state = yield* base.withIsolation({ name: `debug-${resolution.spec.id}` }, (workdir) =>
              debug.start({
                spec: resolution.spec,
                sessionId,
                // Pass the target as the launch program so the debuggee is actually
                // launched (not just an initialize handshake) — the fix for C4.
                launch: { program: target, cwd: workdir },
                cwd: workdir,
                requestApproval: () =>
                  ctx.ask({
                    permission: "debug",
                    patterns: [target],
                    always: [],
                    metadata: { intent: "start", target, sessionId, isolated: workdir },
                  }),
              }),
            )
            log.info("debug session started", { sessionId, adapter: resolution.spec.id })

            return {
              title: `debug: session started (${sessionId})`,
              metadata: { sessionId, adapter: resolution.spec.id, status: state.status, session: state },
              output: `Debug session ${sessionId} started.\nAdapter: ${resolution.spec.id}\nTarget: ${target}\nStatus: ${state.status}\n\nUse intent:break_at (symbol name) to set breakpoints, then intent:continue to run.`,
            }
          }

          // ── resolve the target session for all non-start intents ──────────────
          const sessionId = yield* resolveSessionId(args.session_id)
          if (!sessionId) {
            return {
              title: "debug: no session",
              metadata: {},
              output: "No active debug session. Use intent:start first.",
            }
          }
          const current = yield* debug.get(sessionId)
          if (!current) {
            return {
              title: "debug: no session",
              metadata: {},
              output: `No active debug session '${sessionId}'. Use intent:start first.`,
            }
          }

          // ── break_at ──────────────────────────────────────────────────────────
          if (args.intent === "break_at") {
            if (!args.symbol)
              return { title: "debug: error", metadata: {}, output: "`symbol` is required for intent:break_at." }

            // Symbol resolution via LSP (L2 resolveSymbol) — no raw line numbers.
            const resolved = yield* LSPResolve.resolveSymbol({ lsp, symbol: args.symbol }).pipe(
              Effect.catch(() => Effect.succeed({ type: "not_found" as const })),
            )
            if (resolved.type === "not_found") {
              return {
                title: "debug: symbol not found",
                metadata: { sessionId },
                output: `Symbol '${args.symbol}' not found via LSP. Is an LSP server active for this file type?`,
              }
            }
            if (resolved.type === "ambiguous") {
              const list = resolved.candidates
                .map(
                  (c) =>
                    `  ${c.kindLabel} ${c.name} @ ${path.relative(instance.directory, c.file)}:${c.position.line + 1}`,
                )
                .join("\n")
              return {
                title: "debug: ambiguous symbol",
                metadata: { sessionId },
                output: `Symbol '${args.symbol}' is ambiguous:\n${list}\nRe-issue with a more specific file or kind.`,
              }
            }

            const line = resolved.candidate.position.line + 1
            const state = yield* debug.setBreakpoints({
              sessionId,
              source: resolved.candidate.file,
              breakpoints: [{ line, ...(args.condition ? { condition: args.condition } : {}) }],
            })
            return {
              title: `debug: breakpoint set at ${args.symbol}`,
              metadata: { sessionId, symbol: args.symbol, file: resolved.candidate.file, line, session: state },
              output: `Breakpoint set at symbol '${args.symbol}' → ${path.relative(instance.directory, resolved.candidate.file)}:${line}${args.condition ? ` (condition: ${args.condition})` : ""}.`,
            }
          }

          // ── continue ──────────────────────────────────────────────────────────
          if (args.intent === "continue") {
            const state = yield* debug.continue(sessionId)
            return {
              title: "debug: continue",
              metadata: { sessionId, session: state },
              output: `Session ${sessionId}: resumed (status: ${state.status}).`,
            }
          }

          // ── step ──────────────────────────────────────────────────────────────
          if (args.intent === "step") {
            const kind = args.step_kind ?? "next"
            const state = yield* debug.step(sessionId, kind)
            return {
              title: `debug: step (${kind})`,
              metadata: { sessionId, session: state },
              output: `Step (${kind}) done (status: ${state.status}).`,
            }
          }

          // ── stack ─────────────────────────────────────────────────────────────
          if (args.intent === "stack") {
            const frames = yield* debug.stackTrace(sessionId)
            return {
              title: `debug: stack (${frames.length} frames)`,
              metadata: { sessionId, frames },
              output: `Call stack:\n${renderFrames(frames)}`,
            }
          }

          // ── inspect ───────────────────────────────────────────────────────────
          if (args.intent === "inspect") {
            const frameId = args.frame ?? 0
            const frames = yield* debug.stackTrace(sessionId)
            const frame = frames[frameId]
            if (!frame)
              return {
                title: "debug: inspect",
                metadata: { sessionId },
                output: `Frame #${frameId} not found (${frames.length} total).`,
              }
            const scopes = yield* debug.scopes(sessionId, frame.id)
            const parts: string[] = [
              `Frame #${frameId} (${frame.name ?? "?"} at ${frame.source?.path ?? "?"}:${frame.line ?? "?"})`,
            ]
            for (const scope of scopes.slice(0, 3)) {
              if (typeof scope.variablesReference !== "number") continue
              const vars = yield* debug.variables(sessionId, scope.variablesReference)
              const budget = RuntimeBase.applyOutputBudget(JSON.stringify(vars, null, 2))
              parts.push(
                `[${scope.name ?? "scope"}]${budget.truncated ? ` (${budget.fullBytes} bytes → DEBUG_SESSION.json)` : ""}\n${renderVariables(vars, scope.name)}`,
              )
            }
            return {
              title: `debug: inspect frame #${frameId}`,
              metadata: { sessionId, frameId, scopes },
              output: parts.join("\n\n"),
            }
          }

          // ── eval ──────────────────────────────────────────────────────────────
          if (args.intent === "eval") {
            if (!args.expression)
              return { title: "debug: error", metadata: { sessionId }, output: "`expression` is required for intent:eval." }

            // Side-effecting evals (function calls) need additional confirmation.
            const mightMutate = /\w\s*\(/.test(args.expression)
            if (mightMutate) {
              yield* ctx.ask({
                permission: "debug_eval",
                patterns: [args.expression],
                always: [],
                metadata: { expression: args.expression, sessionId, note: "expression may have side effects" },
              })
            }
            const result = yield* debug.evaluate({
              sessionId,
              expression: args.expression,
              frameId: args.frame,
              context: "repl",
            })
            const value = (result as any)?.result ?? JSON.stringify(result)
            return {
              title: `debug: eval ${args.expression}`,
              metadata: { sessionId, result },
              output: `${args.expression} = ${value}`,
            }
          }

          // ── stop ──────────────────────────────────────────────────────────────
          if (args.intent === "stop") {
            const state = yield* debug.terminate(sessionId)
            return {
              title: "debug: session stopped",
              metadata: { sessionId, status: state.status, session: state, evidence: "DEBUG_SESSION.json" },
              output: `Debug session ${sessionId} terminated.\nSession state (evidence_kind:"debug_session") is in the tool result metadata / DEBUG_SESSION.json.`,
            }
          }

          return { title: "debug: unknown intent", metadata: {}, output: `Unknown intent '${args.intent}'.` }
        }).pipe(
          // DAP/session/privilege failures degrade gracefully (never a Die that kills the
          // turn). DebugService maps privilege + adapter errors to Error, so a single catch
          // covers "needs X privilege", DAP timeouts, and adapter spawn failures alike.
          Effect.catch((err) =>
            Effect.succeed({
              title: "debug: error",
              metadata: {},
              output: err instanceof Error ? err.message : String(err),
            } as Tool.ExecuteResult),
          ),
        ),
    }
  }),
)
