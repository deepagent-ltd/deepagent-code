import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createServer, request } from "node:http"
import { Readable } from "node:stream"
import type { ContextItem, Prompt } from "@/context/prompt"
import { toV2Prompt, type SessionStatus } from "@deepagent-code/sdk/client"
import type { SharedBrowserPlatform } from "@deepagent-code/core/browser/shared-platform"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"

// Bun module mocks survive mock.restore(); later SDK integration files need the original export table.
const sdkClient = { ...(await import("@deepagent-code/sdk/client")) }
afterAll(() => mock.module("@deepagent-code/sdk/client", () => sdkClient))

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const statuses: Record<string, SessionStatus> = {}
const goals: Record<
  string,
  { goalId: string; control?: import("@deepagent-code/core/deepagent/goal-client").GoalClient.Snapshot }
> = {}
let selectedAgent = "agent"
let effectiveAgent = "agent"
const abortedSessions: string[] = []
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
  delivery?: "queue" | "steer"
  metadata?: unknown
  text?: string
  parts?: unknown[]
  messageID?: string
  intentID?: string
  intentSource?: string
  intentVariant?: string
}> = []
const promptPrepareEvents: string[] = []
const toastCalls: Array<{ variant?: string; title?: string; description?: string }> = []
const promptPrepareProgress: string[] = []

