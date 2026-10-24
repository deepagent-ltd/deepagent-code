export * as IMEntitlementSchema from "./entitlement.schema"

import { Schema } from "effect"
import { ConfigIM } from "../config/im"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const Time = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const Realm = Schema.String.check(Schema.makeFilter((value) => ConfigIM.normalizeServiceURL(value, true) === value))
const Term = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("calendarYears"), years: Schema.Literals([1, 3]) }),
  Schema.Struct({ kind: Schema.Literal("lifetime") }),
])

export const Plan = Schema.Struct({
  planID: Schema.Literals(["im-year", "im-three-years", "im-lifetime"]),
  priceCredits: Schema.Literals(["1", "2", "9.9"]),
  term: Term,
  maxBoundDevices: Schema.Literal(1),
  autoRenew: Schema.Literal(false),
}).check(
  Schema.makeFilter((value) =>
    value.planID === "im-lifetime"
      ? value.priceCredits === "9.9" && value.term.kind === "lifetime"
      : value.term.kind === "calendarYears" &&
        (value.planID === "im-year"
          ? value.priceCredits === "1" && value.term.years === 1
          : value.priceCredits === "2" && value.term.years === 3),
  ),
)
export type Plan = typeof Plan.Type

export const Plans = Schema.Struct({
  version: Schema.Literal("dac-im-plans-v1"),
  planVersion: Text,
  salesAvailable: Schema.Boolean,
  serverObservedAt: Time,
  purchaseURL: Schema.NullOr(
    Schema.String.check(
      Schema.makeFilter((value) => {
        const url = URL.parse(value)
        return (
          !!url &&
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.hash &&
          url.href === value &&
          value.length <= 2048
        )
      }),
    ),
  ),
  plans: Schema.Array(Plan).check(Schema.isLengthBetween(3, 3)),
}).check(Schema.makeFilter((value) => new Set(value.plans.map((plan) => plan.planID)).size === 3))
export type Plans = typeof Plans.Type

export const Entitlement = Schema.Struct({
  version: Schema.Literal("dac-im-entitlement-v1"),
  profile: Schema.Literal("dac-im-device-v1"),
  realm: Realm,
  entitlementID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  deviceJkt: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  bindingVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  uuid: Text,
  planID: Schema.NullOr(Text),
  planVersion: Schema.NullOr(Text),
  state: Schema.Literals(["active", "expired", "revoked", "pending"]),
  validityKnown: Schema.Boolean,
  lifetime: Schema.NullOr(Schema.Boolean),
  validFrom: Schema.NullOr(Time),
  expiresAt: Schema.NullOr(Time),
  serverObservedAt: Time,
}).check(
  Schema.makeFilter((value) => {
    if (!value.validityKnown) return value.lifetime === null && value.validFrom === null && value.expiresAt === null
    if (value.lifetime === true) return value.expiresAt === null && value.state !== "expired"
    return (
      value.lifetime === false &&
      value.validFrom !== null &&
      value.expiresAt !== null &&
      value.validFrom < value.expiresAt &&
      (value.state !== "active" ||
        (value.validFrom <= value.serverObservedAt && value.serverObservedAt < value.expiresAt)) &&
      (value.state !== "expired" || value.expiresAt <= value.serverObservedAt)
    )
  }),
)
export type Entitlement = typeof Entitlement.Type

export const UnknownReason = Schema.Literals([
  "service_unconfigured",
  "not_bound",
  "custody_unavailable",
  "unsupported",
  "service_unavailable",
  "invalid_response",
  "scope_changed",
])
const Unknown = Schema.Struct({ state: Schema.Literal("unknown"), reason: UnknownReason })
export const Observation = Schema.Union([
  Unknown,
  Schema.Struct({ state: Schema.Literal("known"), entitlement: Entitlement }),
])
export type Observation = typeof Observation.Type
export const PlansObservation = Schema.Union([
  Unknown,
  Schema.Struct({ state: Schema.Literal("known"), catalog: Plans }),
])
export type PlansObservation = typeof PlansObservation.Type
