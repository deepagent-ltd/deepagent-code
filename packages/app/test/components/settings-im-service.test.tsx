import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { SettingsIMService } from "@/components/settings-v2/im-service"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)

it("saves one normalized HTTPS service and explicitly disables without connecting or activating", async () => {
  const [state, setState] = createStore({ url: "https://trusted.invalid/im" as string | null })
  const save = vi.fn(async (url: string | null) => setState("url", url))
  render(() => (
    <SettingsIMService
      configured={() => state.url}
      service={() => ({ url: state.url, source: "config", reconnectRequired: false })}
      current={() => true}
      save={save}
    />
  ))
  expect(save).not.toHaveBeenCalled()
  const input = screen.getByRole("textbox", { name: dict["settings.im.service.address"] })
  fireEvent.input(input, { target: { value: "https://another.invalid/prefix///" } })
  fireEvent.keyDown(input, { key: "Enter", isComposing: true })
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: dict["settings.im.service.save"] }))
  await screen.findByText(dict["settings.im.service.saved"])
  expect(save.mock.calls).toEqual([["https://another.invalid/prefix"]])
  fireEvent.click(screen.getByRole("button", { name: dict["settings.im.service.disable"] }))
  await screen.findByText(dict["settings.im.service.disabled"])
  expect(save.mock.calls).toEqual([["https://another.invalid/prefix"], [null]])
  expect(screen.getByRole("button", { name: dict["settings.im.service.disable"] }).hasAttribute("disabled")).toBe(true)
})

it("rejects unsafe addresses and exposes a busy service change without changing the original request", async () => {
  const save = vi.fn(async () => {
    throw { data: { code: "im_service_busy" } }
  })
  render(() => (
    <SettingsIMService
      configured={() => undefined}
      service={() => ({ url: null, source: "none", reconnectRequired: false })}
      current={() => true}
      save={save}
    />
  ))
  const input = screen.getByRole("textbox", { name: dict["settings.im.service.address"] })
  for (const value of [
    "http://remote.invalid",
    "https://user:password@trusted.invalid",
    "https://trusted.invalid/?key=x",
    "https://trusted.invalid/#fragment",
  ]) {
    fireEvent.input(input, { target: { value } })
    fireEvent.click(screen.getByRole("button", { name: dict["settings.im.service.save"] }))
    expect(screen.getByRole("alert").textContent).toBe(dict["settings.im.service.invalid"])
  }
  expect(save).not.toHaveBeenCalled()
  fireEvent.input(input, { target: { value: "https://trusted.invalid" } })
  fireEvent.click(screen.getByRole("button", { name: dict["settings.im.service.save"] }))
  await screen.findByText(dict["settings.im.service.busy"])
  expect(save).toHaveBeenCalledTimes(1)
})

it("ignores late save feedback after the settings owner retires", async () => {
  const reply = Promise.withResolvers<void>()
  const [state, setState] = createStore({ current: true })
  const save = vi.fn(() => reply.promise)
  render(() => (
    <SettingsIMService
      configured={() => "https://trusted.invalid"}
      service={() => ({ url: "https://trusted.invalid", source: "environment", reconnectRequired: false })}
      current={() => state.current}
      save={save}
    />
  ))
  fireEvent.click(screen.getByRole("button", { name: dict["settings.im.service.save"] }))
  fireEvent.click(screen.getByRole("button", { name: dict["settings.im.service.save"] }))
  expect(save).toHaveBeenCalledTimes(1)
  setState("current", false)
  reply.resolve()
  await Promise.resolve()
  expect(screen.queryByText(dict["settings.im.service.saved"])).toBeNull()
})
