export * as IMDeviceSchema from "./device.schema"

import { Schema } from "effect"

const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,128}$/))
const HexID = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/))
const Jkt = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/))
export const Info = Schema.Struct({
  profile: Schema.Literal("dac-im-device-v1"),
  storeAvailable: Schema.Literal(true),
  deviceJkt: Jkt,
  publicJwk: Schema.Struct({ kty: Schema.Literal("EC"), crv: Schema.Literal("P-256"), x: Jkt, y: Jkt }),
})
export const Migrate = Schema.Struct({
  migrationID: ID,
  voucher: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  retryOriginal: Schema.optional(Schema.Boolean),
})
export type Migrate = typeof Migrate.Type
export const Migration = Schema.Struct({
  migrationID: ID,
  state: Schema.Literals(["pending", "unknown", "succeeded", "rejected"]),
  chargedCredits: Schema.Literal(0),
  credentialStored: Schema.Boolean,
  code: Schema.optional(Schema.String),
  entitlementID: Schema.optional(HexID),
  uuid: Schema.optional(HexID),
})
export type Migration = typeof Migration.Type
export const Pending = Schema.Struct({ migration: Schema.NullOr(Migration) })