let params: { id?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
// The config value may be the canonical "intelligence" or the legacy "wish" alias (which the app
// normalizer maps to "intelligence"); either way submit sends "intelligence" on the wire.
let promptMode: "direct" | "intelligence" | "wish" = "direct"
let appLocale = "en"
let releaseDelayedPrompt: (() => void) | undefined
let prepareTransportURL: string | undefined
const rejectedAdmissionReceipts = new Set<string>()
let ownerBridge: Pick<SharedBrowserPlatform, "stampInput" | "sealInput"> | undefined
const sentOwnerHeaders: Array<Record<string, string> | undefined> = []

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
      promptAsync: async () => {
        throw new Error("legacy prompt path")
      },
      command: async () => ({ data: undefined }),
      abort: async (input: { sessionID: string }) => {
        abortedSessions.push(input.sessionID)
        return { data: undefined }
      },
    },
    v2: {
      session: {
        prompt: async (
          payload: {
            id?: string
            delivery?: "queue" | "steer"
            prompt: {
              text: string
              metadata?: unknown
              files?: unknown[]
              agents?: unknown[]
              intent?: { id?: string; source?: string; variant?: string }
            }
          },
          options?: { headers?: Record<string, string> },
        ) => {
          sentOwnerHeaders.push(options?.headers)
          const sent = {
            directory,
            delivery: payload.delivery,
            metadata: payload.prompt.metadata,
            text: payload.prompt.text,
            parts: [
              { type: "text", text: payload.prompt.text },
              ...(payload.prompt.files ?? []),
              ...(payload.prompt.agents ?? []),
            ],
            messageID: payload.id,
            intentID: payload.prompt.intent?.id,
            intentSource: payload.prompt.intent?.source,
            intentVariant: payload.prompt.intent?.variant,
          }
          sentPromptAsync.push(sent)
          if (
            (sent.text?.includes("receipt lost") || sent.text?.includes("Edited retry goal")) &&
            !rejectedAdmissionReceipts.has(sent.text ?? "")
          ) {
            rejectedAdmissionReceipts.add(sent.text ?? "")
            throw new Error("connection closed after durable admission")
          }
          if (sent.text === "prompt waits after admission") {
            await new Promise<void>((resolve) => {
              releaseDelayedPrompt = resolve
            })
          }
          return { data: { data: { id: "msg_server_admitted", delivery: payload.delivery ?? "steer" } } }
        },
      },
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
        if (prepareTransportURL) {
          // Happy DOM owns this file's EventTarget globals; use actual Node HTTP rather
          // than mixing its signal with Bun's branded native fetch implementation.
          return new Promise<{ data: ReadableStream<Uint8Array> }>((resolve, reject) => {
            const call = request(prepareTransportURL!, { method: "POST" }, (response) => {
              // Node and DOM declarations spell the standard reader overloads differently.
              resolve({ data: Readable.toWeb(response) as unknown as ReadableStream<Uint8Array> })
            })
            const abort = () => call.destroy(new Error("Own prepare transport aborted"))
            payload.signal?.addEventListener("abort", abort, { once: true })
            call.once("close", () => payload.signal?.removeEventListener("abort", abort))
            call.on("error", reject)
            if (payload.signal?.aborted) abort()
            else call.end(JSON.stringify(payload.body))
          })
        }
        if (text === "prepare fails") {
          throw new Error("POST /session/ses_1/prompt_prepare returned 400", {
            cause: {
              body: { name: "BadRequest", data: { message: "Intelligence prompt preparation failed" } },
              status: 400,
            },
          })
        }
        if (text === "prepare degrades") {
          const degradedResult = {
            prompt_draft_id: "",
            context_plan_id: "",
            state: "general_ready",
            mode: "intelligence",
            route: "general",
            goal: text,
            preview: text,
            intent_id: payload.body?.intent_id,
            degraded: true,
          }
          return {
            data: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify({ type: "result", result: degradedResult })}\n\n`),
                )
                controller.close()
              },
            }),
          }
        }
        if (text === "prepare stalls") {
          return {
            data: new ReadableStream<Uint8Array>({
              start(controller) {
                // Emit one progress delta, then never the terminal event and never close:
                // the exact hung-stream shape the D1 timeout must recover from.
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify({ type: "progress", preview: "Partial" })}\n\n`),
                )
                payload.signal?.addEventListener("abort", () => controller.close(), { once: true })
              },
            }),
          }
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

  mock.module("@deepagent-code/sdk/client", () => ({
    toV2Prompt,
    createDeepAgentCodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@deepagent-code/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: (options: { variant?: string; title?: string; description?: string }) => {
      toastCalls.push(options)
      return 0
    },
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
        current: () => ({ name: selectedAgent }),
        effective: () => ({ name: effectiveAgent }),
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
      data: { command: [], session_status: statuses },
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
      set: (key: string, sessionID: string, value: SessionStatus) => {
        if (key === "session_status") statuses[sessionID] = value
      },
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => ({
      data: {
        session_goal: goals,
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
          { session: storedSessions[directory], session_status: statuses },
          (...args: unknown[]) => {
            if (args[0] === "session_status") {
              statuses[args[1] as string] = args[2] as SessionStatus
              return
            }
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
      sharedBrowser: ownerBridge,
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
  mod.setPrepareStreamIdleTimeoutMs(200)
})

beforeEach(() => {
  prepareTransportURL = undefined
  selectedAgent = "agent"
  effectiveAgent = "agent"
  for (const key of Object.keys(goals)) delete goals[key]
  for (const key of Object.keys(statuses)) delete statuses[key]
  abortedSessions.length = 0
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
  toastCalls.length = 0
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
  ownerBridge = undefined
  sentOwnerHeaders.length = 0
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("prompt submit worktree selection", () => {
  const guardedSubmit = (options: Partial<Parameters<typeof createPromptSubmit>[0]> = {}) =>
    createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      ...options,
    })

  test("a changed mode while busy queues the next activity and leaves the active mode unchanged", async () => {
    params = { id: "session-1" }
    selectedAgent = "plan"
    statuses["session-1"] = { type: "busy" }
    await guardedSubmit({ working: () => true }).handleSubmit(new Event("submit", { cancelable: true }))
    await flushAsyncSubmit()
    expect(sentPromptAsync).toHaveLength(1)
    expect(sentPromptAsync[0].delivery).toBe("queue")
    expect(optimistic[0].message.agent).toBe("plan")
    expect(effectiveAgent).toBe("agent")
  })

  test("same-mode follow-up keeps the existing steer contract", async () => {
    params = { id: "session-1" }
    statuses["session-1"] = { type: "busy" }
    await guardedSubmit({ working: () => true }).handleSubmit(new Event("submit", { cancelable: true }))
    await flushAsyncSubmit()
    expect(sentPromptAsync).toHaveLength(1)
    expect(sentPromptAsync[0].delivery).toBeUndefined()
  })

  test("typed recovery blocks direct submit and abort callbacks without changing the draft or status", async () => {
    params = { id: "session-1" }
    const submit = guardedSubmit({ working: () => true })
    for (const blockedReason of [undefined, "recovery_required", "authority_conflict", "owned_elsewhere"] as const) {
      const status: SessionStatus = { type: "recovery_required", message: "opaque unrelated text", blockedReason }
      statuses["session-1"] = status
      await submit.handleSubmit(new Event("submit", { cancelable: true }))
      await submit.abort()
      expect(statuses["session-1"]).toBe(status)
      expect(promptValue[0]).toMatchObject({ content: "ls" })
    }
    expect(sentPromptAsync).toHaveLength(0)
    expect(preparedDrafts).toHaveLength(0)
    expect(sentShell).toHaveLength(0)
    expect(createdSessions).toHaveLength(0)
    expect(abortedSessions).toHaveLength(0)
    expect(optimistic).toHaveLength(0)
  })

  test("a recovery status arriving during draft confirmation fences admission and survives cleanup", async () => {
    params = { id: "session-1" }
    promptMode = "intelligence"
    const status: SessionStatus = { type: "recovery_required", message: "opaque", blockedReason: "recovery_required" }
    const submit = guardedSubmit({
      confirmPromptDraft: async () => {
        statuses["session-1"] = status
        return { editedGoal: "Reviewed goal" }
      },
    })
    await submit.handleSubmit(new Event("submit", { cancelable: true }))
    await flushAsyncSubmit()
    expect(preparedDrafts).toHaveLength(1)
    expect(sentPromptAsync).toHaveLength(0)
    expect(abortedSessions).toHaveLength(0)
    expect(optimistic).toHaveLength(0)
    expect(statuses["session-1"]).toBe(status)
  })

  test("a recovery status arriving while stop joins admission prevents a late abort request", async () => {
    params = { id: "session-1" }
    promptValue[0] = { type: "text", content: "prompt waits after admission", start: 0, end: 28 }
    const submit = guardedSubmit()
    await submit.handleSubmit(new Event("submit", { cancelable: true }))
    await flushAsyncSubmit()
    expect(sentPromptAsync).toHaveLength(1)
    const stopping = submit.abort()
    await flushAsyncSubmit()
    const status: SessionStatus = { type: "recovery_required", message: "opaque", blockedReason: "owned_elsewhere" }
    statuses["session-1"] = status
    releaseDelayedPrompt?.()
    await stopping
    expect(abortedSessions).toHaveLength(0)
    expect(statuses["session-1"]).toBe(status)
  })

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

  test("keeps an optimistic steer visible after its durable receipt", async () => {
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
    expect(optimisticRemoved).toHaveLength(0)
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

  test("degrades to direct submit when intelligence prompt preparation fails", async () => {
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
    // W1-3 — a failed prepare no longer blocks the send: the raw input goes out on the direct
    // path (same metadata as a route:"general" degrade) instead of stranding the draft.
    expect(sentPromptAsync[0]?.text).toBe("prepare fails")
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

  // D1: the W1-3 degrade must also be VISIBLE — a toast accompanies the direct send.
  test("shows a degrade toast when intelligence prompt preparation fails", async () => {
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

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flushAsyncSubmit()

    expect(sentPromptAsync[0]?.text).toBe("prepare fails")
    expect(toastCalls.length).toBe(1)
    expect(toastCalls[0]?.title).toContain("Intelligence unavailable")
  })

  // D1: the server's own fail-soft degrade arrives as a NORMAL result event (route:general +
  // degraded:true) — the catch path never fires, so the toast must key off the flag.
  test("shows a degrade toast when the server marks the result as degraded", async () => {
    params = { id: "session-1" }
    promptMode = "intelligence"
    promptValue[0] = { type: "text", content: "prepare degrades", start: 0, end: 16 }

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

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flushAsyncSubmit()

    expect(sentPromptAsync[0]?.text).toBe("prepare degrades")
    expect(sentPromptAsync[0]?.metadata).toEqual({
      deepagent: {
        agent_mode_override: "general",
        prompt_pipeline: {
          mode: "direct_override",
        },
      },
    })
    expect(toastCalls.length).toBe(1)
    expect(toastCalls[0]?.title).toContain("Intelligence unavailable")
  })

  // D1: a prepare stream that never emits its terminal event (hung refinement / dropped body)
  // must time out and degrade to direct instead of locking the composer forever.
  test("times out a stalled prepare stream and preserves the draft without automatic dispatch", async () => {
    params = { id: "session-1" }
    promptMode = "intelligence"
    promptValue[0] = { type: "text", content: "prepare stalls", start: 0, end: 14 }

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

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    // The stall is recovered by the 200ms idle deadline (shrunk in beforeAll), so wait past it.
    await new Promise((resolve) => setTimeout(resolve, 300))
    await flushAsyncSubmit()

    expect(sentPromptAsync).toHaveLength(0)
    expect(promptValue[0]?.type === "text" && promptValue[0].content).toBe("prepare stalls")
    expect(toastCalls[0]?.title).toBe("Prompt preparation timed out")
  })

  test("absolute prepare deadline closes real HTTP before headers and despite continuous progress", async () => {
    for (const mode of ["headers", "progress"] as const) {
      params = { id: "session-1" }
      promptMode = "intelligence"
      promptValue[0] = { type: "text", content: `real ${mode}`, start: 0, end: 20 }
      const facts = { requests: 0, closed: 0, progress: 0 }
      const server = createServer((request, response) => {
        facts.requests++
        request.resume()
        const timer =
          mode === "progress"
            ? setInterval(() => {
                facts.progress++
                response.write(`data: ${JSON.stringify({ type: "progress", preview: "Waiting" })}\n\n`)
              }, 20)
            : undefined
        response.on("close", () => {
          clearInterval(timer)
          facts.closed++
        })
        if (mode === "progress") {
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.write('data: {"type":"started"}\n\n')
        }
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Own HTTP fixture has no loopback port")
      prepareTransportURL = `http://127.0.0.1:${address.port}/prepare`
      try {
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
        await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
        await new Promise((resolve) => setTimeout(resolve, 350))
        expect(facts.requests).toBe(1)
        expect(facts.closed).toBe(1)
        expect(sentPromptAsync).toHaveLength(0)
        expect(promptValue[0]?.type === "text" && promptValue[0].content).toBe(`real ${mode}`)
        if (mode === "progress") expect(facts.progress).toBeGreaterThan(1)
      } finally {
        prepareTransportURL = undefined
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
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
    const origins: string[] = []
    ownerBridge = {
      stampInput: async (input) => {
        origins.push("stamp")
        return {
          inputID: input.inputID,
          originalSubmissionID: input.originalSubmissionID,
          rootSessionID: input.sessionID,
          mainIncarnation: "fixture-main",
          rawInputHash: Hash.sha256(input.rawInput),
          sourceKind: "gui_composer",
          sourceBindingHash: "a".repeat(64),
          submissionOrder: origins.length,
        }
      },
      sealInput: async (input) => {
        origins.push("seal")
        return { ...input.stamp, promptHash: Hash.sha256(CanonicalJson.stringify(input.prompt)) }
      },
    }
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
    expect(origins).toEqual(["stamp", "seal"])
    expect(sentOwnerHeaders[0]?.["x-dac-user-input"]).toBeTruthy()
    expect(sentOwnerHeaders[1]).toEqual(sentOwnerHeaders[0])

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
