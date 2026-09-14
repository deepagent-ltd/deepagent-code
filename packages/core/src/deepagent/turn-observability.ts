/**
 * G0 turn observability — the per-turn evidence the Gamma plan (§5 阶段一) requires.
 *
 * The ablation reports so far had to grep the captured transcript to explain WHERE a run's prompt
 * tokens went and WHY turns happened. This module records both facts at the source, next to the
 * data they describe, in the same style as the mechanism beacon (process-local counters plus
 * stable stderr lines; zero durable-schema change, zero behavior change):
 *
 *   [turn] prepared seq=<n> parts=<json>      — after prepare, per provider turn
 *   [turn] summary <json>                     — once per drain end (totals + breakdown sums)
 *
 * `parts` estimates the token weight of every prompt component the Gamma plan names
 * (history / stable system / volatile control / tool results). Estimation is chars/4 (never an
 * LLM call); the summary carries the provider's own usage so the report script can publish the
 * estimate-vs-usage gap instead of hiding it.
 *
 * REVIEW FIX (isolation): all mutable state is SESSION-scoped. The first version kept one
 * process-global turn list / pending map / behavior counters, so concurrent sessions shared
 * `providerTurnSeq` keys — one session's prompt breakdown could attach to another session's
 * report and summaries accumulated across drains. Every recorder now takes the sessionID; the
 * legacy no-session overloads (tests, beacons) use a shared "_" slot.
 */

const charsPerToken = 4
const estimateTokens = (chars: number) => Math.ceil(chars / charsPerToken)

type PreparedParts = {
  readonly stable_system: number
  readonly volatile_system: number
  /** The volatile round/plan control user message (deepagent round context or governed plan context). */
  readonly control_message: number
  /** Durable history excluding tool results and excluding the control message. */
  readonly history: number
  readonly tool_results: number
  readonly total_estimated: number
  readonly history_messages: number
  readonly tool_result_parts: number
}

const JSON_LENGTH_CACHE = new WeakMap<object, number>()
const jsonChars = (value: unknown): number => {
  if (typeof value === "string") return value.length
  if (value === undefined || value === null) return 0
  if (typeof value === "object") {
    const cached = JSON_LENGTH_CACHE.get(value as object)
    if (cached !== undefined) return cached
  }
  let chars: number
  try {
    chars = JSON.stringify(value)?.length ?? 0
  } catch {
    chars = 0
  }
  if (typeof value === "object") JSON_LENGTH_CACHE.set(value as object, chars)
  return chars
}

type Behavior = {
  empty_steps: number
  gate_consults: number
  gate_blocks: number
  gate_releases: number
  compactions: number
  retries: number
  projection_truncated: number
  projection_saved_chars: number
}

type SessionRecord = {
  turns: TurnReport[]
  behavior: Behavior
  preparedLogged: number
  modelProfileKey: string | null
  /** Parts recorded at prepare, keyed by provider turn seq; consumed by the matching turn report. */
  pendingParts: Map<number, PreparedParts>
}

const sessions = new Map<string, SessionRecord>()
// Bounded: settled sessions are dropped (emitTurnSummary clears them), so the map cannot grow
// with a long-lived server beyond the concurrent-session count.
const recordFor = (sessionID?: string): SessionRecord => {
  const key = sessionID ?? "_"
  let record = sessions.get(key)
  if (record === undefined) {
    record = {
      turns: [],
      behavior: {
        empty_steps: 0,
        gate_consults: 0,
        gate_blocks: 0,
        gate_releases: 0,
        compactions: 0,
        retries: 0,
        projection_truncated: 0,
        projection_saved_chars: 0,
      },
      preparedLogged: 0,
      modelProfileKey: null,
      pendingParts: new Map(),
    }
    sessions.set(key, record)
  }
  return record
}

/**
 * Split one prepared turn's request into the Gamma breakdown. `historyMessages` is the exact array
 * handed to `LLM.request` (already attachment-normalized, WITHOUT the control message — pass it
 * separately as `controlMessage`), `stableSystemParts`/`volatileSystemParts` the request's system
 * blocks. Tool results are separated out because tool-output projection (阶段五) needs their
 * baseline measured independently.
 *
 * REVIEW FIX (double counting): the control message used to be counted three ways — once inside
 * `historyMessages` (it is appended to the request messages), once as volatileSystemParts, once as
 * `controlMessage`. Callers now pass the history array WITHOUT the control tail and the volatile
 * system parts WITHOUT it; this function is the single place the control message is measured.
 */
export function preparedParts(input: {
  readonly stableSystemParts: readonly string[]
  readonly volatileSystemParts: readonly string[]
  readonly historyMessages: readonly unknown[]
  readonly controlMessage: string | undefined
}): PreparedParts {
  const stableSystem = estimateTokens(input.stableSystemParts.reduce((a, p) => a + p.length, 0))
  const volatileSystem = estimateTokens(input.volatileSystemParts.reduce((a, p) => a + p.length, 0))
  const controlMessage = estimateTokens(input.controlMessage?.length ?? 0)
  let history = 0
  let toolResults = 0
  let toolResultParts = 0
  for (const message of input.historyMessages) {
    const record = message as { readonly role?: unknown; readonly content?: unknown }
    const content = record?.content
    if (Array.isArray(content)) {
      let historyChars = jsonChars(record?.role)
      for (const part of content) {
        const type = (part as { readonly type?: unknown })?.type
        if (type === "tool-result") {
          toolResults += estimateTokens(jsonChars(part))
          toolResultParts++
        } else historyChars += jsonChars(part)
      }
      history += estimateTokens(historyChars)
    } else {
      history += estimateTokens(jsonChars(message))
    }
  }
  return {
    stable_system: stableSystem,
    volatile_system: volatileSystem,
    control_message: controlMessage,
    history,
    tool_results: toolResults,
    total_estimated: stableSystem + volatileSystem + controlMessage + history + toolResults,
    history_messages: input.historyMessages.length,
    tool_result_parts: toolResultParts,
  }
}

