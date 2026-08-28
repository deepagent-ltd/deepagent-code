import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { WikiService, WikiGraph } from "../../src/wiki/wiki-service"
import { runPanel } from "../../src/panel/orchestrator"
import { arbitrate } from "../../src/panel/arbiter"
import { DEFAULT_QUORUM_POLICY, type PanelOpinion } from "../../src/agent/schema/panel"
import { makeGoalLoopWiring, type SubagentTurnRunner } from "../../src/session/goal-loop-wiring"
import type { Diagnostic } from "../../src/lsp/client"

/**
 * V3.9 §F.3 — Feature-flag independence. The three V3.9 capability flags (`experimentalWiki`,
 * `experimentalExpertPanel`, `experimentalGoalLoop`) MUST be independently rollback-safe: any one OFF
 * must not break the other two or base behaviour, and there must be no cross-flag import coupling
 * (panel must not require wiki, goal-loop must not require wiki, etc.).
 *
 * These tests toggle each flag via RuntimeFlags.layer and assert the other two capabilities still
 * construct + behave. The pure cores (WikiService projection, Panel arbiter/orchestrator) are NOT
 * flag-gated at all — the flags gate only the session-driven wiring — so they always function; the
 * goal-loop WIRING is the one that reads its flag at construction (null when off).
 */

const flagLayer = (over: Partial<RuntimeFlags.Info>) => RuntimeFlags.layer(over)

const turnStub: SubagentTurnRunner = () =>
  Effect.succeed({ ok: true, structured: undefined, text: "", tokensUsed: 1, cost: 0 })

const goalWiringInput = (store: DocumentStore) => ({
  store,
  parentSessionID: "s",
  cwd: "/tmp",
  runTurn: turnStub,
  panelQuestion: () => ({ question: "q", codeRefs: [], lenses: ["correctness" as const], maxRounds: 1 }),
  diagnostics: () => Effect.succeed({ diagnostics: {} as Record<string, Diagnostic[]>, checked: true }),
  rollback: () => Effect.void,
})

// A minimal panel opinion set → the real arbiter must still decide deterministically.
const opinions: PanelOpinion[] = [
  { lens: "correctness", verdict: "approve", findings: [], confidence: 0.9 },
  { lens: "security", verdict: "approve", findings: [], confidence: 0.8 },
]

let root: string
const fresh = () => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-flagindep-"))
  return new DocumentStore(root)
}
const cleanup = () => root && rmSync(root, { recursive: true, force: true })

describe("V3.9 §F.3 — feature-flag independence", () => {
  test("goal_loop OFF: wiki projection + panel arbiter still work", async () => {
    const store = fresh()
    try {
      // goal-loop wiring is unavailable (null) …
      const deps = await Effect.runPromise(
        makeGoalLoopWiring(goalWiringInput(store)).pipe(
          Effect.provide(flagLayer({ experimentalGoalLoop: false, experimentalWiki: true, experimentalExpertPanel: true })),
        ),
      )
      expect(deps).toBeNull()

      // … but the Wiki projection still renders a page (base capability, pure projection).
      const knowledge = store.upsert({
        type: "knowledge",
        scope: "durable",
        description: "a fact",
        body: "body",
        confidence: { evidence_strength: "medium", support_count: 1 },
        provenance: { source: "model" },
      })
      const wiki = new WikiService(new WikiGraph([store]))
      const page = await Effect.runPromise(wiki.renderPage({ docId: knowledge.id, scope: "durable" }))
      expect(page.editable).toBe(true)

      // … and the Panel arbiter still decides deterministically.
      expect(arbitrate(opinions, DEFAULT_QUORUM_POLICY).decision).toBe("approve")
    } finally {
      cleanup()
    }
  })

  test("wiki OFF: panel + goal_loop wiring still construct", async () => {
    const store = fresh()
    try {
      const deps = await Effect.runPromise(
        makeGoalLoopWiring(goalWiringInput(store)).pipe(
          Effect.provide(flagLayer({ experimentalWiki: false, experimentalGoalLoop: true, experimentalExpertPanel: true })),
        ),
      )
      expect(deps).not.toBeNull() // goal loop unaffected by wiki being off

      // Panel still runs end-to-end (pure orchestrator + arbiter), no wiki dependency.
      const verdict = await Effect.runPromise(
        runPanel({
          question: { question: "q", codeRefs: [], lenses: ["correctness", "security"], maxRounds: 1, policy: DEFAULT_QUORUM_POLICY },
          runPanelist: ({ spec }) => Effect.succeed({ lens: spec.lens, verdict: "approve", findings: [], confidence: 0.9 }),
          parentSessionID: "s",
        }),
      )
      expect(verdict.decision).toBe("approve")
    } finally {
      cleanup()
    }
  })

  test("expert_panel OFF: wiki + goal_loop wiring still construct; panel gate fail-closes independently", async () => {
    const store = fresh()
    try {
      // goal-loop wiring still builds — its flag is independent of the panel flag (construction-level
      // independence). The RUNTIME coupling is severed too: with the panel flag off, the goal loop's
      // panel_approves gate fail-closes to needs_human instead of convening the (disabled) panel — see
      // goal-loop-wiring.test.ts "§F.3 panel flag OFF". The arbiter itself remains a pure function.
      const deps = await Effect.runPromise(
        makeGoalLoopWiring(goalWiringInput(store)).pipe(
          Effect.provide(flagLayer({ experimentalExpertPanel: false, experimentalGoalLoop: true, experimentalWiki: true })),
        ),
      )
      expect(deps).not.toBeNull()
      // The panel gate, with the panel flag off, escalates rather than approving (flag independence).
      expect(await Effect.runPromise(deps!.ports.panelApproves())).toEqual({ decision: "needs_human" })

      // Wiki still projects.
      const design = store.upsert({
        type: "design",
        scope: "durable",
        description: "d",
        body: "b",
        provenance: { source: "model" },
      })
      const wiki = new WikiService(new WikiGraph([store]))
      const page = await Effect.runPromise(wiki.renderPage({ docId: design.id, scope: "durable" }))
      expect(page.editable).toBe(false) // design is read-only
    } finally {
      cleanup()
    }
  })

  test("all three OFF: base behaviour intact — pure cores still function, goal wiring absent", async () => {
    const store = fresh()
    try {
      const deps = await Effect.runPromise(
        makeGoalLoopWiring(goalWiringInput(store)).pipe(
          Effect.provide(flagLayer({ experimentalWiki: false, experimentalExpertPanel: false, experimentalGoalLoop: false })),
        ),
      )
      expect(deps).toBeNull()
      // The arbiter (pure, never flag-gated) still works regardless of any flag.
      expect(arbitrate(opinions, DEFAULT_QUORUM_POLICY).decision).toBe("approve")
    } finally {
      cleanup()
    }
  })
})
