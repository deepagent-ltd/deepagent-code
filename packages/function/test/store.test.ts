import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import type { WebSocket } from "ws"
import { createApp } from "../src/api"
import { ShareStore, isValidShareID } from "../src/store"
import { Subscribers } from "../src/subscribers"

let directory: string
let store: ShareStore

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "deepagent-share-test-"))
  store = new ShareStore(directory)
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("ShareStore", () => {
  test("rejects traversal and non-opaque share identifiers", async () => {
    expect(isValidShareID("abc_123-Z")).toBe(true)
    expect(isValidShareID("../outside")).toBe(false)
    expect(isValidShareID("a/b")).toBe(false)
    expect(isValidShareID(".")).toBe(false)
    await expect(store.getData("../outside")).rejects.toThrow("Invalid share ID")
    await expect(store.clear("a/b")).rejects.toThrow("Invalid share ID")
  })

  test("refuses two sessions that collide on the public short identifier", async () => {
    const first = "ses_left_12345678"
    const second = "ses_right_12345678"
    await store.share(first)
    await expect(store.share(second)).rejects.toThrow("Share ID collision")
  })

  test("serializes concurrent publishes without losing entries", async () => {
    const sessionID = "ses_parallel_87654321"
    const secret = await store.share(sessionID)
    expect(secret.length).toBeGreaterThan(0)

    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        store.publish("87654321", secret, `session/message/${sessionID}/${index}`, { index }),
      ),
    )

    const entries = await store.getData("87654321")
    expect(entries).toHaveLength(100)
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(100)
  })

  test("serializes publishes across independent store owners", async () => {
    const sessionID = "ses_multi_owner_12345678"
    const secret = await store.share(sessionID)
    const peer = new ShareStore(directory)

    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        (index % 2 === 0 ? store : peer).publish("12345678", secret, `session/message/${sessionID}/${index}`, {
          index,
        }),
      ),
    )

    const entries = await new ShareStore(directory).getData("12345678")
    expect(entries).toHaveLength(100)
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(100)
  })

  test("serializes publishes across independent OS processes", async () => {
    const sessionID = "ses_process_12345678"
    const secret = await store.share(sessionID)
    const writer = path.join(import.meta.dir, "share-store-writer.ts")
    const processes = [
      Bun.spawn([process.execPath, writer, directory, sessionID, secret, "0", "25"], {
        stdout: "pipe",
        stderr: "pipe",
      }),
      Bun.spawn([process.execPath, writer, directory, sessionID, secret, "25", "25"], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    ]
    expect(await Promise.all(processes.map((child) => child.exited))).toEqual([0, 0])

    const entries = await new ShareStore(directory).getData("12345678")
    expect(entries).toHaveLength(50)
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(50)
  })

  test("recovers an orphaned cross-process lock without deleting a live owner", async () => {
    const sessionID = "ses_orphan_abcdefgh"
    const secret = await store.share(sessionID)
    const lock = path.join(directory, ".locks", "abcdefgh.lock")
    await mkdir(lock, { recursive: true })
    const owner = path.join(lock, "owner")
    await writeFile(owner, "dead-process")
    const stale = new Date(Date.now() - 31_000)
    await utimes(owner, stale, stale)

    await store.publish("abcdefgh", secret, `session/message/${sessionID}/recovered`, { ok: true })
    expect(await store.getData("abcdefgh")).toHaveLength(1)
  })

  test("fails visibly instead of replacing corrupt durable data", async () => {
    const sessionID = "ses_corrupt_abcdefgh"
    const secret = await store.share(sessionID)
    await mkdir(path.join(directory, "abcdefgh"), { recursive: true })
    await writeFile(path.join(directory, "abcdefgh", "data.json"), "{broken")

    await expect(store.publish("abcdefgh", secret, `session/message/${sessionID}/next`, {})).rejects.toBeInstanceOf(
      SyntaxError,
    )
  })

  test("bounds a single published entry", async () => {
    const sessionID = "ses_bounded_abcdefgh"
    const secret = await store.share(sessionID)
    await expect(
      store.publish("abcdefgh", secret, `session/message/${sessionID}/large`, {
        text: "x".repeat(1024 * 1024),
      }),
    ).rejects.toThrow("Share entry exceeds storage limit")
  })

  test("checks the share secret inside the same locked mutation", async () => {
    const sessionID = "ses_authorized_abcdefgh"
    const secret = await store.share(sessionID)
    await expect(store.publish("abcdefgh", "wrong", `session/message/${sessionID}/blocked`, {})).rejects.toThrow(
      "Invalid share secret",
    )
    await store.publish("abcdefgh", secret, `session/message/${sessionID}/allowed`, {})
    await expect(store.clearAuthorized("abcdefgh", "wrong")).rejects.toThrow("Invalid share secret")
    expect(await store.getData("abcdefgh")).toHaveLength(1)
  })

  test("bounds the total number of durable shares", async () => {
    const bounded = new ShareStore(directory, { maxShares: 1 })
    await bounded.share("ses_first_abcdefgh")
    await expect(bounded.share("ses_second_12345678")).rejects.toThrow("Share count exceeds storage limit")
  })

  test("bounds total durable storage", async () => {
    await expect(new ShareStore(directory, { maxStoreBytes: 1 }).share("ses_full_abcdefgh")).rejects.toThrow(
      "Share store exceeds storage limit",
    )
  })

  test("reports only shares with durable metadata", async () => {
    expect(await store.exists("abcdefgh")).toBe(false)
    await store.share("ses_exists_abcdefgh")
    expect(await store.exists("abcdefgh")).toBe(true)
  })
})

