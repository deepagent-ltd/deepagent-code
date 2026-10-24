import { createServer } from "node:http"
import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { createIMEntitlementRead } from "@/components/im/entitlement-read"
import { createIMClient } from "@/utils/im-client"

const fixture = {
  url: "",
  requests: [] as string[],
  completed: [] as string[],
  hold: undefined as Promise<void> | undefined,
  fail: false,
}
const server = createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("access-control-allow-headers", "x-deepagent-code-directory")
  if (request.method === "OPTIONS") {
    response.writeHead(204).end()
    return
  }
  const url = new URL(request.url!, "http://fixture.invalid")
  const directory = url.searchParams.get("directory") ?? ""
  fixture.requests.push(directory)
  if (directory === "old" && fixture.hold) await fixture.hold
  if (fixture.fail) {
    response.writeHead(503).end()
    fixture.completed.push(directory)
    return
  }
  response.setHeader("content-type", "application/json")
  response.end(
    JSON.stringify({
      state: "known",
      entitlement: {
        version: "dac-im-entitlement-v1",
        profile: "dac-im-device-v1",
        realm: "https://service.invalid/im",
        entitlementID: (directory === "old" ? "a" : "b").repeat(32),
        deviceJkt: "c".repeat(43),
        bindingVersion: 1,
        uuid: directory,
        planID: "im-year",
        planVersion: "im-plans-2026-10-19",
        state: "active",
        validityKnown: true,
        lifetime: false,
        validFrom: 1_700_000_000_000,
        expiresAt: 1_731_622_400_000,
        serverObservedAt: 1_710_000_000_000,
      },
    }),
  )
  fixture.completed.push(directory)
})
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  fixture.url = `http://127.0.0.1:${address.port}`
})
afterEach(() => {
  cleanup()
  fixture.requests.length = 0
  fixture.completed.length = 0
  fixture.hold = undefined
  fixture.fail = false
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

it("reads only while the page is current and rejects a delayed prior-scope HTTP observation", async () => {
  const [state, setState] = createStore({ current: false, directory: "old" })
  const gate = Promise.withResolvers<void>()
  fixture.hold = gate.promise
  const client = createIMClient(() => ({
    url: fixture.url,
    directory: state.directory,
    serviceURL: "https://service.invalid/im",
  }))
  render(() => {
    const read = createIMEntitlementRead({
      current: () => state.current,
      scope: client.scope,
      // Deliberately ignore abort to verify generation fencing as well as fetch cancellation.
      entitlement: async () => client.entitlement(),
    })
    const label = () => {
      const value = read.entitlement()
      return value?.state === "known" ? value.entitlement.uuid : "unknown"
    }
    return <output>{label()}</output>
  })
  expect(fixture.requests).toEqual([])
  setState("current", true)
  await waitFor(() => expect(fixture.requests).toEqual(["old"]))
  setState("directory", "new")
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("new"))
  gate.resolve()
  await waitFor(() => expect(fixture.completed).toContain("old"))
  expect(screen.getByRole("status").textContent).toBe("new")
  setState("current", false)
  expect(screen.getByRole("status").textContent).toBe("unknown")
  expect(fixture.requests).toEqual(["old", "new"])
})

it("clears a prior result on explicit refresh failure without admitting a write or retry loop", async () => {
  const client = createIMClient(() => ({ url: fixture.url, directory: "current" }))
  render(() => {
    const read = createIMEntitlementRead({ current: () => true, scope: client.scope, entitlement: client.entitlement })
    return (
      <>
        <output>{read.failed() ? "failed" : (read.entitlement()?.state ?? "loading")}</output>
        <button onClick={() => void read.refresh()}>Refresh</button>
      </>
    )
  })
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("known"))
  fixture.fail = true
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("failed"))
  expect(fixture.requests).toEqual(["current", "current"])
})
