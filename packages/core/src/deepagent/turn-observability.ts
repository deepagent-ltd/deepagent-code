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
  /** Tool results whose IDENTICAL (tool, canonical args) was already produced this drain. */
  repeat_tool_calls: number
  /** Reads of a path already read this drain, whatever the page window (the paging loop). */
  repeated_read_calls: number
  /** Distinct paths read at least once this drain. */
  distinct_read_paths: number
}

/** Per-drain tool-call identity, for the repeat/re-read counters. Session-scoped like everything else. */
type ToolLedger = {
  /** Identity key (tool + canonical args) → how many times this drain has seen it. */
  readonly calls: Map<string, number>
  readonly readPaths: Map<string, number>
}

type SessionRecord = {
  turns: TurnReport[]
  behavior: Behavior
  preparedLogged: number
  /**
   * Prepared-turn trace: the first PREPARED_HEAD_SAMPLES turns verbatim, then one sample every
   * PREPARED_STRIDE turns, capped at PREPARED_MAX_SAMPLES. The earlier `preparedLogged < 3` rule
   * emitted only the first three turns, so a 179-turn run showed a 3-point "growth curve" and the
   * README-level question ("where did the tokens go on this run?") was unanswerable from the log.
   */
  preparedTrace: Array<{ readonly seq: number; readonly parts: PreparedParts }>
  modelProfileKey: string | null
  /** Parts recorded at prepare, keyed by provider turn seq; consumed by the matching turn report. */
  pendingParts: Map<number, PreparedParts>
  ledger: ToolLedger
}

const PREPARED_HEAD_SAMPLES = 3
const PREPARED_STRIDE = 10
const PREPARED_MAX_SAMPLES = 24

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
        repeat_tool_calls: 0,
        repeated_read_calls: 0,
        distinct_read_paths: 0,
      },
      preparedLogged: 0,
      preparedTrace: [],
      modelProfileKey: null,
      pendingParts: new Map(),
      ledger: { calls: new Map(), readPaths: new Map() },
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
  // Head samples verbatim, then a stride sample: a full trajectory at bounded cost, so the growth
  // curve of a long run is readable from the log instead of inferred from two endpoints.
  const sampled =
    record.preparedLogged < PREPARED_HEAD_SAMPLES ||
    (seq % PREPARED_STRIDE === 0 && record.preparedTrace.length < PREPARED_MAX_SAMPLES)
  if (!sampled) return
  record.preparedLogged++
  record.preparedTrace.push({ seq, parts })
  emit(`[turn] prepared seq=${seq} parts=${JSON.stringify(parts)}`)
}

/**
 * Per-drain tool-call ledger. Two distinct facts the ablation traces showed we cannot see today:
 * an IDENTICAL call repeated (the loop that never makes progress), and a READ of a path already read
 * (the paging loop: 66–79% of reads, 80–95% of read characters in the round-6/8 traces).
 */
export const recordToolCall = (tool: string, argsKey: string, sessionID?: string): string | undefined => {
  const ledger = recordFor(sessionID).ledger
  const identity = `${tool}\u0000${argsKey}`
  const seen = ledger.calls.get(identity) ?? 0
  ledger.calls.set(identity, seen + 1)
  const count = seen + 1
  if (seen > 0) recordFor(sessionID).behavior.repeat_tool_calls++
  if (tool !== "read") {
    return IDENTICAL_CALL_THRESHOLDS.has(count) ? identicalCallNudge(tool, count) : undefined
  }
  const reads = ledger.readPaths.get(argsKey) ?? 0
  ledger.readPaths.set(argsKey, reads + 1)
  if (reads > 0) recordFor(sessionID).behavior.repeated_read_calls++
  recordFor(sessionID).behavior.distinct_read_paths = ledger.readPaths.size
  if (IDENTICAL_CALL_THRESHOLDS.has(count)) return identicalCallNudge(tool, count)
  return REPEATED_READ_THRESHOLDS.has(reads + 1) ? repeatedReadNudge(argsKey, reads + 1) : undefined
}

/** Identical `(tool, args)` repeats that earn a nudge — the reference harness's escalation ladder. */
const IDENTICAL_CALL_THRESHOLDS = new Set([3, 5, 8])

/** Reads of the same path (any page window) that earn a nudge: the paging loop, not a repeat. */
const REPEATED_READ_THRESHOLDS = new Set([4, 8])

const identicalCallNudge = (tool: string, count: number): string =>
  `\n\n[repeat guard] This exact ${tool} call has now been made ${count} times. If it did not answer ` +
  `the question, change the arguments or the approach instead of repeating it; if it did, use what ` +
  `you already have.`

const repeatedReadNudge = (path: string, count: number): string =>
  `\n\n[repeat guard] ${path} has been read ${count} times in this session. The earlier results are ` +
  `still in the conversation — reuse them, or read a specific range you have not seen yet, instead ` +
  `of re-reading.`

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
  // The two headline ratios the token question is actually asked in: how much of the billed input
  // is REPLAY of context already sent (quadratic in turns), and how much of the prompt is tool
  // results carried forward. Both are derived, not estimated from a grep of the transcript.
  const lastContext = record.preparedTrace.at(-1)?.parts.total_estimated ?? 0
  const billedInput = usageSums.input + usageSums.cacheRead
  const replayRatio = lastContext > 0 ? Number((billedInput / lastContext).toFixed(2)) : null
  const toolResultShare =
    partsSums.total_estimated > 0 ? Number((partsSums.tool_results / partsSums.total_estimated).toFixed(3)) : 0
  return {
    turns: record.turns.length,
    behavior: record.behavior,
    finish: finishCounts,
    parts: partsSums,
    usage: usageSums,
    ...(replayRatio === null ? {} : { replay_ratio: replayRatio }),
    tool_result_share: toolResultShare,
    context_trajectory: record.preparedTrace.map((sample) => ({
      seq: sample.seq,
      total: sample.parts.total_estimated,
      history: sample.parts.history,
      tool_results: sample.parts.tool_results,
    })),
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
