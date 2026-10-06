import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const run = async (root: string, stage: string, exit = 0) => {
  const child = Bun.spawn(
    [process.execPath, "run", path.join(import.meta.dirname, "im-delivery-process.fixture.ts"), stage],
    {
      cwd: path.join(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        IM_ORACLE_ROOT: root,
        DEEPAGENT_CODE_TEST_HOME: root,
        XDG_CONFIG_HOME: `${root}/config`,
        XDG_DATA_HOME: `${root}/data`,
        XDG_CACHE_HOME: `${root}/cache`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const output = await new Response(child.stdout).text()
  const errors = await new Response(child.stderr).text()
  expect(await child.exited, `${stage}\n${output}\n${errors}`).toBe(exit)
  return exit === 0 ? JSON.parse(output.trim().split("\n").at(-1)!) : undefined
}

describe("IM durable delivery across independent processes", () => {
  test("message/admission/reply crash boundaries preserve one input and one final local reply", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "im-authority-process-"))
    try {
      await run(root, "seed", 71)
      await run(root, "admit-crash", 72)
      expect(await run(root, "recover")).toMatchObject({
        inputs: 1,
        intents: ["admitted"],
        messageCount: 2,
        replies: [],
      })
      expect(await run(root, "finalize")).toMatchObject({
        inputs: 1,
        replies: [{ text: "complete final answer", status: "pending" }],
      })
      await run(root, "deliver-crash", 73)
      expect(await run(root, "deliver-recover")).toMatchObject({
        inputs: 1,
        messageCount: 3,
        replies: [{ text: "complete final answer", status: "delivered" }],
        agentMessages: ["complete final answer"],
      })
      expect(await run(root, "deliver-recover")).toMatchObject({
        messageCount: 3,
        agentMessages: ["complete final answer"],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("a revoked local group membership cannot be bypassed by admission repair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "im-authority-revoked-"))
    try {
      await run(root, "seed", 71)
      expect(await run(root, "revoke")).toMatchObject({ inputs: 0, intents: ["rejected"] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
