import { describe, expect, test } from "bun:test"
import type { Message, Part, PermissionRequest, Project, QuestionRequest, Session } from "@deepagent-code/sdk/v2/client"
import { createRoot } from "solid-js"
import { isServer } from "solid-js/web"
import { createStore, reconcile, unwrap } from "solid-js/store"
import type { SessionGoal, SessionPlan, State } from "./types"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./event-reducer"

const rootSession = (input: { id: string; parentID?: string; archived?: number }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    time: {
      created: 1,
      updated: 1,
      archived: input.archived,
    },
  }) as Session

const userMessage = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt" },
  }) as Message

const assistantMessage = (
  id: string,
  sessionID: string,
  activityProgress?: Extract<Message, { role: "assistant" }>["activityProgress"],
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
  }) as Extract<Message, { role: "assistant" }>

const textPart = (id: string, sessionID: string, messageID: string) =>
  ({
    id,
    sessionID,
    messageID,
    type: "text",
    text: id,
  }) as Part

const permissionRequest = (id: string, sessionID: string, title = id) =>
  ({
    id,
    sessionID,
    permission: title,
    patterns: ["*"],
    metadata: {},
    always: [],
  }) as PermissionRequest

const questionRequest = (id: string, sessionID: string, title = id) =>
  ({
    id,
    sessionID,
    questions: [
      {
        question: title,
        header: title,
        options: [{ label: title, description: title }],
      },
    ],
  }) as QuestionRequest

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

describe("applyGlobalEvent", () => {
  test("upserts project.updated in sorted position", () => {
    const project = [{ id: "a" }, { id: "c" }] as Project[]
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "project.updated", properties: { id: "b" } },
      project,
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject(next) {
        if (typeof next === "function") next(project)
      },
    })

    expect(project.map((x) => x.id)).toEqual(["a", "b", "c"])
    expect(refreshCount).toBe(0)
  })

  test("handles global.disposed by triggering refresh", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "global.disposed" },
      project: [],
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject() {},
    })

    expect(refreshCount).toBe(1)
  })

  test("handles server.connected by triggering refresh", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "server.connected" },
      project: [],
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject() {},
    })

    expect(refreshCount).toBe(1)
  })
})

