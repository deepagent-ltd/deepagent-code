import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { WorkProcessSupervisorSchema } from "../src/session/work-process-supervisor.schema"
import { WorkCommandSchema } from "../src/session/work-command.schema"

const common = { revision: 1, network: "deny", filesystem: "explicit_snapshot_closure", payloadProcesses: 1,
  payloadThreadsMax: 64, supervisorProcessesMax: 2, openFiles: 64, stopProof: "root_exit_stream_eof_tree_empty" }
const linux = { ...common, id: "linux-cgroup2-single-payload-v1", threadsEnforcement: "cgroup_pids", cpu: { quotaMicros: 100_000, periodMicros: 100_000,
  totalWatchdogMicros: 60_000_000, pollMs: 20 }, memory: { maxBytes: 268_435_456, swapMaxBytes: 0 }, tasksMax: 66 }
const windows = { ...common, id: "win32-job-appcontainer-single-payload-v1", threadsEnforcement: "supervisor_watchdog", cpu: { hardCapPercent: 50,
  jobUserTimeLimit100ns: 600_000_000, totalWatchdogMicros: 60_000_000, pollMs: 20 },
  memory: { jobCommitMaxBytes: 268_435_456 }, jobProcessesMax: 1, noBreakaway: true }

test("supervisor configuration binds target OS and separates kernel controls from watchdog limits", () => {
  for (const target of ["linux-x64", "linux-arm64"]) {
    expect(Option.isSome(WorkProcessSupervisorSchema.decodeConfiguration({ target, isolation: linux }))).toBeTrue()
    expect(Option.isNone(WorkProcessSupervisorSchema.decodeConfiguration({ target, isolation: windows }))).toBeTrue()
  }
  for (const target of ["win32-x64", "win32-arm64"]) {
    expect(Option.isSome(WorkProcessSupervisorSchema.decodeConfiguration({ target, isolation: windows }))).toBeTrue()
    expect(Option.isNone(WorkProcessSupervisorSchema.decodeConfiguration({ target, isolation: linux }))).toBeTrue()
  }
  expect(Option.isNone(WorkProcessSupervisorSchema.decodeConfiguration({ target: "darwin-arm64", isolation: linux }))).toBeTrue()
  // The original recipe still targets the unchanged Mac sandbox.
  expect(Option.isSome(Schema.decodeUnknownOption(WorkCommandSchema.Recipe.fields.executable.fields.platform)("darwin-arm64"))).toBeTrue()
  expect(Option.isNone(Schema.decodeUnknownOption(WorkCommandSchema.Recipe.fields.executable.fields.platform)("linux-x64"))).toBeTrue()
})

test("supervisor rejects caller handles, loosened process/network policies and unbounded resource values", () => {
  for (const isolation of [
    { ...linux, cgroupPath: "/sys/fs/cgroup/caller" }, { ...linux, controlFD: 3 }, { ...linux, stopConfirmed: true },
    { ...linux, network: "allow" }, { ...linux, payloadProcesses: 2 }, { ...linux, tasksMax: 67 },
    { ...linux, cpu: { ...linux.cpu, quotaMicros: 999 } }, { ...linux, cpu: { ...linux.cpu, pollMs: 20.5 } },
    { ...linux, cpu: { ...linux.cpu, totalWatchdogMicros: Infinity } },
    { ...linux, memory: { ...linux.memory, maxBytes: 2_147_483_649 } }, { ...linux, memory: { ...linux.memory, swapMaxBytes: 1 } },
    { ...linux, threadsEnforcement: "supervisor_watchdog" },
  ]) expect(Option.isNone(WorkProcessSupervisorSchema.decodeConfiguration({ target: "linux-x64", isolation }))).toBeTrue()
  for (const isolation of [
    { ...windows, appContainerSID: "caller-sid" }, { ...windows, noBreakaway: false }, { ...windows, jobProcessesMax: 2 },
    { ...windows, cpu: { ...windows.cpu, hardCapPercent: 0 } }, { ...windows, cpu: { ...windows.cpu, hardCapPercent: 101 } },
    { ...windows, cpu: { ...windows.cpu, jobUserTimeLimit100ns: 6_000_000_001 } },
    { ...windows, threadsEnforcement: "kernel_hard_limit" },
  ]) expect(Option.isNone(WorkProcessSupervisorSchema.decodeConfiguration({ target: "win32-x64", isolation }))).toBeTrue()
})
