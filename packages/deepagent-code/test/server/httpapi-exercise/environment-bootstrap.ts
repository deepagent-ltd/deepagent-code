import path from "path"

export const preserveExerciseGlobalRoot = !!process.env.DEEPAGENT_CODE_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot =
  process.env.DEEPAGENT_CODE_HTTPAPI_EXERCISE_GLOBAL ??
  path.join(process.env.TMPDIR ?? "/tmp", `deepagent-code-httpapi-global-${process.pid}`)

process.env.DEEPAGENT_CODE_TEST_HOME = exerciseGlobalRoot
process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
process.env.DEEPAGENT_CODE_DISABLE_SHARE = "true"

export const exerciseConfigDirectory = path.join(exerciseGlobalRoot, "config", "deepagent-code")
export const exerciseDataDirectory = path.join(exerciseGlobalRoot, "data", "deepagent-code")
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
  path.join(process.env.TMPDIR ?? "/tmp", `deepagent-code-httpapi-exercise-${process.pid}.db`)

process.env.DEEPAGENT_CODE_DB = exerciseDatabasePath
