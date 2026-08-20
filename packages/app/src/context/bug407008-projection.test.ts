/**
 * BUG-407-008 — spec §7.2 App projection deterministic regression tests (scenarios 20-25,
 * sync/reducer layer). Harness style mirrors ./global-sync/event-reducer.test.ts and
 * ./directory-sync.test.ts.
 *
 * Covered layers:
 *  - `mergeMessage` / `applyDirectoryEvent` (packages/app/src/context/global-sync/event-reducer.ts)
 *    — Fix-D server-owned marker monotonicity + conflict → refetchSession.
 *  - `runInflight` (packages/app/src/context/directory-sync.ts) — keyed trailing forced sync.
 *  - `createDirSyncContext` pagination — deterministic convergence across page order/refresh.
 *
 * Implementation note: the working tree carries a BUG-005 change that classifies a same-activity
 * revision mismatch as staleness (keep the higher revision, no conflict, no forced reload). Tests
 * below pin that actual semantics and annotate where it differs from earlier behavior.
 */
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import type { Message } from "@deepagent-code/sdk/v2/client"
import { ServerScope } from "@/utils/server-scope"
import type { State } from "./global-sync/types"
import { applyDirectoryEvent } from "./global-sync/event-reducer"
import { createDirSyncContext, runInflight } from "./directory-sync"

type AssistantMessage = Extract<Message, { role: "assistant" }>

const baseState = (input: Partial<State> = {}) =>
  ({
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    part: {},
    part_text_accum_delta: {},
    ...input,
  }) as State

const assistantMessage = (
  id: string,
  sessionID: string,
  activityProgress?: AssistantMessage["activityProgress"],
) =>
  ({
    id,
    sessionID,
    role: "assistant",
    parentID: "msg_user",
    time: { created: 1 },
    modelID: "gpt",
    providerID: "openai",
    mode: "build",
    agent: "assistant",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    activityProgress,
  }) as AssistantMessage

const INCIDENT_ACTIVITY = "a6d06b2a82ef234ab9dc71e3fd940292a21b34f4732f28aa19ba8416c4c5e5a9"

const applyMessageUpdated = (
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  info: Message,
  refetchSession?: (sessionID: string) => void,
) =>
  applyDirectoryEvent({
    event: { type: "message.updated", properties: { info } },
    store,
    setStore,
    push() {},
    directory: "/tmp",
    loadLsp() {},
    ...(refetchSession ? { refetchSession } : {}),
  })

const firstAssistant = (store: State, sessionID: string) =>
  store.message[sessionID]?.[0] as AssistantMessage | undefined

