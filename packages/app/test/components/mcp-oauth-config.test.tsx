import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { Dialog } from "@kobalte/core/dialog"
import { DialogConfigureMcp } from "@/components/dialog-configure-mcp"
import { DialogAddMcp } from "@/components/dialog-add-mcp"
import { dict } from "@/i18n/en"
import type { McpRemoteConfig } from "@deepagent-code/sdk/client"

const fixture = vi.hoisted(() => ({
  config: undefined as McpRemoteConfig | undefined,
  save: vi.fn(),
  add: vi.fn(),
  close: vi.fn(),
}))
vi.mock("@/context/sync", () => ({ useSync: () => ({ data: { config: { mcp: { fixture: fixture.config } } } }) }))
vi.mock("@/context/mcp", () => ({
  useMcpUpdate: () => ({ isPending: false, mutateAsync: fixture.save }),
  useMcpAdd: () => ({ isPending: false, mutateAsync: fixture.add }),
}))
vi.mock("@deepagent-code/ui/context/dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@deepagent-code/ui/context/dialog")>()),
  useDialog: () => ({ close: fixture.close }),
}))
vi.mock("@deepagent-code/ui/context/i18n", () => ({ useI18n: () => ({ t: () => "Close" }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)
beforeEach(() => {
  fixture.save.mockReset().mockResolvedValue(undefined)
  fixture.add.mockReset().mockResolvedValue(undefined)
  fixture.close.mockReset()
  fixture.config = {
    type: "remote",
    url: "https://mcp.example.test/mcp",
    headers: { "X-Example": "preserved" },
    oauth: { clientId: "fixture-client", clientSecret: "synthetic-private-secret", scope: "read" },
  }
})

it("requires an issuer for an existing secret, saves the pin and preserves hidden credentials", async () => {
  render(() => (
    <Dialog open>
      <DialogConfigureMcp name="fixture" />
    </Dialog>
  ))
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true)
  expect(screen.getByText(dict["dialog.mcp.configure.issuerRequired"])).toBeTruthy()
  expect(document.body.textContent).not.toContain("synthetic-private-secret")
  fireEvent.input(screen.getByLabelText(dict["dialog.mcp.configure.issuer"]), {
    target: { value: "https://auth.example.test/tenant" },
  })
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false)
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(fixture.save).toHaveBeenCalledTimes(1))
  expect(fixture.save).toHaveBeenCalledWith({
    name: "fixture",
    config: {
      ...fixture.config,
      enabled: true,
      timeout: undefined,
      oauth: {
        clientId: "fixture-client",
        clientSecret: "synthetic-private-secret",
        scope: "read",
        expectedIssuer: "https://auth.example.test/tenant",
      },
    },
  })
  expect(fixture.close).toHaveBeenCalledTimes(1)
})

it("keeps unsafe issuer addresses unsavable and never sends a configuration update", () => {
  render(() => (
    <Dialog open>
      <DialogConfigureMcp name="fixture" />
    </Dialog>
  ))
  for (const value of [
    "https://auth.example.test?",
    "https://auth.example.test#",
    "https://user:pass@auth.example.test",
    "file:///tmp/auth",
    "https://auth.example.test/\u0001issuer",
    `https://auth.example.test/${"界".repeat(3000)}`,
  ]) {
    fireEvent.input(screen.getByLabelText(dict["dialog.mcp.configure.issuer"]), { target: { value } })
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByText(dict["dialog.mcp.configure.issuerInvalid"])).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
  }
  expect(fixture.save).not.toHaveBeenCalled()
})

it("shows an actionable error for an empty hidden secret without exposing it", () => {
  fixture.config = {
    ...fixture.config!,
    oauth: { clientId: "fixture", clientSecret: "", expectedIssuer: "https://auth.example.test" },
  }
  render(() => (
    <Dialog open>
      <DialogConfigureMcp name="fixture" />
    </Dialog>
  ))
  expect(screen.getByRole("alert").textContent).toBe(dict["dialog.mcp.configure.secretEmpty"])
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true)
  expect(fixture.save).not.toHaveBeenCalled()
})

it("allows automatic discovery without a secret and preserves the existing client ID", async () => {
  fixture.config = { ...fixture.config!, oauth: { clientId: "public-client" } }
  render(() => (
    <Dialog open>
      <DialogConfigureMcp name="fixture" />
    </Dialog>
  ))
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false)
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() => expect(fixture.save).toHaveBeenCalledTimes(1))
  expect(fixture.save.mock.calls[0][0].config.oauth).toEqual({ clientId: "public-client", expectedIssuer: undefined })
})

