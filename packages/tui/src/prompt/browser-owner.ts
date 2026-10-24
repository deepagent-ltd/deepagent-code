import type { DeepAgentCodeClient } from "@deepagent-code/sdk"
import type { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import type { SharedBrowserTuiSchema } from "@deepagent-code/core/browser/shared-tui-schema"
import { Identifier } from "@deepagent-code/core/id/id"

export type BrowserOwnerTransport = {
  current(): SharedBrowserTuiSchema.View | undefined
  pair(input: { rootSessionID: string; directory: string }): Promise<SharedBrowserTuiSchema.View>
  reserve(input: Omit<SharedBrowserTuiSchema.Reserve, "secret">): Promise<SharedBrowserSchema.InputStamp | undefined>
  seal(input: Omit<SharedBrowserTuiSchema.Seal, "secret">): Promise<SharedBrowserSchema.InputStamp>
  detach(): Promise<void>
  onState(callback: (view: SharedBrowserTuiSchema.View | undefined) => void): () => void
}
export type BrowserOwnerSource = Readonly<SharedBrowserTuiSchema.View>
export type BrowserOwnerTicket = {
  source: BrowserOwnerSource
  inputID: string
  originalSubmissionID: string
  stamp: Promise<SharedBrowserSchema.InputStamp | undefined>
}
type Prompt = Parameters<DeepAgentCodeClient["v2"]["session"]["prompt"]>[0]

/** An unresolved sealed submission retains the original bytes and IDs. Retrying never
 * reads the composer, refreshes Main order, or prepares the user's text a second time. */
export function createBrowserOwnerSubmit(client: DeepAgentCodeClient, transport?: BrowserOwnerTransport) {
  const state: {
    pending?: {
      request: Prompt
      ticket: BrowserOwnerTicket
      stamp?: SharedBrowserSchema.InputStamp
      dispatched: boolean
    }
    sending: boolean
  } = { sending: false }
  const failure = () => new Error("Original local terminal submission needs confirmation")
  const send = async (pending: NonNullable<typeof state.pending>) => {
    if (state.sending || state.pending !== pending || !transport) throw failure()
    state.sending = true
    try {
      const stamp = await pending.ticket.stamp
      if (stamp && !pending.stamp)
        pending.stamp = await transport.seal({
          attachID: pending.ticket.source.attachID,
          generation: pending.ticket.source.generation,
          stamp,
          prompt: pending.request.prompt,
        })
      // From this line an unknown response may already have admitted canonical input.
      // Only the exact original request may recover it; user cancellation cannot forget it.
      pending.dispatched = true
      const response = await client.v2.session.prompt(pending.request, {
        throwOnError: true,
        ...(pending.stamp
          ? { headers: { "x-dac-user-input": Buffer.from(JSON.stringify(pending.stamp)).toString("base64url") } }
          : {}),
      })
      if (state.pending === pending) state.pending = undefined
      return response
    } finally {
      state.sending = false
    }
  }
  return {
    source(sessionID?: string, directory?: string): BrowserOwnerSource | undefined {
      const view = transport?.current()
      if (
        !view ||
        !view.streamLive ||
        view.state !== "active" ||
        view.rootSessionID !== sessionID ||
        view.directory !== directory
      )
        return undefined
      return Object.freeze({ ...view })
    },
    capture(source: BrowserOwnerSource | undefined, rawInput: string): BrowserOwnerTicket | undefined {
      if (!source || !transport) return undefined
      if (state.pending) throw failure()
      const inputID = Identifier.ascending("message")
      const originalSubmissionID = Identifier.ascending("message")
      // The transport call starts synchronously, before IME deferral or intelligence preparation.
      const stamp = transport
        .reserve({
          attachID: source.attachID,
          generation: source.generation,
          expectedBarrierOrder: source.barrierOrder,
          inputID,
          originalSubmissionID,
          rawInput,
        })
        .catch(() => undefined)
      return { source, inputID, originalSubmissionID, stamp }
    },
    submit(request: Prompt, ticket?: BrowserOwnerTicket) {
      if (!ticket || !transport) return client.v2.session.prompt(request, { throwOnError: true })
      if (state.pending || request.sessionID !== ticket.source.rootSessionID) return Promise.reject(failure())
      const saved = { request: structuredClone({ ...request, id: ticket.inputID }), ticket, dispatched: false }
      if (Buffer.byteLength(JSON.stringify(saved.request)) > 8_388_608) return Promise.reject(failure())
      state.pending = saved
      return send(saved)
    },
    pending(sessionID: string) {
      return state.pending?.request.sessionID === sessionID
    },
    canCancelBeforeDispatch(sessionID: string) {
      return !state.sending && state.pending?.request.sessionID === sessionID && !state.pending.dispatched
    },
    cancelBeforeDispatch(sessionID: string) {
      if (state.sending || state.pending?.request.sessionID !== sessionID || state.pending.dispatched) return false
      state.pending = undefined
      return true
    },
    retry(sessionID: string) {
      const pending = state.pending
      return pending?.request.sessionID === sessionID ? send(pending) : Promise.reject(failure())
    },
  }
}
