import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { IMUserSettingsPage } from "@/components/im/user-settings-page"
import type { IMFacadeStatus } from "@/utils/im-client"
import type { IMEntitlementSchema } from "@deepagent-code/core/im/entitlement.schema"
import { dict } from "@/i18n/en"

const runtime = vi.hoisted(() => ({
  model: "deepseek/flash" as string | undefined,
  visible: true,
  notifications: true,
  sound: false,
  rename: vi.fn(),
  retry: vi.fn(),
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string>) =>
      Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{{${name}}}`, value), dict[key]),
  }),
}))
vi.mock("@/utils/im-client", async (original) => ({
  ...(await original<typeof import("@/utils/im-client")>()),
  useIMClient: () => ({ facadeRename: runtime.rename, facadeRetry: runtime.retry }),
}))
vi.mock("@/context/settings", () => ({
  useSettings: () => ({
    notifications: { agent: () => runtime.notifications },
    sounds: { agentEnabled: () => runtime.sound },
  }),
}))
vi.mock("@/context/server-sync", () => ({
  useServerSync: () => ({
    data: {
      config: {
        get im() {
          return { model: runtime.model }
        },
      },
    },
  }),
}))
vi.mock("@/context/models", () => ({
  useModels: () => ({
    list: () => [{ id: "flash", name: "Flash", provider: { id: "deepseek", name: "DeepSeek" } }],
    visible: () => runtime.visible,
  }),
}))
beforeEach(() => {
  runtime.model = "deepseek/flash"
  runtime.visible = true
  runtime.notifications = true
  runtime.sound = false
  runtime.rename.mockReset()
  runtime.retry.mockReset()
})
afterEach(cleanup)

function status(patch: Partial<IMFacadeStatus> = {}): IMFacadeStatus {
  return {
    facade: "active",
    identity: { uuid: "abcdef123456", name: "alice", orgID: 2, orgAllGroupID: "org2" },
    blocked: null,
    kernel: "connected",
    keyOrigin: "stored",
    service: { url: "https://configured.invalid/im", source: "config", reconnectRequired: false },
    ...patch,
  }
}

it("shows only current identity, connection, access, configured model and read-only DAC preferences", () => {
  const manage = vi.fn()
  render(() => (
    <IMUserSettingsPage status={status()} current={() => true} localAvailable onManageIM={manage} onChanged={vi.fn()} />
  ))
  expect(screen.getByText("alice")).toBeTruthy()
  expect(screen.getByText(dict["im.facade.kernel.connected"])).toBeTruthy()
  expect(screen.getByText(dict["settings.im.entitlement.active"])).toBeTruthy()
  expect(screen.getByText("DeepSeek / Flash")).toBeTruthy()
  expect(screen.getByText(dict["im.user.notificationsOn"])).toBeTruthy()
  expect(screen.getByText(dict["im.user.soundsOff"])).toBeTruthy()
  expect(screen.getByText(dict["im.user.followsDAC"])).toBeTruthy()
  expect(screen.queryByText(/abcdef123456/)).toBeNull()
  expect(screen.queryByRole("textbox")).toBeNull()
  expect(screen.queryByRole("switch")).toBeNull()
  expect(screen.queryByRole("button", { name: dict["im.facade.identity.rename"] })).toBeNull()
  expect(screen.getAllByRole("button")).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: dict["im.user.manageIM"] }))
  expect(manage).toHaveBeenCalledTimes(1)
  expect(runtime.rename).not.toHaveBeenCalled()
  expect(runtime.retry).not.toHaveBeenCalled()
})

it("keeps unknown access and unavailable configured models truthful without embedding activation forms", () => {
  runtime.model = "missing/model"
  render(() => <IMUserSettingsPage current={() => true} localAvailable onManageIM={vi.fn()} onChanged={vi.fn()} />)
  expect(screen.getByText(dict["im.user.identityUnknown"])).toBeTruthy()
  expect(screen.getByText(dict["settings.im.entitlement.unknown"])).toBeTruthy()
  expect(screen.getByText(dict["im.user.modelUnknown"])).toBeTruthy()
  expect(screen.queryByText(dict["settings.im.entitlement.active"])).toBeNull()
  expect(screen.queryByText("DeepSeek / Flash")).toBeNull()
  expect(screen.queryByRole("textbox")).toBeNull()
  expect(runtime.rename).not.toHaveBeenCalled()
  expect(runtime.retry).not.toHaveBeenCalled()
})

it("retires identity editing and prevents management after its parent scope is no longer current", async () => {
  const [state, setState] = createStore({ current: true, rename: 0 })
  const manage = vi.fn()
  render(() => (
    <IMUserSettingsPage
      status={status()}
      current={() => state.current}
      localAvailable
      onManageIM={manage}
      onChanged={vi.fn()}
      renameRequest={state.rename}
    />
  ))
  setState("rename", 1)
  await screen.findByPlaceholderText(dict["im.facade.identity.rename.placeholder"])
  setState("current", false)
  expect(screen.queryByText("alice")).toBeNull()
  expect(screen.queryByRole("textbox")).toBeNull()
  const button = screen.getByRole<HTMLButtonElement>("button", { name: dict["im.user.manageIM"] })
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(manage).not.toHaveBeenCalled()
  expect(runtime.rename).not.toHaveBeenCalled()
})

it("opens the existing rename flow only on a contextual request and preserves cancellation and normalized submission", async () => {
  const [state, setState] = createStore({ rename: 0 })
  const changed = vi.fn()
  runtime.rename.mockResolvedValue({})
  render(() => (
    <IMUserSettingsPage
      status={status()}
      current={() => true}
      localAvailable
      onManageIM={vi.fn()}
      onChanged={changed}
      renameRequest={state.rename}
    />
  ))
  expect(screen.queryByRole("textbox")).toBeNull()
  setState("rename", 1)
  fireEvent.keyDown(await screen.findByPlaceholderText(dict["im.facade.identity.rename.placeholder"]), {
    key: "Escape",
  })
  expect(runtime.rename).not.toHaveBeenCalled()
  setState("rename", 2)
  fireEvent.input(await screen.findByPlaceholderText(dict["im.facade.identity.rename.placeholder"]), {
    target: { value: "ALICE2" },
  })
  fireEvent.click(screen.getByRole("button", { name: dict["common.save"] }))
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
  expect(runtime.rename).toHaveBeenCalledExactlyOnceWith("alice2")
  expect(runtime.retry).not.toHaveBeenCalled()
})

it("offers management for activation-required and keeps existing connection recovery explicit", async () => {
  const [state, setState] = createStore({
    status: status({
      facade: "blocked",
      identity: null,
      kernel: null,
      blocked: { code: "im_activation_required", message: "" },
    }),
  })
  const changed = vi.fn()
  runtime.retry.mockResolvedValue({})
  render(() => (
    <IMUserSettingsPage
      status={state.status}
      current={() => true}
      localAvailable
      onManageIM={vi.fn()}
      onChanged={changed}
    />
  ))
  expect(screen.getAllByRole("button")).toHaveLength(1)
  expect(screen.getByRole("button", { name: dict["im.user.manageIM"] })).toBeTruthy()
  expect(runtime.retry).not.toHaveBeenCalled()
  setState(
    "status",
    status({
      facade: "blocked",
      identity: null,
      kernel: null,
      blocked: { code: "im_service_changed", message: "" },
      service: { url: "https://new.invalid/im", source: "config", reconnectRequired: true },
    }),
  )
  fireEvent.click(await screen.findByRole("button", { name: dict["im.facade.reconnect"] }))
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
  expect(runtime.retry).toHaveBeenCalledTimes(1)
  expect(runtime.rename).not.toHaveBeenCalled()
})

it("shows server-confirmed lifetime access and retires it with the parent scope", () => {
  const [state, setState] = createStore({ current: true })
  const entitlement: IMEntitlementSchema.Observation = {
    state: "known",
    entitlement: {
      version: "dac-im-entitlement-v1",
      profile: "dac-im-device-v1",
      realm: "https://configured.invalid/im",
      entitlementID: "a".repeat(32),
      deviceJkt: "b".repeat(43),
      bindingVersion: 1,
      uuid: "alice",
      planID: "im-lifetime",
      planVersion: "im-plans-2026-10-19",
      state: "active",
      validityKnown: true,
      lifetime: true,
      validFrom: 1_700_000_000_000,
      expiresAt: null,
      serverObservedAt: 1_710_000_000_000,
    },
  }
  render(() => (
    <IMUserSettingsPage
      status={status()}
      entitlement={entitlement}
      current={() => state.current}
      localAvailable
      onManageIM={vi.fn()}
      onChanged={vi.fn()}
    />
  ))
  expect(screen.getByText(dict["settings.im.entitlement.lifetime"])).toBeTruthy()
  setState("current", false)
  expect(screen.queryByText(dict["settings.im.entitlement.lifetime"])).toBeNull()
  expect(screen.getByText(dict["settings.im.entitlement.unknown"])).toBeTruthy()
  expect(runtime.rename).not.toHaveBeenCalled()
  expect(runtime.retry).not.toHaveBeenCalled()
})
