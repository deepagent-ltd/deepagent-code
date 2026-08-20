import type { ModelMessage } from "ai"

/**
 * Wire text used when synthesizing a tool result for a tool call that never
 * got one. Mirrors the interrupted-tool synthesis in message-v2.ts
 * ("[Tool execution was interrupted]") so the model sees one consistent style.
 */
export const INTERRUPTED_TOOL_ERROR_TEXT = "[Tool execution was interrupted]"

export interface RepairReport {
  /** call_ids that had no result → a synthetic error result was inserted. */
  readonly synthesizedResults: string[]
  /** call_ids of orphan results (no preceding call) that were stripped. */
  readonly strippedOrphanResults: string[]
  /** call_ids dropped as duplicates (a repeated call or a repeated result; first wins). */
  readonly droppedDuplicates: string[]
  /** Number of tool→user gaps bridged with a synthetic assistant turn. */
  bridgedToolUserGaps: number
}

export const emptyRepairReport = (): RepairReport => ({
  synthesizedResults: [],
  strippedOrphanResults: [],
  droppedDuplicates: [],
  bridgedToolUserGaps: 0,
})

export const repairReportIsEmpty = (report: RepairReport): boolean =>
  report.synthesizedResults.length === 0 &&
  report.strippedOrphanResults.length === 0 &&
  report.droppedDuplicates.length === 0 &&
  report.bridgedToolUserGaps === 0

export interface RepairOptions {
  /**
   * After repair, if a tool message ends up directly followed by a user
   * message, insert a synthetic assistant "Done." between them. This mirrors
   * the tool→user sequence fix applied by the mistral scrub in
   * transform.normalizeMessages, which runs BEFORE this repairer and cannot
   * see the synthetic tool messages this repairer inserts.
   */
  bridgeToolUserGap?: boolean
  /**
   * UPD-001 telemetry: optional caller-provided collector populated in place
   * with exactly what the repairer changed. The receipt's `call_ids` records
   * the PRE-repair projection, so a repaired wire body diverges from it; this
   * report is what makes that divergence explainable (which call_ids were
   * synthesized / stripped / deduped). Omitted → no collection (pure repair).
   */
  report?: RepairReport
}

/**
 * Repair tool_use/tool_result pairing so providers never receive:
 *
 * 1. an assistant tool-call with no matching tool-result → a synthetic error
 *    result is inserted directly after the message carrying the call
 * 2. an orphan tool-result whose callID never appeared as a call → stripped
 * 3. duplicate callIDs → only the first call and first result survive
 *
 * Constraints:
 * - Pure function: no logging, no I/O, no receipt-semantics changes; input
 *   messages are never mutated (callers may log around it if needed).
 * - MUST run after transform.ts normalizeMessages: the mistral toolCallId
 *   scrub truncates IDs to 9 alphanumeric chars and can collide distinct IDs
 *   into duplicates that only exist post-scrub, so dedup has to come last.
 */
export function repairToolPairing(msgs: ModelMessage[], options: RepairOptions = {}): ModelMessage[] {
  const report = options.report
  const seenCallIDs = new Set<string>()
  const seenResultIDs = new Set<string>()
  // Surviving, not-yet-matched calls: callID -> { toolName, index of message holding the call }
  const unmatched = new Map<string, { toolName: string; messageIndex: number }>()

  // Pass 1: decide which parts survive (dedup + orphan stripping) without
  // emitting anything. A result can legally appear several messages after
  // its call, so missing-result synthesis can only be decided after the full
  // scan.
  const planned = msgs.map((msg, messageIndex) => {
    if (!Array.isArray(msg.content)) return { msg, content: undefined, changed: false }
    let changed = false
    const content = msg.content.filter((part) => {
      if (part.type === "tool-call") {
        if (seenCallIDs.has(part.toolCallId)) {
          changed = true
          report?.droppedDuplicates.push(part.toolCallId)
          return false // duplicate callID: keep the first
        }
        seenCallIDs.add(part.toolCallId)
        unmatched.set(part.toolCallId, { toolName: part.toolName, messageIndex })
        return true
      }
      if (part.type === "tool-result") {
        if (!seenCallIDs.has(part.toolCallId)) {
          changed = true
          report?.strippedOrphanResults.push(part.toolCallId)
          return false // orphan result: no preceding call
        }
        if (seenResultIDs.has(part.toolCallId)) {
          changed = true
          report?.droppedDuplicates.push(part.toolCallId)
          return false // duplicate result for one call: keep the first
        }
        seenResultIDs.add(part.toolCallId)
        unmatched.delete(part.toolCallId)
        return true
      }
      return true
    })
    return { msg, content, changed }
  })

  // Pass 2: rebuild, inserting synthetic results directly after the message
  // carrying the call so the assistant tool_use is always immediately
  // followed by its result.
  const output: ModelMessage[] = []
  planned.forEach(({ msg, content, changed }, messageIndex) => {
    if (content === undefined) {
      output.push(msg)
      return
    }
    // If every part was stripped (orphans/duplicates only), drop the message
    // entirely — an empty content array is rejected by providers. Unmatched
    // calls cannot live here: a surviving call always survives the filter.
    if (content.length === 0) return
    output.push(changed ? ({ ...msg, content } as ModelMessage) : msg)

    const missing = [...unmatched.entries()].filter(([, info]) => info.messageIndex === messageIndex)
    if (missing.length === 0) return
    if (report) for (const [toolCallId] of missing) report.synthesizedResults.push(toolCallId)
    output.push({
      role: "tool",
      content: missing.map(([toolCallId, info]) => ({
        type: "tool-result" as const,
        toolCallId,
        toolName: info.toolName,
        output: { type: "error-text" as const, value: INTERRUPTED_TOOL_ERROR_TEXT },
      })),
    })
  })

  if (!options.bridgeToolUserGap) return output

  // normalizeMessages already bridged every pre-existing tool→user gap for
  // mistral, so any gap left here was introduced by this repairer.
  const bridged: ModelMessage[] = []
  for (let i = 0; i < output.length; i++) {
    bridged.push(output[i])
    if (output[i].role === "tool" && output[i + 1]?.role === "user") {
      bridged.push({ role: "assistant", content: [{ type: "text", text: "Done." }] })
      if (report) report.bridgedToolUserGaps += 1
    }
  }
  return bridged
}

export * as ToolPairing from "./tool-pairing"
