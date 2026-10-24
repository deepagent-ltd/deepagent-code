import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { IMEntitlementSummary } from "@/components/im/entitlement-summary"
import { observeIMEntitlement } from "@/components/im/entitlement"
import type { IMFacadeStatus } from "@/utils/im-client"
import { dict } from "@/i18n/en"
import type { IMEntitlementSchema } from "@deepagent-code/core/im/entitlement.schema"

const openLink = vi.hoisted(() => vi.fn())
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ openLink }) }))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string>) =>
      Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{{${name}}}`, value), dict[key]),
  }),
}))
afterEach(cleanup)

function status(patch: Partial<IMFacadeStatus>): IMFacadeStatus {
  return {
    service: { url: "https://configured.invalid/im", source: "config", reconnectRequired: false },
    facade: "disabled",
    identity: null,
    blocked: null,
    kernel: null,
    keyOrigin: "none",
    ...patch,
  }
}

it("distinguishes missing service and unknown observations from confirmed activation required", () => {
  const view = render(() => <IMEntitlementSummary observation={observeIMEntitlement(undefined)} />)
  expect(screen.getByRole("status").textContent).toBe(dict["settings.im.entitlement.unknown"])
  expect(screen.getByText(dict["settings.im.entitlement.serviceRequired"])).toBeTruthy()
  view.unmount()
  const configured = render(() => <IMEntitlementSummary observation={observeIMEntitlement(status({}))} />)
  expect(screen.getByRole("status").textContent).toBe(dict["settings.im.entitlement.unknown"])
  expect(screen.queryByText(dict["settings.im.entitlement.serviceRequired"])).toBeNull()
  configured.unmount()
  const stale = render(() => (
    <IMEntitlementSummary
      observation={observeIMEntitlement(
        status({
          facade: "active",
          service: { url: "https://new.invalid/im", source: "config", reconnectRequired: true },
        }),
      )}
    />
  ))
  expect(screen.getByRole("status").textContent).toBe(dict["settings.im.entitlement.unknown"])
  stale.unmount()
  render(() => (
    <IMEntitlementSummary
      observation={observeIMEntitlement(
        status({ facade: "blocked", blocked: { code: "im_activation_required", message: "" } }),
      )}
    />
  ))
  expect(screen.getByRole("status").textContent).toBe(dict["settings.im.entitlement.inactive"])
})

it("reports confirmed access without inventing its term from a missing or null expiry", () => {
  const view = render(() => (
    <IMEntitlementSummary observation={observeIMEntitlement(status({ facade: "active", keyOrigin: "stored" }))} />
  ))
  expect(screen.getByRole("status").textContent).toBe(dict["settings.im.entitlement.active"])
  expect(screen.getByText(dict["settings.im.entitlement.expiryUnknown"])).toBeTruthy()
  expect(screen.queryByText(dict["settings.im.entitlement.lifetime"])).toBeNull()
  view.unmount()
  render(() => <IMEntitlementSummary observation={{ state: "active", expiresAt: null }} />)
  expect(screen.getByText(dict["settings.im.entitlement.expiryUnknown"])).toBeTruthy()
})

it("shows explicit expiry or lifetime only when supplied by the observation contract", () => {
  const date = Date.now() + 86_400_000
  const view = render(() => <IMEntitlementSummary observation={{ state: "active", expiresAt: date }} />)
  expect(
    screen.getByText(
      dict["settings.im.entitlement.expiresOn"].replace("{{date}}", new Date(date).toLocaleDateString()),
    ),
  ).toBeTruthy()
  view.unmount()
  const expired = render(() => <IMEntitlementSummary observation={{ state: "active", expiresAt: 0 }} />)
  expect(screen.getByRole("status").textContent).toBe(dict["settings.im.entitlement.expired"])
  expired.unmount()
  render(() => <IMEntitlementSummary observation={{ state: "active", lifetime: true }} />)
  expect(screen.getByText(dict["settings.im.entitlement.lifetime"])).toBeTruthy()
})

it("keeps the new three tiers read-only and opens only the existing homepage on an explicit click", () => {
  render(() => <IMEntitlementSummary observation={{ state: "inactive" }} />)
  const details = screen.getByText(dict["settings.im.entitlement.plans"]).closest("details")!
  expect(details.open).toBe(false)
  fireEvent.click(details.querySelector("summary")!)
  expect(details.open).toBe(true)
  expect(screen.getByText(dict["settings.im.entitlement.planYear"])).toBeTruthy()
  expect(screen.getByText(dict["settings.im.entitlement.planThreeYears"])).toBeTruthy()
  expect(screen.getByText(dict["settings.im.entitlement.planLifetime"])).toBeTruthy()
  expect(screen.getByText(dict["settings.im.entitlement.purchaseUnavailable"])).toBeTruthy()
  expect(screen.queryByRole("button")).toBeNull()
  expect(openLink).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("link", { name: dict["settings.im.entitlement.homepage"] }))
  expect(openLink).toHaveBeenCalledExactlyOnceWith("https://ai.deepagent.ltd/")
})

function authority(patch: Partial<IMEntitlementSchema.Entitlement> = {}): IMEntitlementSchema.Observation {
  return {
    state: "known",
    entitlement: {
      version: "dac-im-entitlement-v1",
      profile: "dac-im-device-v1",
      realm: "https://configured.invalid/im",
      entitlementID: "a".repeat(32),
      deviceJkt: "b".repeat(43),
      bindingVersion: 1,
      uuid: "alice",
      planID: "im-year",
      planVersion: "im-plans-2026-10-19",
      state: "active",
      validityKnown: true,
      lifetime: false,
      validFrom: 1_700_000_000_000,
      expiresAt: 1_731_622_400_000,
      serverObservedAt: 1_710_000_000_000,
      ...patch,
    },
  }
}

it("uses the proved server state and actual expiry without applying the local clock to access", () => {
  const observation = observeIMEntitlement(status({ facade: "active" }), false, authority())
  render(() => <IMEntitlementSummary observation={observation} />)
  expect(screen.getByRole("status").textContent).toBe(dict["settings.im.entitlement.active"])
  expect(
    screen.getByText(
      dict["settings.im.entitlement.expiresOn"].replace("{{date}}", new Date(1_731_622_400_000).toLocaleDateString()),
    ),
  ).toBeTruthy()
  expect(screen.queryByText(dict["settings.im.entitlement.lifetime"])).toBeNull()
})

it("keeps revoked, unsupported, unknown validity and foreign-realm observations truthful", () => {
  const revoked = render(() => (
    <IMEntitlementSummary observation={observeIMEntitlement(status({}), false, authority({ state: "revoked" }))} />
  ))
  expect(screen.getByRole("status").textContent).toBe(dict["settings.im.entitlement.revoked"])
  revoked.unmount()
  const unknown = render(() => (
    <IMEntitlementSummary
      observation={observeIMEntitlement(
        status({}),
        false,
        authority({ validityKnown: false, lifetime: null, validFrom: null, expiresAt: null }),
      )}
    />
  ))
  expect(screen.getByText(dict["settings.im.entitlement.expiryUnknown"])).toBeTruthy()
  expect(screen.queryByText(dict["settings.im.entitlement.lifetime"])).toBeNull()
  unknown.unmount()
  expect(
    observeIMEntitlement(status({ facade: "active" }), false, { state: "unknown", reason: "unsupported" }),
  ).toEqual({ state: "unknown", serviceConfigured: true })
  expect(observeIMEntitlement(status({}), false, authority({ realm: "https://another.invalid/im" }))).toEqual({
    state: "unknown",
    serviceConfigured: true,
  })
})

it("shows the server catalog and opens only its available purchase URL on explicit action", () => {
  openLink.mockClear()
  const catalog: IMEntitlementSchema.Plans = {
    version: "dac-im-plans-v1",
    planVersion: "im-plans-2026-10-19",
    salesAvailable: true,
    serverObservedAt: 1_710_000_000_000,
    purchaseURL: "https://purchase.invalid/console/im",
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
  }
  const view = render(() => (
    <IMEntitlementSummary observation={{ state: "inactive" }} plans={{ state: "known", catalog }} />
  ))
  expect(screen.getByText("9.9 credits · Lifetime · 1 device")).toBeTruthy()
  expect(openLink).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("link", { name: dict["settings.im.entitlement.purchase"] }))
  expect(openLink).toHaveBeenCalledExactlyOnceWith(catalog.purchaseURL)
  view.unmount()
  render(() => (
    <IMEntitlementSummary
      observation={{ state: "inactive" }}
      plans={{ state: "known", catalog: { ...catalog, salesAvailable: false } }}
    />
  ))
  expect(screen.queryByRole("link", { name: dict["settings.im.entitlement.purchase"] })).toBeNull()
  expect(screen.getByText(dict["settings.im.entitlement.purchaseUnavailable"])).toBeTruthy()
})
