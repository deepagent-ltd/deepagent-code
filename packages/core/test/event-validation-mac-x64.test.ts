import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { EventValidation } from "../src/deepagent/event-validation"
import { EventValidationSchema } from "../src/deepagent/event-validation.schema"
import { WorkCommandMacX64Schema } from "../src/session/work-command-mac-x64.schema"
import { EventValidationStoreFixture } from "./fixture/event-validation-store"

const arm = { ...EventValidationStoreFixture.configuration(), expiresAt: 2_000_000_000_000 }
const intel = Schema.decodeUnknownSync(EventValidationSchema.Configuration, { onExcessProperty: "error" })({
  ...arm,
  recipe: { ...arm.recipe, schemaVersion: "work-command-recipe.mac-x64.v1", executable: {
    ...arm.recipe.executable, platform: "darwin-x64", assetPath: WorkCommandMacX64Schema.RUNTIME_ASSET,
  } },
})

test("the original ARM configuration encoding and hash remain unchanged", () => {
  expect(Schema.decodeUnknownSync(EventValidationSchema.Configuration, { onExcessProperty: "error" })(arm)).toEqual(arm)
  expect(EventValidation.hash(arm)).toBe("969a2e3dedd1b6111ad0bb2799491993a1beefbe7c8ea28053ae57fd43ad5a22")
  expect(EventValidation.hash(intel)).not.toBe(EventValidation.hash(arm))
})

test("Intel validation preserves explicit tag, exact asset and independent public request marker", () => {
  const request = { ...intel.recipe, executable: "installed-bun-mac-x64-v1" }
  const decode = Schema.decodeUnknownOption(EventValidationSchema.MacRecipeRequest, { onExcessProperty: "error" })
  expect(Option.isSome(decode(request))).toBe(true)
  expect(Option.isSome(decode({ ...arm.recipe, executable: "installed-bun-v1" }))).toBe(true)
  expect(Option.isNone(decode({ ...request, executable: "installed-bun-v1" }))).toBe(true)
  expect(Option.isNone(decode({ ...arm.recipe, executable: "installed-bun-mac-x64-v1" }))).toBe(true)
  expect(Schema.decodeUnknownSync(EventValidationSchema.Candidates)({ targets: [{ targetID: "intel", recipes: [request] }] })
    .targets[0]?.recipes[0]?.schemaVersion).toBe("work-command-recipe.mac-x64.v1")
  expect(Schema.decodeUnknownSync(EventValidationSchema.Captured)({ captureID: "capture", expiresAt: intel.expiresAt,
    preview: { kind: intel.kind, recipe: request, parameters: intel.parameters, watch: intel.watch, maxRuns: intel.maxRuns,
      ruleExpiresAt: intel.expiresAt } }).preview.recipe.executable).toBe("installed-bun-mac-x64-v1")
})

test("a caller cannot mix platform, tag, runtime identity or unrelated execution profiles", () => {
  const decode = Schema.decodeUnknownOption(EventValidationSchema.Configuration, { onExcessProperty: "error" })
  for (const recipe of [
    { ...intel.recipe, schemaVersion: "work-command-recipe.v1" },
    { ...arm.recipe, schemaVersion: "work-command-recipe.mac-x64.v1" },
    { ...intel.recipe, executable: { ...intel.recipe.executable, assetPath: arm.recipe.executable.assetPath } },
    { ...intel.recipe, executable: { ...intel.recipe.executable, platform: "darwin-arm64" } },
    { ...intel.recipe, executable: "installed-bun-mac-x64-v1" },
    { ...intel.recipe, schemaVersion: "work-command-recipe.v2" },
    { ...intel.recipe, schemaVersion: "work-command-recipe.windows.v2" },
  ]) expect(Option.isNone(decode({ ...intel, recipe }))).toBe(true)
})
