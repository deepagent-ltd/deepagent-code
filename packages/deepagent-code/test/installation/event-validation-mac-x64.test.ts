import { expect, test } from "bun:test"
import { Schema } from "effect"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { WorkCommandMacX64Schema } from "@deepagent-code/core/session/work-command-mac-x64.schema"
import { EventValidationMac } from "../../src/installation/event-validation-mac"
import { WorkCommandRuntime } from "../../src/installation/work-command-runtime"
import { EventValidationStoreFixture } from "../../../core/test/fixture/event-validation-store"

const arm = EventValidationStoreFixture.configuration().recipe
const intel = Schema.decodeUnknownSync(WorkCommandMacX64Schema.Recipe, { onExcessProperty: "error" })({
  ...arm, schemaVersion: "work-command-recipe.mac-x64.v1", executable: { ...arm.executable,
    platform: "darwin-x64", assetPath: WorkCommandMacX64Schema.RUNTIME_ASSET },
})

test("read-model recipe projection retains the exact independent Mac request markers", () => {
  const armRequest = EventValidationMac.request(arm)
  const intelRequest = EventValidationMac.request(intel)
  expect(armRequest.executable).toBe("installed-bun-v1")
  expect(intelRequest.executable).toBe("installed-bun-mac-x64-v1")
  expect(Schema.decodeUnknownSync(EventValidationSchema.MacRecipeRequest)(intelRequest)).toEqual(intelRequest)
  expect(EventValidationMac.supports(arm)).toBe(process.platform === "darwin" && process.arch === "arm64")
  expect(EventValidationMac.supports(intel)).toBe(process.platform === "darwin" && process.arch === "x64")
  expect(arm.schemaVersion).toBe("work-command-recipe.v1")
  expect(intel.schemaVersion).toBe("work-command-recipe.mac-x64.v1")
})

test("recipe JSON and a cloned object cannot mint either installed native runtime", async () => {
  await expect(WorkCommandRuntime.verifiedMacRecipeRuntime(Object.create(null), intel)).rejects.toBeDefined()
  await expect(WorkCommandRuntime.verifiedMacRecipeRuntime(Object.create(null), arm)).rejects.toBeDefined()
})
