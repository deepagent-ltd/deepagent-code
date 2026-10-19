import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import type { SharedBrowserTuiSchema } from "@deepagent-code/core/browser/shared-tui-schema"
import { SharedBrowserTuiPairing } from "@/components/shared-browser-tui-pairing"
import { dict } from "@/i18n/en"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
afterEach(cleanup)

it("requires a live exact Main pairing and keeps unknown approvals and late list responses in their original scope", async () => {
  const original: SharedBrowserTuiSchema.View = {
    requestID: "pair",
    challengeHash: "a".repeat(64),
    rootSessionID: "session",
    directory: "/project",
    attachID: "attach",
    generation: "source",
    pendingUntil: Date.now() + 60_000,
    state: "pending",
    streamLive: false,
    barrierOrder: 0,
  }
  const listing = Promise.withResolvers<SharedBrowserTuiSchema.View[]>()
  const listeners = new Set<(view: SharedBrowserTuiSchema.View) => void>()
  const calls: SharedBrowserTuiSchema.Approve[] = []
  const bridge = {
    tuiPending: async () => listing.promise,
    tuiApprove: async (input: SharedBrowserTuiSchema.Approve) => {
      calls.push(structuredClone(input))
      if (calls.length === 1) throw new Error("Unknown Main acknowledgement")
      return { ...original, state: "active" as const, streamLive: true }
    },
    tuiDetach: async () => ({ ...original, state: "retired" as const }),
    onTuiState: (callback: (view: SharedBrowserTuiSchema.View) => void) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
  }
  const app = render(() => <SharedBrowserTuiPairing bridge={bridge} sessionID="session" directory="/project" />)
  expect(screen.queryByRole("region", { name: dict["browser.tui.title"] })).toBeNull()
  expect(listeners.size).toBe(1)
  for (const receive of listeners) receive(original)
  expect(
    screen.getByRole("button", { name: `${dict["browser.tui.pendingConnections"]} 1` }).getAttribute("aria-expanded"),
  ).toBe("true")
  await waitFor(() =>
    expect((screen.getByRole("button", { name: dict["browser.tui.approve"] }) as HTMLButtonElement).disabled).toBe(
      true,
    ),
  )
  for (const receive of listeners) receive({ ...original, streamLive: true })
  const approve = () => screen.getByRole("button", { name: dict["browser.tui.approve"] })
  await waitFor(() => expect((approve() as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(approve())
  await screen.findByRole("alert")
  fireEvent.click(approve())
  await screen.findByRole("button", { name: dict["browser.tui.detach"] })
  expect(calls).toEqual([
    {
      attachID: original.attachID,
      requestID: original.requestID,
      challengeHash: original.challengeHash,
      rootSessionID: original.rootSessionID,
      directory: original.directory,
      expectedGeneration: original.generation,
    },
    calls[0],
  ])
  listing.resolve([
    original,
    { ...original, attachID: "foreign", rootSessionID: "another", challengeHash: "b".repeat(64) },
  ])
  await waitFor(() => expect(screen.queryByRole("button", { name: dict["browser.tui.approve"] })).toBeNull())
  expect(screen.getByText(original.challengeHash).isConnected).toBe(true)
  expect(screen.queryByText("b".repeat(64))).toBeNull()
  const summary = screen.getByRole("button", { name: `${dict["browser.tui.title"]} 1` })
  fireEvent.click(summary)
  expect(summary.getAttribute("aria-expanded")).toBe("false")
  expect(screen.queryByText(original.challengeHash)).toBeNull()
  expect(screen.queryByRole("button", { name: dict["browser.tui.detach"] })).toBeNull()
  fireEvent.click(summary)
  fireEvent.click(screen.getByRole("button", { name: dict["browser.tui.detach"] }))
  await waitFor(() => expect(screen.queryByRole("region", { name: dict["browser.tui.title"] })).toBeNull())
  for (const receive of listeners) receive({ ...original, state: "retired" })
  expect(screen.queryByRole("region", { name: dict["browser.tui.title"] })).toBeNull()
  app.unmount()
  expect(listeners.size).toBe(0)
})

it("keeps dormant and retired-only connections invisible and rejects replies from a replaced scope", async () => {
  const original: SharedBrowserTuiSchema.View = {
    requestID: "pair-a",
    challengeHash: "a".repeat(64),
    rootSessionID: "session-a",
    directory: "/project-a",
    attachID: "attach-a",
    generation: "source-a",
    pendingUntil: Date.now() + 60_000,
    state: "pending",
    streamLive: true,
    barrierOrder: 0,
  }
  const list = Promise.withResolvers<SharedBrowserTuiSchema.View[]>()
  const approval = Promise.withResolvers<SharedBrowserTuiSchema.View>()
  const listeners = new Set<(view: SharedBrowserTuiSchema.View) => void>()
  const approve = vi.fn(() => approval.promise)
  const listing = vi.fn((sessionID: string) =>
    sessionID === original.rootSessionID ? Promise.resolve([]) : list.promise,
  )
  const bridge = {
    tuiPending: listing,
    tuiApprove: approve,
    tuiDetach: async () => ({ ...original, state: "retired" as const }),
    onTuiState: (receive: (view: SharedBrowserTuiSchema.View) => void) => {
      listeners.add(receive)
      return () => {
        listeners.delete(receive)
      }
    },
  }
  const [scope, setScope] = createStore({ sessionID: "session-a", directory: "/project-a" })
  render(() => <SharedBrowserTuiPairing bridge={bridge} sessionID={scope.sessionID} directory={scope.directory} />)
  await waitFor(() => expect(listing).toHaveBeenCalledOnce())
  expect(screen.queryByRole("region", { name: dict["browser.tui.title"] })).toBeNull()
  for (const receive of listeners) receive(original)
  await screen.findByRole("button", { name: dict["browser.tui.approve"] })
  const oldObserver = [...listeners][0]
  fireEvent.click(screen.getByRole("button", { name: dict["browser.tui.approve"] }))
  expect(approve).toHaveBeenCalledOnce()
  setScope({ sessionID: "session-b", directory: "/project-b" })
  expect(screen.queryByRole("region", { name: dict["browser.tui.title"] })).toBeNull()
  approval.resolve({ ...original, state: "active" })
  oldObserver({ ...original, state: "active" })
  list.resolve([original, { ...original, rootSessionID: "session-b", directory: "/project-b", state: "retired" }])
  await waitFor(() => expect(listing).toHaveBeenCalledTimes(2))
  await approval.promise
  expect(screen.queryByText(original.challengeHash)).toBeNull()
  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.queryByRole("region", { name: dict["browser.tui.title"] })).toBeNull()
  expect(listeners.size).toBe(1)
  for (const receive of listeners)
    receive({
      ...original,
      requestID: "pair-b",
      attachID: "attach-b",
      generation: "source-b",
      rootSessionID: "session-b",
      directory: "/project-b",
      challengeHash: "b".repeat(64),
    })
  expect(screen.getByText("b".repeat(64))).toBeDefined()
  expect(
    screen.getByRole("button", { name: `${dict["browser.tui.pendingConnections"]} 1` }).getAttribute("aria-expanded"),
  ).toBe("true")
  expect(approve).toHaveBeenCalledOnce()
})

it("keeps a failed listing actionable through a compact disclosure and hides it after an empty refresh", async () => {
  const listeners = new Set<(view: SharedBrowserTuiSchema.View) => void>()
  const listing = vi.fn(async (): Promise<SharedBrowserTuiSchema.View[]> => {
    if (listing.mock.calls.length === 1) throw new Error("Owner state unavailable")
    return []
  })
  const act = vi.fn(async (): Promise<SharedBrowserTuiSchema.View> => {
    throw new Error("Not an approval")
  })
  const bridge = {
    tuiPending: listing,
    tuiApprove: act,
    tuiDetach: act,
    onTuiState: (receive: (view: SharedBrowserTuiSchema.View) => void) => {
      listeners.add(receive)
      return () => {
        listeners.delete(receive)
      }
    },
  }
  const app = render(() => <SharedBrowserTuiPairing bridge={bridge} sessionID="session" directory="/project" />)
  const summary = await screen.findByRole("button", { name: `${dict["browser.tui.attention"]} !` })
  expect(summary.getAttribute("aria-expanded")).toBe("false")
  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.queryByRole("button", { name: dict["browser.tui.refresh"] })).toBeNull()
  fireEvent.click(summary)
  expect(screen.getByRole("alert").textContent).toBe(dict["browser.tui.unknown"])
  fireEvent.click(screen.getByRole("button", { name: dict["browser.tui.refresh"] }))
  await waitFor(() => expect(screen.queryByRole("region", { name: dict["browser.tui.title"] })).toBeNull())
  expect(listing).toHaveBeenCalledTimes(2)
  expect(act).not.toHaveBeenCalled()
  app.unmount()
  expect(listeners.size).toBe(0)
})
