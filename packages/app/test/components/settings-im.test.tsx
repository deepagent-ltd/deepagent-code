import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { SettingsIMV2 } from "@/components/settings-v2/im"
import type { IMActivationClient } from "@/components/im/activation-controller"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({
  scope: (): string => "original",
  local: () => true,
  config: () => ({ model: "ordinary/model", im: { model: "deepseek/deepseek-flash" } }),
  update: async (_config: { im: { model: string } }) => {},
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@/context/server", () => ({
  useServer: () => ({ scope: wiring.scope }),
  ServerConnection: { local: wiring.local },
}))
vi.mock("@/context/server-sdk", () => ({
  useServerSDK: () => ({
    scope: "original",
    client: {
      client: {
        request: async (input: { url: string }) => ({
          data:
            input.url === "/api/v1/im/device/info"
              ? {
                  profile: "dac-im-device-v1",
                  storeAvailable: true,
                  deviceJkt: "a".repeat(43),
                  publicJwk: { kty: "EC", crv: "P-256", x: "b".repeat(43), y: "c".repeat(43) },
                }
              : { migration: null },
        }),
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
afterEach(cleanup)
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
  const patches: { im: { model: string } }[] = []
  wiring.update = async (patch) => {
    patches.push(patch)
    setState("config", "im", patch.im)
  }
  render(() => <SettingsIMV2 activation={api} />)
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
  render(() => <SettingsIMV2 activation={api} />)
  expect(screen.getByText(dict["im.activation.localOnly"])).toBeTruthy()
  expect(api.activationPending).not.toHaveBeenCalled()
  expect(api.activate).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})