describe("applyDirectoryEvent", () => {
  test("preserves a Home-specific retained session limit", () => {
    const [store, setStore] = createStore(
      baseState({
        limit: 1,
        session: [rootSession({ id: "a" }), rootSession({ id: "b" }), rootSession({ id: "c" })],
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "d" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      retainedLimit: 3,
    })

    expect(store.session).toHaveLength(3)
  })

  test("inserts root sessions in sorted order and updates sessionTotal", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "b" })],
        sessionTotal: 1,
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "a" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual(["a", "b"])
    expect(store.sessionTotal).toBe(2)

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "c", parentID: "a" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.sessionTotal).toBe(2)
  })

  test("cleans session caches when archived", () => {
    const message = userMessage("msg_1", "ses_1")
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_1" }), rootSession({ id: "ses_2" })],
        sessionTotal: 2,
        message: { ses_1: [message] },
        part: { [message.id]: [textPart("prt_1", "ses_1", message.id)] },
        session_diff: { ses_1: [] },
        todo: { ses_1: [] },
        permission: { ses_1: [] },
        question: { ses_1: [] },
        session_status: { ses_1: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_1", archived: 10 }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual(["ses_2"])
    expect(store.sessionTotal).toBe(1)
    expect(store.message.ses_1).toBeUndefined()
    expect(store.part[message.id]).toBeUndefined()
    expect(store.session_diff.ses_1).toBeUndefined()
    expect(store.todo.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
    expect(store.question.ses_1).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
  })

  test("archive then restore returns sessionTotal to its original value", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_1" }), rootSession({ id: "ses_2" })],
        sessionTotal: 2,
      }),
    )

    // Archive ses_1: removed from the list, sessionTotal drops.
    applyDirectoryEvent({
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_1", archived: 10 }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual(["ses_2"])
    expect(store.sessionTotal).toBe(1)

    // Restore ses_1 (archived cleared): re-inserted, sessionTotal returns to the original value.
    applyDirectoryEvent({
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_1" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual(["ses_1", "ses_2"])
    expect(store.sessionTotal).toBe(2)
  })

  test("restoring a child session does not increment sessionTotal", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_1" })],
        sessionTotal: 1,
      }),
    )

    // A child session (parentID set) re-appearing via session.updated must not touch the counter.
    applyDirectoryEvent({
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_2", parentID: "ses_1" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.sessionTotal).toBe(1)
  })

  test("cleans session caches when deleted and decrements only root totals", () => {
    const cases = [
      { info: rootSession({ id: "ses_1" }), expectedTotal: 1 },
      { info: rootSession({ id: "ses_2", parentID: "ses_1" }), expectedTotal: 2 },
    ]

    for (const item of cases) {
      const message = userMessage("msg_1", item.info.id)
      const [store, setStore] = createStore(
        baseState({
          session: [
            rootSession({ id: "ses_1" }),
            rootSession({ id: "ses_2", parentID: "ses_1" }),
            rootSession({ id: "ses_3" }),
          ],
          sessionTotal: 2,
          message: { [item.info.id]: [message] },
          part: { [message.id]: [textPart("prt_1", item.info.id, message.id)] },
          session_diff: { [item.info.id]: [] },
          todo: { [item.info.id]: [] },
          permission: { [item.info.id]: [] },
          question: { [item.info.id]: [] },
          session_status: { [item.info.id]: { type: "busy" } },
        }),
      )

      applyDirectoryEvent({
        event: { type: "session.deleted", properties: { info: item.info } },
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
      })

      expect(store.session.find((x) => x.id === item.info.id)).toBeUndefined()
      expect(store.sessionTotal).toBe(item.expectedTotal)
      expect(store.message[item.info.id]).toBeUndefined()
      expect(store.part[message.id]).toBeUndefined()
      expect(store.session_diff[item.info.id]).toBeUndefined()
      expect(store.todo[item.info.id]).toBeUndefined()
      expect(store.permission[item.info.id]).toBeUndefined()
      expect(store.question[item.info.id]).toBeUndefined()
      expect(store.session_status[item.info.id]).toBeUndefined()
    }
  })

  test("cleans caches for trimmed sessions on session.created", () => {
    const dropped = rootSession({ id: "ses_b" })
    const kept = rootSession({ id: "ses_a" })
    const message = userMessage("msg_1", dropped.id)
    const [store, setStore] = createStore(
      baseState({
        limit: 1,
        session: [dropped],
        message: { [dropped.id]: [message] },
        part: { [message.id]: [textPart("prt_1", dropped.id, message.id)] },
        session_diff: { [dropped.id]: [] },
        todo: { [dropped.id]: [] },
        permission: { [dropped.id]: [] },
        question: { [dropped.id]: [] },
        session_status: { [dropped.id]: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: kept } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual([kept.id])
    expect(store.message[dropped.id]).toBeUndefined()
    expect(store.part[message.id]).toBeUndefined()
    expect(store.session_diff[dropped.id]).toBeUndefined()
    expect(store.todo[dropped.id]).toBeUndefined()
    expect(store.permission[dropped.id]).toBeUndefined()
    expect(store.question[dropped.id]).toBeUndefined()
    expect(store.session_status[dropped.id]).toBeUndefined()
  })

  test("cleanupDroppedSessionCaches clears part-only orphan state", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_keep" })],
        part: { msg_1: [textPart("prt_1", "ses_drop", "msg_1")] },
      }),
    )

    cleanupDroppedSessionCaches(store, setStore, store.session)

    expect(store.part.msg_1).toBeUndefined()
  })

  test("upserts and removes messages while clearing orphaned parts", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_3", sessionID)] },
        part: { msg_2: [textPart("prt_1", sessionID, "msg_2")] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: userMessage("msg_2", sessionID) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_2", "msg_3"])

    applyDirectoryEvent({
      event: {
        type: "message.updated",
        properties: {
          info: {
            ...userMessage("msg_2", sessionID),
            role: "assistant",
          } as unknown as Message,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.find((x) => x.id === "msg_2")?.role).toBe("assistant")

    applyDirectoryEvent({
      event: { type: "message.removed", properties: { sessionID, messageID: "msg_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_3"])
    expect(store.part.msg_2).toBeUndefined()
  })

  test("replaces a retained optimistic steer when its canonical event arrives", () => {
    const sessionID = "ses_1"
    const clientMessageID = "msg_client"
    const canonical = {
      ...userMessage("msg_server", sessionID),
      metadata: {
        deepagent: {
          promptAdmission: {
            clientMessageID,
          },
        },
      },
    } as Message
    const clientPart = textPart("prt_client", sessionID, clientMessageID)
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [userMessage(clientMessageID, sessionID)] },
        part: { [clientMessageID]: [clientPart] },
        part_text_accum_delta: { [clientPart.id]: "pending" },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: canonical } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((message) => message.id)).toEqual([canonical.id])
    expect(store.message[sessionID]).toHaveLength(1)
    expect(store.part[clientMessageID]).toBeUndefined()
    expect(store.part_text_accum_delta[clientPart.id]).toBeUndefined()
  })

  test("preserves server-owned activity progress when a stale message update omits it", () => {
    const sessionID = "ses_1"
    const current = assistantMessage("msg_assistant", sessionID, {
      activityID: "activity-1",
      revision: 2,
      state: "final",
    })
    const [store, setStore] = createStore(baseState({ message: { [sessionID]: [current] } }))

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: { ...current, activityProgress: undefined } } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect((store.message[sessionID]?.[0] as Extract<Message, { role: "assistant" }>).activityProgress).toEqual(
      current.activityProgress,
    )
  })

  test("rejects conflicting progress identity and requests a canonical session refresh", () => {
    const sessionID = "ses_1"
    const current = assistantMessage("msg_assistant", sessionID, {
      activityID: "activity-1",
      revision: 2,
      state: "progress",
    })
    const [store, setStore] = createStore(baseState({ message: { [sessionID]: [current] } }))
    const refreshed: string[] = []

    applyDirectoryEvent({
      event: {
        type: "message.updated",
        properties: {
          info: assistantMessage(current.id, sessionID, {
            activityID: "activity-other",
            revision: 0,
            state: "final",
          }),
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      refetchSession: (id) => refreshed.push(id),
    })

    expect((store.message[sessionID]?.[0] as Extract<Message, { role: "assistant" }>).activityProgress).toEqual(
      current.activityProgress,
    )
    expect(refreshed).toEqual([sessionID])
  })

  test("BUG-005: treats a same-activity revision mismatch as staleness, not a conflict", () => {
    const sessionID = "ses_1"
    const current = assistantMessage("msg_assistant", sessionID, {
      activityID: "activity-1",
      revision: 5,
      state: "progress",
    })
    const [store, setStore] = createStore(baseState({ message: { [sessionID]: [current] } }))
    const refreshed: string[] = []
    const apply = (revision: number, state: "progress" | "final") =>
      applyDirectoryEvent({
        event: {
          type: "message.updated",
          properties: {
            info: assistantMessage(current.id, sessionID, {
              activityID: "activity-1",
              revision,
              state,
            }),
          },
        },
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
        refetchSession: (id) => refreshed.push(id),
      })

    // A stale page/event carrying an older revision must keep the higher one and never escalate.
    apply(2, "progress")
    expect(refreshed).toEqual([])
    expect(
      (store.message[sessionID]?.[0] as Extract<Message, { role: "assistant" }>).activityProgress?.revision,
    ).toBe(5)

    // A newer revision is adopted without triggering a canonical refresh either.
    apply(7, "final")
    expect(refreshed).toEqual([])
    const progress = (store.message[sessionID]?.[0] as Extract<Message, { role: "assistant" }>).activityProgress
    expect(progress?.revision).toBe(7)
    expect(progress?.state).toBe("final")
  })

  test("allows a same-revision activity marker to advance but never regress", () => {
    const sessionID = "ses_1"
    const provisional = assistantMessage("msg_assistant", sessionID, {
      activityID: "activity-1",
      revision: 0,
      state: "provisional",
    })
    const [store, setStore] = createStore(baseState({ message: { [sessionID]: [provisional] } }))
    const apply = (state: "progress" | "final" | "provisional") =>
      applyDirectoryEvent({
        event: {
          type: "message.updated",
          properties: {
            info: assistantMessage(provisional.id, sessionID, {
              activityID: "activity-1",
              revision: 0,
              state,
            }),
          },
        },
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
      })

    apply("progress")
    apply("final")
    apply("provisional")

    expect((store.message[sessionID]?.[0] as Extract<Message, { role: "assistant" }>).activityProgress?.state).toBe(
      "final",
    )
  })

  test("rejects an invalid activity marker and requests a canonical session refresh", () => {
    const sessionID = "ses_1"
    const current = assistantMessage("msg_assistant", sessionID)
    const [store, setStore] = createStore(baseState({ message: { [sessionID]: [current] } }))
    const refreshed: string[] = []

    applyDirectoryEvent({
      event: {
        type: "message.updated",
        properties: {
          info: {
            ...current,
            activityProgress: { activityID: "", revision: -1, state: "terminal" },
          } as unknown as Message,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      refetchSession: (id) => refreshed.push(id),
    })

    expect((store.message[sessionID]?.[0] as Extract<Message, { role: "assistant" }>).activityProgress).toBeUndefined()
    expect(refreshed).toEqual([sessionID])
  })

  test("upserts and prunes message parts", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const [store, setStore] = createStore(
      baseState({
        part: { [messageID]: [textPart("prt_1", sessionID, messageID), textPart("prt_3", sessionID, messageID)] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.part.updated", properties: { part: textPart("prt_2", sessionID, messageID) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.part[messageID]?.map((x) => x.id)).toEqual(["prt_1", "prt_2", "prt_3"])

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            ...textPart("prt_2", sessionID, messageID),
            text: "changed",
          } as Part,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    const updated = store.part[messageID]?.find((x) => x.id === "prt_2")
    expect(updated?.type).toBe("text")
    if (updated?.type === "text") expect(updated.text).toBe("changed")

    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_1" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_3" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.part[messageID]).toBeUndefined()
  })

  test("tracks permission and question request lifecycles", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        permission: { [sessionID]: [permissionRequest("perm_1", sessionID), permissionRequest("perm_3", sessionID)] },
        question: { [sessionID]: [questionRequest("q_1", sessionID), questionRequest("q_3", sessionID)] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "permission.asked", properties: permissionRequest("perm_2", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.map((x) => x.id)).toEqual(["perm_1", "perm_2", "perm_3"])

    applyDirectoryEvent({
      event: { type: "permission.asked", properties: permissionRequest("perm_2", sessionID, "updated") },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.find((x) => x.id === "perm_2")?.permission).toBe("updated")

    applyDirectoryEvent({
      event: { type: "permission.replied", properties: { sessionID, requestID: "perm_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.map((x) => x.id)).toEqual(["perm_1", "perm_3"])

    applyDirectoryEvent({
      event: { type: "question.asked", properties: questionRequest("q_2", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.map((x) => x.id)).toEqual(["q_1", "q_2", "q_3"])

    applyDirectoryEvent({
      event: { type: "question.asked", properties: questionRequest("q_2", sessionID, "updated") },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.find((x) => x.id === "q_2")?.questions[0]?.header).toBe("updated")

    applyDirectoryEvent({
      event: { type: "question.rejected", properties: { sessionID, requestID: "q_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.map((x) => x.id)).toEqual(["q_1", "q_3"])
  })

  test("updates vcs branch in store and cache", () => {
    const [store, setStore] = createStore(baseState({ vcs: { branch: "main", default_branch: "main" } }))
    const [cacheStore, setCacheStore] = createStore({
      value: { branch: "main", default_branch: "main" } as State["vcs"],
    })

    applyDirectoryEvent({
      event: { type: "vcs.branch.updated", properties: { branch: "feature/test" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      vcsCache: {
        store: cacheStore,
        setStore: setCacheStore,
        ready: () => true,
      },
    })

    expect(store.vcs).toEqual({ branch: "feature/test", default_branch: "main" })
    expect(cacheStore.value).toEqual({ branch: "feature/test", default_branch: "main" })
  })

  test("routes disposal and lsp events to side-effect handlers", () => {
    const [store, setStore] = createStore(baseState())
    const pushes: string[] = []
    let lspLoads = 0

    applyDirectoryEvent({
      event: { type: "server.instance.disposed" },
      store,
      setStore,
      push(directory) {
        pushes.push(directory)
      },
      directory: "/tmp",
      loadLsp() {
        lspLoads += 1
      },
    })

    applyDirectoryEvent({
      event: { type: "lsp.updated" },
      store,
      setStore,
      push(directory) {
        pushes.push(directory)
      },
      directory: "/tmp",
      loadLsp() {
        lspLoads += 1
      },
    })

    expect(pushes).toEqual(["/tmp"])
    expect(lspLoads).toBe(1)
  })
})

// provider lifecycle root cause B: the 6-byte ID time field wrapped on 2026-08-14, so chronologically
// NEWER messages/parts carry lexicographically SMALLER IDs (`msg_00...` < `msg_ff...`). Realtime
// inserts must keep (time, id) chronological order instead of ID order.
describe("message ordering across the ID time wrap (provider lifecycle)", () => {
  const WRAP_OLD_ID = "msg_ffa88f0840015Xj7vIrcdNEJJB" // 2026-08-13 17:51:46
  const WRAP_NEW_ID = "msg_00d62a3c4001KqYw3o8wBBH6qm" // 2026-08-17 09:42:43
  const WRAP_OLD_TIME = 1786614706000
  const WRAP_NEW_TIME = 1786930963000

  const timedUserMessage = (id: string, sessionID: string, created: number) =>
    ({ ...userMessage(id, sessionID), time: { created } }) as Message

  const timedTextPart = (id: string, sessionID: string, messageID: string, start: number) =>
    ({
      id,
      sessionID,
      messageID,
      type: "text",
      text: id,
      time: { start },
    }) as Part

  test("message.updated appends a chronologically newer msg_00... after the older msg_ff...", () => {
    const sessionID = "ses_1"
    expect(WRAP_NEW_ID < WRAP_OLD_ID).toBe(true) // sanity: raw ID order is reversed
    const [store, setStore] = createStore(
      baseState({ message: { [sessionID]: [timedUserMessage(WRAP_OLD_ID, sessionID, WRAP_OLD_TIME)] } }),
    )

    applyDirectoryEvent({
      event: {
        type: "message.updated",
        properties: { info: timedUserMessage(WRAP_NEW_ID, sessionID, WRAP_NEW_TIME) },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((message) => message.id)).toEqual([WRAP_OLD_ID, WRAP_NEW_ID])

    // Identity-based removal still works in a (time, id)-ordered array.
    applyDirectoryEvent({
      event: { type: "message.removed", properties: { sessionID, messageID: WRAP_OLD_ID } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((message) => message.id)).toEqual([WRAP_NEW_ID])
  })

  test("message.part.updated appends a chronologically newer wrapped part at the tail", () => {
    const sessionID = "ses_1"
    const messageID = WRAP_NEW_ID
    const oldPart = timedTextPart("prt_ffa88f084001aaaa", sessionID, messageID, WRAP_OLD_TIME)
    const newPart = timedTextPart("prt_00d62a3c4001bbbb", sessionID, messageID, WRAP_NEW_TIME)
    expect(newPart.id < oldPart.id).toBe(true) // sanity: raw ID order is reversed
    const [store, setStore] = createStore(baseState({ part: { [messageID]: [oldPart] } }))

    applyDirectoryEvent({
      event: { type: "message.part.updated", properties: { part: newPart } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.part[messageID]?.map((part) => part.id)).toEqual([oldPart.id, newPart.id])
  })
})

// Regression guard for the plan panel. The model pushes repeated plan.updated events that advance
// step statuses; the reducer feeds them into a per-session plan store via reconcile. The previous
// code used `{ key: "plan_id" }`, which reconcile applies recursively to the nested `steps[]` array
// — but a step's identity field is `step_id`, not `plan_id`, so every step resolved to
// `key=undefined`.
//
// IMPORTANT (verified against solid-js@1.9.10): the wrong key does NOT drop status updates — field
// values land correctly under plan_id, step_id, or null alike (see the status-advance test below,
// which passes under all three keys). The only behavioural difference is per-step PROXY IDENTITY on
// reorder, and even that is invisible to the current UI: the dock renders via <Index> (positional)
// over plain objects the `planAsTodos` memo re-creates every tick, so store-proxy identity is never
// consumed by the render. `key: "step_id"` is therefore the correct minimal-diff choice on data-
// contract grounds (field-level updates instead of whole-object replace, correct identity if the
// render ever moves to a keyed <For>), not a fix for a reproducible "stuck" symptom at this layer.
// The status-advance test IS the meaningful CI regression guard; the identity test below only
// documents the proxy-identity contract and requires --conditions=browser (see its comment).
describe("plan.updated reconcile (session_plan)", () => {
  const planEvent = (
    sessionID: string,
    steps: Array<[step_id: string, status: string]>,
    activeStepID: string | null,
  ) => ({
    type: "plan.updated",
    properties: {
      sessionID,
      plan_id: "plan_1",
      plan_version: 1,
      goal: "ship it",
      assumptions: ["CI"],
      active_step_id: activeStepID,
      steps: steps.map(([step_id, status]) => ({ step_id, title: step_id.toUpperCase(), status })),
      done: steps.filter(([, status]) => status === "done").length,
      total: steps.length,
    },
  })

  // Mirror the real setSessionPlan writer in server-sync.tsx: session_plan[sid] = reconcile(plan, ...).
  const makeSetSessionPlan = (
    setPlanStore: (path: "sp", sid: string, value: unknown) => void,
    key: string | null,
  ) => {
    return (sessionID: string, plan: SessionPlan | undefined) => {
      if (!plan) return
      setPlanStore("sp", sessionID, reconcile(plan, { key }) as never)
    }
  }

  const dispatch = (setStore: any, store: any, setSessionPlan: any, event: any) => {
    applyDirectoryEvent({
      event,
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      setSessionPlan,
    })
  }

  test("two consecutive plan.updated events advance step status through the reducer", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore(baseState())
      const [planStore, setPlanStore] = createStore<{ sp: Record<string, SessionPlan> }>({ sp: {} })
      const setSessionPlan = makeSetSessionPlan(setPlanStore as never, "step_id")

      // First plan.updated: step "a" is active, the rest pending.
      dispatch(setStore, store, setSessionPlan, planEvent("ses_1", [["a", "active"], ["b", "pending"], ["c", "pending"]], "a"))
      expect(planStore.sp.ses_1.steps.map((s) => s.status)).toEqual(["active", "pending", "pending"])
      expect(planStore.sp.ses_1.plan_version).toBe(1)
      expect(planStore.sp.ses_1.assumptions).toEqual(["CI"])

      // Second plan.updated: same plan_id, "a" done and "b" now active. This is the event the old
      // code effectively dropped from the panel's point of view.
      dispatch(setStore, store, setSessionPlan, planEvent("ses_1", [["a", "done"], ["b", "active"], ["c", "pending"]], "b"))
      expect(planStore.sp.ses_1.steps.map((s) => s.status)).toEqual(["done", "active", "pending"])

      // Third advance, to be thorough.
      dispatch(setStore, store, setSessionPlan, planEvent("ses_1", [["a", "done"], ["b", "done"], ["c", "active"]], "c"))
      expect(planStore.sp.ses_1.steps.map((s) => s.status)).toEqual(["done", "done", "active"])
      expect(planStore.sp.ses_1.active_step_id).toBe("c")
      expect(planStore.sp.ses_1.done).toBe(2)

      dispose()
    })
  })

  // Per-step proxy identity across reorder only manifests under the CLIENT (browser) build of
  // Solid's store; the SSR build never retains proxy identity, so this assertion is only meaningful
  // under `--conditions=browser`. CI GAP: the package `test`/`test:ci` scripts run SSR-only, so this
  // test is skipped in CI today. It is NOT a user-visible regression guard — the dock renders steps
  // positionally via <Index> over memo-recreated plain objects, so proxy identity never reaches the
  // render. It documents the reconcile identity contract for a future keyed-<For> render only. To
  // exercise it locally: `bun test --conditions=browser --preload ./happydom.ts <this file>`.
  test.skipIf(isServer)("keying by step_id preserves per-step identity across reorder", () => {
    const mk = (rows: Array<[string, string]>): SessionPlan => ({
      plan_id: "plan_1",
      plan_version: 1,
      goal: "g",
      assumptions: [],
      active_step_id: rows[0]?.[0] ?? null,
      steps: rows.map(([step_id, status]) => ({ step_id, title: step_id.toUpperCase(), status })),
      done: rows.filter(([, s]) => s === "done").length,
      total: rows.length,
    })

    const identityStable = (key: string) =>
      createRoot((dispose) => {
        const [store, setStore] = createStore<{ p?: SessionPlan }>({})
        setStore("p", reconcile(mk([["a", "active"], ["b", "pending"]]), { key }))
        const before = unwrap(store.p!.steps.find((s) => s.step_id === "a")!)
        setStore("p", reconcile(mk([["b", "active"], ["a", "done"]]), { key }))
        const after = unwrap(store.p!.steps.find((s) => s.step_id === "a")!)
        dispose()
        return before === after
      })

    // The fix keys by step_id and keeps a step's identity stable when the array reorders.
    expect(identityStable("step_id")).toBe(true)
    // The old (buggy) key does not.
    expect(identityStable("plan_id")).toBe(false)
  })
})

// NOTE: the `todo.updated reconcile` describe block was removed here. Task tracking is unified onto
// the plan system: the backend no longer emits `todo.updated` (both todowrite tool writers were
// removed) and the reducer no longer handles it. The plan panel's live-update coverage lives in the
// `plan.updated reconcile (session_plan)` describe block below.

// V3.9 §D: the goal.updated event feeds the live Goal status bar via a session_goal store (analogous
// to session_plan). Verifies the reducer routes the payload to setSessionGoal and that consecutive
// ticks advance the phase + ledger.
describe("goal.updated reducer (session_goal)", () => {
  const goalEvent = (sessionID: string, phase: string, tokens: number) => ({
    type: "goal.updated",
    properties: {
      sessionID,
      goalId: "goal_1",
      planDocId: "plan_1",
      phase,
      ledger: { ticks: tokens / 10, tokens, cost: 0, wallclockMs: 1000 },
      stallCount: 0,
      gaps: phase === "needs_human" ? ["reviewer_clean unmet"] : [],
    },
  })

  const dispatch = (setSessionGoal: (sid: string, g: SessionGoal | undefined) => void, event: unknown) => {
    const [store, setStore] = createStore(baseState())
    applyDirectoryEvent({
      event: event as never,
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      setSessionGoal,
    })
  }

  test("routes goal.updated to setSessionGoal and advances phase + ledger", () => {
    createRoot((dispose) => {
      const [goalStore, setGoalStore] = createStore<{ g: Record<string, SessionGoal> }>({ g: {} })
      const setSessionGoal = (sid: string, goal: SessionGoal | undefined) => {
        if (!goal) return
        setGoalStore("g", sid, reconcile(goal) as never)
      }

      dispatch(setSessionGoal, goalEvent("ses_1", "running", 10))
      expect(goalStore.g.ses_1.phase).toBe("running")
      expect(goalStore.g.ses_1.ledger.tokens).toBe(10)

      dispatch(setSessionGoal, goalEvent("ses_1", "running", 120))
      expect(goalStore.g.ses_1.ledger.tokens).toBe(120)

      dispatch(setSessionGoal, goalEvent("ses_1", "needs_human", 200))
      expect(goalStore.g.ses_1.phase).toBe("needs_human")
      expect(goalStore.g.ses_1.gaps).toEqual(["reviewer_clean unmet"])

      dispose()
    })
  })
})
