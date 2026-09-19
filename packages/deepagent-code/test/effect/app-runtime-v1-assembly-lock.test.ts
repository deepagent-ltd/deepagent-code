import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { SessionV2 } from "@deepagent-code/core/session"
import type { AppServices } from "../../src/effect/app-runtime"
import type { Session } from "../../src/session/session"
import type { SessionStatus } from "../../src/session/status"
import type { SessionRunState } from "../../src/session/run-state"
import type { SessionProcessor } from "../../src/session/processor"
import type { SessionCompaction } from "../../src/session/compaction"
import type { SessionRevert } from "../../src/session/revert"
import type { SessionSummary } from "../../src/session/summary"
import type { SessionPrompt } from "../../src/session/prompt"
import type { GoalManager } from "../../src/session/goal-manager"
import type { ToolRegistry } from "../../src/tool/registry"

// v2w-j5 V1-assembly teardown lock: the AppRuntime production root no longer composes the legacy
// turn assembly (SessionPrompt.productionLayer and the SessionStatus/SessionRunState/
// SessionProcessor/SessionCompaction/SessionRevert/SessionSummary default layers). Census proofs
// live in the app-runtime.ts comment; the httpapi routes graph keeps its own listings for the
// session-ingress surface (prompt/command/shell receipts + the V2-resume bridge). Two locks:
//   1. type-level — none of the removed services is resolvable from the root context, while the
//      kept V1 faces (Session, GoalManager, ToolRegistry) and the V2 stack still are;
//   2. source-level — the root composition module references none of the removed layer constants.
// Type-only imports on purpose: importing runtime values would build the whole app graph.

type Removed = never
type InRoot<S> = S extends AppServices ? true : Removed
type AbsentFromRoot<S> = S extends AppServices ? Removed : true

type PromptAbsent = AbsentFromRoot<SessionPrompt.Service>
type ProcessorAbsent = AbsentFromRoot<SessionProcessor.Service>
type RunStateAbsent = AbsentFromRoot<SessionRunState.Service>
type CompactionAbsent = AbsentFromRoot<SessionCompaction.Service>
type RevertAbsent = AbsentFromRoot<SessionRevert.Service>
type SummaryAbsent = AbsentFromRoot<SessionSummary.Service>
type StatusAbsent = AbsentFromRoot<SessionStatus.Service>

describe("AppRuntime V1-assembly lock (v2w-j5)", () => {
  test("the removed V1 turn-assembly services are NOT part of the AppRuntime service context", () => {
    const prompt: PromptAbsent = true
    const processor: ProcessorAbsent = true
    const runState: RunStateAbsent = true
    const compaction: CompactionAbsent = true
    const revert: RevertAbsent = true
    const summary: SummaryAbsent = true
    const status: StatusAbsent = true
    expect(
      [prompt, processor, runState, compaction, revert, summary, status].every((lock) => lock === true),
    ).toBe(true)
  })

  test("the kept root faces are still resolvable (Session, GoalManager, ToolRegistry, SessionV2)", () => {
    // If any of these flips to Removed the const assignment fails the typecheck — same lock
    // direction as the v2-drive composition lock above.
    const session: InRoot<Session.Service> = true
    const goals: InRoot<GoalManager.Service> = true
    const tools: InRoot<ToolRegistry.Service> = true
    const v2: InRoot<SessionV2.Service> = true
    expect([session, goals, tools, v2].every((lock) => lock === true)).toBe(true)
  })

  test("the root composition module references none of the removed V1 layer constants", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../src/effect/app-runtime.ts"),
      "utf8",
    )
    const banned = [
      "SessionPrompt.productionLayer",
      "SessionPrompt.defaultLayer",
      "SessionProcessor.defaultLayer",
      "SessionRunState.defaultLayer",
      "SessionCompaction.defaultLayer",
      "SessionRevert.defaultLayer",
      "SessionSummary.defaultLayer",
      "SessionStatus.defaultLayer",
    ]
    expect(banned.filter((constant) => source.includes(constant))).toEqual([])
  })
})
