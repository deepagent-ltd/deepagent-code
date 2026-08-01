import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"

type WorkerInput = {
  readonly action: "claim" | "complete" | "get"
  readonly database: string
  readonly now: number
  readonly workspaceID: string
  readonly eventID: string
  readonly taskID: string
  readonly ownerID?: string
  readonly agentID?: string
  readonly generation?: number
  readonly leaseMs?: number
  readonly resources?: ReadonlyArray<string>
  readonly continuationRef?: string
  readonly artifacts?: ReadonlyArray<string>
}

const runWorker = async (input: WorkerInput) => {
  const child = Bun.spawn([process.execPath, "test/fixture/agent-execution-worker.ts", JSON.stringify(input)], {
    cwd: import.meta.dir.replace(/\/test$/, ""),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  return JSON.parse(stdout.trim()) as Record<string, unknown> | boolean | undefined
}

describe("AgentExecution cross-process recovery", () => {
  test("persists ownership, fences a stale process, and restores continuation after takeover", async () => {
    const directory = mkdtempSync(join(tmpdir(), "deepagent-agent-execution-"))
    try {
      const base = {
        database: join(directory, "agent-execution.db"),
        workspaceID: "wrk_cross_process",
        eventID: DeepAgentEvent.ID.create(1_000),
        taskID: "repair",
      }
      const first = await runWorker({
        ...base,
        action: "claim",
        now: 1_000,
        ownerID: "process_a",
        agentID: "agent_a",
        leaseMs: 1_000,
        resources: ["file:src/shared.ts"],
      })
      expect(first).toMatchObject({ type: "claimed", record: { generation: 1, ownerID: "process_a" } })

      const busy = await runWorker({
        ...base,
        action: "claim",
        now: 1_500,
        ownerID: "process_b",
        agentID: "agent_a",
        leaseMs: 1_000,
      })
      expect(busy).toMatchObject({ type: "busy", record: { generation: 1, ownerID: "process_a" } })

      const takeover = await runWorker({
        ...base,
        action: "claim",
        now: 2_001,
        ownerID: "process_b",
        agentID: "agent_a",
        leaseMs: 1_000,
        resources: ["file:src/shared.ts"],
      })
      expect(takeover).toMatchObject({ type: "claimed", record: { generation: 2, ownerID: "process_b" } })

      expect(
        await runWorker({ ...base, action: "complete", now: 2_100, ownerID: "process_a", generation: 1 }),
      ).toBe(false)
      expect(
        await runWorker({
          ...base,
          action: "complete",
          now: 2_100,
          ownerID: "process_b",
          generation: 2,
          continuationRef: "agent/recovered",
          artifacts: ["session:ses_recovered", "git-ref:agent/recovered"],
        }),
      ).toBe(true)

      const restored = await runWorker({ ...base, action: "get", now: 2_200 })
      expect(restored).toMatchObject({
        status: "completed",
        generation: 2,
        continuationRef: "agent/recovered",
        artifacts: ["session:ses_recovered", "git-ref:agent/recovered"],
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
