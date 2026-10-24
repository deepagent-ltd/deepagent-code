import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { IMEntitlementSchema } from "../src/im/entitlement.schema"
import { IMActivationSchema } from "../src/im/activation.schema"

const catalog = {
  version: "dac-im-plans-v1",
  planVersion: "im-plans-2026-10-19",
  salesAvailable: false,
  serverObservedAt: 2000,
  purchaseURL: null,
  plans: [
    {
      planID: "im-year",
      priceCredits: "1",
      term: { kind: "calendarYears", years: 1 },
      maxBoundDevices: 1,
      autoRenew: false,
    },
    {
      planID: "im-three-years",
      priceCredits: "2",
      term: { kind: "calendarYears", years: 3 },
      maxBoundDevices: 1,
      autoRenew: false,
    },
    { planID: "im-lifetime", priceCredits: "9.9", term: { kind: "lifetime" }, maxBoundDevices: 1, autoRenew: false },
  ],
} as const
const entitlement = {
  version: "dac-im-entitlement-v1",
  profile: "dac-im-device-v1",
  realm: "https://owned.example/im",
  entitlementID: "e".repeat(32),
  deviceJkt: "j".repeat(43),
  bindingVersion: 1,
  uuid: "u".repeat(32),
  planID: "im-year",
  planVersion: "im-plans-2026-10-19",
  state: "active",
  validityKnown: true,
  lifetime: false,
  validFrom: 1000,
  expiresAt: 3000,
  serverObservedAt: 2000,
}
test("the authoritative plan catalog preserves exact decimal strings and matching terms", () => {
  expect(Schema.decodeUnknownSync(IMEntitlementSchema.Plans)(catalog)).toEqual(catalog)
  for (const replacement of [
    { ...catalog.plans[0], priceCredits: 1 },
    { ...catalog.plans[0], priceCredits: "1.0" },
    { ...catalog.plans[0], term: { kind: "lifetime" } },
    catalog.plans[1],
  ])
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(IMEntitlementSchema.Plans)({
          ...catalog,
          plans: [replacement, ...catalog.plans.slice(1)],
        }),
      ),
    ).toBe(true)
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(IMEntitlementSchema.Plans)({
        ...catalog,
        purchaseURL: "http://untrusted.example/buy",
      }),
    ),
  ).toBe(true)
})
test("finite and explicit lifetime observations retain expired and revoked states without granting communication", () => {
  for (const state of ["active", "expired", "revoked", "pending"]) {
    expect(
      Schema.decodeUnknownSync(IMEntitlementSchema.Observation)({
        state: "known",
        entitlement: {
          ...entitlement,
          state,
          expiresAt: state === "expired" ? 1500 : 3000,
        },
      }),
    ).toMatchObject({ state: "known", entitlement: { state } })
  }
  expect(
    Schema.decodeUnknownSync(IMEntitlementSchema.Entitlement)({
      ...entitlement,
      planID: "legacy-lifetime",
      planVersion: "old-authentic-version",
      lifetime: true,
      expiresAt: null,
    }),
  ).toMatchObject({ lifetime: true })
})
test("unknown validity and null dates never imply lifetime, and malformed intervals fail closed", () => {
  expect(
    Schema.decodeUnknownSync(IMEntitlementSchema.Entitlement)({
      ...entitlement,
      planID: null,
      planVersion: null,
      validityKnown: false,
      lifetime: null,
      validFrom: null,
      expiresAt: null,
    }),
  ).toMatchObject({ validityKnown: false, lifetime: null })
  for (const invalid of [
    { lifetime: null, expiresAt: null },
    { lifetime: false, expiresAt: 1000 },
    { validityKnown: false },
    { lifetime: true, expiresAt: null, state: "expired" },
    { state: "active", expiresAt: 1500 },
    { state: "expired", expiresAt: 3000 },
    { state: "active", validFrom: 2500 },
  ])
    expect(
      Option.isNone(Schema.decodeUnknownOption(IMEntitlementSchema.Entitlement)({ ...entitlement, ...invalid })),
    ).toBe(true)
})
test("the new read contract does not widen legacy one-credit activation or transaction amounts", () => {
  const quote = { quoteID: "old-quote", priceCredits: 1, quotaCost: 100, expiresAt: 3000, entitlementExpiresAt: null }
  expect(Schema.decodeUnknownSync(IMActivationSchema.Quote)(quote).priceCredits).toBe(1)
  expect(Option.isNone(Schema.decodeUnknownOption(IMActivationSchema.Quote)({ ...quote, priceCredits: "9.9" }))).toBe(
    true,
  )
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(IMActivationSchema.Transaction)({
        transactionID: "t".repeat(16),
        name: "alice",
        method: "activation_code",
        quoteID: "old-quote",
        state: "succeeded",
        chargedCredits: 9.9,
        credentialStored: true,
      }),
    ),
  ).toBe(true)
})
