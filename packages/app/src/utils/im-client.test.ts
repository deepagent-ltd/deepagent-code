import { describe, expect, test } from "bun:test"
import { createIMClient, mergeIMMessages } from "./im-client"
import type { IMAttachment, IMMessage } from "@/components/im/types"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"

test("an identical admitted remote snapshot preserves the mounted card while new transport facts replace it", () => {
  const message: IMMessage = {
    id: "remote-message",
    groupID: "group",
    senderID: "sender",
    senderType: "user",
    type: "file",
    content: "fixture.png",
    mentions: null,
    metadata: null,
    replyToID: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    remoteAttachments: [{
      profile: "kernel_media",
      attachmentID: "a".repeat(64),
      contentRef: "a".repeat(64),
      filename: "fixture.png",
      mime: "image/png",
      sizeBytes: 70,
      sha256: "b".repeat(64),
      createdAt: 1,
      expiresAt: 86_400_001,
    }],
  }
  expect(mergeIMMessages([message], [structuredClone(message)])[0]).toBe(message)
  const updated = { ...structuredClone(message), updatedAt: 2 }
  expect(mergeIMMessages([message], [updated])[0]).toBe(updated)
  expect(mergeIMMessages([], [structuredClone(message)])[0]).not.toBe(message)
})

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
    const createdAt = Date.now()
    const attachment: IMAttachment = MediaIntent.attachment({
      id: "ima_fixture",
      workspaceID: "workspace",
      projectID: null,
      groupID: "group",
      messageID: "message",
      uploadedBy: "server",
      filename: "fixture.txt",
      mime: "text/plain",
      preview: false,
      createdAt,
      expiresAt: createdAt + 86_400_000,
      sizeBytes: data.byteLength,
      checksum: new Bun.CryptoHasher("sha256").update(data).digest("hex"),
    })
    const client = createIMClient(() => ({
      url: "https://gateway.test/w",
      directory: "/fixture",
      workspace: "workspace",
      bearer: "fixture-token",
    }))
    const original = globalThis.fetch
    const served = { bytes: data }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect([
        "/w/api/v1/im/attachments/ima_fixture",
        "/w/api/v1/im/attachments/ima_fixture/content",
      ]).toContain(url.pathname)
      expect(url.searchParams.get("workspace")).toBe("workspace")
      expect(url.searchParams.has("auth_token")).toBe(false)
      expect(init?.cache).toBe("no-store")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token")
      if (!url.pathname.endsWith("/content"))
        return new Response(JSON.stringify(attachment), { headers: { "content-type": "application/json" } })
      return new Response(served.bytes)
    }) as typeof fetch
    try {
      expect(await (await client.downloadAttachment(attachment)).text()).toBe("verified fixture bytes")
      served.bytes = data.slice()
      served.bytes[0] ^= 1
      await expect(client.downloadAttachment(attachment)).rejects.toThrow("integrity")
      served.bytes = data
      await expect(client.downloadAttachment({ ...attachment, checksum: "wrong" })).rejects.toThrow("changed")
      await expect(client.downloadAttachment({ ...attachment, sizeBytes: 0 })).rejects.toThrow("changed")
      await expect(client.downloadAttachment({ ...attachment, expiresAt: 0 })).rejects.toThrow("changed")
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
    expect(seenHeaders["x-deepagent-code-directory"]).toBe("%2Ftmp%2Fproject")
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

for (const method of ["listGroups", "facadeStatus"] as const)
  test(`directory routing encodes Chinese and literal percent in ${method} headers while preserving workspace identity`, async () => {
    const directory = "/tmp/中文项目 %literal"
    const observed: Request[] = []
    const client = createIMClient(() => ({
      url: "https://gateway.test/w",
      directory,
      workspace: "actual-workspace",
      bearer: "fixture-token",
    }))
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      observed.push(new Request(input, init))
      return Response.json(
        method === "listGroups"
          ? []
          : { facade: "disabled", identity: null, blocked: null, kernel: null, keyOrigin: "none" },
      )
    }) as typeof fetch
    try {
      await client[method]()
      expect(observed).toHaveLength(1)
      expect(observed[0].method).toBe("GET")
      expect(new URL(observed[0].url).searchParams.get("directory")).toBe(directory)
      expect(new URL(observed[0].url).pathname).toBe(`/w/api/v1/im/${method === "listGroups" ? "groups" : "status"}`)
      expect(decodeURIComponent(observed[0].headers.get("x-deepagent-code-directory")!)).toBe(directory)
      expect(observed[0].headers.get("x-deepagent-code-directory")).toBe(encodeURIComponent(directory))
      expect(observed[0].headers.get("x-deepagent-code-workspace")).toBe("actual-workspace")
      expect(observed[0].headers.get("authorization")).toBe("Bearer fixture-token")
    } finally {
      globalThis.fetch = original
    }
  })
