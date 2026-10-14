import { createStore } from "solid-js/store"
import { Schema } from "effect"
import { IMActivationSchema } from "@deepagent-code/core/im/activation.schema"
import { validateIMName } from "@deepagent-code/core/im/facade-contract"
import { IMFacadeRequestError } from "@/utils/im-client"

// This port contains observations only. The Host owns the transaction and its credential custody.
export type IMActivationQuote = IMActivationSchema.Quote
export type IMActivationResult = IMActivationSchema.Transaction
export type IMActivationInput = IMActivationSchema.Submit
export const IMActivationErrorKeys = {
  insufficient_credits: "im.activation.error.insufficient_credits",
  invalid_credential: "im.activation.error.invalid_credential",
  invalid_name: "im.activation.error.invalid_name",
  code_invalid: "im.activation.error.code_invalid",
  transaction_conflict: "im.activation.error.transaction_conflict",
  unavailable: "im.activation.error.unavailable",
  invalid_input: "im.activation.error.invalid_input",
  im_activation_invalid: "im.activation.error.invalid_credential",
  im_activation_quote_expired: "im.activation.error.quote_expired",
  im_identity_conflict: "im.activation.error.transaction_conflict",
  im_activation_conflict: "im.activation.error.transaction_conflict",
  im_activation_pending: "im.activation.error.pending",
} as const
export type IMActivationClient = {
  scope: () => unknown
  activationQuote: (signal: AbortSignal) => Promise<IMActivationQuote>
  activationPending: (signal: AbortSignal) => Promise<IMActivationResult | null>
  activate: (input: IMActivationInput, signal: AbortSignal) => Promise<IMActivationResult>
  activationStatus: (transactionID: string, signal: AbortSignal) => Promise<IMActivationResult>
}

