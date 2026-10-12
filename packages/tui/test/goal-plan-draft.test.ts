import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { GoalPlanClient } from "@deepagent-code/core/deepagent/goal-plan-client"
import { createGoalPlanDraftStore } from "../src/util/goal-plan-draft"
import { tmpdir } from "./fixture/fixture"
const scope = {
  server: "fixture",
  url: "http://127.0.0.1:1",
  directory: "/fixture",
  operator: "fixture",
  sessionID: "ses_fixture",
  goalID: "goal_fixture",
}

test("disk close/reopen retains exact unknown command and fixed scope, with private durable files", async () => {
  await using root = await tmpdir()
  const store = createGoalPlanDraftStore(root.path)
  const draft = await GoalPlanClient.create(scope, 2)
  await store.put(draft)
  const command = { action: "begin" as const, request: draft.begin }
  let sends = 0
  await expect(
    GoalPlanClient.send(
      store,
      {
        async send() {
          sends++
          throw new GoalPlanClient.RequestError("CONNECTION_UNKNOWN", "Lost ACK", true)
        },
        async get() {
          throw new Error("No read")
        },
      },
      draft,
      command,
    ),
  ).rejects.toThrow("Lost ACK")
  const reopened = createGoalPlanDraftStore(root.path)
  const [saved] = await reopened.list(scope)
  expect(saved.phase).toBe("unknown")
  expect(saved.command).toEqual(command)
  expect(saved.editID).toBe(await GoalPlanClient.locator(command.request))
  expect(sends).toBe(1)
  expect(await reopened.list({ ...scope, operator: "other" })).toEqual([])
  expect((await fs.stat(path.join(root.path, "goal-plan-v1"))).mode & 0o777).toBe(0o700)
  expect((await fs.stat(path.join(root.path, "goal-plan-v1/records.json"))).mode & 0o777).toBe(0o600)
  await expect(reopened.put({ ...saved, revision: saved.revision + 1 }, 0)).rejects.toThrow("Another client")
})

test("wide directory, record symlink and bad persisted fields refuse before any dispatch", async () => {
  await using root = await tmpdir()
  const store = createGoalPlanDraftStore(root.path)
  const draft = await GoalPlanClient.create(scope, 2)
  await fs.mkdir(path.join(root.path, "goal-plan-v1"), { mode: 0o755 })
  let sends = 0
  const transport = {
    async send() {
      sends++
      return null
    },
    async get() {
      return null
    },
  }
  await expect(
    GoalPlanClient.send(store, transport, draft, { action: "begin", request: draft.begin }),
  ).rejects.toThrow()
  await fs.chmod(path.join(root.path, "goal-plan-v1"), 0o700)
  await fs.writeFile(path.join(root.path, "outside.json"), "[]", { mode: 0o600 })
  await fs.symlink(path.join(root.path, "outside.json"), path.join(root.path, "goal-plan-v1/records.json"))
  await expect(store.list(scope)).rejects.toThrow()
  await fs.unlink(path.join(root.path, "goal-plan-v1/records.json"))
  await fs.writeFile(
    path.join(root.path, "goal-plan-v1/records.json"),
    JSON.stringify([{ ...draft, token: "injected-secret" }]),
    { mode: 0o600 },
  )
  await expect(store.list(scope)).rejects.toThrow()
  expect(sends).toBe(0)
  expect(await fs.readFile(path.join(root.path, "outside.json"), "utf8")).toBe("[]")
})

test("serialized total capacity refuses atomically and retains all prior unknown records", async () => {
  await using root = await tmpdir()
  const store = createGoalPlanDraftStore(root.path)
  const content = {
    steps: Array.from({ length: 128 }, (_, index) => ({
      step_id: `step-${index}`,
      title: "Future",
      status: "pending" as const,
      note: "中".repeat(4096),
    })),
    activeStepID: null,
    dispositions: [],
  }
  // This candidate exceeds 1 MiB; no journal file is published at all.
  const huge = { ...(await GoalPlanClient.create(scope, 1)), candidate: content }
  await expect(store.put(huge)).rejects.toThrow()
  const candidate = { ...content, steps: content.steps.slice(0, 40) }
  let accepted = 0
  for (let index = 0; index < 12; index++) {
    const draft = { ...(await GoalPlanClient.create(scope, 1)), candidate, phase: "unknown" as const }
    const before = accepted
      ? createHash("sha256")
          .update(await fs.readFile(path.join(root.path, "goal-plan-v1/records.json")))
          .digest("hex")
      : undefined
    try {
      await store.put(draft)
      accepted++
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      if (before === undefined) throw new Error("Capacity failed before any accepted record")
      expect(
        createHash("sha256")
          .update(await fs.readFile(path.join(root.path, "goal-plan-v1/records.json")))
          .digest("hex"),
      ).toBe(before)
      expect(await store.list(scope)).toHaveLength(accepted)
      expect(accepted).toBeGreaterThan(0)
      return
    }
  }
  throw new Error("Total serialized capacity was not enforced")
})
