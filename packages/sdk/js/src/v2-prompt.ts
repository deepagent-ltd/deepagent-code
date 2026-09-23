import type { Prompt, SessionPromptData } from "./gen/types.gen.js"

/** Preserve the legacy composer request while admitting through the V2 Session authority. */
export function toV2Prompt(input: NonNullable<SessionPromptData["body"]>): Prompt {
  if (input.parts.some((part) => part.type === "subtask"))
    throw new Error("Subtask prompt parts require the task tool; V2 prompt admission cannot represent them")
  const text = input.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n")
  const files = input.parts.flatMap((part) =>
    part.type === "file"
      ? [{
          uri: part.url,
          mime: part.mime,
          ...(part.filename === undefined ? {} : { name: part.filename }),
          ...(part.source === undefined
            ? {}
            : { source: { text: part.source.text.value, start: part.source.text.start, end: part.source.text.end } }),
        }]
      : [],
  )
  const agents = input.parts.flatMap((part) =>
    part.type === "agent"
      ? [{
          name: part.name,
          ...(part.source === undefined
            ? {}
            : { source: { text: part.source.value, start: part.source.start, end: part.source.end } }),
        }]
      : [],
  )
  if (!text.trim() && files.length === 0 && agents.length === 0)
    throw new Error("V2 prompt admission requires text, a file, or an agent attachment")
  return {
    text,
    ...(files.length === 0 ? {} : { files }),
    ...(agents.length === 0 ? {} : { agents }),
    ...(input.format === undefined ? {} : { format: input.format }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.model === undefined
      ? {}
      : { model: { id: input.model.modelID, providerID: input.model.providerID,
          ...(input.variant === undefined ? {} : { variant: input.variant }) } }),
    ...(input.intentID === undefined && input.intentSource === undefined && input.intentVariant === undefined
      ? {}
      : { intent: { id: input.intentID, source: input.intentSource, variant: input.intentVariant } }),
  }
}
