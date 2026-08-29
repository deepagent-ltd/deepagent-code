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
const PINNED_COUNTS = {
  admission_control: 6,
  orchestration: 1,
  child_execution: 5,
  recovery_compaction_context: 0,
  projection_permission: 1,
  composition_compat: 1,
  unclassified: 0,
} as const
const PINNED_RESULT_SHA256 = "cee86cb006cd7b4cc93b559cee634819fe2b6cd3cd3ef5ca81fa99ee67687f52"

describe("Core V2 caller inventory classification", () => {
  test("classifies every §8 category by explicit path rules", () => {
    expect(classifyCaller("packages/deepagent-code/src/server/routes/instance/httpapi/handlers/session.ts")).toBe(
      "admission_control",
    )
    expect(classifyCaller("packages/deepagent-code/src/im/agent-executor-server.ts")).toBe("admission_control")
    expect(classifyCaller("packages/deepagent-code/src/cli/cmd/github.handler.ts")).toBe("admission_control")
    expect(classifyCaller("packages/deepagent-code/src/session/prompt.ts")).toBe("orchestration")
    expect(classifyCaller("packages/deepagent-code/src/session/steer.ts")).toBe("orchestration")
    expect(classifyCaller("packages/deepagent-code/src/session/task-executor.ts")).toBe("child_execution")
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
    // prompt.ts keeps exactly one code reference (its own export name); its hundreds of
    // SessionPromptLoop/SessionPromptEpoch-era mentions are distinct symbols or prose.
    const inventory = scanCallerInventory(repository)
    const prompt = inventory.entries.find((entry) => entry.path === "packages/deepagent-code/src/session/prompt.ts")
    expect(prompt?.references).toBe(1)
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
    expect(inventory.entries.length).toBe(14)
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
