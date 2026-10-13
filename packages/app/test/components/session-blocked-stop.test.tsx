import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createStore } from "solid-js/store"
import { createServer, type ServerResponse } from "node:http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { SessionBlockedStop } from "@/pages/session/composer/session-blocked-stop"
import { ScopedKey, ServerScope } from "@/utils/server-scope"
import { getScenarioOverride, setScenarioOverride } from "@/components/prompt-input/scenario-override"
import { dict } from "@/i18n/en"

const wiring = vi.hoisted(() => ({
  sdk: {} as { client: ReturnType<typeof createDeepAgentCodeClient>; directory: string; scope: ServerScope },
  toast: vi.fn(),
}))
vi.mock("@/context/sdk", () => ({ useSDK: () => wiring.sdk }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@/utils/toast", () => ({ showToast: wiring.toast }))
afterEach(() => {
  cleanup()
  wiring.toast.mockClear()
})

async function peer() {
  const requests: { url: string; directory?: string }[] = []
  const replies: ServerResponse[] = []
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    requests.push({ url: request.url ?? "", directory: request.headers["x-deepagent-code-directory"]?.toString() })
    replies.push(response)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The original HTTP peer was not bound")
  const client = createDeepAgentCodeClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory: "/first-project",
  })
  const finish = (index: number, status: number) => {
    replies[index].writeHead(status, { "Content-Type": "application/json" })
    replies[index].end(JSON.stringify(status === 200 ? true : { message: "Original stop failed" }))
  }
  const close = async () => {
    cleanup()
    for (const response of replies) if (!response.writableEnded) response.end()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
  return { client, requests, finish, close }
}

it("captures the displayed Session and directory once, rejects duplicate clicks and ignores a late failure after navigation", async () => {
  const remote = await peer()
  wiring.sdk = { client: remote.client, directory: "/first-project", scope: ServerScope.local }
  const [view, setView] = createStore({ sessionID: "first-session" })
  const interrupted = vi.fn()
  const session = ScopedKey.from(wiring.sdk.scope, view.sessionID)
  const directory = ScopedKey.from(wiring.sdk.scope, wiring.sdk.directory)
  setScenarioOverride(session, "intelligence")
  setScenarioOverride(directory, "intelligence")
  try {
    render(() => <SessionBlockedStop sessionID={view.sessionID} onAbort={interrupted} />)
    fireEvent.click(screen.getByRole("button", { name: dict["prompt.action.stop"] }))
    fireEvent.click(screen.getByRole("button", { name: dict["prompt.action.stop"] }))
    await waitFor(() => expect(remote.requests).toHaveLength(1))
    expect(remote.requests[0]).toEqual({ url: "/session/first-session/abort", directory: "%2Ffirst-project" })
    expect(screen.getByRole("button")).toHaveProperty("disabled", true)
    expect(interrupted).toHaveBeenCalledTimes(1)
    expect(getScenarioOverride(session)).toBeUndefined()
    expect(getScenarioOverride(directory)).toBeUndefined()
    setView("sessionID", "second-session")
    remote.finish(0, 503)
    await waitFor(() => expect(screen.getByRole("button")).toHaveProperty("disabled", false))
    expect(wiring.toast).not.toHaveBeenCalled()
    expect(remote.requests).toHaveLength(1)
    fireEvent.click(screen.getByRole("button"))
    await waitFor(() => expect(remote.requests).toHaveLength(2))
    expect(remote.requests[1].url).toBe("/session/second-session/abort")
    remote.finish(1, 200)
    await waitFor(() => expect(screen.getByRole("button")).toHaveProperty("disabled", false))
  } finally {
    await remote.close()
  }
})

it("shows a current stop failure but suppresses a pending failure after the original dock is unmounted", async () => {
  const remote = await peer()
  wiring.sdk = { client: remote.client, directory: "/first-project", scope: ServerScope.local }
  try {
    render(() => <SessionBlockedStop sessionID="original-session" />)
    fireEvent.click(screen.getByRole("button"))
    await waitFor(() => expect(remote.requests).toHaveLength(1))
    remote.finish(0, 503)
    await waitFor(() => expect(wiring.toast).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole("button")).toHaveProperty("disabled", false))
    fireEvent.click(screen.getByRole("button"))
    await waitFor(() => expect(remote.requests).toHaveLength(2))
    cleanup()
    remote.finish(1, 503)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(wiring.toast).toHaveBeenCalledTimes(1)
    expect(remote.requests.every((request) => request.url === "/session/original-session/abort")).toBe(true)
  } finally {
    await remote.close()
  }
})
