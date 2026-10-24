import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { Config } from "@deepagent-code/sdk/client"
import { IMEntitlementSchema } from "@deepagent-code/core/im/entitlement.schema"
import { Schema } from "effect"
import { SettingsIMV2 } from "@/components/settings-v2/im"
import type { IMActivationClient } from "@/components/im/activation-controller"
import type { IMFacadeStatus } from "@/utils/im-client"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({
  scope: (): string => "original",
  local: () => true,
  config: (): Config => ({ model: "ordinary/model", im: { model: "deepseek/deepseek-flash" } }),
  update: async (_config: Config) => {},
  configReads: 0,
  deviceReads: 0,
  facade: "disabled" as IMFacadeStatus["facade"],
  entitlementReads: 0,
  entitlement: { state: "unknown", reason: "unsupported" } as IMEntitlementSchema.Observation,
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
        dict[key],
      ),
  }),
}))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ openLink: vi.fn() }) }))
vi.mock("@/context/server", () => ({
  useServer: () => ({ scope: wiring.scope }),
  ServerConnection: { local: wiring.local },
}))
vi.mock("@/context/server-sdk", () => ({
  useServerSDK: () => ({
    scope: "original",
    client: {
      im: {
        entitlement: async () => {
          wiring.entitlementReads++
          return { data: wiring.entitlement }
        },
        plans: async () => ({ data: { state: "unknown", reason: "unsupported" } }),
        facade: {
          status: async () => ({
            data: {
              facade: wiring.facade,
              identity: null,
              blocked: null,
              kernel: null,
              keyOrigin: "none",
              service: {
                url:
                  wiring.config().im?.url === null
                    ? null
                    : (wiring.config().im?.url ?? "https://configured.invalid/im"),
                source: "config",
                reconnectRequired: false,
              },
            },
          }),
        },
      },
      global: {
        config: {
          get: async () => {
            wiring.configReads++
            return { data: wiring.config() }
          },
        },
      },
      client: {
        request: async (input: { url: string }) => {
          wiring.deviceReads++
          return {
            data:
              input.url === "/api/v1/im/device/info"
                ? {
                    profile: "dac-im-device-v1",
                    storeAvailable: true,
                    deviceJkt: "a".repeat(43),
                    publicJwk: { kty: "EC", crv: "P-256", x: "b".repeat(43), y: "c".repeat(43) },
                  }
                : { migration: null },
          }
        },
      },
    },
  }),
}))
vi.mock("@/context/server-sync", () => ({
  useServerSync: () => ({
    data: {
      get config() {
        return wiring.config()
      },
    },
    updateConfig: wiring.update,
    refreshProviders: vi.fn(),
    queryOptions: { globalConfig: () => ({ queryKey: ["settings-im-config"] }) },
  }),
}))
vi.mock("@/context/models", () => ({
  useModels: () => ({
    list: () => [
      {
        id: "deepseek-flash",
        name: "Flash",
        provider: {
          id: "deepseek",
          name: "DeepSeek",
          get apiKey() {
            throw new Error("The model UI must not read credentials")
          },
        },
      },
      { id: "disabled", name: "Disabled", provider: { id: "deepseek", name: "DeepSeek" } },
      { id: "another", name: "Another", provider: { id: "deepseek", name: "DeepSeek" } },
    ],
    visible: (model: { modelID: string }) => model.modelID !== "disabled",
  }),
}))
beforeEach(() => {
  wiring.facade = "disabled"
  wiring.entitlementReads = 0
  wiring.entitlement = { state: "unknown", reason: "unsupported" }
})
afterEach(cleanup)
function settings(api: IMActivationClient) {
  const query = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } })
  return render(() => (
    <QueryClientProvider client={query}>
      <SettingsIMV2 activation={api} />
    </QueryClientProvider>
  ))
}
function client() {
  const scope = {}
  return {
    scope: () => scope,
    activationPending: vi.fn<IMActivationClient["activationPending"]>(async () => null),
    activationQuote: vi.fn<IMActivationClient["activationQuote"]>(async () => ({
      quoteID: "quote",
      priceCredits: 1,
      quotaCost: 500000,
      expiresAt: Date.now() + 60_000,
      entitlementExpiresAt: null,
    })),
    activate: vi.fn<IMActivationClient["activate"]>(),
    activationStatus: vi.fn<IMActivationClient["activationStatus"]>(),
  } satisfies IMActivationClient
}

it("the real settings wiring writes only im.model from visible configured models and never purchases on mount", async () => {
  const api = client()
  const [state, setState] = createStore({
    config: { model: "ordinary/model", im: { model: "deepseek/deepseek-flash" } },
  })
  wiring.scope = () => "original"
  wiring.local = () => true
  wiring.config = () => state.config
  const patches: Config[] = []
  wiring.update = async (patch) => {
    patches.push(patch)
    if (patch.im?.model) setState("config", "im", "model", patch.im.model)
  }
  settings(api)
  expect(screen.getByLabelText(dict["im.activation.code"])).toHaveProperty("disabled", true)
  expect(api.activationQuote).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole("button", { name: dict["settings.im.service.checkDevice"] }))
  await waitFor(() => expect(api.activationQuote).toHaveBeenCalledTimes(1))
  const trigger = screen.getByRole("button", { name: "DeepSeek / Flash" })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  await screen.findByRole("option", { name: "DeepSeek / Another" })
  expect(screen.queryByRole("option", { name: "DeepSeek / Disabled" })).toBeNull()
  fireEvent.click(screen.getByRole("option", { name: "DeepSeek / Another" }))
  await screen.findByText(dict["settings.im.model.saved"])
  expect(patches).toEqual([{ im: { model: "deepseek/another" } }])
  expect(state.config.model).toBe("ordinary/model")
  expect(api.activate).not.toHaveBeenCalled()
})