it("cancels edited configuration without saving or changing the stored configuration", () => {
  const original = structuredClone(fixture.config)
  render(() => (
    <Dialog open>
      <DialogConfigureMcp name="fixture" />
    </Dialog>
  ))
  fireEvent.input(screen.getByLabelText(dict["dialog.mcp.add.url"]), {
    target: { value: "https://mcp.example.test/unsaved" },
  })
  fireEvent.click(screen.getByRole("button", { name: dict["dialog.mcp.add.cancel"] }))
  expect(fixture.close).toHaveBeenCalledOnce()
  expect(fixture.save).not.toHaveBeenCalled()
  expect(fixture.config).toEqual(original)
})

it.each(["add", "configure"] as const)(
  "a late %s save cannot close a replacement dialog after cancellation",
  async (mode) => {
    const pending = Promise.withResolvers<void>()
    fixture.config = { ...fixture.config!, oauth: false }
    const mutation = mode === "add" ? fixture.add : fixture.save
    mutation.mockReturnValueOnce(pending.promise)
    const view = render(() => (
      <Dialog open>{mode === "add" ? <DialogAddMcp /> : <DialogConfigureMcp name="fixture" />}</Dialog>
    ))
    if (mode === "add") {
      fireEvent.input(screen.getByLabelText(dict["dialog.mcp.add.name"]), { target: { value: "late-local" } })
      fireEvent.input(screen.getByLabelText(dict["dialog.mcp.add.command"]), { target: { value: "node peer.js" } })
    }
    fireEvent.click(
      screen.getByRole("button", {
        name: dict[mode === "add" ? "dialog.mcp.add.submit" : "dialog.mcp.configure.save"],
      }),
    )
    await waitFor(() => expect(mutation).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole("button", { name: dict["dialog.mcp.add.cancel"] }))
    view.unmount()
    render(() => (
      <Dialog open>
        <p>Replacement dialog</p>
      </Dialog>
    ))
    pending.resolve()
    await pending.promise
    await Promise.resolve()
    expect(fixture.close).toHaveBeenCalledOnce()
    expect(screen.getByText("Replacement dialog")).toBeTruthy()
  },
)

it.each([false, true])(
  "adds a remote server with explicit OAuth disabled=%s and leaves other credentials out",
  async (disabled) => {
    render(() => (
      <Dialog open>
        <DialogAddMcp />
      </Dialog>
    ))
    fireEvent.input(screen.getByLabelText(dict["dialog.mcp.add.name"]), { target: { value: "public-peer" } })
    fireEvent.click(screen.getByRole("button", { name: dict["dialog.mcp.add.typeRemote"] }))
    fireEvent.input(screen.getByLabelText(dict["dialog.mcp.add.url"]), {
      target: { value: "https://mcp.example.test/public" },
    })
    const oauth = screen.getByRole("switch", { name: dict["dialog.mcp.configure.oauth"] })
    expect(oauth.getAttribute("aria-checked")).toBe("true")
    if (disabled) fireEvent.click(oauth)
    expect(oauth.getAttribute("aria-checked")).toBe(String(!disabled))
    fireEvent.click(screen.getByRole("button", { name: dict["dialog.mcp.add.submit"] }))
    await waitFor(() => expect(fixture.add).toHaveBeenCalledTimes(1))
    expect(fixture.add).toHaveBeenCalledWith({
      name: "public-peer",
      config: {
        type: "remote",
        url: "https://mcp.example.test/public",
        enabled: true,
        ...(disabled ? { oauth: false } : {}),
      },
    })
    expect(fixture.close).toHaveBeenCalledTimes(1)
  },
)

it("keeps the remote OAuth choice out of a local command and cancels without adding", async () => {
  render(() => (
    <Dialog open>
      <DialogAddMcp />
    </Dialog>
  ))
  fireEvent.input(screen.getByLabelText(dict["dialog.mcp.add.name"]), { target: { value: "local-peer" } })
  fireEvent.click(screen.getByRole("button", { name: dict["dialog.mcp.add.typeRemote"] }))
  fireEvent.click(screen.getByRole("switch", { name: dict["dialog.mcp.configure.oauth"] }))
  fireEvent.click(screen.getByRole("button", { name: dict["dialog.mcp.add.typeLocal"] }))
  expect(screen.queryByRole("switch")).toBeNull()
  fireEvent.input(screen.getByLabelText(dict["dialog.mcp.add.command"]), { target: { value: "node peer.js" } })
  fireEvent.click(screen.getByRole("button", { name: dict["dialog.mcp.add.submit"] }))
  await waitFor(() =>
    expect(fixture.add).toHaveBeenCalledWith({
      name: "local-peer",
      config: { type: "local", command: ["node", "peer.js"], enabled: true },
    }),
  )
  expect(fixture.close).toHaveBeenCalledTimes(1)
  cleanup()
  fixture.add.mockClear()
  fixture.close.mockClear()
  render(() => (
    <Dialog open>
      <DialogAddMcp />
    </Dialog>
  ))
  fireEvent.click(screen.getByRole("button", { name: dict["dialog.mcp.add.cancel"] }))
  expect(fixture.close).toHaveBeenCalledTimes(1)
  expect(fixture.add).not.toHaveBeenCalled()
})
