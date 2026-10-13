export * as WorkCommandWindowsSchema from "./work-command-windows.schema"

import { Schema } from "effect"
import { WorkCommandSchema } from "./work-command.schema"
import { WorkProcessSupervisorSchema } from "./work-process-supervisor.schema"
import { WorkWindowsPathSchema } from "./work-windows-path.schema"

export const Target = Schema.Literals(["win32-x64", "win32-arm64"])
export type Target = typeof Target.Type
export const Identity = WorkProcessSupervisorSchema.Identity.members[1]
export type Identity = typeof Identity.Type

/** Independent business record. The original POSIX codec and canonical bytes
 * stay unchanged; this data never reconstructs a Windows process/file handle. */
export const Record = Schema.Struct({ ...WorkCommandSchema.Record.fields,
  version: Schema.Literal(2), target: Target,
  workspaceIdentity: Schema.NullOr(Identity),
  outputs: Schema.Array(Schema.Struct({ relative: WorkWindowsPathSchema.Relative, identity: Identity,
    sha256: WorkCommandSchema.Record.fields.runtimeHash,
    bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_048_576)),
  })).check(Schema.isMaxLength(32)),
}).check(Schema.makeFilter((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= WorkCommandSchema.MAX_RECORD_BYTES &&
  WorkWindowsPathSchema.nonOverlapping(value.outputs.map((output) => output.relative))))
export type Record = typeof Record.Type

export const StoredRecord = Schema.Union([WorkCommandSchema.Record, Record])
export type StoredRecord = typeof StoredRecord.Type
export const decodeRecord = Schema.decodeUnknownOption(StoredRecord, { onExcessProperty: "error" })
