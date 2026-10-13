import fs from "node:fs/promises"
import { constants, type Stats } from "node:fs"
import path from "node:path"
import { Flock } from "@deepagent-code/core/util/flock"
import { GoalPlanClient } from "@deepagent-code/core/deepagent/goal-plan-client"

// Client observations, never a grant. A completed write is required before network dispatch.
export function createGoalPlanDraftStore(stateDirectory: string) {
  const directory = path.join(stateDirectory, "goal-plan-v1")
  const file = path.join(directory, "records.json")
  async function ready() {
    // POSIX mode bits cannot prove a Windows DACL. Until that boundary has a
    // native verifier, durable plan edit dispatch on that platform stays unavailable.
    if (process.platform === "win32" || !process.getuid) throw new Error("goal_plan_store_unavailable")
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    requirePrivate(await fs.lstat(directory), "directory")
  }
  async function read() {
    await ready()
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
      throw error
    })
    if (!handle) return []
    try {
      const stat = await handle.stat()
      requirePrivate(stat, "file")
      if (stat.size > GoalPlanClient.maxStoreBytes) throw new Error("goal_plan_store_limit")
      const bytes = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      const after = await handle.stat()
      requirePrivate(after, "file")
      if (
        length !== stat.size ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new Error("goal_plan_store_changed")
      return GoalPlanClient.records(JSON.parse(bytes.subarray(0, length).toString("utf8")))
    } finally {
      await handle.close()
    }
  }
  async function write(values: GoalPlanClient.Draft[]) {
    await ready()
    const bytes = JSON.stringify(GoalPlanClient.records(values))
    const temporary = path.join(directory, `${crypto.randomUUID()}.tmp`)
    try {
      const handle = await fs.open(temporary, "wx", 0o600)
      try {
        requirePrivate(await handle.stat(), "file")
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temporary, file)
      const parent = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
      try {
        requirePrivate(await parent.stat(), "directory")
        await parent.sync()
      } finally {
        await parent.close()
      }
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }
  return {
    async list(scope: GoalPlanClient.Scope) {
      await ready()
      return (await read()).filter((value) => GoalPlanClient.sameScope(value.scope, scope))
    },
    async put(value: GoalPlanClient.Draft, expectedRevision?: number) {
      await ready()
      await Flock.withLock(file, async () => write(GoalPlanClient.upsert(await read(), value, expectedRevision)), {
        dir: path.join(directory, "locks"),
        timeoutMs: 2000,
      })
      return value
    },
    async discard(value: GoalPlanClient.Draft) {
      await ready()
      await Flock.withLock(
        file,
        async () => {
          const records = await read()
          const current = records.find((item) => item.id === value.id)
          if (current && (current.revision !== value.revision || !GoalPlanClient.sameScope(current.scope, value.scope)))
            throw new Error("goal_plan_store_conflict")
          await write(records.filter((item) => item.id !== value.id))
        },
        { dir: path.join(directory, "locks"), timeoutMs: 2000 },
      )
    },
  }
}

function requirePrivate(stat: Stats, kind: "directory" | "file") {
  const owner = process.getuid?.()
  if (
    owner === undefined ||
    stat.uid !== owner ||
    (stat.mode & 0o077) !== 0 ||
    (kind === "directory" ? !stat.isDirectory() : !stat.isFile())
  )
    throw new Error("goal_plan_store_unavailable")
}
