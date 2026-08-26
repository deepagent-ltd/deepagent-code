import type { Message } from "@deepagent-code/sdk/v2/client"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

export function promptAdmissionClientMessageID(message: Message): string | undefined {
  if (message.role !== "user") return undefined
  const deepagent = message.metadata?.deepagent
  if (!isRecord(deepagent)) return undefined
  const admission = deepagent.promptAdmission
  if (!isRecord(admission)) return undefined
  return typeof admission.clientMessageID === "string" ? admission.clientMessageID : undefined
}