/** One settled provider turn: the provider's own usage plus the turn's behavior counters. */
export type TurnReport = {
  readonly seq: number
  readonly finish: "stop" | "tool-calls" | "error" | "other"
  readonly toolCalls: number
  readonly usage: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
  readonly parts?: PreparedParts
}

const emit = (line: string) => process.stderr.write(line + "\n")

export const recordPrepared = (seq: number, parts: PreparedParts, sessionID?: string): void => {
  const record = recordFor(sessionID)
  record.pendingParts.set(seq, parts)
  if (record.preparedLogged < 3) {
    record.preparedLogged++
    emit(`[turn] prepared seq=${seq} parts=${JSON.stringify(parts)}`)
  }
}

export const recordTurn = (report: TurnReport, sessionID?: string): void => {
  const record = recordFor(sessionID)
  const parts = record.pendingParts.get(report.seq)
  record.pendingParts.delete(report.seq)
  record.turns.push(parts === undefined ? report : { ...report, parts })
  if (report.finish !== "error" && report.toolCalls === 0) record.behavior.empty_steps++
}

export const recordGateConsult = (blocked: boolean, released = false, sessionID?: string): void => {
  const behavior = recordFor(sessionID).behavior
  behavior.gate_consults++
  if (blocked) behavior.gate_blocks++
  if (released) behavior.gate_releases++
}

export const recordCompaction = (sessionID?: string): void => {
  recordFor(sessionID).behavior.compactions++
}

export const recordRetry = (sessionID?: string): void => {
  recordFor(sessionID).behavior.retries++
}

/** G3 history projection — cumulative counters pulled from the projection module at rollup. */
export const recordProjection = (truncated: number, savedChars: number, sessionID?: string): void => {
  const behavior = recordFor(sessionID).behavior
  behavior.projection_truncated += truncated
  behavior.projection_saved_chars += savedChars
}

/** G3 model profile — the resolved profile key rides every rollup (plan: observable, never hidden). */
export const recordModelProfile = (key: string, sessionID?: string): void => {
  recordFor(sessionID).modelProfileKey = key
}

/**
 * REVIEW FIX (leak): every exit path of a drain must clear its pending parts, not only the ones
 * that reach recordTurn. Idempotent and allocation-free when the slot is already gone (e.g.
 * right after emitTurnSummary deleted it) — a plain recordFor() here would RE-CREATE an empty
 * slot and leak one entry per drain in a long-lived process.
 */
export const clearPendingParts = (sessionID?: string): void => {
  sessions.get(sessionID ?? "_")?.pendingParts.clear()
}

/** Drain-end rollup: per-component token sums, per-turn usage sums, and the behavior counters. */
export const turnSummary = (sessionID?: string) => {
  const record = recordFor(sessionID)
  const partsSums = record.turns.reduce(
    (acc, turn) => {
      const parts = turn.parts
      if (!parts) return acc
      acc.stable_system += parts.stable_system
      acc.volatile_system += parts.volatile_system
      acc.control_message += parts.control_message
      acc.history += parts.history
      acc.tool_results += parts.tool_results
      acc.total_estimated += parts.total_estimated
      return acc
    },
    { stable_system: 0, volatile_system: 0, control_message: 0, history: 0, tool_results: 0, total_estimated: 0 },
  )
  const usageSums = record.turns.reduce(
    (acc, turn) => {
      acc.input += turn.usage.input
      acc.output += turn.usage.output
      acc.reasoning += turn.usage.reasoning
      acc.cacheRead += turn.usage.cacheRead
      acc.cacheWrite += turn.usage.cacheWrite
      return acc
    },
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  )
  const finishCounts = record.turns.reduce<Record<string, number>>((acc, turn) => {
    acc[turn.finish] = (acc[turn.finish] ?? 0) + 1
    return acc
  }, {})
  return {
    turns: record.turns.length,
    behavior: record.behavior,
    finish: finishCounts,
    parts: partsSums,
    usage: usageSums,
    ...(record.modelProfileKey ? { profile: record.modelProfileKey } : {}),
  }
}

export const emitTurnSummary = (sessionID?: string): void => {
  const record = recordFor(sessionID)
  if (record.turns.length === 0) {
    sessions.delete(sessionID ?? "_")
    return
  }
  emit(`[turn] summary ${JSON.stringify(turnSummary(sessionID))}`)
  // The rollup is CUMULATIVE per drain chain but a NEW drain of the same session must not
  // double-count: reset after emission and free the slot (long-lived process bound).
  sessions.delete(sessionID ?? "_")
}

/** Test accessor. */
export const recordedTurns = (sessionID?: string): readonly TurnReport[] => recordFor(sessionID).turns
