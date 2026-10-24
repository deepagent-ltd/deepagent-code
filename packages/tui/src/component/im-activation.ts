import { createStore } from "solid-js/store"
import { Schema } from "effect"
import { IMActivationSchema } from "@deepagent-code/core/im/activation.schema"
import { validateIMName } from "@deepagent-code/core/im/facade-contract"
import { IMRequestError, type IMClient } from "./im-client"

export function createIMActivation(input: { client: IMClient; current: () => boolean }) {
  const captured = input.client.scope()
  const abort = new AbortController()
  const pending = {
    conflict: false,
    intent: undefined as Pick<IMActivationSchema.Submit, "transactionID" | "name" | "method" | "quoteID"> | undefined,
  }
  const [state, setState] = createStore({
    name: "",
    method: "api_key" as IMActivationSchema.Submit["method"],
    credential: "",
    confirmed: false,
    quote: undefined as IMActivationSchema.Quote | undefined,
    transaction: undefined as IMActivationSchema.Transaction | undefined,
    transactionID: undefined as string | undefined,
    initialized: false,
    busy: false,
    uncertain: false,
    failure: undefined as unknown,
  })
  const current = () =>
    input.current() && !abort.signal.aborted && !captured.signal?.aborted && captured === input.client.scope()
  const requireCurrent = () => {
    if (!current()) throw new IMRequestError("im_activation_unavailable", "Activation scope changed")
  }
  const signal = () => AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)])
  const accept = (transaction: IMActivationSchema.Transaction) => {
    requireCurrent()
    if (
      (state.transaction?.chargedCredits === 1 && transaction.chargedCredits !== 1) ||
      (transaction.method === "activation_code" && transaction.chargedCredits === 1) ||
      (transaction.state === "succeeded" &&
        (transaction.chargedCredits === null ||
          (transaction.method === "activation_code" && transaction.chargedCredits !== 0)))
    )
      throw new IMRequestError("im_activation_unavailable", "Activation charge was not observed")
    const prior = state.transaction ?? pending.intent
    if (
      (state.transactionID && transaction.transactionID !== state.transactionID) ||
      (prior &&
        (transaction.name !== prior.name ||
          transaction.method !== prior.method ||
          transaction.quoteID !== prior.quoteID))
    )
      throw new IMRequestError("im_activation_unavailable", "Activation transaction changed")
    const uncertain =
      transaction.state === "pending" ||
      transaction.state === "unknown" ||
      (transaction.state === "succeeded" && !transaction.credentialStored) ||
      (transaction.state === "rejected" && transaction.chargedCredits !== 0)
    setState({ transaction, transactionID: transaction.transactionID, uncertain })
    if (!uncertain) {
      pending.intent = undefined
      setState({ credential: "", confirmed: false })
    }
    return transaction
  }
  const editable = () =>
    current() && state.initialized && !state.busy && !state.uncertain && state.transaction?.state !== "succeeded"
  const canRetryOriginal = () =>
    current() &&
    !!state.transactionID &&
    state.transaction?.state === "unknown" &&
    state.transaction.chargedCredits === null
  const recoverPending = async () => {
    const transaction = await input.client.activationPending(signal())
    requireCurrent()
    if (!transaction) throw new IMRequestError("im_activation_unavailable", "Pending activation was not observed")
    pending.intent = {
      transactionID: transaction.transactionID,
      name: transaction.name,
      method: transaction.method,
      quoteID: transaction.quoteID,
    }
    setState({
      transaction: undefined,
      transactionID: transaction.transactionID,
      name: transaction.name,
      method: transaction.method,
    })
    const result = accept(transaction)
    pending.conflict = false
    return result
  }
  return {
    state,
    editable,
    canRetryOriginal,
    update(
      value: Partial<Pick<IMActivationSchema.Submit, "name" | "method" | "credential">> & { confirmed?: boolean },
    ) {
      if (!editable() && !(canRetryOriginal() && !state.busy && value.name === undefined && value.method === undefined))
        return false
      setState({
        ...value,
        failure: undefined,
        ...(value.name !== undefined || value.method !== undefined || value.credential !== undefined
          ? { confirmed: false }
          : {}),
      })
      if (state.transaction?.state === "rejected") setState({ transaction: undefined, transactionID: undefined })
      return true
    },
    async retryOriginal() {
      requireCurrent()
      const transaction = state.transaction
      if (!canRetryOriginal() || state.busy || !transaction || !state.credential || !state.confirmed) return
      const request = {
        transactionID: transaction.transactionID,
        name: transaction.name,
        method: transaction.method,
        quoteID: transaction.quoteID,
        credential: state.credential,
        retryOriginal: true,
      }
      Schema.decodeUnknownSync(IMActivationSchema.Submit)(request, { onExcessProperty: "error" })
      setState({ busy: true, failure: undefined })
      try {
        return accept(await input.client.activate(request, signal()))
      } catch (error) {
        if (current()) setState("failure", () => error)
        throw error
      } finally {
        if (current()) setState({ busy: false, credential: "", confirmed: false })
      }
    },
    async load(readQuote = true) {
      requireCurrent()
      if (state.busy || state.uncertain) return
      setState({ busy: true, failure: undefined })
      try {
        const transaction = await input.client.activationPending(signal())
        requireCurrent()
        if (transaction) return accept(transaction)
        if (!readQuote) return
        const quote = await input.client.activationQuote(signal())
        requireCurrent()
        setState({ quote, initialized: true })
      } catch (error) {
        if (current()) setState("failure", () => error)
        throw error
      } finally {
        if (current()) setState({ busy: false, initialized: true })
      }
    },
    async submit() {
      requireCurrent()
      if (!editable()) return
      const name = validateIMName(state.name)
      if (!name.ok || !state.credential || (state.method === "api_key" && !state.confirmed))
        throw new IMRequestError("im_activation_missing", "Explicit activation confirmation is required")
      if (!state.quote || state.quote.expiresAt <= Date.now())
        throw new IMRequestError("im_activation_expired", "Activation quote expired")
      const request = Schema.decodeUnknownSync(IMActivationSchema.Submit)(
        {
          transactionID: `im-${crypto.randomUUID()}`,
          name: name.name,
          method: state.method,
          credential: state.credential,
          quoteID: state.quote.quoteID,
        },
        { onExcessProperty: "error" },
      )
      pending.intent = {
        transactionID: request.transactionID,
        name: request.name,
        method: request.method,
        quoteID: request.quoteID,
      }
      setState({ busy: true, uncertain: true, failure: undefined, transactionID: request.transactionID })
      try {
        return accept(await input.client.activate(request, signal()))
      } catch (error) {
        if (current() && error instanceof IMRequestError && error.code === "im_activation_pending") {
          // This exact Host refusal precedes this ID's admission and external POST.
          // Adopt the retained transaction only through its current observation.
          pending.conflict = true
          return await recoverPending().catch((cause: unknown) => {
            if (current()) setState("failure", () => cause)
            throw cause
          })
        }
        if (current()) setState("failure", () => error)
        throw error
      } finally {
        setState({ credential: "", confirmed: false })
        if (current()) setState("busy", false)
      }
    },
    async refresh(transactionID = state.transactionID) {
      requireCurrent()
      if (state.busy || !transactionID) return
      Schema.decodeUnknownSync(IMActivationSchema.Submit.fields.transactionID)(transactionID)
      if (state.transactionID && transactionID !== state.transactionID)
        throw new IMRequestError("im_activation_unavailable", "Original transaction is required")
      setState({ busy: true, failure: undefined, transactionID, uncertain: true })
      try {
        if (pending.conflict) return await recoverPending()
        return accept(await input.client.activationStatus(transactionID, signal()))
      } catch (error) {
        if (current()) setState("failure", () => error)
        throw error
      } finally {
        if (current()) setState("busy", false)
      }
    },
    dispose() {
      abort.abort()
      pending.intent = undefined
      pending.conflict = false
      setState("credential", "")
    },
  }
}

export type IMActivation = ReturnType<typeof createIMActivation>
