import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { WorkCommandSchema } from "../src/session/work-command.schema"
import { WorkCommandMacX64Schema } from "../src/session/work-command-mac-x64.schema"
import { WorkCommandV2Schema } from "../src/session/work-command-v2.schema"

const recipe = {
  schemaVersion: "work-command-recipe.mac-x64.v1", logicalID: "verify", revision: 1,
  executable: { assetPath: WorkCommandMacX64Schema.RUNTIME_ASSET, sha256: "a".repeat(64), bytes: 128,
    platform: "darwin-x64", identity: { kind: "posix", device: "1", inode: "2" } },
  argv: [{ kind: "literal", value: "verify.ts" }, { kind: "parameter", parameter: "mode" }],
  parameters: [{ key: "mode", choices: ["check", "compile"] }], cwd: null,
  inputs: ["verify.ts"], outputs: ["result.txt"], environment: [{ name: "CI", value: "1" }],
  workspace: "private_explicit_files.v1", sandbox: {
    id: "darwin-single-process-workspace-v1", revision: 1, network: "deny", processes: 1, openFiles: 64,
    maxInputFiles: 256, maxInputFileBytes: 16_777_216, maxInputBytes: 67_108_864, maxDepth: 16,
    maxOutputFiles: 32, maxOutputFileBytes: 1_048_576, maxOutputBytes: 33_554_432,
  }, timeoutMs: 60_000, stdoutBytes: 1_048_576, stderrBytes: 1_048_576,
}
const decode = Schema.decodeUnknownOption(WorkCommandMacX64Schema.Recipe, { onExcessProperty: "error" })
const request = Schema.decodeUnknownOption(WorkCommandMacX64Schema.RecipeRequest, { onExcessProperty: "error" })

test("Intel approval has an independent tag and fixed asset; the original ARM schema remains exclusive", () => {
  expect(Option.isSome(decode(recipe))).toBeTrue()
  expect(Option.isSome(request({ ...recipe, executable: "installed-bun-mac-x64-v1" }))).toBeTrue()
  expect(Schema.is(WorkCommandV2Schema.ApprovedRecipe)(recipe)).toBeTrue()
  expect(Schema.is(WorkCommandV2Schema.ApprovedRecipeRequest)({ ...recipe, executable: "installed-bun-mac-x64-v1" })).toBeTrue()
  expect(Schema.is(WorkCommandSchema.Recipe)(recipe)).toBeFalse()
  const arm = { ...recipe, schemaVersion: "work-command-recipe.v1", executable: { ...recipe.executable,
    assetPath: "packages/work-file-helper/bin/darwin-arm64/bun-command-runtime", platform: "darwin-arm64" } }
  expect(Schema.is(WorkCommandSchema.Recipe)(arm)).toBeTrue()
  expect(Schema.is(WorkCommandV2Schema.ApprovedRecipe)(arm)).toBeTrue()
  expect(Option.isNone(decode(arm))).toBeTrue()
  expect(Option.isNone(request({ ...recipe, executable: "installed-bun-v1" }))).toBeTrue()
})

test("Intel rejects target swaps, extra authority, and the same bounded snapshot/argv/parameter violations", () => {
  for (const value of [
    { ...recipe, executable: { ...recipe.executable, platform: "darwin-arm64" } },
    { ...recipe, executable: { ...recipe.executable, assetPath: "packages/work-file-helper/bin/darwin-arm64/bun-command-runtime" } },
    { ...recipe, executable: { ...recipe.executable, identity: { kind: "windows", volumeSerial: "a".repeat(16), fileID: "b".repeat(32) } } },
    { ...recipe, target: "darwin-x64" }, { ...recipe, inputs: ["../verify.ts"] },
    { ...recipe, outputs: ["verify.ts"] }, { ...recipe, inputs: ["source", "source/child"] },
    { ...recipe, parameters: [...recipe.parameters, ...recipe.parameters] },
    { ...recipe, argv: [{ kind: "parameter", parameter: "unknown" }] },
    { ...recipe, environment: [{ name: "PATH", value: "/caller" }] },
    { ...recipe, timeoutMs: 600_001 }, { ...recipe, stdoutBytes: 1_048_577 },
    { ...recipe, sandbox: { ...recipe.sandbox, network: "allow" } },
    { ...recipe, argv: Array.from({ length: 16 }, () => ({ kind: "literal", value: "a".repeat(2048) })) },
  ]) expect(Option.isNone(decode(value))).toBeTrue()
  for (const value of [
    { ...recipe, inputs: ["source", "source/child"] },
    { ...recipe, parameters: [...recipe.parameters, ...recipe.parameters] },
    { ...recipe, argv: [{ kind: "parameter", parameter: "unknown" }] },
  ]) expect(Option.isNone(request({ ...value, executable: "installed-bun-mac-x64-v1" }))).toBeTrue()
})
