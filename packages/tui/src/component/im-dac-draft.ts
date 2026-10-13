import { createStore } from "solid-js/store"
import { Schema } from "effect"
import { IMDacSessionSchema } from "@deepagent-code/core/im/dac-session.schema"
import { IMDacCommandRejected, IMRequestError, type IMClient, type IMDacCommand } from "./im-client"

export type IMDacDraftSnapshot = {
  text: string
  delivery: "queue" | "steer"
  referenceMessageIDs: string[]
  newSession: boolean
  intent?: typeof IMDacSessionSchema.Submit.Type
  commandID?: string
}

/** Recognize only an explicit command, preserving the private body after its prefix. */
export function imDacText(content: string) {
  return /^\/dac(?:\s|$)/.test(content) ? content.slice(4) : undefined
}

/** One conversation owns this draft and its ambiguous intent until disposal. */
export function createIMDacDraft(input: {
  client: IMClient
  groupID: string
  current: () => boolean
  restore?: IMDacDraftSnapshot
}) {
  const scope = input.client.scope()
  const abort = new AbortController()
  const pending = { intent: input.restore?.intent }
  const [state, setState] = createStore({
    text: input.restore?.text ?? "",
    delivery: input.restore?.delivery ?? ("queue" as "queue" | "steer"),
    referenceMessageIDs: input.restore?.referenceMessageIDs ?? ([] as string[]),
    newSession: input.restore?.newSession ?? false,
    commandID: input.restore?.commandID,
    busy: false,
    uncertain: !!pending.intent,
    replyUncertain: false,
    command: undefined as IMDacCommand | undefined,
    failure: undefined as unknown,
  })
  const current = () =>
    !abort.signal.aborted && input.current() && input.client.scope() === scope && !scope.signal?.aborted
  const requireCurrent = () => {
    if (!current()) throw new IMRequestError("dac_scope_changed", "DAC draft scope changed", 409)
  }
  const unresolved = () => state.uncertain || state.replyUncertain || state.command?.replyStatus === "unknown"
  const accept = (command: IMDacCommand) => {
    requireCurrent()
    const admittedDraft = pending.intent?.commandID === command.commandID
    setState({ command, commandID: command.commandID, uncertain: command.state === "pending", replyUncertain: false })
    if (command.state === "pending") return command
    pending.intent = undefined
    if (command.state === "admitted" && admittedDraft)
      setState({ text: "", referenceMessageIDs: [], newSession: false })
    return command
  }
  const observe = async (commandID = state.commandID) => {
    requireCurrent()
    if (state.busy || !commandID) return
    setState({ busy: true, failure: undefined })
    try {
      return accept(
        await input.client.dacCommand(
          input.groupID,
          commandID,
          AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
        ),
      )
    } catch (error) {
      if (current()) setState("failure", () => error)
      throw error
    } finally {
      if (current()) setState("busy", false)
    }
  }
  return {
    state,
    editable: () => current() && !state.busy && !unresolved(),
    update(update: Partial<Pick<IMDacDraftSnapshot, "text" | "delivery" | "referenceMessageIDs" | "newSession">>) {
      if (!current() || state.busy || unresolved()) return false
      setState(update)
      setState("failure", undefined)
      return true
    },
    snapshot(): IMDacDraftSnapshot {
      return {
        text: state.text,
        delivery: state.delivery,
        referenceMessageIDs: [...state.referenceMessageIDs],
        newSession: state.newSession,
        intent: pending.intent,
        commandID: state.commandID,
      }
    },
    async submit() {
      requireCurrent()
      if (state.busy) return
      if (pending.intent) return observe(pending.intent.commandID)
      if (unresolved()) return observe()
      if (!pending.intent) {
        if (!state.text.trim()) throw new IMRequestError("invalid_request", "DAC command is empty")
        pending.intent = Schema.decodeUnknownSync(IMDacSessionSchema.Submit)(
          {
            commandID: `dac-${crypto.randomUUID()}`,
            text: state.text,
            delivery: state.delivery,
            ...(state.referenceMessageIDs.length ? { referenceMessageIDs: [...state.referenceMessageIDs] } : {}),
            ...(state.newSession ? { newSession: true } : {}),
          },
          { onExcessProperty: "error" },
        )
      }
      // Dispatch can admit before its response is lost. Only its receipt or explicit before-admission rejection unlocks edits.
      setState({ busy: true, uncertain: true, failure: undefined, commandID: pending.intent.commandID })
      try {
        return accept(
          await input.client.dacSubmit(
            input.groupID,
            pending.intent,
            AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
          ),
        )
      } catch (error) {
        if (current()) {
          if (error instanceof IMDacCommandRejected) {
            pending.intent = undefined
            setState({ uncertain: false, commandID: undefined })
          }
          setState("failure", () => error)
        }
        throw error
      } finally {
        if (current()) setState("busy", false)
      }
    },
    refresh: observe,
    async inspect(commandID: string) {
      requireCurrent()
      if (state.busy || state.uncertain || state.replyUncertain) return
      return observe(commandID)
    },
    async retryReply() {
      requireCurrent()
      const command = state.command
      if (
        state.busy ||
        state.uncertain ||
        state.replyUncertain ||
        !command ||
        command.state !== "admitted" ||
        command.replyStatus !== "dead" ||
        !command.finalMessageID
      )
        return
      // A response can be lost after enqueueing delivery. Only GET of this command can
      // reconcile that uncertainty; the button never creates a prompt or retries the model.
      setState({ busy: true, replyUncertain: true, failure: undefined })
      try {
        return accept(
          await input.client.dacReplyRetry(
            input.groupID,
            command.commandID,
            AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
          ),
        )
      } catch (error) {
        if (current()) setState("failure", () => error)
        throw error
      } finally {
        if (current()) setState("busy", false)
      }
    },
    dispose() {
      abort.abort()
    },
  }
}

export type IMDacDraft = ReturnType<typeof createIMDacDraft>
