import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Config, DeepAgentCodeClient, Path, Project } from "@deepagent-code/sdk/client"
import type { NormalizedProviderListResponse } from "@deepagent-code/ui/context"
import { bootstrapDirectory, loadPathQuery, loadProvidersQuery } from "./bootstrap"
import { applyDirectoryEvent } from "./event-reducer"
import type { State, VcsCache } from "./types"
import { ServerScope } from "@/utils/server-scope"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

function pathFixture(directory = "/project"): Path {
  return {
    home: "/home",
    data: "",
    cache: "",
    state: "",
    tmp: "",
    log: "",
    repos: "",
    config: "",
    worktree: directory,
    directory,
    agent: {
      schemaVersion: "deepagent_generic_agent_runtime.v1",
      mode: "unavailable",
      agentMode: "general",
      implementation: "visible_skeleton",
      agentManaged: false,
      originalPathAllowed: true,
      providerExecutedToolPolicy: "deny_by_default",
      knowledgeEnabled: false,
      directories: {
        data: "",
        cache: "",
        state: "",
        tmp: "",
        runs: "",
        artifacts: "",
        output: "",
        log: "",
      },
      coverage: [],
    },
  }
}

describe("bootstrapDirectory", () => {
  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const mcpReads: string[] = []
    const [store, setStore] = createStore<State>({
      status: "loading",
      agent: [],
      command: [],
      project: "",
      projectMeta: undefined,
      icon: undefined,
      provider_ready: true,
      provider,
      config: {},
      path: pathFixture(),
      session: [],
      sessionTotal: 0,
      session_status: {},
      session_working(id: string) {
        return this.session_status[id]?.type !== "idle"
      },
      session_diff: {},
      todo: {},
      permission: {},
      permission_v2: {},
      question_v2: {},
      question: {},
      mcp_ready: true,
      mcp: {},
      lsp_ready: true,
      lsp: [],
      vcs: undefined,
      limit: 5,
      message: {},
      part: {},
      part_text_accum_delta: {},
    })

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: pathFixture(),
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: {
          list: async () => {
            mcpReads.push("command")
            return { data: [] }
          },
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        mcp: {
          status: async () => {
            mcpReads.push("status")
            return { data: {} }
          },
        },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as DeepAgentCodeClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(mcpReads).toEqual([])
  })

  test("rebuilds V2 pending permissions and questions without losing newer Question events", async () => {
    const legacySession = { id: "ses_legacy", time: { created: 1, updated: 1 } } as State["session"][number]
    const v2Permission = {
      id: "per_v2",
      sessionID: "ses_v2",
      permission: "bash",
      patterns: ["git status"],
      metadata: {},
      always: [],
    } as State["permission"][string][number]
    const stalePermission = { ...v2Permission, id: "per_stale", sessionID: "ses_stale" }
    const legacyPermission = { ...v2Permission, id: "per_legacy", sessionID: "ses_legacy" }
    const pendingQuestion = {
      id: "que_v2",
      sessionID: "ses_v2",
      questions: [
        {
          header: "Execute plan",
          question: "Approve exact version?",
          options: [{ label: "Execute this version", description: "Same Session" }],
        },
      ],
    }
    const staleQuestion = { ...pendingQuestion, id: "que_stale" }
    const lateQuestion = { ...pendingQuestion, id: "que_late" }
    const legacyQuestion = { ...pendingQuestion, id: "que_legacy", sessionID: "ses_legacy" }
    const legacyRejectedQuestion = { ...legacyQuestion, id: "que_legacy_rejected" }
    const lateLegacyQuestion = { ...legacyQuestion, id: "que_legacy_late" }
    const updatedQuestion = { ...pendingQuestion, questions: [{ ...pendingQuestion.questions[0]!, header: "Newer observed request" }] }
    const [store, setStore] = createStore<State>({
      status: "loading",
      agent: [],
      command: [],
      project: "",
      projectMeta: undefined,
      icon: undefined,
      provider_ready: true,
      provider,
      config: {},
      path: pathFixture(),
      session: [legacySession],
      sessionTotal: 0,
      session_status: {},
      session_working(id: string) {
        return this.session_status[id]?.type !== "idle"
      },
      session_diff: {},
      todo: {},
      permission: { ses_v2: [v2Permission], ses_stale: [stalePermission] },
      permission_v2: { ses_v2: { per_v2: true } },
      question_v2: { ses_v2: { que_stale: true, que_v2: true } },
      question: { ses_v2: [staleQuestion, pendingQuestion], ses_legacy: [legacyQuestion, legacyRejectedQuestion] },
      mcp_ready: true,
      mcp: {},
      lsp_ready: true,
      lsp: [],
      vcs: undefined,
      limit: 5,
      message: {},
      part: {},
      part_text_accum_delta: {},
    })

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: pathFixture(),
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: {
          status: async () => ({ data: {} }),
          get: async ({ sessionID }: { sessionID: string }) => ({
            data: { id: sessionID, time: { created: 1, updated: 1 } },
          }),
        },
        vcs: { get: async () => ({ data: undefined }) },
        command: { list: async () => ({ data: [] }) },
        permission: { list: async () => ({ data: [legacyPermission] }) },
        v2: {
          question: {
            request: {
              list: async () => {
                for (const event of [
                  { type: "question.v2.asked" as const, properties: lateQuestion },
                  { type: "question.v2.asked" as const, properties: updatedQuestion },
                  { type: "question.asked" as const, properties: lateLegacyQuestion },
                  { type: "question.replied" as const, properties: { sessionID: "ses_legacy", requestID: "que_legacy", answers: [] } },
                  { type: "question.rejected" as const, properties: { sessionID: "ses_legacy", requestID: "que_legacy_rejected" } },
                  {
                    type: "question.v2.replied" as const,
                    properties: { sessionID: "ses_v2", requestID: "que_stale", answers: [] },
                  },
                ])
                  applyDirectoryEvent({ event, store, setStore, directory: "/project", push() {}, loadLsp() {} })
                return { data: { data: [pendingQuestion, staleQuestion] } }
              },
            },
          },
          permission: {
            request: {
              list: async () => ({
                data: {
                  data: [
                    {
                      id: "per_v2",
                      sessionID: "ses_v2",
                      action: "bash",
                      resources: ["git status"],
                      save: [],
                      metadata: {},
                    },
                  ],
                },
              }),
            },
          },
        },
        question: { list: async () => ({ data: [legacyQuestion, legacyRejectedQuestion] }) },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as DeepAgentCodeClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(store.permission.ses_v2?.map((x) => x.id)).toEqual(["per_v2"])
    expect(store.permission.ses_legacy?.map((x) => x.id)).toEqual(["per_legacy"])
    expect(store.permission.ses_stale).toEqual([])
    expect(store.permission_v2.ses_v2).toEqual({ per_v2: true })
    expect(store.question.ses_v2?.map((question) => question.id)).toEqual(["que_late", "que_v2"])
    expect(store.question.ses_legacy?.map((question) => question.id)).toEqual(["que_legacy_late"])
    expect(store.question.ses_v2?.find((question) => question.id === "que_v2")?.questions[0]?.header).toBe("Newer observed request")
    expect(store.question_v2.ses_v2).toEqual({ que_late: true, que_v2: true })
    expect(store.question_v2.ses_legacy).toEqual({})
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as DeepAgentCodeClient
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, client).queryKey]).toEqual([
      "https://debian.example",
      null,
      "providers",
    ])
  })
})
