import { describe, expect, test } from "bun:test"
import { createIMClient } from "./im-client"
import type { IMAttachment } from "@/components/im/types"

describe("createIMClient.webSocketURL", () => {
  test("routes directory and auth_token into the websocket URL", () => {
    const client = createIMClient(() => ({
      url: "http://127.0.0.1:49365",
      directory: "/tmp/project",
      username: "deepagent-code",
      password: "secret",
    }))

    const url = new URL(client.webSocketURL("grp_1"))
    expect(url.protocol).toBe("ws:")
    expect(url.pathname).toBe("/ws/im/group/grp_1")
    expect(url.username).toBe("")
    expect(url.password).toBe("")
    expect(url.searchParams.get("directory")).toBe("/tmp/project")
    expect(url.searchParams.get("auth_token")).toBe(btoa("deepagent-code:secret"))
  })

  test("upgrades https to wss and includes workspace when present", () => {
    const client = createIMClient(() => ({
      url: "https://app.example.test",
      directory: "/tmp/project",
      workspace: "ws_42",
      password: "secret",
    }))

    const url = new URL(client.webSocketURL("grp_2"))
    expect(url.protocol).toBe("wss:")
    expect(url.searchParams.get("workspace")).toBe("ws_42")
    expect(url.searchParams.get("auth_token")).toBe(btoa("deepagent-code:secret"))
  })

  test("omits auth_token when no password is set", () => {
    const client = createIMClient(() => ({
      url: "http://127.0.0.1:49365",
      directory: "/tmp/project",
    }))

    const url = new URL(client.webSocketURL("grp_3"))
    expect(url.searchParams.has("auth_token")).toBe(false)
    expect(url.searchParams.get("directory")).toBe("/tmp/project")
  })

  test("server mode: WS omits auth_token (gateway authenticates via cookie)", () => {
    const client = createIMClient(() => ({
      url: "https://gw.test/w",
      directory: "/tmp/project",
      bearer: "jwt-token",
    }))

    const url = new URL(client.webSocketURL("grp_4"))
    expect(url.protocol).toBe("wss:")
    expect(url.pathname).toBe("/w/ws/im/group/grp_4")
    expect(url.searchParams.has("auth_token")).toBe(false)
    expect(url.searchParams.get("directory")).toBe("/tmp/project")
  })
})

describe("createIMClient HTTP auth + routing", () => {
  test("media download preserves auth/routing, disables HTTP caching, and verifies returned bytes", async () => {
    const data = new TextEncoder().encode("verified fixture bytes")
    const attachment: IMAttachment = {
      id: "ima_fixture",
      workspaceID: "workspace",
      projectID: null,
      groupID: "group",
      messageID: "message",
      uploadedBy: "server",
      filename: "fixture.txt",
      mime: "text/plain",
      preview: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      sizeBytes: data.byteLength,
      checksum: new Bun.CryptoHasher("sha256").update(data).digest("hex"),
    }
    const client = createIMClient(() => ({
      url: "https://gateway.test/w",
      directory: "/fixture",
      workspace: "workspace",
      bearer: "fixture-token",
    }))
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe("/w/api/v1/im/attachments/ima_fixture/content")
      expect(url.searchParams.get("workspace")).toBe("workspace")
      expect(url.searchParams.has("auth_token")).toBe(false)
      expect(init?.cache).toBe("no-store")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token")
      return new Response(data)
    }) as typeof fetch
    try {
      expect(await (await client.downloadAttachment(attachment)).text()).toBe("verified fixture bytes")
      await expect(client.downloadAttachment({ ...attachment, checksum: "wrong" })).rejects.toThrow("integrity")
      await expect(client.downloadAttachment({ ...attachment, sizeBytes: 0 })).rejects.toThrow("integrity")
      await expect(client.downloadAttachment({ ...attachment, expiresAt: 0 })).rejects.toThrow("expiration")
    } finally {
      globalThis.fetch = original
    }
  })
  test("server mode sends Bearer and directory header (survives gateway proxy)", async () => {
    let seenHeaders: Record<string, string> = {}
    const client = createIMClient(() => ({
      url: "https://gw.test/w",
      directory: "/tmp/project",
      bearer: "jwt-token",
    }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders = (init?.headers as Record<string, string>) ?? {}
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    try {
      await client.listGroups()
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(seenHeaders["Authorization"]).toBe("Bearer jwt-token")
    expect(seenHeaders["x-deepagent-code-directory"]).toBe("/tmp/project")
  })

  test("self-hosted mode sends Basic auth", async () => {
    let seenHeaders: Record<string, string> = {}
    const client = createIMClient(() => ({
      url: "http://127.0.0.1:49365",
      directory: "/tmp/project",
      password: "secret",
    }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders = (init?.headers as Record<string, string>) ?? {}
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    try {
      await client.listGroups()
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(seenHeaders["Authorization"]).toBe(`Basic ${btoa("deepagent-code:secret")}`)
  })
})
