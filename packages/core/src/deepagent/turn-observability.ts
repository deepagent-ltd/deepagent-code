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

/**
 * Split one prepared turn's request into the Gamma breakdown. `historyMessages` is the exact array
 * handed to `LLM.request` (already attachment-normalized), `controlMessage` the single volatile
 * control user message the DeepAgent layer appends after history. Tool results are separated out
 * because tool-output projection (阶段五) needs their baseline measured independently.
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

const turns: TurnReport[] = []
const behavior = {
  empty_steps: 0,
  gate_consults: 0,
  gate_blocks: 0,
  gate_releases: 0,
  compactions: 0,
  retries: 0,
}
let preparedLogged = 0
/** Parts recorded at prepare, keyed by provider turn seq; consumed by the matching turn report. */
const pendingParts = new Map<number, PreparedParts>()

const emit = (line: string) => process.stderr.write(line + "\n")

export const recordPrepared = (seq: number, parts: PreparedParts): void => {
  pendingParts.set(seq, parts)
  if (preparedLogged < 3) {
    preparedLogged++
    emit(`[turn] prepared seq=${seq} parts=${JSON.stringify(parts)}`)
  }
}

export const recordTurn = (report: TurnReport): void => {
  const parts = pendingParts.get(report.seq)
  pendingParts.delete(report.seq)
  turns.push(parts === undefined ? report : { ...report, parts })
  if (report.finish !== "error" && report.toolCalls === 0) behavior.empty_steps++
}

export const recordGateConsult = (blocked: boolean, released = false): void => {
  behavior.gate_consults++
  if (blocked) behavior.gate_blocks++
  if (released) behavior.gate_releases++
}

export const recordCompaction = (): void => {
  behavior.compactions++
}

export const recordRetry = (): void => {
  behavior.retries++
}

/** Drain-end rollup: per-component token sums, per-turn usage sums, and the behavior counters. */
export const turnSummary = () => {
  const partsSums = turns.reduce(
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
  const usageSums = turns.reduce(
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
  const finishCounts = turns.reduce<Record<string, number>>((acc, turn) => {
    acc[turn.finish] = (acc[turn.finish] ?? 0) + 1
    return acc
  }, {})
  return {
    turns: turns.length,
    behavior,
    finish: finishCounts,
    parts: partsSums,
    usage: usageSums,
  }
}

export const emitTurnSummary = (): void => {
  if (turns.length === 0) return
  emit(`[turn] summary ${JSON.stringify(turnSummary())}`)
}

/** Test accessor. */
export const recordedTurns = (): readonly TurnReport[] => turns
