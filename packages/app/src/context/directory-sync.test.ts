import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { Message, Part } from "@deepagent-code/sdk/v2/client"
import { ServerScope } from "@/utils/server-scope"
import { createDirSyncContext } from "./directory-sync"

const state = () =>
  createStore({
    path: { directory: "/repo" },
    session: [] as Array<{ id: string }>,
    mcp: {},
    message: {} as Record<string, Message[] | undefined>,
    part: {} as Record<string, Part[] | undefined>,
  })

const userMessage = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
})

describe("directory optimistic targeting", () => {
  test("writes and removes an explicit worktree optimistic message in that child store", () =>
    createRoot((dispose) => {
      const current = state()
      const worktree = state()
      const children = new Map([
        ["/repo/main", current],
        ["/repo/worktree", worktree],
      ])
      const serverSync = {
        child(directory: string) {
          const child = children.get(directory)
          if (!child) throw new Error(`Unknown child: ${directory}`)
          return child
        },
      } as unknown as Parameters<typeof createDirSyncContext>[1]
      const sync = createDirSyncContext("/repo/main", serverSync, {
        createClient() {
          return {}
        },
      } as unknown as Parameters<typeof createDirSyncContext>[2])
      const message = userMessage("msg_client", "ses_1")

      sync.session.optimistic.add({
        directory: "/repo/worktree",
        sessionID: message.sessionID,
        message,
        parts: [],
      })

      expect(current[0].message[message.sessionID]).toBeUndefined()
      expect(worktree[0].message[message.sessionID]?.map((item) => item.id)).toEqual([message.id])

      sync.session.optimistic.remove({
        directory: "/repo/worktree",
        sessionID: message.sessionID,
        messageID: message.id,
      })

      expect(worktree[0].message[message.sessionID]).toEqual([])
      dispose()
    }))

  test("does not restore an optimistic message after the canonical steer arrives before the retry", () =>
    createRoot((dispose) => {
      const current = state()
      const serverSync = {
        child() {
          return current
        },
      } as unknown as Parameters<typeof createDirSyncContext>[1]
      const sync = createDirSyncContext("/repo/main", serverSync, {
        createClient() {
          return {}
        },
      } as unknown as Parameters<typeof createDirSyncContext>[2])
      const sessionID = "ses_1"
      const client = userMessage("msg_client", sessionID)
      const canonical = {
        ...userMessage("msg_server", sessionID),
        metadata: {
          deepagent: {
            promptAdmission: {
              clientMessageID: client.id,
            },
          },
        },
      }

      sync.session.optimistic.add({ sessionID, message: client, parts: [] })
      expect(current[0].message[sessionID]?.map((message) => message.id)).toEqual([client.id])

      current[1]("message", sessionID, [canonical])
      sync.session.optimistic.add({ sessionID, message: client, parts: [] })

      expect(current[0].message[sessionID]?.map((message) => message.id)).toEqual([canonical.id])
      expect(current[0].part[client.id]).toBeUndefined()
      dispose()
    }))

  test("does not merge a private placeholder from a stale page after the canonical event", async () => {
    let releaseStalePage: (() => void) | undefined
    let calls = 0
    const current = state()
    const serverSync = {
      child() {
        return current
      },
      plan: {
        async sync() {},
      },
    } as unknown as Parameters<typeof createDirSyncContext>[1]
    const sync = createDirSyncContext("/repo/main", serverSync, {
      scope: ServerScope.local,
      createClient() {
        return {
          session: {
            async get() {
              return { data: { id: "ses_1" } }
            },
            async messages() {
              calls += 1
              if (calls === 1) {
                return {
                  data: [],
                  response: { headers: new Headers({ "x-next-cursor": "older" }) },
                }
              }
              await new Promise<void>((resolve) => {
                releaseStalePage = resolve
              })
              return { data: [], response: { headers: new Headers() } }
            },
          },
        }
      },
    } as unknown as Parameters<typeof createDirSyncContext>[2])
    const sessionID = "ses_1"
    const client = userMessage("msg_client", sessionID)
    const canonical = {
      ...userMessage("msg_server", sessionID),
      metadata: {
        deepagent: {
          promptAdmission: {
            clientMessageID: client.id,
          },
        },
      },
    }
    current[1]("session", [current[0].session.length], { id: sessionID })
    sync.session.optimistic.add({ sessionID, message: client, parts: [] })
    await sync.session.sync(sessionID)

    const stale = sync.session.history.loadMore(sessionID)
    await Promise.resolve()
    current[1]("message", sessionID, [canonical])
    releaseStalePage?.()
    await stale

    expect(calls).toBe(2)
    expect(current[0].message[sessionID]?.map((message) => message.id)).toEqual([canonical.id])
  })

  test("preserves a canonical steer when a stale replace page returns after the event", async () => {
    let releaseStalePage: (() => void) | undefined
    const current = state()
    const serverSync = {
      child() {
        return current
      },
      plan: {
        async sync() {},
      },
    } as unknown as Parameters<typeof createDirSyncContext>[1]
    const sync = createDirSyncContext("/repo/main", serverSync, {
      scope: ServerScope.local,
      createClient() {
        return {
          session: {
            async get() {
              return { data: { id: "ses_1" } }
            },
            async messages() {
              await new Promise<void>((resolve) => {
                releaseStalePage = resolve
              })
              return { data: [], response: { headers: new Headers() } }
            },
          },
        }
      },
    } as unknown as Parameters<typeof createDirSyncContext>[2])
    const sessionID = "ses_1"
    const client = userMessage("msg_client", sessionID)
    const canonical = {
      ...userMessage("msg_server", sessionID),
      metadata: {
        deepagent: {
          promptAdmission: {
            clientMessageID: client.id,
          },
        },
      },
    }
    current[1]("session", [current[0].session.length], { id: sessionID })
    sync.session.optimistic.add({ sessionID, message: client, parts: [] })
    const stale = sync.session.sync(sessionID, { force: true })
    await Promise.resolve()
    expect(releaseStalePage).toBeDefined()
    current[1]("message", sessionID, [canonical])
    releaseStalePage?.()
    await stale

    expect(current[0].message[sessionID]?.map((message) => message.id)).toEqual([canonical.id])
  })
})
