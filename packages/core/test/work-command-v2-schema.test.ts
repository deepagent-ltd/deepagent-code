import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { WorkCommandV2Schema } from "../src/session/work-command-v2.schema"
import { WorkCommandSchema } from "../src/session/work-command.schema"

const common = { revision: 1, network: "deny", filesystem: "explicit_snapshot_closure", payloadProcesses: 1,
  payloadThreadsMax: 64, supervisorProcessesMax: 2, openFiles: 64, stopProof: "root_exit_stream_eof_tree_empty" }
const linux = { ...common, id: "linux-cgroup2-single-payload-v1", threadsEnforcement: "cgroup_pids",
  cpu: { quotaMicros: 100_000, periodMicros: 100_000, totalWatchdogMicros: 60_000_000, pollMs: 20 },
  memory: { maxBytes: 268_435_456, swapMaxBytes: 0 }, tasksMax: 66 }
const windows = { ...common, id: "win32-job-appcontainer-single-payload-v1", threadsEnforcement: "supervisor_watchdog",
  cpu: { hardCapPercent: 50, jobUserTimeLimit100ns: 600_000_000, totalWatchdogMicros: 60_000_000, pollMs: 20 },
  memory: { jobCommitMaxBytes: 268_435_456 }, jobProcessesMax: 1, noBreakaway: true }
const recipe = { schemaVersion: "work-command-recipe.v2", logicalID: "compile", revision: 1,
  executable: { assetPath: "packages/work-file-helper/bin/linux-x64/bun-command-runtime", sha256: "a".repeat(64),
    bytes: 128, platform: "linux-x64", identity: { kind: "posix", device: "1", inode: "2" } },
  argv: [{ kind: "literal", value: "build" }, { kind: "parameter", parameter: "mode" }],
  parameters: [{ key: "mode", choices: ["check", "compile"] }], cwd: null, inputs: ["source.ts"], outputs: ["result.txt"],
  environment: [{ name: "CI", value: "1" }], workspace: "private_explicit_files.v1", sandbox: linux,
  timeoutMs: 120_000, stdoutBytes: 1_048_576, stderrBytes: 1_048_576 }

test("v2 recipes and policy requests bind target, actual identity kind and independent isolation", () => {
  for (const platform of ["linux-x64", "linux-arm64"]) {
    expect(Option.isSome(WorkCommandV2Schema.decodeRecipe({ ...recipe, executable: { ...recipe.executable, platform } }))).toBeTrue()
    expect(Option.isSome(WorkCommandV2Schema.decodeRequest({ ...recipe, executable: "installed-bun-v2", target: platform }))).toBeTrue()
  }
  for (const platform of ["win32-x64", "win32-arm64"]) {
    expect(Option.isSome(WorkCommandV2Schema.decodeRecipe({ ...recipe, sandbox: windows,
      executable: { ...recipe.executable, platform, identity: { kind: "windows", volumeSerial: "a".repeat(16), fileID: "b".repeat(32) } } }))).toBeTrue()
    expect(Option.isSome(WorkCommandV2Schema.decodeRequest({ ...recipe, executable: "installed-bun-v2", target: platform, sandbox: windows }))).toBeTrue()
  }
  expect(Schema.is(WorkCommandSchema.Recipe)(recipe)).toBeFalse()
})

test("v2 rejects private handles, wrong OS isolation and ambiguous or unbounded recipe authority", () => {
  for (const value of [
    { ...recipe, executable: { ...recipe.executable, platform: "darwin-arm64" } },
    { ...recipe, executable: { ...recipe.executable, identity: { kind: "windows", volumeSerial: "a".repeat(16), fileID: "b".repeat(32) } } },
    { ...recipe, sandbox: windows }, { ...recipe, sandbox: { ...linux, delegatedCgroup: "/sys/fs/cgroup/caller" } },
    { ...recipe, inputs: ["../source.ts"] }, { ...recipe, outputs: ["source.ts"] },
    { ...recipe, inputs: ["source", "source/child"] }, { ...recipe, parameters: [...recipe.parameters, ...recipe.parameters] },
    { ...recipe, argv: [{ kind: "parameter", parameter: "unknown" }] },
    { ...recipe, environment: [{ name: "PATH", value: "/caller" }] }, { ...recipe, timeoutMs: 600_001 },
    { ...recipe, argv: Array.from({ length: 16 }, () => ({ kind: "literal", value: "a".repeat(2048) })) },
  ]) expect(Option.isNone(WorkCommandV2Schema.decodeRecipe(value))).toBeTrue()
  expect(Option.isNone(WorkCommandV2Schema.decodeRequest({ ...recipe, executable: "installed-bun-v2", target: "win32-x64" }))).toBeTrue()
})
