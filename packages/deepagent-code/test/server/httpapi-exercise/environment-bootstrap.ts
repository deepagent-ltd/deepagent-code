import path from "path"
import fs from "node:fs/promises"
import os from "node:os"

export const preserveExerciseGlobalRoot = !!process.env.DEEPAGENT_CODE_HTTPAPI_EXERCISE_GLOBAL
const requestedGlobalRoot =
  process.env.DEEPAGENT_CODE_HTTPAPI_EXERCISE_GLOBAL ??
  path.join(os.tmpdir(), `deepagent-code-httpapi-global-${process.pid}`)
await fs.mkdir(requestedGlobalRoot, { recursive: true })
export const exerciseGlobalRoot = await fs.realpath(requestedGlobalRoot)

process.env.DEEPAGENT_CODE_TEST_HOME = exerciseGlobalRoot
process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
process.env.DEEPAGENT_CODE_DISABLE_SHARE = "true"

export const exerciseDataDirectory = path.join(exerciseGlobalRoot, "data", "deepagent-code")
// An explicit test data-root override is the unified config/data home on every OS.
export const exerciseConfigDirectory = exerciseDataDirectory
// The exerciser has no external IM service. Establish this before constructing
// any application or instance, rather than disposing live instances from a seed.
process.env.DEEPAGENT_IM_FACADE_URL = ""
if (!(await Bun.file(path.join(exerciseConfigDirectory, "config.jsonc")).exists()))
  await Bun.write(
    path.join(exerciseConfigDirectory, "config.jsonc"),
    JSON.stringify({
      $schema: "https://ai.deepagent.ltd/config.schema.json",
      im: { url: null },
    }),
  )
process.env.DEEPAGENT_CODE_HOME = exerciseDataDirectory
process.env.DEEPAGENT_CODE_EXPERIMENTAL_EXPERT_PANEL = "false"
process.env.DEEPAGENT_CODE_EXPERIMENTAL_GOAL_LOOP = "false"
process.env.DEEPAGENT_CODE_EXPERIMENTAL_WIKI = "false"
process.env.DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED = "false"
process.env.DEEPAGENT_CODE_V4_MULTI_AGENT_RUNTIME = "false"
process.env.DEEPAGENT_CODE_V4_THREAD_ENABLED = "false"

export const preserveExerciseDatabase = !!process.env.DEEPAGENT_CODE_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath =
  process.env.DEEPAGENT_CODE_HTTPAPI_EXERCISE_DB ??
  path.join(os.tmpdir(), `deepagent-code-httpapi-exercise-${process.pid}.db`)

process.env.DEEPAGENT_CODE_DB = exerciseDatabasePath

// Fresh exerciser roots use the real signed development-owner bootstrap for
// loopback model turns. Existing caller-owned roots/databases require opt-in.
if (!preserveExerciseGlobalRoot && !preserveExerciseDatabase) process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT = "1"