describe("Subscribers", () => {
  test("bounds live sockets and terminates a slow consumer", () => {
    class SocketFixture extends EventEmitter {
      readyState = 1
      bufferedAmount = 0
      terminated = false
      send(_payload: string, callback: (error?: Error) => void) {
        callback()
      }
      terminate() {
        this.terminated = true
        this.emit("close")
      }
    }

    const subscribers = new Subscribers({ maxSubscribers: 1, maxSubscribersPerShare: 1, maxBufferedBytes: 8 })
    const first = new SocketFixture()
    const second = new SocketFixture()
    expect(subscribers.add("abcdefgh", first as unknown as WebSocket)).toBe(true)
    expect(subscribers.add("abcdefgh", first as unknown as WebSocket)).toBe(true)
    expect(subscribers.add("abcdefgh", second as unknown as WebSocket)).toBe(false)
    expect(subscribers.stats()).toEqual({ subscribers: 1, shares: 1 })

    subscribers.publish("abcdefgh", { key: "session/info/ses", content: { large: true } })
    expect(first.terminated).toBe(true)
    expect(subscribers.stats()).toEqual({ subscribers: 0, shares: 0 })
  })
})

describe("share HTTP boundary", () => {
  test("fails closed when the admin secret is absent", async () => {
    const app = createApp({ store, subscribers: new Subscribers(), env: () => "" })
    const response = await app.request("/share_delete_admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionShortName: "abcdefgh", adminSecret: "" }),
    })
    expect(response.status).toBe(503)
  })

  test("rejects invalid admin credentials and traversal before touching storage", async () => {
    const app = createApp({
      store,
      subscribers: new Subscribers(),
      env: (key) => (key === "ADMIN_SECRET" ? "configured-secret" : ""),
    })
    const badSecret = await app.request("/share_delete_admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionShortName: "abcdefgh", adminSecret: "wrong" }),
    })
    expect(badSecret.status).toBe(401)

    const traversal = await app.request("/share_delete_admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionShortName: "../outside", adminSecret: "configured-secret" }),
    })
    expect(traversal.status).toBe(400)
    expect((await app.request("/share_data?id=../outside")).status).toBe(400)
  })

  test("rejects malformed session identifiers and oversized bodies", async () => {
    const app = createApp({
      store,
      subscribers: new Subscribers(),
      env: (key) => (key === "SHARE_CREATE_TOKEN" ? "create-secret" : ""),
    })
    const malformed = await app.request("/share_create", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer create-secret" },
      body: JSON.stringify({ sessionID: "../escape" }),
    })
    expect(malformed.status).toBe(400)

    const oversized = await app.request("/share_create", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) },
      body: JSON.stringify({ sessionID: "ses_large_abcdefgh" }),
    })
    expect(oversized.status).toBe(413)
  })

  test("fails closed and authenticates share creation before consuming quota", async () => {
    const missing = createApp({ store, subscribers: new Subscribers(), env: () => "" })
    expect(
      (
        await missing.request("/share_create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID: "ses_create_abcdefgh" }),
        })
      ).status,
    ).toBe(503)

    const configured = createApp({
      store,
      subscribers: new Subscribers(),
      env: (key) => (key === "SHARE_CREATE_TOKEN" ? "create-secret" : ""),
    })
    expect(
      (
        await configured.request("/share_create", {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: "Bearer wrong" },
          body: JSON.stringify({ sessionID: "ses_create_abcdefgh" }),
        })
      ).status,
    ).toBe(401)
    expect(await store.exists("abcdefgh")).toBe(false)

    const created = await configured.request("/share_create", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer create-secret" },
      body: JSON.stringify({ sessionID: "ses_create_abcdefgh" }),
    })
    expect(created.status).toBe(200)
    expect(await store.exists("abcdefgh")).toBe(true)
  })

  test("fails closed for unauthenticated Feishu callbacks", async () => {
    const missing = createApp({ store, subscribers: new Subscribers(), env: () => "" })
    expect(
      (
        await missing.request("/feishu", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ challenge: "probe", token: "" }),
        })
      ).status,
    ).toBe(503)

    const configured = createApp({
      store,
      subscribers: new Subscribers(),
      env: (key) => (key === "FEISHU_VERIFICATION_TOKEN" ? "verified" : ""),
    })
    expect(
      (
        await configured.request("/feishu", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ challenge: "probe", token: "wrong" }),
        })
      ).status,
    ).toBe(401)
    const verified = await configured.request("/feishu", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge: "probe", token: "verified" }),
    })
    expect(verified.status).toBe(200)
    expect(await verified.json()).toEqual({ challenge: "probe" })
  })

  test("returns a typed unauthorized response for an invalid share secret", async () => {
    const sessionID = "ses_http_abcdefgh"
    await store.share(sessionID)
    const app = createApp({ store, subscribers: new Subscribers(), env: () => "" })
    const response = await app.request("/share_sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionID,
        secret: "wrong",
        key: `session/message/${sessionID}/blocked`,
        content: {},
      }),
    })
    expect(response.status).toBe(401)
  })
})
