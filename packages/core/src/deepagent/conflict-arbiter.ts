export * as ConflictArbiter from "./conflict-arbiter"

import { DeepAgentEvent } from "./deepagent-event"

// V4.0 §C3 — the Conflict Arbiter. PURE conflict DETECTION + resolution ORDERING for multiple agents
// editing concurrently. It does not hold locks or touch git — the runtime (deepagent-code) enforces the
// physical isolation (FileLockService for §C3.1 file locks, branch/worktree for §C3.2). This module
// decides (a) WHETHER two claims conflict, and (b) given a conflict set, which claim WINS the ordering
// (§C3 处理顺序). Kept pure so the arbitration is deterministic + unit-testable.
//
// §C3 three isolation layers (this module models the DECISION for each; enforcement is the runtime's):
//   1. 文件锁    — two claims conflict if their file scopes overlap (a claim with empty scope = broad,
//                  conservatively conflicts with everything).
//   2. 分支隔离  — each agent works on its own branch/worktree (runtime concern; not decided here).
//   3. 语义冲突  — two claims conflict if they touch the same symbol (caller supplies symbol sets from
//                  the code graph; empty symbols ⇒ fall back to file-scope overlap only).
//
// §C3 处理顺序 (resolution ordering, applied by `rank`/`resolve`):
//   1. critical/high 优先 (higher priority wins).
//   2. 更小 diff 优先 (smaller declared change wins).
//   3. 人类显式任务优先于周期任务 (human-originated beats scheduled/system).
//   4. 无法自动合并 → human approval queue (resolve returns needsHuman when a winner can't be picked
//      deterministically, i.e. a true tie on all keys).

// A claim = one agent's intent to modify a set of files/symbols, carrying the info the ordering needs.
export interface Claim {
  readonly taskID: string
  readonly agentID: string
  readonly files: ReadonlyArray<string>
  // symbols (from the code graph) this claim modifies; empty ⇒ semantic layer not evaluated for it.
  readonly symbols: ReadonlyArray<string>
  readonly priority: DeepAgentEvent.EventPriority
  // declared size of the change (e.g. lines or files touched) — smaller wins per §C3.2. Optional;
  // undefined ⇒ treated as unknown/large (loses the diff-size tiebreak).
  readonly diffSize?: number
  // §C3.3: a claim originating from a human's explicit task beats a periodic/scheduled one.
  readonly origin: "human" | "schedule" | "system"
}

const PRIORITY_RANK: Record<DeepAgentEvent.EventPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
}

const overlaps = <T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean => {
  const set = new Set(a)
  return b.some((x) => set.has(x))
}

/**
 * §C3 — do two claims conflict? A claim with an EMPTY file scope is "broad/unknown" and conservatively
 * conflicts with any other claim (fail-safe: the runtime must serialize it). Otherwise claims conflict
 * if their file scopes overlap OR (when both declare symbols) their symbol sets overlap.
 */
export const conflicts = (a: Claim, b: Claim): boolean => {
  if (a.taskID === b.taskID) return false
  if (a.files.length === 0 || b.files.length === 0) return true // broad scope ⇒ conservative conflict
  if (overlaps(a.files, b.files)) return true
  if (a.symbols.length > 0 && b.symbols.length > 0 && overlaps(a.symbols, b.symbols)) return true
  return false
}


// §C3 ordering comparator: negative ⇒ `a` wins (sorts first). Applies the four keys in order:
// priority desc → diffSize asc → origin(human first) → stable by taskID.
const ORIGIN_RANK: Record<Claim["origin"], number> = { human: 0, schedule: 1, system: 1 }
export const compare = (a: Claim, b: Claim): number => {
  const p = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] // higher priority first
  if (p !== 0) return p
  const da = a.diffSize ?? Number.POSITIVE_INFINITY
  const db = b.diffSize ?? Number.POSITIVE_INFINITY
  if (da !== db) return da - db // smaller diff first
  const o = ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] // human before schedule/system
  if (o !== 0) return o
  return a.taskID < b.taskID ? -1 : a.taskID > b.taskID ? 1 : 0 // stable
}

export type Resolution =
  | { readonly type: "winner"; readonly winner: Claim; readonly deferred: ReadonlyArray<Claim> }
  | { readonly type: "needs_human"; readonly claims: ReadonlyArray<Claim> }

/**
 * §C3 — resolve ONE conflict group into a single winner (proceeds now) + deferred claims (re-queued
 * after the winner completes), OR `needs_human` when the top two claims are indistinguishable on every
 * ordering key (a true tie ⇒ "无法自动合并" → human approval queue). A singleton group trivially wins.
 */
export const resolve = (group: ReadonlyArray<Claim>): Resolution => {
  if (group.length === 0) return { type: "needs_human", claims: [] }
  if (group.length === 1) return { type: "winner", winner: group[0], deferred: [] }
  const sorted = [...group].sort(compare)
  // a true tie on all deterministic keys EXCEPT the taskID stabilizer ⇒ can't auto-pick → human.
  const top = sorted[0]
  const second = sorted[1]
  const tie =
    PRIORITY_RANK[top.priority] === PRIORITY_RANK[second.priority] &&
    (top.diffSize ?? Number.POSITIVE_INFINITY) === (second.diffSize ?? Number.POSITIVE_INFINITY) &&
    ORIGIN_RANK[top.origin] === ORIGIN_RANK[second.origin]
  if (tie) return { type: "needs_human", claims: group }
  return { type: "winner", winner: top, deferred: sorted.slice(1) }
}
