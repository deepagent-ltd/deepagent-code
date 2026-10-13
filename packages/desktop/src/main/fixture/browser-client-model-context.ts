export * as BrowserClientModelContext from "./browser-client-model-context"

/** Read-only QA model context parsing. Returning a public control reference does
 * not provide a scope, permission, admission or Native lease. */
export function controlID(messages: readonly { role: string; content: unknown }[]) {
  const text = messages.filter((message) => message.role === "user").flatMap((message) =>
    typeof message.content === "string" ? [message.content] : Array.isArray(message.content)
      ? message.content.flatMap((value: unknown) => value && typeof value === "object" && "text" in value &&
        typeof value.text === "string" ? [value.text] : []) : []).join("\n")
  if (!text.includes("Bounded browser program approved"))
    throw new Error("The original client must explicitly use its approved program")
  const references = Array.from(new Set(Array.from(text.matchAll(/browser controlID:\s*([a-f0-9-]{36})(?![a-f0-9-])/g),
    (match) => match[1]!)))
  if (references.length !== 1)
    throw new Error("Exactly one original client control marker is required")
  return references[0]!
}
