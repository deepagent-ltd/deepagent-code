export * as EventValidationMac from "./event-validation-mac"

import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"

/** Read-model selection only. Execution still captures the real installation and
 * reopens its exact native runtime through WorkCommandRuntime's trusted factory. */
export function supports(recipe: EventValidationSchema.Recipe) {
  if (recipe.schemaVersion === "work-command-recipe.v2") return false
  return process.platform === "darwin" && recipe.executable.platform === `${process.platform}-${process.arch}` &&
    ((process.arch === "arm64" && recipe.schemaVersion === "work-command-recipe.v1") ||
      (process.arch === "x64" && recipe.schemaVersion === "work-command-recipe.mac-x64.v1"))
}

export function request(recipe: EventValidationSchema.Recipe): EventValidationSchema.MacRecipeRequest {
  if (recipe.schemaVersion === "work-command-recipe.v2")
    throw new EventValidationSchema.Error({ code: "VALIDATION_UNAVAILABLE", message: "Mac validation requires an installed Mac recipe" })
  if (recipe.schemaVersion === "work-command-recipe.mac-x64.v1")
    return { ...recipe, executable: "installed-bun-mac-x64-v1" }
  return { ...recipe, executable: "installed-bun-v1" }
}
