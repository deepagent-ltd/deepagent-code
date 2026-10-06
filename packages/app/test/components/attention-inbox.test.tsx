import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import type { AttentionItem, AttentionList } from "@deepagent-code/sdk/client"
import { DialogAttention } from "@/components/dialog-attention"
import { dict } from "@/i18n/en"

const api = vi.hoisted(() => ({ capability: vi.fn(), list: vi.fn(), get: vi.fn(), seen: vi.fn() }))
const connection = vi.hoisted(() => ({ key: (): string => "server-a" }))
vi.mock("@/context/server-sdk", () => ({ useServerSDK: () => ({ client: { v2: { attention: api } } }) }))
vi.mock("@/context/server", () => ({
  useServer: () => ({
    get key() {
      return connection.key()
    },
  }),
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    intl: () => "en",
    t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
  }),
}))
vi.mock("@deepagent-code/ui/context/i18n", () => ({ useI18n: () => ({ t: () => "Close" }) }))

const item = (id = "recovery-1", patch: Partial<AttentionItem> = {}): AttentionItem => ({
  id,
  revision: "revision-1",
  kind: "execution_recovery",
  state: "recovery_required",
  reasonCode: "recovery_required",
  occurredAt: null,
  observedAt: 2000,
  session: {
    id: "session-remote",
    title: "Other project session",
    projectID: "project-remote",
    directory: "/projects/other",
    workspaceID: null,
  },
  source: { activityID: "activity-1" },
  seen: false,
  seenAt: null,
  ...patch,
})
const page = (data = [item()], nextCursor?: string): AttentionList => ({
  data,
  nextCursor,
  asOf: 2000,
  scope: "implicit-local",
  unseenCount: data.filter((entry) => !entry.seen).length,
})
const success = <T,>(data: T) => ({ data, response: { status: 200 } })
const open = (onOpenSession = vi.fn()) =>
  render(() => (
    <Dialog open>
      <DialogAttention onOpenSession={onOpenSession} />
    </Dialog>
  ))
const refresh = () => fireEvent.click(screen.getByRole("button", { name: dict["attention.refresh"] }))

beforeEach(() => {
  Object.values(api).forEach((method) => method.mockReset())
  connection.key = () => "server-a"
  api.capability.mockResolvedValue(
    success({ enabled: true, scope: "implicit-local", actor: "server", reason: "enabled" }),
  )
  api.list.mockResolvedValue(success(page()))
  api.get.mockResolvedValue(success({ data: item() }))
  api.seen.mockResolvedValue(success({ data: item("recovery-1", { seen: true, seenAt: 3000 }) }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("renders real dialog controls and opens the server-provided cross-project session without marking viewed", async () => {
  const navigate = vi.fn()
  open(navigate)
  expect(await screen.findByRole("dialog", { name: dict["attention.title"] })).toBeTruthy()
  await screen.findByText("Other project session")
  expect(screen.getByText(dict["attention.timeUnknown"])).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: dict["attention.details"] }))
  await screen.findByText(dict["attention.reason.recovery_required"])
  expect(api.seen).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: dict["attention.openSession"] }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(item().session))
  expect(api.get).toHaveBeenCalledWith({ itemID: "recovery-1" })
  expect(api.seen).not.toHaveBeenCalled()
})

it("marks only the explicit observed revision and keeps recovery visible after viewing", async () => {
  open()
  await screen.findByText("Other project session")
  api.list.mockResolvedValue(success(page([item("recovery-1", { seen: true, seenAt: 3000 })])))
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  await screen.findByText(dict["attention.seen"])
  expect(api.seen).toHaveBeenCalledExactlyOnceWith({ itemID: "recovery-1", revision: "revision-1" })
  expect(screen.getByText(dict["attention.state.recovery_required"])).toBeTruthy()
  expect(screen.getByRole("button", { name: dict["attention.markSeen"] }).hasAttribute("disabled")).toBe(true)
})

it.each(["profile_disabled", "unsupported_host"])(
  "shows disabled capability %s without fetching the list",
  async (reason) => {
    api.capability.mockResolvedValue(success({ enabled: false, scope: "implicit-local", actor: "server", reason }))
    open()
    await screen.findByText(
      dict[reason === "profile_disabled" ? "attention.disabled.profile" : "attention.disabled.host"],
    )
    expect(api.list).not.toHaveBeenCalled()
    expect(api.seen).not.toHaveBeenCalled()
  },
)

