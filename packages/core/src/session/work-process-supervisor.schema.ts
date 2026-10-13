export * as WorkProcessSupervisorSchema from "./work-process-supervisor.schema"

import { Schema } from "effect"

const integer = (minimum: number, maximum: number) => Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(minimum), Schema.isLessThanOrEqualTo(maximum))
const common = {
  revision: Schema.Literal(1), network: Schema.Literal("deny"), filesystem: Schema.Literal("explicit_snapshot_closure"),
  payloadProcesses: Schema.Literal(1), payloadThreadsMax: Schema.Literal(64), supervisorProcessesMax: Schema.Literal(2),
  openFiles: Schema.Literal(64), stopProof: Schema.Literal("root_exit_stream_eof_tree_empty"),
}

export const Target = Schema.Literals(["linux-x64", "linux-arm64", "win32-x64", "win32-arm64"])
export type Target = typeof Target.Type
export const Identity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("posix"), device: Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/)),
    inode: Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/)) }),
  Schema.Struct({ kind: Schema.Literal("windows"), volumeSerial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
    fileID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)) }),
])
export type Identity = typeof Identity.Type

// These limits describe kernel controls and a separate supervisor watchdog.
// Neither this configuration nor a JSON stop flag is an installed execution proof.
export const LinuxIsolation = Schema.Struct({ ...common, id: Schema.Literal("linux-cgroup2-single-payload-v1"),
  threadsEnforcement: Schema.Literal("cgroup_pids"),
  cpu: Schema.Struct({ quotaMicros: integer(1_000, 1_000_000), periodMicros: integer(1_000, 1_000_000),
    totalWatchdogMicros: integer(1, 600_000_000), pollMs: integer(10, 100) }),
  memory: Schema.Struct({ maxBytes: integer(16_777_216, 2_147_483_648), swapMaxBytes: Schema.Literal(0) }),
  tasksMax: Schema.Literal(66),
})
export const WindowsIsolation = Schema.Struct({ ...common, id: Schema.Literal("win32-job-appcontainer-single-payload-v1"),
  threadsEnforcement: Schema.Literal("supervisor_watchdog"),
  cpu: Schema.Struct({ hardCapPercent: integer(1, 100), jobUserTimeLimit100ns: integer(1, 6_000_000_000),
    totalWatchdogMicros: integer(1, 600_000_000), pollMs: integer(10, 100) }),
  memory: Schema.Struct({ jobCommitMaxBytes: integer(16_777_216, 2_147_483_648) }),
  jobProcessesMax: Schema.Literal(1), noBreakaway: Schema.Literal(true),
})
export const Isolation = Schema.Union([LinuxIsolation, WindowsIsolation])
export type Isolation = typeof Isolation.Type
export const Configuration = Schema.Struct({ target: Target, isolation: Isolation }).check(Schema.makeFilter((value) =>
  value.target.startsWith("linux-") === (value.isolation.id === "linux-cgroup2-single-payload-v1")))
export type Configuration = typeof Configuration.Type

// No delegated cgroup path, AppContainer SID, setup FD, or control handle comes
// from recipe/HTTP data. The signed installed factory obtains them itself.
export const decodeConfiguration = Schema.decodeUnknownOption(Configuration, { onExcessProperty: "error" })
