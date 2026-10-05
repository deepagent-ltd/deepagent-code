import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { Dialog } from "@kobalte/core/dialog"
import userEvent from "@testing-library/user-event"
import { ClaimCard, BlockedCard, IdentityCard } from "@/components/im/facade-cards"
import { RebindDialog, KernelGroupDialog } from "@/components/im/facade-dialogs"
import { dict } from "@/i18n/en"

const client = vi.hoisted(() => ({
  facadeClaim: vi.fn(),
  facadeRetry: vi.fn(),
  facadeRename: vi.fn(),
  facadeRebind: vi.fn(),
  facadeResolve: vi.fn(),
  facadeCreateGroup: vi.fn(),
}))
const dialog = vi.hoisted(() => ({ close: vi.fn(), show: vi.fn() }))

vi.mock("@/utils/im-client", () => ({ useIMClient: () => client }))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values?: Record<string, string>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, value), dict[key]),
  }),
}))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => dialog }))
vi.mock("@deepagent-code/ui/context/i18n", () => ({ useI18n: () => ({ t: () => "Close" }) }))

beforeEach(() => {
  Object.values(client).forEach((fn) => fn.mockReset())
  Object.values(dialog).forEach((fn) => fn.mockReset())
})
afterEach(cleanup)

describe("IM identity components", () => {
  it("keeps an IME confirmation local and only submits after composition ends", async () => {
    const done = vi.fn()
    client.facadeClaim.mockResolvedValue({})
    render(() => <ClaimCard onClaimed={done} />)
    const input = screen.getByPlaceholderText(dict["im.facade.claim.name.placeholder"])
    fireEvent.input(input, { target: { value: "张三" } })
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 })
    expect(client.facadeClaim).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(client.facadeClaim).toHaveBeenCalledWith("张三")
  })

  it("admits one claim while pending and preserves the name on a recoverable error", async () => {
    const pending = Promise.withResolvers<unknown>()
    client.facadeClaim.mockReturnValue(pending.promise)
    const done = vi.fn()
    render(() => <ClaimCard onClaimed={done} />)
    const input = screen.getByPlaceholderText(dict["im.facade.claim.name.placeholder"])
    fireEvent.input(input, { target: { value: "alice" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(client.facadeClaim).toHaveBeenCalledTimes(1)
    pending.reject({ code: "im_name_taken", message: "internal details" })
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(dict["im.facade.error.im_name_taken"]))
    expect((input as HTMLInputElement).value).toBe("alice")
    expect(done).not.toHaveBeenCalled()
    client.facadeClaim.mockResolvedValue({})
    fireEvent.input(input, { target: { value: "alice2" } })
    fireEvent.click(screen.getByRole("button", { name: dict["im.facade.claim.submit"] }))
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
  })

  it("rejects invalid names without calling the platform", async () => {
    render(() => <ClaimCard onClaimed={vi.fn()} />)
    fireEvent.input(screen.getByPlaceholderText(dict["im.facade.claim.name.placeholder"]), {
      target: { value: "alice@example" },
    })
    fireEvent.click(screen.getByRole("button", { name: dict["im.facade.claim.submit"] }))
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(client.facadeClaim).not.toHaveBeenCalled()
  })

  it("retries a blocked connection once and preserves the error until recovery", async () => {
    const pending = Promise.withResolvers<unknown>()
    client.facadeRetry.mockReturnValue(pending.promise)
    const recovered = vi.fn()
    render(() => (
      <BlockedCard blocked={{ code: "im_kernel_error", message: "private upstream detail" }} onRecovered={recovered} />
    ))
    fireEvent.click(screen.getByRole("button", { name: dict["im.facade.retry"] }))
    expect(screen.getByRole("button", { name: dict["im.facade.retrying"] }).hasAttribute("disabled")).toBe(true)
    pending.resolve({})
    await waitFor(() => expect(recovered).toHaveBeenCalledTimes(1))
    expect(client.facadeRetry).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("private upstream detail")).toBeNull()
  })

  it("renames through the active identity card and lets Escape cancel without a request", async () => {
    const user = userEvent.setup()
    client.facadeRename.mockResolvedValue({})
    const changed = vi.fn()
    render(() => (
      <IdentityCard
        status={{
          facade: "active",
          identity: { uuid: "abcdef123456", name: "alice", orgID: 2, orgAllGroupID: "org2" },
          blocked: null,
          kernel: "connected",
          keyOrigin: "stored",
        }}
        onChanged={changed}
      />
    ))
    fireEvent.click(screen.getByRole("button", { name: dict["im.facade.identity.rename"] }))
    fireEvent.keyDown(screen.getByPlaceholderText(dict["im.facade.identity.rename.placeholder"]), { key: "Escape" })
    expect(client.facadeRename).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: dict["im.facade.identity.rename"] }))
    const input = screen.getByPlaceholderText(dict["im.facade.identity.rename.placeholder"])
    fireEvent.input(input, { target: { value: "ALICE2" } })
    fireEvent.blur(input)
    await user.click(screen.getByRole("button", { name: dict["common.save"] }))
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(client.facadeRename).toHaveBeenCalledWith("alice2")
  })

  it("directs a revoked identity to console inheritance instead of an unauthenticated rebind", () => {
    render(() => <BlockedCard blocked={{ code: "im_key_invalid", message: "expired" }} onRecovered={vi.fn()} />)
    expect(screen.getByText(dict["im.facade.blocked.recovery"])).toBeTruthy()
    expect(screen.queryByRole("button", { name: dict["im.facade.identity.rebind"] })).toBeNull()
  })
})

