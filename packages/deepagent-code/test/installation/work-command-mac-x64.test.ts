import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { LocalOperatorPolicy } from "../../src/im/local-operator-policy"
import { NativeInstallation } from "../../src/installation/native-installation"
import { WorkCommandRuntime } from "../../src/installation/work-command-runtime"

const recipe = {
  schemaVersion: "work-command-recipe.mac-x64.v1", logicalID: "verify", revision: 1,
  executable: "installed-bun-mac-x64-v1", argv: [{ kind: "literal", value: "verify.ts" }],
  parameters: [], cwd: null, inputs: ["verify.ts"], outputs: [], environment: [],
  workspace: "private_explicit_files.v1", sandbox: {
    id: "darwin-single-process-workspace-v1", revision: 1, network: "deny", processes: 1, openFiles: 64,
    maxInputFiles: 256, maxInputFileBytes: 16_777_216, maxInputBytes: 67_108_864, maxDepth: 16,
    maxOutputFiles: 32, maxOutputFileBytes: 1_048_576, maxOutputBytes: 33_554_432,
  }, timeoutMs: 60_000, stdoutBytes: 1_048_576, stderrBytes: 1_048_576,
}
const policy = {
  version: 4, targets: [{ id: "intel", directory: "/private/tmp/qa-intel", agentID: "verify",
    providerID: "qa", modelID: "qa", budget: WorkAuthorityPolicy.PROJECT_PROFILE.budget,
    project: { tools: ["read", "managed_command"], commandRecipes: [recipe], fileScope: {
      read: [{ kind: "file", path: "verify.ts" }], write: [], deny: [], maxReadBytes: 16_384,
      maxPageBytes: 16_384, maxHashBytes: 16_777_216, maxWriteBytes: 0, symlinks: "deny",
    } },
  }],
}

test("offline Intel policy is explicit and cannot choose a captured asset identity or inherit the ARM runtime marker", async () => {
  const parsed = await Effect.runPromise(LocalOperatorPolicy.parse(policy))
  expect(parsed.version).toBe(4)
  for (const changed of [
    { ...recipe, executable: "installed-bun-v1" },
    { ...recipe, executable: { platform: "darwin-x64", sha256: "a".repeat(64) } },
    { ...recipe, target: "darwin-arm64" },
    { ...recipe, schemaVersion: "work-command-recipe.v2" },
  ]) {
    const invalid = { ...policy, targets: policy.targets.map((target) => ({ ...target,
      project: { ...target.project, commandRecipes: [changed] } })) }
    expect(Exit.isFailure(await Effect.runPromiseExit(LocalOperatorPolicy.parse(invalid)))).toBeTrue()
  }
})

test("a source invocation or an orphan object cannot capture either installed Mac runtime", async () => {
  expect(Exit.isFailure(await Effect.runPromiseExit(NativeInstallation.current()))).toBeTrue()
  // Negative identity test only: this object is not an installation receipt or a native proof.
  await expect(WorkCommandRuntime.verifiedMacX64Runtime(Object.create(null))).rejects.toBeDefined()
  await expect(WorkCommandRuntime.verifiedRuntime(Object.create(null))).rejects.toBeDefined()
})
