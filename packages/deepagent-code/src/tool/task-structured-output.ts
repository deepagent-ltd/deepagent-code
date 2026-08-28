import Ajv from "ajv"
import { Option, Schema } from "effect"

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export function validateStructuredOutput(schema: Record<string, unknown>, value: unknown): string | undefined {
  const { $schema: _, ...document } = schema
  const validate = new Ajv({ allErrors: true, strict: false }).compile(document)
  if (validate(value)) return undefined
  return (
    validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ??
    "schema validation failed"
  )
}

export function extractStructuredText(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const objectStart = trimmed.indexOf("{")
  const objectEnd = trimmed.lastIndexOf("}")
  const arrayStart = trimmed.indexOf("[")
  const arrayEnd = trimmed.lastIndexOf("]")
  return [
    trimmed,
    fenced,
    objectStart !== -1 && objectEnd > objectStart ? trimmed.slice(objectStart, objectEnd + 1) : undefined,
    arrayStart !== -1 && arrayEnd > arrayStart ? trimmed.slice(arrayStart, arrayEnd + 1) : undefined,
  ]
    .filter((candidate): candidate is string => candidate !== undefined)
    .map((candidate) => Option.getOrUndefined(decodeJson(candidate)))
    .find((candidate) => candidate !== undefined)
}
