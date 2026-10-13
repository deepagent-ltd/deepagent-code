export * as EventValidationPlatform from "./event-validation-platform"

import { Schema } from "effect"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { EventValidationMac } from "./event-validation-mac"

export function supports(recipe: EventValidationSchema.Recipe) {
  if (recipe.schemaVersion !== "work-command-recipe.v2") return EventValidationMac.supports(recipe)
  return process.platform === "linux" && recipe.executable.platform === `${process.platform}-${process.arch}` &&
    Schema.is(EventValidationSchema.LinuxRecipe)(recipe)
}

export function request(recipe: EventValidationSchema.Recipe): EventValidationSchema.RecipeRequest {
  if (recipe.schemaVersion !== "work-command-recipe.v2") return EventValidationMac.request(recipe)
  return { ...recipe, executable: "installed-bun-v2", target: recipe.executable.platform }
}
