function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function unwrap(message: string) {
  const text = message.replace(/^Error:\s*/, "").trim()
  const parse = (value: string) => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }
  const read = (value: string) => {
    const first = parse(value)
    if (typeof first !== "string") return first
    return parse(first.trim())
  }

  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  const json = read(text) ?? (start !== -1 && end > start ? read(text.slice(start, end + 1)) : undefined)
  if (!record(json)) return text

  const error = record(json.error) ? json.error : undefined
  if (typeof error?.message === "string") return error.message
  if (typeof json.message === "string") return json.message
  if (typeof json.error === "string") return json.error
  if (typeof error?.type === "string") return error.type
  if (typeof error?.code === "string") return error.code
  return text
}

export function describeSessionError(error: { name?: string; data?: unknown }) {
  const message = record(error.data) ? error.data.message : undefined
  const detail = typeof message === "string" ? unwrap(message) : (error.name ?? "")

  return {
    kind: classifyError(`${error.name ?? ""} ${detail}`),
    detail: detail.replace(/((?:api[\s_-]*key|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;)}\]]+/gi, "$1[redacted]"),
  } as const
}

function classifyError(text: string) {
  if (
    /authentication[_ -]?error|authentication fails|invalid api key|api key.{0,50}invalid|unauthori[sz]ed|(?:http|status(?: code)?)\s*401/i.test(
      text,
    )
  )
    return "authentication"
  if (/permission[_ -]?denied|insufficient.permissions|forbidden|(?:http|status(?: code)?)\s*403/i.test(text))
    return "permission"
  if (/insufficient[_ -]?quota|quota[_ -]?exceeded|billing[_ -]?error/i.test(text)) return "quota"
  if (/rate[_ -]?limit|too many requests|(?:http|status(?: code)?)\s*429/i.test(text)) return "rateLimit"
  if (/context[_ -]?length[_ -]?exceeded|context window|prompt is too long/i.test(text)) return "context"
  if (/network[_ -]?error|fetch failed|econnreset|etimedout|enotfound/i.test(text)) return "network"
  return "unknown"
}
