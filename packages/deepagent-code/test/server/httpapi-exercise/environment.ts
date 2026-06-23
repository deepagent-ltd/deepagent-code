import { Flag } from "@deepagent-code/core/flag/flag"
import { Effect } from "effect"
import path from "path"

const preserveExerciseGlobalRoot = !!process.env.DEEPAGENT_CODE_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot =
  process.env.DEEPAGENT_CODE_HTTPAPI_EXERCISE_GLOBAL ??
  path.join(process.env.TMPDIR ?? "/tmp", `deepagent-code-httpapi-global-${process.pid}`)
process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
process.env.DEEPAGENT_CODE_DISABLE_SHARE = "true"
export const exerciseConfigDirectory = path.join(exerciseGlobalRoot, "config", "deepagent-code")
export const exerciseDataDirectory = path.join(exerciseGlobalRoot, "data", "deepagent-code")

const preserveExerciseDatabase = !!process.env.DEEPAGENT_CODE_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath =
  process.env.DEEPAGENT_CODE_HTTPAPI_EXERCISE_DB ??
  path.join(process.env.TMPDIR ?? "/tmp", `deepagent-code-httpapi-exercise-${process.pid}.db`)
process.env.DEEPAGENT_CODE_DB = exerciseDatabasePath
Flag.DEEPAGENT_CODE_DB = exerciseDatabasePath

export const original = {
  DEEPAGENT_CODE_SERVER_PASSWORD: Flag.DEEPAGENT_CODE_SERVER_PASSWORD,
  DEEPAGENT_CODE_SERVER_USERNAME: Flag.DEEPAGENT_CODE_SERVER_USERNAME,
}

export const cleanupExercisePaths = Effect.promise(async () => {
  const fs = await import("fs/promises")
  if (!preserveExerciseDatabase) {
    await Promise.all(
      [exerciseDatabasePath, `${exerciseDatabasePath}-wal`, `${exerciseDatabasePath}-shm`].map((file) =>
        fs.rm(file, { force: true }).catch(() => undefined),
      ),
    )
  }
  if (!preserveExerciseGlobalRoot)
    await fs.rm(exerciseGlobalRoot, { recursive: true, force: true }).catch(() => undefined)
})
