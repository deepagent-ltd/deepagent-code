const sensitiveKey = /(?:^|[_-])(?:api[_-]?key|authorization|token|secret|password|credential|private[_-]?key|env(?:ironment)?)$|(?:ApiKey|Token|Secret|Password|Credential|PrivateKey)$/i
const environmentVariableKey = /^[A-Z][A-Z0-9_]{2,}$/
const secretValue = /\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,"'}]+))/gi
const environmentAssignment = /\b([A-Z][A-Z0-9_]{2,})\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/g
const credentialURL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@/]+@[^\s"'`<>]+/gi
const absolutePath = /(?:\/Users\/|\/home\/|\/root\/|\/tmp\/|\/var\/|[A-Za-z]:\\Users\\)[^\s"'`<>]+/g

export function sanitizeBundleValue(value: unknown): unknown {
  if (typeof value === "string") return value
    .replace(secretValue, "[REDACTED]")
    .replace(environmentAssignment, "$1=[REDACTED]")
    .replace(credentialURL, "[REDACTED_URL]")
    .replace(absolutePath, "[REDACTED_PATH]")
  if (Array.isArray(value)) return value.map(sanitizeBundleValue)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) || environmentVariableKey.test(key) ? "[REDACTED]" : sanitizeBundleValue(item)]),
    )
  return value
}