it("treats an older server's missing capability as unsupported", async () => {
  api.capability.mockResolvedValue({ error: {}, response: { status: 404 } })
  open()
  await screen.findByText(dict["attention.disabled.host"])
  expect(api.list).not.toHaveBeenCalled()
})

it("offers retry on initial failure and preserves stale results after a later failure", async () => {
  api.list.mockRejectedValueOnce(new Error("network"))
  open()
  await screen.findByText(dict["attention.loadError"])
  expect(screen.queryByText(dict["attention.empty"])).toBeNull()
  refresh()
  await screen.findByText("Other project session")
  api.list.mockRejectedValueOnce(new Error("network"))
  refresh()
  await screen.findByText(dict["attention.stale"])
  expect(screen.getByText("Other project session")).toBeTruthy()
})

it("sends type and viewed filters to the backend and ignores the older filter response", async () => {
  open()
  await screen.findByText("Other project session")
  const older = Promise.withResolvers<ReturnType<typeof success<AttentionList>>>()
  api.list.mockReturnValueOnce(older.promise)
  fireEvent.change(screen.getByRole("combobox", { name: dict["attention.filter.kind"] }), {
    target: { value: "activity_failed" },
  })
  api.list.mockResolvedValueOnce(success(page([])))
  fireEvent.change(screen.getByRole("combobox", { name: dict["attention.filter.view"] }), {
    target: { value: "unseen" },
  })
  await screen.findByText(dict["attention.empty"])
  expect(api.list).toHaveBeenLastCalledWith({ kind: "activity_failed", view: "unseen", cursor: undefined, limit: "30" })
  older.resolve(success(page([item("old-result")])))
  await Promise.resolve()
  expect(screen.queryByText("Other project session")).toBeNull()
})

it("loads another page and refreshes the loaded pages without collapsing the list", async () => {
  const second = item("recovery-2", { session: { ...item().session, title: "Second page session" } })
  api.list.mockImplementation((query) =>
    Promise.resolve(success(query.cursor ? page([second]) : page([item()], "cursor-2"))),
  )
  open()
  fireEvent.click(await screen.findByRole("button", { name: dict["attention.more"] }))
  await screen.findByText("Second page session")
  expect(screen.getAllByRole("listitem")).toHaveLength(2)
  refresh()
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(4))
  expect(screen.getAllByRole("listitem")).toHaveLength(2)
  expect(api.list).toHaveBeenLastCalledWith({ kind: undefined, view: "all", cursor: "cursor-2", limit: "30" })
})

it("clears a previous cursor when a refreshed server response omits pagination", async () => {
  api.list.mockResolvedValueOnce(success(page([item()], "cursor-2")))
  open()
  await screen.findByRole("button", { name: dict["attention.more"] })
  const final = page()
  Reflect.deleteProperty(final, "nextCursor")
  api.list.mockResolvedValueOnce(success(final))
  refresh()
  await waitFor(() => expect(screen.queryByRole("button", { name: dict["attention.more"] })).toBeNull())
  expect(screen.getAllByRole("listitem")).toHaveLength(1)
})

it("refetches a conflicting receipt and requires another explicit mark for the new revision", async () => {
  open()
  await screen.findByText("Other project session")
  fireEvent.click(screen.getByRole("button", { name: dict["attention.details"] }))
  await screen.findByText(dict["attention.reason.recovery_required"])
  const newer = item("recovery-1", {
    revision: "revision-2",
    state: "authority_conflict",
    reasonCode: "authority_conflict",
  })
  api.seen.mockResolvedValueOnce({ error: {}, response: { status: 409 } })
  api.get.mockResolvedValue(success({ data: newer }))
  api.list.mockResolvedValue(success(page([newer])))
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  await screen.findByText(dict["attention.changed"])
  await screen.findByText(dict["attention.reason.authority_conflict"])
  expect(api.seen).toHaveBeenCalledTimes(1)
  expect(api.get).toHaveBeenCalledTimes(2)
  expect(screen.queryByText(dict["attention.seen"])).toBeNull()
})