describe("BUG-407-008 §7.2 App projection — reducer monotonicity (scenarios 20-22)", () => {
  test("20: revision 8 arrives via SSE first, revision 9 after — latest revision 9 is established", () => {
    const sessionID = "ses_0149b8afffffWlu80cVGdzFI9s"
    const [store, setStore] = createStore(baseState())

    // revision 8's owning assistant message arrives first over the realtime stream.
    applyMessageUpdated(
      store,
      setStore,
      assistantMessage("msg_incident_r8", sessionID, {
        activityID: INCIDENT_ACTIVITY,
        revision: 8,
        state: "progress",
      }),
    )
    // revision 9's owning assistant message arrives afterwards.
    applyMessageUpdated(
      store,
      setStore,
      assistantMessage("msg_incident_r9", sessionID, {
        activityID: INCIDENT_ACTIVITY,
        revision: 9,
        state: "progress",
      }),
    )

    // Both owning messages coexist in the store with their server-owned markers intact; the
    // "only revision 9 is visible" contract is a timeline-layer selection (Fix-E). Fix-E was
    // removed in commit 1ae96499 — see message-timeline.bug407008.test.ts scenario 18 for the
    // pinned actual timeline behavior. At the store layer the latest revision is well-defined:
    expect(store.message[sessionID]?.map((m) => m.id)).toEqual(["msg_incident_r8", "msg_incident_r9"])
    expect((store.message[sessionID]?.[0] as AssistantMessage).activityProgress?.revision).toBe(8)
    expect((store.message[sessionID]?.[1] as AssistantMessage).activityProgress?.revision).toBe(9)
  })

  test("21: revision 9 first, out-of-order revision 8 after — no regression to revision 8", () => {
    const sessionID = "ses_1"
    const current = assistantMessage("msg_assistant", sessionID, {
      activityID: INCIDENT_ACTIVITY,
      revision: 9,
      state: "progress",
    })
    const [store, setStore] = createStore(baseState({ message: { [sessionID]: [current] } }))
    const refreshed: string[] = []

    // A stale event/page replays the SAME owning message with the older revision 8.
    applyMessageUpdated(
      store,
      setStore,
      assistantMessage(current.id, sessionID, {
        activityID: INCIDENT_ACTIVITY,
        revision: 8,
        state: "progress",
      }),
      (id) => refreshed.push(id),
    )

    // The store never regresses to revision 8 ...
    expect(firstAssistant(store, sessionID)?.activityProgress?.revision).toBe(9)
    expect(firstAssistant(store, sessionID)?.activityProgress?.activityID).toBe(INCIDENT_ACTIVITY)
    // ... and, per the working-tree BUG-005 semantics, a same-activity revision mismatch is
    // treated as staleness: it keeps the higher revision WITHOUT escalating to a forced session
    // reload. (Before BUG-005 this same event was a conflict that triggered refetchSession.)
    expect(refreshed).toEqual([])
  })

  test("22: after a terminal marker, marker-less or stale progress events cannot clear or downgrade it", () => {
    const sessionID = "ses_1"
    const terminal = assistantMessage("msg_assistant", sessionID, {
      activityID: INCIDENT_ACTIVITY,
      revision: 10,
      state: "interrupted",
      terminalReason: "user_abort",
    })
    const [store, setStore] = createStore(baseState({ message: { [sessionID]: [terminal] } }))
    const refreshed: string[] = []
    const refetch = (id: string) => refreshed.push(id)

    // (a) A late ordinary update WITHOUT any marker must not clear the terminal marker.
    applyMessageUpdated(store, setStore, { ...terminal, activityProgress: undefined }, refetch)
    expect(firstAssistant(store, sessionID)?.activityProgress).toEqual(terminal.activityProgress)

    // (b) A stale event replaying the same revision as non-terminal `progress` must not downgrade.
    applyMessageUpdated(
      store,
      setStore,
      assistantMessage(terminal.id, sessionID, {
        activityID: INCIDENT_ACTIVITY,
        revision: 10,
        state: "progress",
      }),
      refetch,
    )
    expect(firstAssistant(store, sessionID)?.activityProgress?.state).toBe("interrupted")
    expect(firstAssistant(store, sessionID)?.activityProgress?.terminalReason).toBe("user_abort")

    // (c) An even older revision's progress event cannot displace the terminal revision either.
    applyMessageUpdated(
      store,
      setStore,
      assistantMessage(terminal.id, sessionID, {
        activityID: INCIDENT_ACTIVITY,
        revision: 8,
        state: "progress",
      }),
      refetch,
    )
    expect(firstAssistant(store, sessionID)?.activityProgress?.revision).toBe(10)
    expect(firstAssistant(store, sessionID)?.activityProgress?.state).toBe("interrupted")
    // None of these are integrity conflicts, so no forced reload is requested.
    expect(refreshed).toEqual([])
  })
})

