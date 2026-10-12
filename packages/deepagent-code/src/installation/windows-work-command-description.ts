export * as WindowsWorkCommandDescription from "./windows-work-command-description"

import { Option, Schema } from "effect"
import { WorkStorageCleanupWindowsSchema } from "@deepagent-code/core/session/work-storage-cleanup-windows.schema"
import { WorkWindowsPathSchema } from "@deepagent-code/core/session/work-windows-path.schema"
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Identity = Schema.Struct({ kind: Schema.Literal("windows"),
  volume_serial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
  file_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)) })
const Stamp = Schema.String.check(Schema.isMaxLength(512))
const Counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
/** Read-only facts from an original command External. This codec neither
 * constructs a Native command nor promotes stored JSON into a stop proof. */
export const Observation = Schema.Struct({ version: Schema.Literal(1),
  phase: Schema.Literals(["ready", "running", "retired", "unknown"]),
  security: WorkStorageCleanupWindowsSchema.NativeSecurity, aclRestoreHash: Schema.NullOr(Digest),
  binding: Schema.Struct({ nonce: Digest, work_id: Schema.String, command_id: Schema.String,
    recipe_hash: Digest, control_revision: Counter.check(Schema.isGreaterThan(0)) }),
  inventory: Schema.Struct({ data_identity: Identity, stage_identity: Identity, project_identity: Identity, root_identity: Identity,
    files: Schema.Array(Schema.Struct({ relative: WorkWindowsPathSchema.MemberRelative, identity: Identity,
      bytes: Counter.check(Schema.isLessThanOrEqualTo(16_777_216)), sha256: Digest, stamp: Stamp })).check(Schema.isMaxLength(288)),
    directories: Schema.Array(Schema.Struct({ relative: WorkWindowsPathSchema.DirectoryRelative,
      identity: Identity, stamp: Stamp })).check(Schema.isMaxLength(4610)) }),
  jobRetired: Schema.Boolean, appContainerRetired: Schema.Boolean, aclRestored: Schema.Boolean,
}).check(Schema.makeFilter((value) => value.phase === "retired"
  ? value.jobRetired && value.appContainerRetired && value.aclRestored && value.aclRestoreHash !== null
  : value.aclRestoreHash === null && !value.appContainerRetired && !value.aclRestored))
export type Observation = typeof Observation.Type
export function decode(text: unknown) {
  return typeof text === "string" && Buffer.byteLength(text) <= 131_072
    ? Option.flatMap(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text),
      Schema.decodeUnknownOption(Observation, { onExcessProperty: "error" })) : Option.none<Observation>()
}
export function identity(value: typeof Identity.Type) {
  return { kind: "windows" as const, volumeSerial: value.volume_serial, fileID: value.file_id }
}
