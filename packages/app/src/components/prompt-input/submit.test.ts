import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { ContextItem, Prompt } from "@/context/prompt"

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
const optimisticRemoved: string[] = []
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
const preparedIntents: Array<{ intentID?: string; source?: string }> = []
const sentPromptAsync: Array<{
  directory: string
  metadata?: unknown
  text?: string
  parts?: Array<{ id?: string; type: string; text?: string }>
  messageID?: string
  intentID?: string
  intentSource?: string
  intentVariant?: string
}> = []
const promptPrepareEvents: string[] = []
const promptPrepareProgress: string[] = []

let params: { id?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
// The config value may be the canonical "intelligence" or the legacy "wish" alias (which the app
// normalizer maps to "intelligence"); either way submit sends "intelligence" on the wire.
let promptMode: "direct" | "intelligence" | "wish" = "direct"
let appLocale = "en"
let releaseDelayedPrompt: (() => void) | undefined
const rejectedAdmissionReceipts = new Set<string>()

const promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const promptContextItems: Array<ContextItem & { key: string }> = []
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
      promptAsync: async (payload?: {
        metadata?: unknown
        parts?: Array<{ type: string; text?: string }>
        messageID?: string
        intentID?: string
        intentSource?: string
        intentVariant?: string
      }) => {
        const sent = {
          directory,
          metadata: payload?.metadata,
          text: payload?.parts?.find((part) => part.type === "text")?.text,
          parts: payload?.parts,
          messageID: payload?.messageID,
          intentID: payload?.intentID,
          intentSource: payload?.intentSource,
          intentVariant: payload?.intentVariant,
        }
        sentPromptAsync.push(sent)
        if (
          (sent.text === "receipt lost" || sent.text === "Edited retry goal") &&
          !rejectedAdmissionReceipts.has(sent.text)
        ) {
          rejectedAdmissionReceipts.add(sent.text)
          throw new Error("connection closed after durable admission")
        }
        if (sent.text === "prompt waits after admission") {
          await new Promise<void>((resolve) => {
            releaseDelayedPrompt = resolve
          })
        }
        return { data: { messageID: "msg_server_admitted", delivery: "steer" } }
      },
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    client: {
      request: async (payload: {
        url?: string
        path?: { sessionID?: string }
        body?: {
          mode?: string
          output_language?: string
          intent_id?: string
          intent_source?: string
          parts?: Array<{ type: string; text?: string }>
        }
        signal?: AbortSignal
      }) => {
        const text = payload.body?.parts?.find((part) => part.type === "text")?.text
        preparedDrafts.push({
          directory,
          sessionID: payload.path?.sessionID ?? "",
          mode: payload.body?.mode ?? "",
          outputLanguage: payload.body?.output_language,
          text,
        })
        preparedIntents.push({ intentID: payload.body?.intent_id, source: payload.body?.intent_source })
        if (text === "prepare fails") {
          throw new Error("POST /session/ses_1/prompt_prepare returned 400", {
            cause: {
              body: { name: "BadRequest", data: { message: "Intelligence prompt preparation failed" } },
              status: 400,
            },
          })
        }
        if (text === "prepare waits") {
          return {
            data: new ReadableStream<Uint8Array>({
              start(controller) {
                payload.signal?.addEventListener(
                  "abort",
                  () => controller.error(new DOMException("Aborted", "AbortError")),
                  { once: true },
                )
              },
            }),
          }
        }
        const result = {
          prompt_draft_id: `prompt_draft:test:${preparedDrafts.length}`,
          context_plan_id: `context_plan:test:${preparedDrafts.length}`,
          state: "draft_ready",
          mode: payload.body?.mode ?? "intelligence",
          route: text === "hello" ? "general" : "code",
          goal: "Prepared goal",
          preview: "# Prepared prompt",
          intent_id: payload.body?.intent_id,
        }
        return {
          data: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  [
                    `data: ${JSON.stringify({ type: "progress", preview: "Prepared" })}\n\n`,
                    `data: ${JSON.stringify({ type: "progress", preview: "Prepared goal" })}\n\n`,
                    `data: ${JSON.stringify({ type: "result", result })}\n\n`,
                  ].join(""),
                ),
              )
              controller.close()
            },
          }),
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
        add: (item: ContextItem) => {
          promptContextItems.push({ ...item, key: `restored:${promptContextItems.length}:${item.path}` })
        },
        remove: (key: string) => {
          const index = promptContextItems.findIndex((item) => item.key === key)
          if (index >= 0) promptContextItems.splice(index, 1)
        },
        items: () => promptContextItems,
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
          remove: (value: { messageID: string }) => {
            optimisticRemoved.push(value.messageID)
          },
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
  optimisticRemoved.length = 0
  promoted.length = 0
  params = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  preparedDrafts.length = 0
  preparedIntents.length = 0
  sentPromptAsync.length = 0
  promptPrepareEvents.length = 0
  promptPrepareProgress.length = 0
  promptContextItems.length = 0
  promptValue[0] = { type: "text", content: "ls", start: 0, end: 2 }
  selected = "/repo/worktree-a"
  variant = undefined
  promptMode = "direct"
  appLocale = "en"
  releaseDelayedPrompt?.()
  releaseDelayedPrompt = undefined
  rejectedAdmissionReceipts.clear()
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
    expect(optimisticRemoved).toHaveLength(1)
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

  test("prepares and confirms intelligence prompts before async submission", async () => {
    params = { id: "session-1" }
    promptMode = "intelligence"

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
      onPromptPrepareProgress: (preview) => promptPrepareProgress.push(preview),
      onPromptPrepareEnd: () => promptPrepareEvents.push("end"),
      confirmPromptDraft: async () => ({ editedGoal: "Edited prepared goal" }),
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flushAsyncSubmit()

    expect(promptPrepareEvents).toEqual(["start", "end"])
    expect(promptPrepareProgress).toEqual(["Prepared", "Prepared goal"])
    expect(preparedDrafts).toEqual([
      { directory: "/repo/main", sessionID: "session-1", mode: "intelligence", outputLanguage: "english", text: "ls" },
    ])
    expect(sentPromptAsync[0]?.text).toBe("Edited prepared goal")
    expect(preparedIntents[0]?.intentID).toBe(sentPromptAsync[0]?.intentID)
    expect(preparedIntents[0]?.source).toBe("intelligence")
    expect(sentPromptAsync[0]?.intentSource).toBe("intelligence")
    expect(sentPromptAsync[0]?.intentVariant).toBe("rewritten")
    expect(sentPromptAsync[0]?.metadata).toEqual({
      deepagent: {
        prompt_pipeline: {
          mode: "intelligence",
          confirmed_draft_id: "prompt_draft:test:1",
          edited_goal: "Edited prepared goal",
        },
      },
    })
  })

  // Legacy-compat: a config still storing the pre-rename "wish" value must normalize to
  // "intelligence" on the wire (read-old/send-new). Also exercises the Chinese output language.
  test("prepares intelligence prompts in Chinese, normalizing a legacy 'wish' config to 'intelligence'", async () => {
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
      { directory: "/repo/main", sessionID: "session-1", mode: "intelligence", outputLanguage: "chinese", text: "ls" },
    ])
  })

  test("routes non-code intelligence prompts through general without confirmation", async () => {
    params = { id: "session-1" }
    promptMode = "intelligence"
    const confirms: string[] = []
    const discards: string[] = []
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
      onPromptPrepareDiscard: () => discards.push("discard"),
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await flushAsyncSubmit()

    expect(confirms).toEqual([])
    expect(discards).toEqual(["discard"])
    expect(preparedDrafts).toEqual([
      {
        directory: "/repo/main",
        sessionID: "session-1",
        mode: "intelligence",
        outputLanguage: "english",
        text: "hello",
      },
    ])
    expect(sentPromptAsync[0]?.text).toBe("hello")
    expect(preparedIntents[0]?.intentID).toBe(sentPromptAsync[0]?.intentID)
    expect(sentPromptAsync[0]?.intentVariant).toBe("original")
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

  test("does not submit when intelligence prompt preparation fails", async () => {
    params = { id: "session-1" }
    promptMode = "intelligence"
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
        mode: "intelligence",
        outputLanguage: "english",
        text: "prepare fails",
      },
    ])
    expect(sentPromptAsync).toEqual([])
    promptValue[0] = { type: "text", content: "ls", start: 0, end: 2 }
  })

  test("stops intelligence prompt preparation without submitting", async () => {
    params = { id: "session-1" }
    promptMode = "intelligence"
    promptValue[0] = { type: "text", content: "prepare waits", start: 0, end: 13 }

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
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flushAsyncSubmit()
    await submit.abort()
    await flushAsyncSubmit()

    expect(promptPrepareEvents).toEqual(["start", "end"])
    expect(sentPromptAsync).toEqual([])
    promptValue[0] = { type: "text", content: "ls", start: 0, end: 2 }
  })

  test("supersedes an in-flight intelligence preparation without admitting or restoring it", async () => {
    params = { id: "session-1" }
    promptMode = "intelligence"
    promptValue[0] = { type: "text", content: "prepare waits", start: 0, end: 13 }
    const discards: string[] = []

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
      onPromptPrepareDiscard: () => discards.push("discard"),
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flushAsyncSubmit()
    await submit.cancelPending()
    await flushAsyncSubmit()

    expect(discards).toEqual(["discard"])
    expect(sentPromptAsync).toEqual([])
    promptValue[0] = { type: "text", content: "ls", start: 0, end: 2 }
  })

  test("joins an admission already in flight and rejects a duplicate local submit", async () => {
    params = { id: "session-1" }
    promptValue[0] = {
      type: "text",
      content: "prompt waits after admission",
      start: 0,
      end: 28,
    }

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
    expect(sentPromptAsync).toHaveLength(1)

    await submit.handleSubmit(event)
    expect(sentPromptAsync).toHaveLength(1)

    let canceled = false
    const cancel = submit.cancelPending().then(() => {
      canceled = true
    })
    await flushAsyncSubmit()
    expect(canceled).toBe(false)

    releaseDelayedPrompt?.()
    await cancel
    expect(canceled).toBe(true)
    expect(sentPromptAsync).toHaveLength(1)
    promptValue[0] = { type: "text", content: "ls", start: 0, end: 2 }
  })

  test("reuses submission identity when the durable admission receipt is lost", async () => {
    params = { id: "session-1" }
    promptValue[0] = { type: "text", content: "receipt lost", start: 0, end: 12 }
    const context = {
      type: "file" as const,
      path: "src/retry.ts",
      comment: "keep this review context",
      commentID: "comment-1",
      key: "original-ui-key",
    }
    promptContextItems.push(context, {
      type: "file",
      path: "src/reference.ts",
      key: "reference-ui-key",
    })

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

    expect(promptContextItems.find((item) => item.commentID === context.commentID)?.key).not.toBe(context.key)

    await submit.handleSubmit(event)
    await flushAsyncSubmit()

    expect(sentPromptAsync).toHaveLength(2)
    expect(sentPromptAsync[0]?.messageID).toBeDefined()
    expect(sentPromptAsync[1]?.messageID).toBe(sentPromptAsync[0]?.messageID)
    expect(sentPromptAsync[0]?.intentID).toBeDefined()
    expect(sentPromptAsync[1]?.intentID).toBe(sentPromptAsync[0]?.intentID)
    expect(sentPromptAsync[1]?.parts).toEqual(sentPromptAsync[0]?.parts)

    promptContextItems.push({ ...context, key: "new-ui-key-after-success" })
    await submit.handleSubmit(event)
    await flushAsyncSubmit()

    expect(sentPromptAsync).toHaveLength(3)
    expect(sentPromptAsync[2]?.messageID).not.toBe(sentPromptAsync[0]?.messageID)
    expect(sentPromptAsync[2]?.intentID).not.toBe(sentPromptAsync[0]?.intentID)
    promptValue[0] = { type: "text", content: "ls", start: 0, end: 2 }
  })

  test("reuses the final prepared payload when an intelligence admission receipt is lost", async () => {
    params = { id: "session-1" }
    promptMode = "intelligence"
    promptValue[0] = { type: "text", content: "intelligence receipt lost", start: 0, end: 25 }
    let confirms = 0

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
        confirms += 1
        return { editedGoal: "Edited retry goal" }
      },
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event
    await submit.handleSubmit(event)
    await flushAsyncSubmit()
    await submit.handleSubmit(event)
    await flushAsyncSubmit()

    expect(preparedDrafts).toHaveLength(1)
    expect(confirms).toBe(1)
    expect(sentPromptAsync).toHaveLength(2)
    expect(sentPromptAsync[1]?.messageID).toBe(sentPromptAsync[0]?.messageID)
    expect(sentPromptAsync[1]?.intentID).toBe(sentPromptAsync[0]?.intentID)
    expect(sentPromptAsync[1]?.parts).toEqual(sentPromptAsync[0]?.parts)
    expect(sentPromptAsync[1]?.metadata).toEqual(sentPromptAsync[0]?.metadata)
    expect(sentPromptAsync[1]?.metadata).toMatchObject({
      deepagent: {
        prompt_pipeline: {
          confirmed_draft_id: "prompt_draft:test:1",
        },
      },
    })
    promptValue[0] = { type: "text", content: "ls", start: 0, end: 2 }
  })
})
