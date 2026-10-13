import { expect, test } from "bun:test"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"
import { createIMClient } from "../../../src/component/im-client"
import { createMediaPreview } from "../../../src/component/im-media-preview"

const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8MsAAAAASUVORK5CYII=",
  "base64",
)
async function fixture() {
  const state = {
    enabled: true,
    allowed: true,
    corrupt: false,
    calls: [] as string[],
    body: bytes,
    delay: undefined as Promise<void> | undefined,
  }
  const createdAt = Date.now()
  const value = MediaIntent.attachment({
    id: "ima_fixture",
    workspaceID: "/project",
    projectID: null,
    groupID: "group",
    messageID: "message",
    uploadedBy: "server",
    filename: "image.png",
    mime: "image/png",
    sizeBytes: bytes.length,
    checksum: await MediaIntent.checksum(new Uint8Array(bytes)),
    createdAt,
    expiresAt: createdAt + 86_400_000,
    preview: true,
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      state.calls.push(`${request.method} ${new URL(request.url).pathname}`)
      if (request.headers.get("authorization") !== "Bearer private-fixture" || !state.allowed)
        return new Response("denied", { status: 403 })
      if (new URL(request.url).pathname === "/global/capabilities")
        return Response.json({ features: { v4FileUploadEnabled: state.enabled } })
      if (new URL(request.url).pathname.endsWith("/content")) {
        await state.delay
        return new Response(state.corrupt ? new Uint8Array(bytes.length) : state.body)
      }
      return Response.json(value)
    },
  })
  const sdk = {
    client: createOpencodeClient({ baseUrl: server.url.href, headers: { authorization: "Bearer private-fixture" } }),
    url: server.url.href,
    directory: "/project",
  }
  const client = createIMClient(sdk)
  return {
    state,
    value,
    client,
    sdk,
    [Symbol.asyncDispose]: async () => {
      await server.stop(true)
    },
  }
}

test("actual authenticated media reads have a single-resource viewer and every view rechecks authority", async () => {
  await using test = await fixture()
  const abort = new AbortController()
  const preview = await createMediaPreview({ attachment: test.value, client: test.client, signal: abort.signal })
  try {
    expect(preview.url).not.toContain("private-fixture")
    expect(preview.url).not.toContain("ima_fixture")
    const page = await fetch(preview.url)
    expect(page.status).toBe(200)
    expect(page.headers.get("referrer-policy")).toBe("no-referrer")
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'")
    const asset = preview.url.replace("/view/", "/image/")
    expect((await fetch(asset, { headers: { origin: "https://untrusted.invalid" } })).status).toBe(403)
    expect((await fetch(asset, { headers: { host: "localhost:1234" } })).status).toBe(403)
    expect(Buffer.from(await (await fetch(asset)).arrayBuffer())).toEqual(bytes)
    expect(test.state.calls.filter((call) => call.endsWith("/content"))).toHaveLength(1)
    test.state.allowed = false
    await fetch(asset).catch(() => undefined)
    await expect(fetch(preview.url)).rejects.toThrow()
    expect(test.state.calls.every((call) => call.startsWith("GET "))).toBe(true)
    expect(test.state.calls.filter((call) => call.endsWith("/content"))).toHaveLength(1)
  } finally {
    preview.close()
  }
})

test("OFF rejects before listen; abort closes the owned listener; original expiry and huge pixels deny preview", async () => {
  await using test = await fixture()
  test.state.enabled = false
  await expect(
    createMediaPreview({ attachment: test.value, client: test.client, signal: new AbortController().signal }),
  ).rejects.toThrow()
  test.state.enabled = true
  const abort = new AbortController()
  const preview = await createMediaPreview({ attachment: test.value, client: test.client, signal: abort.signal })
  abort.abort()
  await expect(fetch(preview.url)).rejects.toThrow()
  const createdAt = Date.now() - 86_400_001
  await expect(
    createMediaPreview({
      attachment: { ...test.value, createdAt, expiresAt: createdAt + 86_400_000 },
      client: test.client,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow()
  const oversized = { ...test.value, sizeBytes: 8 * 1024 * 1024 + 1 }
  await expect(
    createMediaPreview({ attachment: oversized, client: test.client, signal: new AbortController().signal }),
  ).rejects.toThrow()
})

test("integrity failure closes the viewer and in-flight resource admission rejects a second request", async () => {
  await using test = await fixture()
  const pending = Promise.withResolvers<void>()
  test.state.delay = pending.promise
  const preview = await createMediaPreview({
    attachment: test.value,
    client: test.client,
    signal: new AbortController().signal,
  })
  const asset = preview.url.replace("/view/", "/image/")
  const first = fetch(asset)
  for (let count = 0; count < 100 && !test.state.calls.some((call) => call.endsWith("/content")); count++)
    await Bun.sleep(5)
  expect((await fetch(asset)).status).toBe(429)
  test.state.corrupt = true
  pending.resolve()
  await first.catch(() => undefined)
  await expect(fetch(preview.url)).rejects.toThrow()
  preview.close()
})

test("concurrent preview creation retains one listener and the original near-term expiry closes it", async () => {
  await using test = await fixture()
  const createdAt = Date.now() - 86_400_000 + 700
  const value = { ...test.value, createdAt, expiresAt: createdAt + 86_400_000 }
  const results = await Promise.allSettled([
    createMediaPreview({ attachment: value, client: test.client, signal: new AbortController().signal }),
    createMediaPreview({ attachment: value, client: test.client, signal: new AbortController().signal }),
  ])
  const accepted = results.filter((item) => item.status === "fulfilled")
  expect(accepted).toHaveLength(1)
  const preview = accepted[0]!.value
  try {
    expect(preview.expiresAt).toBe(value.expiresAt)
    expect((await fetch(preview.url, { headers: { referer: "https://untrusted.invalid/" } })).status).toBe(403)
    expect((await fetch(preview.url)).status).toBe(200)
    await Bun.sleep(Math.max(0, value.expiresAt - Date.now()) + 30)
    await expect(fetch(preview.url)).rejects.toThrow()
  } finally {
    preview.close()
  }
})

test("a changed client identity invalidates the existing ticket before any remote read", async () => {
  await using test = await fixture()
  const preview = await createMediaPreview({
    attachment: test.value,
    client: test.client,
    signal: new AbortController().signal,
  })
  const count = test.state.calls.length
  test.sdk.directory = "/changed"
  await fetch(preview.url.replace("/view/", "/image/")).catch(() => undefined)
  await expect(fetch(preview.url)).rejects.toThrow()
  expect(test.state.calls).toHaveLength(count)
  preview.close()
})
