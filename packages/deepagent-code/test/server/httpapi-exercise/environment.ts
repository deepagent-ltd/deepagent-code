import { Flag } from "@deepagent-code/core/flag/flag"
import { Effect } from "effect"
import {
  exerciseConfigDirectory,
  exerciseDataDirectory,
  exerciseDatabasePath,
  exerciseGlobalRoot,
  preserveExerciseDatabase,
  preserveExerciseGlobalRoot,
} from "./environment-bootstrap"

export { exerciseConfigDirectory, exerciseDataDirectory, exerciseDatabasePath, exerciseGlobalRoot }

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
