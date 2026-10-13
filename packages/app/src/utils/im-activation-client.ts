import type { DeepAgentCodeClient } from "@deepagent-code/sdk"
import { Option, Schema } from "effect"
import { IMActivationSchema } from "@deepagent-code/core/im/activation.schema"
import type { IMActivationClient } from "@/components/im/activation-controller"
import { IMFacadeRequestError } from "./im-client"

export function createIMActivationClient(input: {
  client: DeepAgentCodeClient
  scope: () => unknown
  current: () => boolean
}): IMActivationClient {
  const captured = input.scope()
  const current = () => input.current() && captured === input.scope()
  const read = async (action: () => Promise<{ data?: unknown; error?: unknown; response?: Response }>) => {
    if (!current()) throw new IMFacadeRequestError("status_changed", "Activation scope changed", 503)
    const result = await action()
    if (!current()) throw new IMFacadeRequestError("status_changed", "Activation scope changed", 503)
    if (result.error || result.data === undefined) {
      const detail =
        result.error && typeof result.error === "object" && "data" in result.error ? result.error.data : undefined
      const code =
        detail && typeof detail === "object" && "code" in detail && typeof detail.code === "string"
          ? detail.code
          : "unavailable"
      throw new IMFacadeRequestError(code, "Activation could not be confirmed", result.response?.status ?? 503)
    }
    return result.data
  }
  return {
    scope: input.scope,
    async activationQuote(signal) {
      const decoded = Schema.decodeUnknownOption(IMActivationSchema.Quote)(
        await read(() => input.client.im.activationQuote({}, { signal, throwOnError: false })),
      )
      if (Option.isNone(decoded)) throw new IMFacadeRequestError("invalid_response", "Invalid activation quote", 503)
      return decoded.value
    },
    async activationPending(signal) {
      const decoded = Schema.decodeUnknownOption(IMActivationSchema.Pending)(
        await read(() => input.client.im.activationPending({}, { signal, throwOnError: false })),
      )
      if (Option.isNone(decoded))
        throw new IMFacadeRequestError("invalid_response", "Invalid activation observation", 503)
      return decoded.value.transaction
    },
    async activate(request, signal) {
      const decoded = Schema.decodeUnknownOption(IMActivationSchema.Transaction)(
        await read(() => input.client.im.activate(request, { signal, throwOnError: false })),
      )
      if (Option.isNone(decoded)) throw new IMFacadeRequestError("invalid_response", "Invalid activation receipt", 503)
      return decoded.value
    },
    async activationStatus(transactionID, signal) {
      const decoded = Schema.decodeUnknownOption(IMActivationSchema.Transaction)(
        await read(() => input.client.im.activationStatus({ transactionID }, { signal, throwOnError: false })),
      )
      if (Option.isNone(decoded)) throw new IMFacadeRequestError("invalid_response", "Invalid activation receipt", 503)
      return decoded.value
    },
  }
}