it("nonlocal or retired settings cannot mount activation, read a payment credential or save an IM model", () => {
  const api = client()
  wiring.scope = () => "other-server"
  wiring.local = () => true
  const update = vi.fn()
  wiring.update = update
  settings(api)
  expect(screen.getByText(dict["im.activation.localOnly"])).toBeTruthy()
  expect(api.activationPending).not.toHaveBeenCalled()
  expect(api.activate).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})

it("confirms an edited service with a real config read before remounting and never probes or activates on save", async () => {
  const api = client()
  const [state, setState] = createStore({
    config: { im: { model: "deepseek/deepseek-flash", url: "https://old.invalid/im" as string | null } },
  })
  wiring.scope = () => "original"
  wiring.local = () => true
  wiring.config = () => state.config
  wiring.configReads = 0
  wiring.deviceReads = 0
  const patches: Config[] = []
  wiring.update = async (patch) => {
    patches.push(patch)
    if (patch.im?.url !== undefined) setState("config", "im", "url", patch.im.url)
    if (patch.im?.model) setState("config", "im", "model", patch.im.model)
  }
  settings(api)
  await screen.findByRole("button", { name: dict["settings.im.service.checkDevice"] })
  expect(wiring.deviceReads).toBe(0)
  expect(api.activationQuote).not.toHaveBeenCalled()
  const address = screen.getByRole("textbox", { name: dict["settings.im.service.address"] })
  fireEvent.input(address, { target: { value: "https://new.invalid/prefix/" } })
  fireEvent.click(screen.getByRole("button", { name: dict["settings.im.service.save"] }))
  await screen.findByText(dict["settings.im.service.saved"])
  expect(patches).toEqual([{ im: { model: "deepseek/deepseek-flash", url: "https://new.invalid/prefix" } }])
  expect(wiring.configReads).toBe(1)
  expect(wiring.deviceReads).toBe(0)
  expect(api.activationQuote).not.toHaveBeenCalled()
  expect(api.activate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: dict["settings.im.service.checkDevice"] }))
  await waitFor(() => expect(api.activationQuote).toHaveBeenCalledTimes(1))
  fireEvent.input(screen.getByRole("textbox", { name: dict["im.activation.name"] }), {
    target: { value: "own-test-name" },
  })
  fireEvent.click(screen.getByRole("button", { name: dict["settings.im.service.disable"] }))
  await screen.findByText(dict["settings.im.service.disabled"])
  expect(wiring.configReads).toBe(2)
  expect(state.config.im.url).toBeNull()
  expect(screen.getByRole("textbox", { name: dict["im.activation.name"] })).toHaveProperty("disabled", true)
  expect(screen.getByText(dict["settings.im.entitlement.serviceRequired"])).toBeTruthy()
  expect(screen.queryByRole("button", { name: dict["settings.im.service.checkDevice"] })).toBeNull()
  expect(api.activate).not.toHaveBeenCalled()
  const model = screen.getByRole("button", { name: "DeepSeek / Flash" })
  model.focus()
  fireEvent.keyDown(model, { key: "ArrowDown" })
  fireEvent.click(await screen.findByRole("option", { name: "DeepSeek / Another" }))
  await screen.findByText(dict["settings.im.model.saved"])
  expect(patches.at(-1)).toEqual({ im: { model: "deepseek/another", url: null } })
})

it("does not infer current access from an active facade when the authority query is unsupported", async () => {
  const api = client()
  wiring.scope = () => "original"
  wiring.local = () => true
  wiring.config = () => ({ im: { url: "https://configured.invalid/im" } })
  wiring.facade = "active"
  settings(api)
  await waitFor(() => expect(wiring.entitlementReads).toBe(1))
  await screen.findByText(dict["settings.im.entitlement.unknown"])
  expect(screen.queryByText(dict["settings.im.entitlement.lifetime"])).toBeNull()
  expect(screen.queryByRole("button", { name: dict["im.activation.charge"] })).toBeNull()
  expect(api.activationPending).not.toHaveBeenCalled()
  expect(api.activationQuote).not.toHaveBeenCalled()
  expect(api.activate).not.toHaveBeenCalled()
})

it("renders authoritative access and expiry, then refreshes read-only without loading a payment or device identity", async () => {
  const api = client()
  wiring.scope = () => "original"
  wiring.local = () => true
  wiring.config = () => ({ im: { url: "https://configured.invalid/im" } })
  wiring.deviceReads = 0
  wiring.entitlement = {
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
    },
  }
  expect(Schema.decodeUnknownSync(IMEntitlementSchema.Observation)(wiring.entitlement).state).toBe("known")
  settings(api)
  await screen.findByText(dict["settings.im.entitlement.active"])
  expect(
    screen.getByText(
      dict["settings.im.entitlement.expiresOn"].replace("{{date}}", new Date(1_731_622_400_000).toLocaleDateString()),
    ),
  ).toBeTruthy()
  expect(screen.queryByLabelText(dict["im.activation.code"])).toBeNull()
  wiring.entitlement = { state: "unknown", reason: "service_unavailable" }
  fireEvent.click(screen.getByRole("button", { name: dict["settings.im.entitlement.refresh"] }))
  await waitFor(() => expect(wiring.entitlementReads).toBe(2))
  await screen.findByText(dict["settings.im.entitlement.unknown"])
  expect(screen.queryByText(dict["settings.im.entitlement.active"])).toBeNull()
  expect(wiring.deviceReads).toBe(0)
  expect(api.activationPending).not.toHaveBeenCalled()
  expect(api.activationQuote).not.toHaveBeenCalled()
  expect(api.activate).not.toHaveBeenCalled()
})
