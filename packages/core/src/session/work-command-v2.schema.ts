export * as WorkCommandV2Schema from "./work-command-v2.schema"

import { Schema } from "effect"
import { WorkCommandSchema } from "./work-command.schema"
import { WorkCommandMacX64Schema } from "./work-command-mac-x64.schema"
import { WorkProcessSupervisorSchema } from "./work-process-supervisor.schema"

/** A separate recipe version preserves the old Mac recipe's canonical bytes. The
 * signed factory must still obtain real runtime, workspace and containment handles. */
export const Recipe = Schema.Struct({ ...WorkCommandSchema.Recipe.fields,
  schemaVersion: Schema.Literal("work-command-recipe.v2"),
  executable: Schema.Struct({ ...WorkCommandSchema.Recipe.fields.executable.fields,
    platform: WorkProcessSupervisorSchema.Target, identity: WorkProcessSupervisorSchema.Identity }),
  sandbox: WorkProcessSupervisorSchema.Isolation,
}).check(Schema.makeFilter((value) => validOptions(value) &&
  Schema.is(WorkProcessSupervisorSchema.Configuration)({ target: value.executable.platform, isolation: value.sandbox }) &&
  (value.executable.platform.startsWith("linux-") ? value.executable.identity.kind === "posix" :
    value.executable.identity.kind === "windows")))
export type Recipe = typeof Recipe.Type

/** Policy selects a target, never a cgroup, token/SID, control FD, or executable path. */
export const RecipeRequest = Schema.Struct({ ...Recipe.fields,
  executable: Schema.Literal("installed-bun-v2"), target: WorkProcessSupervisorSchema.Target,
}).check(Schema.makeFilter((value) => validOptions(value) &&
  Schema.is(WorkProcessSupervisorSchema.Configuration)({ target: value.target, isolation: value.sandbox })))
export type RecipeRequest = typeof RecipeRequest.Type
export const ApprovedRecipe = Schema.Union([WorkCommandSchema.Recipe, WorkCommandMacX64Schema.Recipe, Recipe])
export type ApprovedRecipe = typeof ApprovedRecipe.Type
export const ApprovedRecipeRequest = Schema.Union([WorkCommandSchema.RecipeRequest, WorkCommandMacX64Schema.RecipeRequest, RecipeRequest])
export type ApprovedRecipeRequest = typeof ApprovedRecipeRequest.Type
/** Comparison data from an original supervisor observation. JSON decoding
 * cannot produce the Host's private StopProof or command observation handle. */
export const Supervision = Schema.Struct({
  version: Schema.Literal(2), target: WorkProcessSupervisorSchema.Target,
  supervisorHash: WorkCommandSchema.Recipe.fields.executable.fields.sha256,
  isolationHash: WorkCommandSchema.Recipe.fields.executable.fields.sha256,
  stopHash: WorkCommandSchema.Recipe.fields.executable.fields.sha256,
  nonce: WorkCommandSchema.Recipe.fields.executable.fields.sha256,
  rootPID: Schema.Int.check(Schema.isGreaterThan(0)),
  rootExit: Schema.Literal(true), treeEmpty: Schema.Literal(true),
  stdoutEOF: Schema.Literal(true), stderrEOF: Schema.Literal(true),
})
export type Supervision = typeof Supervision.Type
export const decodeRecipe = Schema.decodeUnknownOption(Recipe, { onExcessProperty: "error" })
export const decodeRequest = Schema.decodeUnknownOption(RecipeRequest, { onExcessProperty: "error" })

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