it("clears data on server change and rejects late detail, list and receipt responses", async () => {
  const [key, setKey] = createSignal("server-a")
  connection.key = key
  const navigate = vi.fn()
  open(navigate)
  await screen.findByText("Other project session")
  const lateList = Promise.withResolvers<ReturnType<typeof success<AttentionList>>>()
  const lateDetail = Promise.withResolvers<ReturnType<typeof success<{ data: AttentionItem }>>>()
  const lateSeen = Promise.withResolvers<ReturnType<typeof success<{ data: AttentionItem }>>>()
  api.list.mockReturnValueOnce(lateList.promise)
  api.get.mockReturnValueOnce(lateDetail.promise)
  api.seen.mockReturnValueOnce(lateSeen.promise)
  refresh()
  fireEvent.click(screen.getByRole("button", { name: dict["attention.openSession"] }))
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  setKey("server-b")
  await screen.findByText(dict["attention.serverChanged"])
  lateList.resolve(success(page()))
  lateDetail.resolve(success({ data: item() }))
  lateSeen.resolve(success({ data: item("recovery-1", { seen: true }) }))
  await Promise.all([lateList.promise, lateDetail.promise, lateSeen.promise])
  expect(screen.queryByText("Other project session")).toBeNull()
  expect(navigate).not.toHaveBeenCalled()
  expect(api.capability).toHaveBeenCalledTimes(1)
})

it("polls only while mounted, retains details, and clears the five-second interval on close", async () => {
  const interval = vi.spyOn(globalThis, "setInterval")
  const clear = vi.spyOn(globalThis, "clearInterval")
  const rendered = open()
  await screen.findByText("Other project session")
  fireEvent.click(screen.getByRole("button", { name: dict["attention.details"] }))
  await screen.findByText(dict["attention.reason.recovery_required"])
  const focus = screen.getByRole("button", { name: dict["attention.openSession"] })
  focus.focus()
  const newer = item("recovery-1", {
    revision: "revision-2",
    state: "authority_conflict",
    reasonCode: "authority_conflict",
  })
  api.list.mockResolvedValue(success(page([newer])))
  const index = interval.mock.calls.findIndex((entry) => entry[1] === 5000)
  expect(index).toBeGreaterThanOrEqual(0)
  const tick = interval.mock.calls[index][0]
  if (typeof tick !== "function") throw new Error("Expected interval callback")
  tick()
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
  await screen.findByText(dict["attention.reason.authority_conflict"])
  expect(within(screen.getByRole("listitem")).getByText(dict["attention.state.authority_conflict"])).toBeTruthy()
  expect(document.activeElement).toBe(focus)
  expect(api.seen).not.toHaveBeenCalled()
  rendered.unmount()
  expect(clear).toHaveBeenCalledWith(interval.mock.results[index].value)
})

it("removes a successfully viewed item from the unseen filter even if the follow-up refresh fails", async () => {
  open()
  await screen.findByText("Other project session")
  fireEvent.change(screen.getByRole("combobox", { name: dict["attention.filter.view"] }), {
    target: { value: "unseen" },
  })
  await screen.findByText("Other project session")
  api.list.mockRejectedValueOnce(new Error("network"))
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  await screen.findByText(dict["attention.stale"])
  expect(screen.queryByText("Other project session")).toBeNull()
  expect(screen.getByText(/0 not viewed/)).toBeTruthy()
  expect(api.seen).toHaveBeenCalledTimes(1)
})

it("does not navigate a vanished item and refetches after its 404", async () => {
  const navigate = vi.fn()
  open(navigate)
  await screen.findByText("Other project session")
  api.get.mockResolvedValueOnce({ error: {}, response: { status: 404 } })
  api.list.mockResolvedValue(success(page([])))
  fireEvent.click(screen.getByRole("button", { name: dict["attention.openSession"] }))
  await screen.findByText(dict["attention.changed"])
  await screen.findByText(dict["attention.empty"])
  expect(navigate).not.toHaveBeenCalled()
  expect(api.seen).not.toHaveBeenCalled()
})

