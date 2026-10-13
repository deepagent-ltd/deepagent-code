export * as IMActivationSchema from "./activation.schema"

import { Schema } from "effect"

const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,128}$/))
const Time = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const Method = Schema.Literals(["api_key", "activation_code"])

export const Quote = Schema.Struct({
  quoteID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
  priceCredits: Schema.Literal(1),
  quotaCost: Schema.Int.check(Schema.isGreaterThan(0)),
  expiresAt: Time,
  entitlementExpiresAt: Schema.NullOr(Time),
})
export type Quote = typeof Quote.Type

export const Submit = Schema.Struct({
  transactionID: ID,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  method: Method,
  credential: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  quoteID: Quote.fields.quoteID,
})
export type Submit = typeof Submit.Type

// Secrets are retained by the Host only. An unknown charge is not reported as zero.
export const Transaction = Schema.Struct({
  transactionID: ID,
  name: Submit.fields.name,
  method: Method,
  quoteID: Quote.fields.quoteID,
  state: Schema.Literals(["pending", "unknown", "succeeded", "rejected"]),
  chargedCredits: Schema.NullOr(Schema.Literals([0, 1])),
  credentialStored: Schema.Boolean,
  code: Schema.optional(Schema.String),
})
export type Transaction = typeof Transaction.Type

export const Pending = Schema.Struct({ transaction: Schema.NullOr(Transaction) })

export class Error extends Schema.TaggedErrorClass<Error>()("IMActivation.Error", {
  code: Schema.String,
}) {}
