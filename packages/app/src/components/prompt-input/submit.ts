import type { Message, Session } from "@deepagent-code/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@deepagent-code/core/util/encode"
import { Binary } from "@deepagent-code/core/util/binary"
import { useNavigate, useParams } from "@solidjs/router"
import { batch, type Accessor } from "solid-js"
import type { FileSelection } from "@/context/file"
import { useServerSync } from "@/context/server-sync"
import { type Locale, useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ContextItem, type ImageAttachmentPart, type Prompt, usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { deepAgentPromptModeFromConfig } from "@/utils/deepagent-settings"
import { resolveScenarioOverride, resetScenarioOnStop } from "./scenario-override"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  metadata?: {
    deepagent?: {
      prompt_pipeline?: {
        mode: "intelligence" | "direct_override"
        confirmed_draft_id?: string
        edited_goal?: string
      }
      agent_mode_override?: "general"
    }
  }
}

export type DeepAgentPromptPrepareResult = {
  prompt_draft_id: string
  context_plan_id: string
  state: string
  mode: "intelligence"
  route: "code" | "general"
  goal: string
  preview: string
}

export type DeepAgentPromptConfirmResult = { editedGoal: string }

type DeepAgentPromptModeForConfirmation = DeepAgentPromptPrepareResult["mode"]

type DeepAgentPromptOutputLanguage = "chinese" | "english"

type SessionPromptAsyncInput = Parameters<ReturnType<typeof useSDK>["client"]["session"]["promptAsync"]>[0] & {
  metadata?: FollowupDraft["metadata"]
}

type RawSdkClient = {
  client: {
    request<TData>(options: {
      method: string
      url: string
      path?: Record<string, string>
      body?: unknown
      headers?: Record<string, string>
    }): Promise<{ data?: TData }>
  }
}