export function createIMActivation(input: {
  client: IMActivationClient
  current: () => boolean
  activated: () => void
}) {
  const captured = input.client.scope()
  const owner = {
    active: true,
    requests: new AbortController(),
    pendingConflict: false,
    transaction: undefined as Pick<IMActivationInput, "transactionID" | "name" | "method" | "quoteID"> | undefined,
  }
  const current = () => owner.active && input.current() && captured === input.client.scope()
  const signal = () => AbortSignal.any([owner.requests.signal, AbortSignal.timeout(30_000)])
  const [state, setState] = createStore({
    name: "",
    method: "activation_code" as IMActivationInput["method"],
    credential: "",
    consent: false,
    busy: false,
    observed: false,
    quote: undefined as IMActivationQuote | undefined,
    transactionID: undefined as string | undefined,
    result: undefined as IMActivationResult | undefined,
    error: "" as "" | keyof typeof IMActivationErrorKeys,
  })
  const reject = (code: string) => {
    if (!current()) return
    setState(
      "error",
      Object.hasOwn(IMActivationErrorKeys, code) ? (code as keyof typeof IMActivationErrorKeys) : "unavailable",
    )
  }
  const failure = (error: unknown) => {
    if (!current()) return
    reject(error instanceof IMFacadeRequestError ? error.code : "unavailable")
  }
  const receive = (result: IMActivationResult, transactionID: string) => {
    if (!current() || result.transactionID !== transactionID || state.transactionID !== transactionID) return
    if (
      !owner.transaction ||
      result.name !== owner.transaction.name ||
      result.method !== owner.transaction.method ||
      result.quoteID !== owner.transaction.quoteID ||
      (state.result?.chargedCredits === 1 && result.chargedCredits !== 1) ||
      (result.method === "activation_code" && result.chargedCredits === 1) ||
      (result.state === "succeeded" &&
        (result.chargedCredits === null || (result.method === "activation_code" && result.chargedCredits !== 0)))
    ) {
      setState("error", "unavailable")
      return
    }
    setState("result", result)
    if (result.state === "succeeded" && result.credentialStored) {
      setState({ transactionID: undefined, credential: "", consent: false })
      input.activated()
      return
    }
    if (result.state === "rejected") reject(result.code ?? "unavailable")
    if (result.state === "rejected" && result.chargedCredits === 0)
      setState({ transactionID: undefined, credential: "", consent: false })
  }
  const restore = (pending: IMActivationResult) => {
    if (!current()) return
    owner.transaction = {
      transactionID: pending.transactionID,
      name: pending.name,
      method: pending.method,
      quoteID: pending.quoteID,
    }
    owner.pendingConflict = false
    setState({ transactionID: pending.transactionID, name: pending.name, method: pending.method, error: "" })
    receive(pending, pending.transactionID)
  }
  const recoverPending = async () => {
    const pending = await input.client.activationPending(signal())
    if (pending) restore(pending)
  }
  const load = async () => {
    if (!current() || state.busy) return
    setState({ busy: true, observed: false, quote: undefined, error: "" })
    try {
      const pending = await input.client.activationPending(signal())
      if (!current()) return
      if (pending) restore(pending)
      setState("observed", true)
      const quote = await input.client.activationQuote(signal())
      if (!current()) return
      if (quote.priceCredits !== 1 || quote.expiresAt <= Date.now()) throw new Error("Changed activation quote")
      setState("quote", quote)
    } catch (error) {
      failure(error)
    } finally {
      if (current()) setState("busy", false)
    }
  }
  const submit = async () => {
    if (
      !current() ||
      state.busy ||
      !state.observed ||
      state.transactionID ||
      !state.quote ||
      state.quote.expiresAt <= Date.now() ||
      !state.name.trim() ||
      !state.credential.trim() ||
      (state.method === "api_key" && !state.consent)
    )
      return
    const name = validateIMName(state.name)
    if (!name.ok) {
      setState("error", "invalid_name")
      return
    }
    const request = Object.freeze({
      transactionID: `im-activation-${crypto.randomUUID()}`,
      name: name.name,
      method: state.method,
      credential: state.credential,
      quoteID: state.quote.quoteID,
    })
    if (!Schema.is(IMActivationSchema.Submit)(request)) {
      setState("error", "invalid_input")
      return
    }
    owner.transaction = {
      transactionID: request.transactionID,
      name: request.name,
      method: request.method,
      quoteID: request.quoteID,
    }
    setState({ busy: true, error: "", transactionID: request.transactionID, result: undefined })
    try {
      receive(await input.client.activate(request, signal()), request.transactionID)
    } catch (error) {
      // A transport or parsing failure provides no evidence that charging did not happen.
      failure(error)
      if (current() && error instanceof IMFacadeRequestError && error.code === "im_activation_pending") {
        // This exact Host refusal precedes this ID's admission and external POST.
        // Read the already retained transaction; it is never another purchase.
        owner.pendingConflict = true
        await recoverPending().catch(failure)
      }
    } finally {
      if (current()) setState({ busy: false, credential: "", consent: false })
    }
  }
  const check = async () => {
    const transactionID = state.transactionID
    if (!current() || state.busy || !transactionID) return
    setState({ busy: true, error: "" })
    try {
      if (owner.pendingConflict) {
        await recoverPending()
        return
      }
      receive(await input.client.activationStatus(transactionID, signal()), transactionID)
    } catch (error) {
      failure(error)
    } finally {
      if (current()) setState("busy", false)
    }
  }
  const canRetryOriginal = () =>
    current() &&
    !!owner.transaction &&
    !!state.transactionID &&
    state.result?.state === "unknown" &&
    state.result.chargedCredits === null
  const retryOriginal = async () => {
    if (!canRetryOriginal() || state.busy || !owner.transaction || !state.credential || !state.consent) return
    const request = Object.freeze({ ...owner.transaction, credential: state.credential, retryOriginal: true })
    if (!Schema.is(IMActivationSchema.Submit)(request)) {
      setState("error", "invalid_input")
      return
    }
    setState({ busy: true, error: "" })
    try {
      receive(await input.client.activate(request, signal()), request.transactionID)
    } catch (error) {
      // A failed retry does not disprove a previous payment or replace the original intent.
      failure(error)
    } finally {
      if (current()) setState({ busy: false, credential: "", consent: false })
    }
  }
  const update = (patch: Partial<Pick<typeof state, "name" | "method" | "credential" | "consent">>) => {
    if (!current() || state.busy) return
    if (state.transactionID && (!canRetryOriginal() || patch.name !== undefined || patch.method !== undefined)) return
    setState(patch)
    if (patch.name !== undefined || patch.method !== undefined || patch.credential !== undefined)
      setState("consent", false)
    if (patch.method !== undefined) setState({ credential: "", consent: false })
  }
  const dispose = () => {
    owner.active = false
    owner.requests.abort()
    setState({ credential: "", consent: false })
  }
  return { state, update, load, submit, check, canRetryOriginal, retryOriginal, current, dispose }
}