describe("BUG-407-008 §7.2 App projection — trailing forced sync (scenarios 23-24)", () => {
  test("23: conflict during an in-flight ordinary sync keeps canonical and runs one trailing forced sync after commit", async () => {
    const sessionID = "ses_1"
    const canonical = assistantMessage("msg_assistant", sessionID, {
      activityID: INCIDENT_ACTIVITY,
      revision: 9,
      state: "progress",
    })
    const [store, setStore] = createStore(baseState({ message: { [sessionID]: [canonical] } }))

    // Simulated durable read source: the authority commit flips this flag while the ordinary
    // sync is still in flight; only the trailing forced sync may observe the committed state.
    let authorityCommitted = false
    const reads: Array<{ run: number; sawCommittedState: boolean }> = []
    let runs = 0
    let gate: (() => void) | undefined
    const task = async () => {
      runs += 1
      const run = runs
      // The read happens at sync start — the ordinary sync reads BEFORE the authority commit,
      // while the trailing forced sync reads after it.
      reads.push({ run, sawCommittedState: authorityCommitted })
      if (run === 1) {
        // The ordinary sync is still in flight when the conflict arrives.
        await new Promise<void>((resolve) => {
          gate = resolve
        })
      }
    }

    const inflight = new Map<string, Promise<void>>()
    const trailing = new Set<string>()
    let forced: Promise<void> | undefined
    // Mirrors directory-sync wiring: refetchSession -> session.sync(sessionID, { force: true }),
    // implemented via keyed runInflight so a forced call during an in-flight sync becomes a
    // trailing forced sync instead of being swallowed.
    const refetchSession = (id: string) => {
      forced = runInflight(inflight, trailing, id, true, task)
    }

    const ordinary = runInflight(inflight, trailing, sessionID, false, task)
    await Promise.resolve()
    expect(runs).toBe(1)

    // Authority commit happens, then the conflicting marker event arrives mid-flight.
    applyMessageUpdated(
      store,
      setStore,
      assistantMessage(canonical.id, sessionID, {
        activityID: "activity-other",
        revision: 0,
        state: "final",
      }),
      refetchSession,
    )

    // Canonical marker is preserved against the conflicting incoming marker ...
    expect(firstAssistant(store, sessionID)?.activityProgress).toEqual(canonical.activityProgress)
    // ... and the conflict requested a refetch that was queued, not executed yet.
    expect(forced).toBeDefined()
    expect(runs).toBe(1)
    expect(trailing.has(sessionID)).toBe(true)

    // The authority commit lands while the ordinary sync is still running.
    authorityCommitted = true
    gate?.()
    await ordinary
    await forced

    // Exactly one trailing forced sync ran, and its read happened AFTER the commit.
    expect(runs).toBe(2)
    expect(reads).toEqual([
      { run: 1, sawCommittedState: false },
      { run: 2, sawCommittedState: true },
    ])
    expect(trailing.size).toBe(0)
  })

  test("24: multiple conflicts in the same window coalesce into exactly one trailing forced sync, no loop", async () => {
    const sessionID = "ses_1"
    let runs = 0
    let gate: (() => void) | undefined
    const task = async () => {
      runs += 1
      if (runs === 1) {
        await new Promise<void>((resolve) => {
          gate = resolve
        })
      }
    }
    const inflight = new Map<string, Promise<void>>()
    const trailing = new Set<string>()

    // Ordinary sync already in flight ...
    const ordinary = runInflight(inflight, trailing, sessionID, false, task)
    await Promise.resolve()
    expect(runs).toBe(1)

    // ... then the SAME session receives several marker conflicts inside that window. Each one
    // asks for a forced refetch (as applyDirectoryEvent would via refetchSession).
    const forced = [
      runInflight(inflight, trailing, sessionID, true, task),
      runInflight(inflight, trailing, sessionID, true, task),
      runInflight(inflight, trailing, sessionID, true, task),
    ]
    await Promise.resolve()
    // The in-flight ordinary Promise must not swallow them: a trailing run is armed.
    expect(trailing.has(sessionID)).toBe(true)
    expect(runs).toBe(1)

    gate?.()
    await Promise.all([ordinary, ...forced])

    // Exactly ONE trailing forced sync executed (ordinary + trailing = 2 runs total).
    expect(runs).toBe(2)
    expect(trailing.size).toBe(0)

    // No retry loop: after settling, nothing else runs.
    for (let attempt = 0; attempt < 50; attempt += 1) await Promise.resolve()
    expect(runs).toBe(2)
    expect(trailing.size).toBe(0)
  })
})

