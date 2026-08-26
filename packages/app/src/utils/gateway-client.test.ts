import { describe, expect, test } from "bun:test"
import { createGatewayClient, normalizeGatewayUrl, workspaceBaseUrl } from "./gateway-client"

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>

function mockFetch(handler: Handler): typeof globalThis.fetch {
  const fn = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
    return Promise.resolve(handler(url, init))
  }
  return Object.assign(fn, { preconnect: () => {} }) as typeof globalThis.fetch
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("gateway url helpers", () => {
  test("normalizeGatewayUrl adds https and strips trailing slashes", () => {
    expect(normalizeGatewayUrl("gateway.example.com/")).toBe("https://gateway.example.com")
    expect(normalizeGatewayUrl("http://localhost:8080//")).toBe("http://localhost:8080")
    expect(normalizeGatewayUrl("  ")).toBeUndefined()
  })

  test("workspaceBaseUrl appends /w", () => {
    expect(workspaceBaseUrl("https://gateway.example.com")).toBe("https://gateway.example.com/w")
  })
})

describe("gateway client auth", () => {
  test("login stores the access token and posts credentials", async () => {
    let seenBody: string | undefined
    const client = createGatewayClient({
      gatewayUrl: "https://gw.test",
      fetch: mockFetch((url, init) => {
        expect(url).toBe("https://gw.test/control/v1/auth/login")
        seenBody = init?.body as string
        return json({ accessToken: "tok-1", user: { id: "u1", email: "a@b.c", role: "member", orgId: "o1" } })
      }),
    })

    const result = await client.login("a@b.c", "pw")
    expect(result.accessToken).toBe("tok-1")
    expect(client.accessToken).toBe("tok-1")
    expect(JSON.parse(seenBody!)).toEqual({ email: "a@b.c", password: "pw" })
  })

  test("refresh swaps the access token", async () => {
    const client = createGatewayClient({
      gatewayUrl: "https://gw.test",
      fetch: mockFetch((url) => {
        expect(url).toBe("https://gw.test/control/v1/auth/refresh")
        return json({ accessToken: "tok-2" })
      }),
    })
    const token = await client.refresh()
    expect(token).toBe("tok-2")
    expect(client.accessToken).toBe("tok-2")
  })

  test("refresh returns null and clears token on 401", async () => {
    const client = createGatewayClient({
      gatewayUrl: "https://gw.test",
      fetch: mockFetch(() => new Response("", { status: 401 })),
    })
    client.setAccessToken("stale")
    expect(await client.refresh()).toBeNull()
    expect(client.accessToken).toBeNull()
  })

  test("getContainer refreshes once on 401 then retries with the new token", async () => {
    const seenAuth: Array<string | null> = []
    let refreshed = false
    const client = createGatewayClient({
      gatewayUrl: "https://gw.test",
      fetch: mockFetch((url, init) => {
        if (url.endsWith("/auth/refresh")) {
          refreshed = true
          return json({ accessToken: "fresh" })
        }
        const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"] ?? null
        seenAuth.push(auth)
        if (!refreshed) return new Response("", { status: 401 })
        return json({
          id: "c1",
          userId: "u1",
          status: "running",
          imageVersion: "1",
          deepagentCodeVersion: "1",
          createdAt: 0,
        })
      }),
    })
    client.setAccessToken("old")

    const container = await client.getContainer()
    expect(container?.status).toBe("running")
    expect(refreshed).toBe(true)
    // First attempt with the old token, retry with the refreshed one.
    expect(seenAuth[0]).toBe("Bearer old")
    expect(seenAuth[1]).toBe("Bearer fresh")
  })

  test("getContainer returns null on 404", async () => {
    const client = createGatewayClient({
      gatewayUrl: "https://gw.test",
      fetch: mockFetch(() => json({ error: { code: "CONTAINER_NOT_FOUND" } }, 404)),
    })
    expect(await client.getContainer()).toBeNull()
  })

  test("workspaceBaseUrl reflects the gateway", () => {
    const client = createGatewayClient({ gatewayUrl: "https://gw.test", fetch: mockFetch(() => json({})) })
    expect(client.workspaceBaseUrl()).toBe("https://gw.test/w")
  })
})