describe("IM facade dialogs", () => {
  it("masks a new key and never renders it from a server error", async () => {
    const secret = "sk-component-test-secret"
    client.facadeRebind.mockRejectedValue(Object.assign(new Error(secret), { code: "im_key_invalid" }))
    render(() => (
      <Dialog open>
        <RebindDialog onRebound={vi.fn()} />
      </Dialog>
    ))
    const input = screen.getByPlaceholderText(dict["im.facade.rebind.placeholder"])
    expect((input as HTMLInputElement).type).toBe("password")
    fireEvent.input(input, { target: { value: secret } })
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    expect(client.facadeRebind).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(document.body.textContent).not.toContain(secret)
    expect(dialog.close).not.toHaveBeenCalled()
  })

  it("resolves and deduplicates members before creating a group", async () => {
    client.facadeResolve.mockResolvedValue({ uuid: "bob-uuid", name: "bob" })
    client.facadeCreateGroup.mockResolvedValue({ id: "group-1", name: "team" })
    const created = vi.fn()
    render(() => (
      <Dialog open>
        <KernelGroupDialog onCreated={created} />
      </Dialog>
    ))
    const member = screen.getByPlaceholderText(dict["im.facade.group.members.placeholder"])
    fireEvent.input(member, { target: { value: "BOB" } })
    fireEvent.keyDown(member, { key: "Enter", isComposing: true })
    expect(client.facadeResolve).not.toHaveBeenCalled()
    fireEvent.keyDown(member, { key: "Enter" })
    await waitFor(() => expect((member as HTMLInputElement).value).toBe(""))
    fireEvent.input(member, { target: { value: "bob" } })
    fireEvent.keyDown(member, { key: "Enter" })
    await waitFor(() => expect((member as HTMLInputElement).value).toBe(""))
    fireEvent.input(screen.getByPlaceholderText(dict["im.group.create.placeholder"]), { target: { value: "team" } })
    fireEvent.click(screen.getByRole("button", { name: dict["im.group.create"] }))
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1))
    expect(client.facadeCreateGroup).toHaveBeenCalledWith("team", ["bob"])
    expect(dialog.close).toHaveBeenCalledTimes(1)
  })

  it("does not silently omit a typed member when creating a group", async () => {
    const pending = Promise.withResolvers<{ uuid: string; name: string }>()
    client.facadeResolve.mockReturnValue(pending.promise)
    render(() => (
      <Dialog open>
        <KernelGroupDialog onCreated={vi.fn()} />
      </Dialog>
    ))
    fireEvent.input(screen.getByPlaceholderText(dict["im.group.create.placeholder"]), { target: { value: "team" } })
    const member = screen.getByPlaceholderText(dict["im.facade.group.members.placeholder"])
    fireEvent.input(member, { target: { value: "bob" } })
    const create = screen.getByRole("button", { name: dict["im.group.create"] })
    expect(create.hasAttribute("disabled")).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: dict["im.facade.group.members.add"] }))
    fireEvent.keyDown(member, { key: "Enter" })
    expect(client.facadeResolve).toHaveBeenCalledTimes(1)
    expect(create.hasAttribute("disabled")).toBe(true)
    pending.resolve({ uuid: "bob-uuid", name: "bob" })
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false))
    expect(client.facadeCreateGroup).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Remove bob" }))
    expect(screen.queryByRole("button", { name: "Remove bob" })).toBeNull()
  })
})
