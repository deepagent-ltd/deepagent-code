import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  CALLER_INVENTORY_QUERY_ID,
  CALLER_INVENTORY_QUERY_VERSION,
  classifyCaller,
  scanCallerInventory,
} from "../../script/core-v2-caller-inventory"

const repository = resolve(import.meta.dir, "../../../..")

// Pinned completion evidence (§8 of the migration plan): the legacy orchestration denominator is
// fully classified and its canonical hash is fixed. Any new legacy call surface must be added to
// the classifier through a reviewed change, which moves this hash deliberately.
// v2f-i + v2f-h2 re-pin (2026-09-18): the durable-only wave removed the remaining code references
// to SessionPrompt from the task-*/goal-*/facade-activity child-execution callers and core's im
// orchestrator (v2f-i), then deleted the legacy task executor/input/dispatcher/delivery modules
// and moved the task tool onto the Core V2 TaskRunAuthority (v2f-h2). Both sweeps independently
// converged on this 8-file denominator and hash. prompt.ts remains the single orchestration
// authority surface. Any new legacy call surface must be added to the classifier through a
// reviewed change, which moves this hash deliberately.
// v2w-j5 re-pin (2026-09-19): the V1 assembly is torn out of the AppRuntime root graph
// (app-runtime.ts drops the SessionPrompt import + productionLayer listing; zero root-level
// consumers), so the denominator shrinks to the httpapi session-ingress surface (groups/handlers/
// server — the F-slice command/shell receipts + V2-resume bridge that still require the monolith)
// plus prompt.ts itself as the single orchestration surface (8→4 files).
// v2w-l2 re-pin (2026-09-19): the prompt.ts monolith is decomposed and deleted. The httpapi
// session ingress re-points at the lean V2 surfaces (session/prompt-v2.ts + session/
// command-v2.ts — new symbols, not the legacy identifier), the legacy provider-receipt recovery
// sweeps moved to session/legacy-provider-receipt-recovery.ts, and the structured-output helpers
// to session/structured-output-prompt.ts. The denominator reaches its honest minimum: ZERO
// production code references to SessionPrompt (4→0 files).
const PINNED_COUNTS = {
  admission_control: 0,
  orchestration: 0,
  child_execution: 0,
  recovery_compaction_context: 0,
  projection_permission: 0,
  composition_compat: 0,
  unclassified: 0,
} as const
const PINNED_RESULT_SHA256 = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"

describe("Core V2 caller inventory classification", () => {
  test("classifies every §8 category by explicit path rules", () => {
    expect(classifyCaller("packages/deepagent-code/src/server/routes/instance/httpapi/handlers/session.ts")).toBe(
      "admission_control",
    )
    expect(classifyCaller("packages/deepagent-code/src/im/agent-executor-server.ts")).toBe("admission_control")
    expect(classifyCaller("packages/deepagent-code/src/cli/cmd/github.handler.ts")).toBe("admission_control")
    expect(classifyCaller("packages/deepagent-code/src/session/prompt.ts")).toBe("orchestration")
    expect(classifyCaller("packages/deepagent-code/src/session/steer.ts")).toBe("orchestration")
    expect(classifyCaller("packages/deepagent-code/src/tool/task.ts")).toBe("child_execution")
    expect(classifyCaller("packages/deepagent-code/src/session/goal-manager.ts")).toBe("child_execution")
    expect(classifyCaller("packages/core/src/deepagent/goal-loop.ts")).toBe("child_execution")
    expect(classifyCaller("packages/deepagent-code/src/session/compaction.ts")).toBe("recovery_compaction_context")
    expect(classifyCaller("packages/deepagent-code/src/session/prompt-epoch.ts")).toBe("recovery_compaction_context")
    expect(classifyCaller("packages/deepagent-code/src/session/message-v2.ts")).toBe("projection_permission")
    expect(classifyCaller("packages/deepagent-code/src/permission/index.ts")).toBe("projection_permission")
    expect(classifyCaller("packages/deepagent-code/src/effect/app-runtime.ts")).toBe("composition_compat")
    expect(classifyCaller("packages/core/src/database/migration/20260712050000_session_steer_queue.ts")).toBe(
      "composition_compat",
    )
  })

  test("comments, strings, and renamed V2 symbols never enter the denominator", () => {
    // v2w-l2: the monolith is deleted; the moved modules (prompt-v2, command-v2,
    // legacy-provider-receipt-recovery, structured-output-prompt) keep their historical
    // "SessionPrompt.*" Effect.fn span labels and prose mentions, which are strings and never
    // enter the identifier-scanned denominator.
    const inventory = scanCallerInventory(repository)
    expect(inventory.entries.length).toBe(0)
    // Files that only mention the symbol in comments/strings or via SessionPromptIntent/Epoch
    // symbols are excluded entirely.
    expect(inventory.entries.some((entry) => entry.path === "packages/deepagent-code/src/session/steer.ts")).toBe(
      false,
    )
    expect(inventory.entries.some((entry) => entry.path === "packages/deepagent-code/src/session/message-v2.ts")).toBe(
      false,
    )
    expect(
      inventory.entries.some((entry) => entry.path === "packages/deepagent-code/src/session/prompt-intent.ts"),
    ).toBe(false)
  })

  test("unknown call surface stays unclassified so the gate fails closed", () => {
    expect(classifyCaller("packages/deepagent-code/src/session/some-new-legacy-caller.ts")).toBe("unclassified")
    expect(classifyCaller("packages/core/src/unexpected/area.ts")).toBe("unclassified")
  })

  test("excludes tests, fixtures, and scripts from the denominator", () => {
    const inventory = scanCallerInventory(repository)
    for (const entry of inventory.entries) {
      expect(entry.path.includes("/test/")).toBe(false)
      expect(entry.path.includes("/fixture/")).toBe(false)
      expect(entry.path.endsWith(".test.ts")).toBe(false)
      expect(entry.path.includes("/script/")).toBe(false)
      expect(entry.references).toBeGreaterThan(0)
    }
  })
})

describe("Core V2 caller inventory gate", () => {
  test("the production denominator is fully classified with zero unclassified callers", () => {
    const inventory = scanCallerInventory(repository)
    expect(inventory.query_id).toBe(CALLER_INVENTORY_QUERY_ID)
    expect(inventory.query_version).toBe(CALLER_INVENTORY_QUERY_VERSION)
    // v2w-l2: zero — the legacy orchestration identifier has no production code references.
    expect(inventory.entries.length).toBe(0)
    expect(inventory.unclassified).toBe(0)
    expect(inventory.counts).toEqual(PINNED_COUNTS)
  })

  test("the pinned result hash detects any drift in the legacy call surface", () => {
    const inventory = scanCallerInventory(repository)
    expect(inventory.result_sha256).toBe(PINNED_RESULT_SHA256)
    // Determinism: two scans of the same tree produce the identical canonical result.
    expect(scanCallerInventory(repository).result_sha256).toBe(inventory.result_sha256)
  })
})
