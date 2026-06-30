import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const enabledAutoAccept: Array<{ sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: string[] = []
const syncedDirectories: string[] = []
const preparedDrafts: Array<{
  directory: string
  sessionID: string
  mode: string
  outputLanguage?: string
  text?: string
}> = []
const sentPromptAsync: Array<{ directory: string; metadata?: unknown; text?: string }> = []
const promptPrepareEvents: string[] = []

let params: { id?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let promptMode: "direct" | "wish" = "direct"
let appLocale = "en"

const promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const flushAsyncSubmit = () => new Promise((resolve) => setTimeout(resolve, 0))

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    session: {
      create: async () => {
        createdSessions.push(directory)
        return {
          data: {
            id: `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
          },
        }
      },
      shell: async () => {
        sentShell.push(directory)
        return { data: undefined }
      },
      prompt: async () => ({ data: undefined }),
      promptAsync: async (payload?: { metadata?: unknown; parts?: Array<{ type: string; text?: string }> }) => {
        sentPromptAsync.push({
          directory,
          metadata: payload?.metadata,
          text: payload?.parts?.find((part) => part.type === "text")?.text,
        })
        return { data: undefined }
      },
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    client: {
      request: async (payload: {
        path?: { sessionID?: string }
        body?: { mode?: string; output_language?: string; parts?: Array<{ type: string; text?: string }> }
      }) => {
        const text = payload.body?.parts?.find((part) => part.type === "text")?.text
        preparedDrafts.push({
          directory,
          sessionID: payload.path?.sessionID ?? "",
          mode: payload.body?.mode ?? "",
          outputLanguage: payload.body?.output_language,
          text,
        })
        if (text === "prepare fails") {
          throw new Error("POST /session/ses_1/prompt_prepare returned 400", {
            cause: { body: { name: "BadRequest", data: { message: "Wish prompt preparation failed" } }, status: 400 },
          })
        }
        return {
          data: {
            prompt_draft_id: "prompt_draft:test:1",
            context_plan_id: "context_plan:test:1",
            state: "draft_ready",
            mode: payload.body?.mode ?? "wish",
            route: text === "hello" ? "general" : "code",
            goal: "Prepared goal",
            preview: "# Prepared prompt",
          },
        }
      },
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
  }))

  mock.module("@deepagent-code/sdk/v2/client", () => ({
    createDeepAgentCodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@deepagent-code/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: () => 0,
  }))

  mock.module("@deepagent-code/core/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ sessionID, directory })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => ({
      current: () => promptValue,
      reset: () => undefined,
      set: () => undefined,
      context: {
        add: () => undefined,
        remove: () => undefined,
        items: () => [],
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => ({
      data: { command: [] },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => ({
      data: {
        config: {
          provider: {
            deepagent: {
              options: {
                promptMode,
              },
            },
          },
        },
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      locale: () => appLocale,
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  params = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  preparedDrafts.length = 0
  sentPromptAsync.length = 0
  promptPrepareEvents.length = 0
  promptValue[0] = { type: "text", content: "ls", start: 0, end: 2 }
  selected = "/repo/worktree-a"
  variant = undefined
  promptMode = "direct"
  appLocale = "en"
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flushAsyncSubmit()

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flushAsyncSubmit()

    expect(storedSessions["/repo/worktree-a"]).toEqual([{ id: "session-1", title: "New session 1" }])
    expect(optimisticSeeded).toEqual([true])
  })

  test("prepares and confirms wish prompts before async submission", async () => {
    params = { id: "session-1" }
    promptMode = "wish"

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onPromptPrepareStart: () => promptPrepareEvents.push("start"),
      onPromptPrepareEnd: () => promptPrepareEvents.push("end"),
      confirmPromptDraft: async () => ({ editedGoal: "Edited prepared goal" }),
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flushAsyncSubmit()

    expect(promptPrepareEvents).toEqual(["start", "end"])
    expect(preparedDrafts).toEqual([
      { directory: "/repo/main", sessionID: "session-1", mode: "wish", outputLanguage: "english", text: "ls" },
    ])
    expect(sentPromptAsync[0]?.text).toBe("Edited prepared goal")
    expect(sentPromptAsync[0]?.metadata).toEqual({
      deepagent: {
        prompt_pipeline: {
          mode: "wish",
          confirmed_draft_id: "prompt_draft:test:1",
          edited_goal: "Edited prepared goal",
        },
      },
    })
  })

  test("prepares wish prompts in Chinese when the app locale is Chinese", async () => {
    params = { id: "session-1" }
    promptMode = "wish"
    appLocale = "zh"

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      confirmPromptDraft: async () => ({ editedGoal: "编辑后的中文 prompt" }),
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flushAsyncSubmit()

    expect(preparedDrafts).toEqual([
      { directory: "/repo/main", sessionID: "session-1", mode: "wish", outputLanguage: "chinese", text: "ls" },
    ])
  })

  test("routes non-code wish prompts through general without confirmation", async () => {
    params = { id: "session-1" }
    promptMode = "wish"
    const confirms: string[] = []
    promptValue[0] = { type: "text", content: "hello", start: 0, end: 5 }

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      confirmPromptDraft: async () => {
        confirms.push("called")
        return { editedGoal: "should not submit" }
      },
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flushAsyncSubmit()

    expect(confirms).toEqual([])
    expect(preparedDrafts).toEqual([
      { directory: "/repo/main", sessionID: "session-1", mode: "wish", outputLanguage: "english", text: "hello" },
    ])
    expect(sentPromptAsync[0]?.text).toBe("hello")
    expect(sentPromptAsync[0]?.metadata).toEqual({
      deepagent: {
        agent_mode_override: "general",
        prompt_pipeline: {
          mode: "direct_override",
        },
      },
    })
    promptValue[0] = { type: "text", content: "ls", start: 0, end: 2 }
  })

  test("does not submit when wish prompt preparation fails", async () => {
    params = { id: "session-1" }
    promptMode = "wish"
    promptValue[0] = { type: "text", content: "prepare fails", start: 0, end: 13 }

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flushAsyncSubmit()

    expect(preparedDrafts).toEqual([
      {
        directory: "/repo/main",
        sessionID: "session-1",
        mode: "wish",
        outputLanguage: "english",
        text: "prepare fails",
      },
    ])
    expect(sentPromptAsync).toEqual([])
    promptValue[0] = { type: "text", content: "ls", start: 0, end: 2 }
  })
})