it("does not reduce another filter's count when an older viewed receipt arrives after switching type", async () => {
  open()
  await screen.findByText("Other project session")
  const pending = Promise.withResolvers<ReturnType<typeof success<{ data: AttentionItem }>>>()
  api.seen.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  const failed = item("failed-1", {
    kind: "activity_failed",
    state: "failed",
    reasonCode: "activity_failed",
    session: { ...item().session, title: "Failed execution" },
  })
  api.list.mockResolvedValueOnce(success(page([failed])))
  fireEvent.change(screen.getByRole("combobox", { name: dict["attention.filter.kind"] }), {
    target: { value: "activity_failed" },
  })
  await screen.findByText("Failed execution")
  api.list.mockRejectedValueOnce(new Error("network"))
  pending.resolve(success({ data: item("recovery-1", { seen: true, seenAt: 3000 }) }))
  await screen.findByText(dict["attention.stale"])
  expect(screen.getByText(/1 not viewed/)).toBeTruthy()
  expect(screen.getByText("Failed execution")).toBeTruthy()
  expect(screen.queryByText("Other project session")).toBeNull()
})

it("keeps a newer source revision unseen when an older viewed receipt arrives after a refresh", async () => {
  open()
  await screen.findByText("Other project session")
  const pending = Promise.withResolvers<ReturnType<typeof success<{ data: AttentionItem }>>>()
  api.seen.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  const newer = item("recovery-1", {
    revision: "revision-2",
    state: "authority_conflict",
    reasonCode: "authority_conflict",
  })
  api.list.mockResolvedValueOnce(success(page([newer])))
  refresh()
  await screen.findByText(dict["attention.state.authority_conflict"])
  api.list.mockRejectedValueOnce(new Error("network"))
  pending.resolve(success({ data: item("recovery-1", { seen: true, seenAt: 3000 }) }))
  await screen.findByText(dict["attention.stale"])
  expect(screen.getByText(/1 not viewed/)).toBeTruthy()
  expect(screen.getByText(dict["attention.state.authority_conflict"])).toBeTruthy()
  expect(screen.queryByText(dict["attention.seen"])).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: dict["attention.markSeen"] }))
  expect(api.seen).toHaveBeenLastCalledWith({ itemID: "recovery-1", revision: "revision-2" })
})

it("does not subtract an already-observed receipt twice when a refresh wins the race", async () => {
  const other = item("recovery-2", { session: { ...item().session, title: "Another unviewed item" } })
  api.list.mockResolvedValue(success(page([item(), other])))
  open()
  await screen.findByText("Other project session")
  const pending = Promise.withResolvers<ReturnType<typeof success<{ data: AttentionItem }>>>()
  api.seen.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getAllByRole("button", { name: dict["attention.markSeen"] })[0])
  api.list.mockResolvedValueOnce(success(page([item("recovery-1", { seen: true, seenAt: 3000 }), other])))
  refresh()
  await screen.findByText(dict["attention.seen"])
  api.list.mockRejectedValueOnce(new Error("network"))
  pending.resolve(success({ data: item("recovery-1", { seen: true, seenAt: 3000 }) }))
  await screen.findByText(dict["attention.stale"])
  expect(screen.getByText(/1 not viewed/)).toBeTruthy()
  expect(screen.getByText("Another unviewed item")).toBeTruthy()
})

it("does not restore old details when a newer source revision arrived while GET was pending", async () => {
  open()
  await screen.findByText("Other project session")
  const pending = Promise.withResolvers<ReturnType<typeof success<{ data: AttentionItem }>>>()
  api.get.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole("button", { name: dict["attention.details"] }))
  const newer = item("recovery-1", {
    revision: "revision-2",
    state: "authority_conflict",
    reasonCode: "authority_conflict",
  })
  api.list.mockResolvedValueOnce(success(page([newer])))
  refresh()
  await screen.findByText(dict["attention.state.authority_conflict"])
  pending.resolve(success({ data: item() }))
  await screen.findByText(dict["attention.reason.authority_conflict"])
  expect(screen.queryByText(dict["attention.reason.recovery_required"])).toBeNull()
  expect(api.seen).not.toHaveBeenCalled()
})