describe("BUG-407-008 §7.2 App projection — pagination determinism (scenario 25)", () => {
  test("25: newest-first paging, refresh and reconnect all converge to the same projection", async () => {
    await createRoot(async (dispose) => {
      const sessionID = "ses_0149b8afffffWlu80cVGdzFI9s"
      const newest = assistantMessage("msg_incident_new", sessionID, {
        activityID: INCIDENT_ACTIVITY,
        revision: 9,
        state: "progress",
      })
      const older = assistantMessage("msg_incident_old", sessionID, {
        activityID: INCIDENT_ACTIVITY,
        revision: 8,
        state: "progress",
      })

      const state = () =>
        createStore({
          path: { directory: "/repo" },
          session: [] as Array<{ id: string }>,
          mcp: {},
          message: {} as Record<string, Message[] | undefined>,
          part: {} as Record<string, unknown[] | undefined>,
          part_text_accum_delta: {} as Record<string, string | undefined>,
          todo: {} as Record<string, unknown[] | undefined>,
          session_diff: {} as Record<string, unknown[] | undefined>,
          session_status: {} as Record<string, unknown | undefined>,
          permission: {} as Record<string, unknown[] | undefined>,
          question: {} as Record<string, unknown[] | undefined>,
        })
      const current = state()
      const serverSync = {
        child() {
          return current
        },
        plan: {
          async sync() {},
        },
      } as unknown as Parameters<typeof createDirSyncContext>[1]

      let messageCalls = 0
      const sync = createDirSyncContext("/repo/main", serverSync, {
        scope: ServerScope.local,
        createClient() {
          return {
            session: {
              async get() {
                return { data: { id: sessionID } }
              },
              // Durable authority: the newest page (revision 9) is served first with a cursor to
              // the older page (revision 8); the older page has no further cursor.
              async messages(input: { limit: number; before?: string }) {
                messageCalls += 1
                if (input.before === "cursor-old") {
                  return { data: [{ info: older, parts: [] }], response: { headers: new Headers() } }
                }
                return {
                  data: [{ info: newest, parts: [] }],
                  response: { headers: new Headers({ "x-next-cursor": "cursor-old" }) },
                }
              },
            },
          }
        },
      } as unknown as Parameters<typeof createDirSyncContext>[2])

      const snapshot = () =>
        JSON.parse(
          JSON.stringify(
            (current[0].message[sessionID] ?? []).map((message) => ({
              id: message.id,
              progress: message.role === "assistant" ? message.activityProgress ?? null : null,
            })),
          ),
        )

      current[1]("session", [current[0].session.length], { id: sessionID })

      // Pass 1: load the newest page first, then page backwards to the older page.
      await sync.session.sync(sessionID)
      await sync.session.history.loadMore(sessionID)
      const afterPaging = snapshot()
      expect(afterPaging).toEqual([
        { id: newest.id, progress: newest.activityProgress },
        { id: older.id, progress: older.activityProgress },
      ])

      // Pass 2: refresh/reconnect — evict all in-memory caches and rebuild from HTTP pages.
      sync.session.evict(sessionID)
      expect(current[0].message[sessionID]).toBeUndefined()
      await sync.session.sync(sessionID, { force: true })
      await sync.session.history.loadMore(sessionID)
      const afterReconnect = snapshot()

      // Identical projection regardless of page arrival order and cache state.
      expect(afterReconnect).toEqual(afterPaging)
      // Both pages were served twice (newest + older per pass); nothing else was fetched.
      expect(messageCalls).toBe(4)
      dispose()
    })
  })
})