type FollowupSendInput = {
  client: ReturnType<typeof useSDK>["client"]
  serverSync: ReturnType<typeof useServerSync>
  sync: ReturnType<typeof useSync>
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
  onBeforeSubmit?: () => void
  onPromptPrepareStart?: () => void
  onPromptPrepareEnd?: () => void
  promptOutputLanguage?: DeepAgentPromptOutputLanguage
  confirmPromptDraft?: (draft: DeepAgentPromptPrepareResult) => Promise<DeepAgentPromptConfirmResult | false>
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

const promptPipelineMode = (metadata: FollowupDraft["metadata"]): DeepAgentPromptModeForConfirmation | undefined => {
  const mode = metadata?.deepagent?.prompt_pipeline?.mode
  return mode === "intelligence" ? mode : undefined
}

async function prepareDeepAgentPromptDraft(input: {
  client: ReturnType<typeof useSDK>["client"]
  sessionID: string
  mode: DeepAgentPromptModeForConfirmation
  outputLanguage: DeepAgentPromptOutputLanguage
  parts: SessionPromptAsyncInput["parts"]
}) {
  const raw = input.client as unknown as RawSdkClient
  const response = await raw.client.request<DeepAgentPromptPrepareResult>({
    method: "POST",
    url: "/session/{sessionID}/prompt_prepare",
    path: { sessionID: input.sessionID },
    body: {
      mode: input.mode,
      output_language: input.outputLanguage,
      parts: input.parts,
    },
    headers: {
      "Content-Type": "application/json",
    },
  })
  if (!response.data) throw new Error("Prompt draft prepare returned no data")
  return response.data
}

export type DeepAgentPromptSuggestion = {
  status: string | null
  body: string | null
}

// #4: fetch the latest macro-round next-round suggestion the backend persisted for a high/max
// turn. Mirrors `prepareDeepAgentPromptDraft`'s raw-request pattern (GET, no body). Returns
// undefined when the route has no suggestion yet so callers can no-op fail-safe.
export async function fetchLatestSuggestion(
  client: ReturnType<typeof useSDK>["client"],
  sessionID: string,
): Promise<DeepAgentPromptSuggestion | undefined> {
  const raw = client as unknown as RawSdkClient
  const response = await raw.client.request<DeepAgentPromptSuggestion>({
    method: "GET",
    url: "/session/{sessionID}/prompt_suggestion",
    path: { sessionID },
  })
  return response.data
}

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const [, setStore] = input.serverSync.child(input.draft.sessionDirectory)

  const setBusy = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }
      input.onBeforeSubmit?.()

      await input.client.session.command({
        sessionID: input.draft.sessionID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: `${input.draft.model.providerID}/${input.draft.model.modelID}`,
        variant: input.draft.variant,
        parts: images.map((attachment) => ({
          id: Identifier.ascending("part"),
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.dataUrl,
          filename: attachment.filename,
        })),
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const buildParts = (promptText: string) =>
    buildRequestParts({
      prompt: input.draft.prompt,
      context: input.draft.context,
      images,
      text: promptText,
      sessionID: input.draft.sessionID,
      messageID,
      sessionDirectory: input.draft.sessionDirectory,
    })
  const preparedParts = buildParts(text)

  const mode = promptPipelineMode(input.draft.metadata)
  let waited = false
  let metadata = input.draft.metadata
  let confirmedDraft: DeepAgentPromptConfirmResult | undefined
  if (mode) {
    const ok = await wait()
    waited = true
    if (!ok) return false

    // D2: while intelligence prepares the prompt (a real model call), surface a busy/"advice generating"
    // state so the composer indicates work is in progress rather than appearing frozen. The
    // existing confirm surface then shows the prepared prompt for review/edit before send.
    setBusy()
    input.onPromptPrepareStart?.()
    let prepared: DeepAgentPromptPrepareResult
    try {
      prepared = await prepareDeepAgentPromptDraft({
        client: input.client,
        sessionID: input.draft.sessionID,
        mode,
        outputLanguage: input.promptOutputLanguage ?? "english",
        parts: preparedParts.requestParts,
      })
    } catch (err) {
      setIdle()
      input.onPromptPrepareEnd?.()
      throw err
    }
    input.onPromptPrepareEnd?.()
    if (prepared.route === "general") {
      metadata = {
        deepagent: {
          agent_mode_override: "general",
          prompt_pipeline: {
            mode: "direct_override",
          },
        },
      }
    } else {
      const confirmed = await input.confirmPromptDraft?.(prepared)
      if (!confirmed) {
        setIdle()
        return false
      }
      confirmedDraft = confirmed

      metadata = {
        deepagent: {
          prompt_pipeline: {
            mode,
            confirmed_draft_id: prepared.prompt_draft_id,
            edited_goal: confirmed.editedGoal,
          },
        },
      }
    }
  }

  const submittedParts = confirmedDraft ? buildParts(confirmedDraft.editedGoal) : preparedParts

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: submittedParts.optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  try {
    if (!waited && !(await wait())) {
      return false
    }
    input.onBeforeSubmit?.()

    batch(() => {
      setBusy()
      add()
    })

    const promptInput: SessionPromptAsyncInput = {
      sessionID: input.draft.sessionID,
      agent: input.draft.agent,
      model: input.draft.model,
      messageID,
      parts: submittedParts.requestParts,
      variant: input.draft.variant,
      metadata,
    }
    await input.client.session.promptAsync(promptInput)
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  onPromptPrepareStart?: () => void
  onPromptPrepareEnd?: () => void
  confirmPromptDraft?: (draft: DeepAgentPromptPrepareResult) => Promise<DeepAgentPromptConfirmResult | false>
}

type CommentItem = {
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

const promptOutputLanguage = (locale: Locale) => (locale === "zh" || locale === "zht" ? "chinese" : "english")

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk.scope, sessionID)

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    // D3: any stop resets the scenario to `direct` and pauses scenario automation for this
    // session and its directory scope, so the next user message is a plain direct submission
    // until they re-engage intelligence.
    resetScenarioOnStop(pendingKey(sessionID), ScopedKey.from(sdk.scope, sdk.directory))

    input.onAbort?.()

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    return sdk.client.session
      .abort({
        sessionID,
      })
      .catch(() => {})
  }

  const restoreCommentItems = (items: CommentItem[]) => {
    for (const item of items) {
      prompt.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const removeCommentItems = (items: { key: string }[]) => {
    for (const item of items) {
      prompt.context.remove(item.key)
    }
  }

  const clearContext = () => {
    for (const item of prompt.context.items()) {
      prompt.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    const [, setStore] = serverSync.child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const variant = local.model.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sdk.directory
    const isNewSession = !params.id
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk.client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(sdk.scope, createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk.createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        serverSync.child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info()
    if (!session && isNewSession) {
      const created = await client.session
        .create()
        .then((x) => x.data ?? undefined)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(sessionDirectory, created)
        session = created
        if (shouldAutoAccept) permission.enableAutoAccept(session.id, sessionDirectory)
        local.session.promote(sessionDirectory, session.id)
        layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
        navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const context = prompt.context.items().slice()
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
    }
    // D1: a scenario override (from the send-adjacent toggle) takes precedence over the
    // configured promptMode. The toggle writes a directory-scoped key keyed on the PROJECT
    // directory (`sdk.directory`, stable before the session exists and before a "create worktree"
    // selection swaps `sessionDirectory` to the new worktree dir). Read the same project-scoped
    // key so the toggle's override is found at submit time even in the worktree case; resolve
    // session-then-directory. After a stop (D3) the override is "direct", so the next turn is a
    // plain direct submission until the user re-engages intelligence.
    const promptMode =
      resolveScenarioOverride(pendingKey(session.id), ScopedKey.from(sdk.scope, projectDirectory)) ??
      deepAgentPromptModeFromConfig(serverSync.data.config)
    if (promptMode === "intelligence") {
      draft.metadata = {
        deepagent: {
          prompt_pipeline: {
            mode: promptMode,
          },
        },
      }
    }

    const clearInput = () => {
      prompt.reset()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      prompt.set(currentPrompt, input.promptLength(currentPrompt))
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
    }

    if (!isNewSession && mode === "normal" && input.shouldQueue?.()) {
      input.onQueue?.(draft)
      clearContext()
      clearInput()
      return
    }

    if (mode === "shell") {
      input.onSubmit?.()
      clearInput()
      client.session
        .shell({
          sessionID: session.id,
          agent,
          model,
          command: text,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        input.onSubmit?.()
        clearInput()
        client.session
          .command({
            sessionID: session.id,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            variant,
            parts: images.map((attachment) => ({
              id: Identifier.ascending("part"),
              type: "file" as const,
              mime: attachment.mime,
              url: attachment.dataUrl,
              filename: attachment.filename,
            })),
          })
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")
    const preparesPromptDraft = promptPipelineMode(draft.metadata) === "intelligence"

    const removeOptimisticMessage = () => {
      sync.session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    if (!preparesPromptDraft) {
      removeCommentItems(commentItems)
      clearInput()
    }

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sdk.scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync.set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        restoreCommentItems(commentItems)
        restoreInput()
      }

      pending.set(pendingKey(session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([WorktreeState.wait(sdk.scope, sessionDirectory), abortWait, timeout]).finally(
        () => {
          if (timer.id === undefined) return
          clearTimeout(timer.id)
        },
      )
      pending.delete(pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    void sendFollowupDraft({
      client,
      sync,
      serverSync,
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
      onBeforeSubmit: input.onSubmit,
      onPromptPrepareStart: input.onPromptPrepareStart,
      onPromptPrepareEnd: input.onPromptPrepareEnd,
      promptOutputLanguage: promptOutputLanguage(language.locale()),
      confirmPromptDraft: input.confirmPromptDraft,
    })
      .then((sent) => {
        pending.delete(pendingKey(session.id))
        if (sent) {
          if (preparesPromptDraft) {
            clearContext()
            clearInput()
          }
          return
        }
        if (sessionDirectory === projectDirectory) {
          sync.set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (!preparesPromptDraft) restoreCommentItems(commentItems)
        restoreInput()
      })
      .catch((err) => {
        pending.delete(pendingKey(session.id))
        if (sessionDirectory === projectDirectory) {
          sync.set("session_status", session.id, { type: "idle" })
        }
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: errorMessage(err),
        })
        removeOptimisticMessage()
        if (!preparesPromptDraft) restoreCommentItems(commentItems)
        restoreInput()
      })
  }

  return {
    abort,
    handleSubmit,
  }
}
