export * as WorkCommandMacX64Schema from "./work-command-mac-x64.schema"

import { Schema } from "effect"
import { WorkCommandSchema } from "./work-command.schema"

export const RUNTIME_ASSET = "packages/work-file-helper/bin/darwin-x64/bun-command-runtime"
export const Executable = Schema.Struct({ ...WorkCommandSchema.Recipe.fields.executable.fields,
  assetPath: Schema.Literal(RUNTIME_ASSET), platform: Schema.Literal("darwin-x64"),
})
export type Executable = typeof Executable.Type

/** An explicit Intel approval cannot reinterpret the old ARM recipe or installed grant.
 * Execution still requires the original signed factory and current opened asset identity. */
export const Recipe = Schema.Struct({ ...WorkCommandSchema.Recipe.fields,
  schemaVersion: Schema.Literal("work-command-recipe.mac-x64.v1"), executable: Executable,
}).check(Schema.makeFilter(validOptions))
export type Recipe = typeof Recipe.Type
export const RecipeRequest = Schema.Struct({ ...Recipe.fields,
  executable: Schema.Literal("installed-bun-mac-x64-v1"),
}).check(Schema.makeFilter(validOptions))
export type RecipeRequest = typeof RecipeRequest.Type

function validOptions(value: {
  parameters: WorkCommandSchema.Recipe["parameters"]; environment: WorkCommandSchema.Recipe["environment"];
  inputs: readonly string[]; outputs: readonly string[]; argv: WorkCommandSchema.Recipe["argv"]
}) {
  const paths = [...value.inputs, ...value.outputs]
  const keys = value.parameters.map((parameter) => parameter.key)
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= 32_768 && new Set(paths).size === paths.length &&
    new Set(keys).size === keys.length && new Set(value.environment.map((entry) => entry.name)).size === value.environment.length &&
    paths.reduce((sum, relative) => sum + Buffer.byteLength(relative), 0) <= 8192 &&
    !paths.some((relative) => paths.some((parent) => relative.startsWith(`${parent}/`))) &&
    value.argv.every((argument) => argument.kind === "literal" || keys.includes(argument.parameter)) &&
    value.argv.reduce((sum, argument) => sum + (argument.kind === "literal" ? Buffer.byteLength(argument.value) :
      Math.max(...value.parameters.find((parameter) => parameter.key === argument.parameter)!.choices.map((choice) => Buffer.byteLength(choice)))), 0) <= 16_384
}
