export * as WindowsBrowserFileStage from "./windows-file-stage"

import { Schema } from "effect"
import type { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { WorkWindowsPathSchema } from "@deepagent-code/core/session/work-windows-path.schema"

const Identity = Schema.Struct({ kind: Schema.Literal("windows"),
  volume_serial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
  file_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)) })
export const Description = Schema.Struct({ version: Schema.Literal(1), directory: WorkWindowsPathSchema.Absolute,
  path: WorkWindowsPathSchema.Absolute, root: Identity, stage: Identity, file: Identity,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(52_428_800)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)), sealed: Schema.Boolean })
export type Description = typeof Description.Type
export const identity = (value: typeof Identity.Type): BrowserFileSchema.Identity => ({
  kind: "windows", volumeSerial: value.volume_serial, fileID: value.file_id,
})
