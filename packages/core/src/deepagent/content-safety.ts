export * as ContentSafety from "./content-safety"

// V4.0 §E3 — the CONTENT SAFETY scrubber. A PURE, deterministic function that sanitises any text about
// to leave the trust boundary (an agent-authored push, a log excerpt, an LLM prompt/response). It
// mirrors the redaction approach of deepagent-code's import/util/secrets.ts but is reimplemented
// SELF-CONTAINED here because `core` cannot import from deepagent-code.
//
// LAYERING: lives in `core`, imports NOTHING. No IO, no config store — the caller passes the allowlist
// and limits in, so this stays a pure, unit-testable policy.
//
// §E3 责任, mapped to `scrub`:
//   secret 脱敏     : replace API keys / tokens / bearer / aws keys with «redacted».
//   文件路径权限    : (path allowlisting is resolved by the caller against the FS ACL — not here).
//   外链白名单      : strip URLs whose host is not in `allowedLinkHosts` (undefined = allow all).
//   大日志截断      : truncate content beyond `maxLogChars` with a `…[truncated]` marker.
//   注入风险标记    : FLAG (not modify) content matching common prompt-injection patterns.

const REDACTED = "«redacted»"
const LINK_REMOVED = "«link removed»"
const TRUNCATION_MARKER = "…[truncated]"

// Lenient default log ceiling — large but bounded. Callers tighten per surface.
const DEFAULT_MAX_LOG_CHARS = 100_000

// §E3 secret 脱敏 — heuristic credential patterns. Mirrors secrets.ts SECRET_PATTERNS. All global so
// every occurrence is replaced.
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-ant-[A-Za-z0-9_\-]{16,}/g, // Anthropic key (before the generic sk- rule)
  /sk-[A-Za-z0-9_\-]{16,}/g, // OpenAI-style key
  /Bearer\s+[A-Za-z0-9_\-\.]{16,}/gi, // Bearer token
  /(?:ANTHROPIC|OPENAI|DEEPSEEK)[A-Z_]*TOKEN\s*[:=]\s*["']?[A-Za-z0-9_\-]{8,}/gi, // env token
  /gh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub token
  /AIza[0-9A-Za-z_\-]{20,}/g, // Google API key
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
]

// §E3 注入风险标记 — common prompt-injection tells. Case-insensitive; used only to set the flag (not a
// hard gate). Patterns are deliberately broad on the connective words (the/your/any/all/prior + a
// bounded `\w+` gap) so obvious variants ("ignore your previous instructions", "ignore all prior
// instructions") are caught, while the bounded `{0,3}` word gap avoids catastrophic backtracking.
const INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /ignore\s+(?:\w+\s+){0,3}(?:previous|prior|above|earlier)\s+(?:instructions|prompts?|context)/i,
  /(?:disregard|forget|override)\s+(?:\w+\s+){0,3}(?:previous|prior|above|earlier|instructions|prompt)/i,
  /you\s+are\s+now\b/i,
  /system\s+prompt/i,
  /new\s+instructions\s*:/i,
]

// Any http(s) URL. Host is captured to check against the allowlist.
const URL_PATTERN = /https?:\/\/([^\s/?#]+)[^\s]*/gi

export interface ScrubInput {
  readonly content: string
  // external-link allowlist by host. UNDEFINED = allow all links (strip none); an explicit (possibly
  // empty) array strips every URL whose host is not listed.
  readonly allowedLinkHosts?: ReadonlyArray<string>
  // truncate beyond this many chars. Defaults to a lenient 100_000.
  readonly maxLogChars?: number
}

export interface ScrubResult {
  readonly content: string
  readonly redactedSecrets: number
  readonly strippedLinks: number
  readonly truncated: boolean
  readonly promptInjectionSuspected: boolean
}

// Extract the bare host (drop any userinfo / port / trailing punctuation) from a URL's authority for
// allowlist comparison. A trailing dot (FQDN root, or a URL ending a sentence — "see https://ok.com.")
// is stripped so a whitelisted host isn't over-stripped by punctuation.
const hostOf = (authority: string): string => {
  const noUser = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority
  const noPort = noUser.split(":")[0] ?? noUser
  return noPort.replace(/\.+$/, "").toLowerCase()
}

/**
 * §E3 — sanitise `content` and report what was changed/flagged. Order:
 *   1. redact secrets   → replace each match with «redacted», counting hits.
 *   2. strip links      → if an allowlist is provided, replace disallowed URLs with «link removed».
 *   3. flag injection   → set promptInjectionSuspected if any injection pattern matches (no mutation).
 *   4. truncate         → cut beyond maxLogChars, appending `…[truncated]`.
 * Injection detection runs on the post-redaction/post-strip text and does NOT alter content.
 */
export const scrub = (input: ScrubInput): ScrubResult => {
  let content = input.content
  let redactedSecrets = 0
  let strippedLinks = 0

  // 1. secret 脱敏
  for (const re of SECRET_PATTERNS) {
    content = content.replace(re, () => {
      redactedSecrets++
      return REDACTED
    })
  }

  // 2. 外链白名单 — undefined allowlist = allow all (strip nothing). An explicit list strips others.
  const allowed = input.allowedLinkHosts
  if (allowed != null) {
    const allowedLower = allowed.map((h) => h.toLowerCase())
    content = content.replace(URL_PATTERN, (match, authority: string) => {
      if (allowedLower.includes(hostOf(authority))) return match
      strippedLinks++
      return LINK_REMOVED
    })
  }

  // 3. 注入风险标记 — flag only, never mutate.
  const promptInjectionSuspected = INJECTION_PATTERNS.some((re) => re.test(content))

  // 4. 大日志截断 — cut on CODE-POINT boundaries (Array.from), not UTF-16 units, so truncating at a
  // boundary that lands mid-surrogate (emoji/astral char) never leaves a lone surrogate in the output.
  const maxLogChars = input.maxLogChars ?? DEFAULT_MAX_LOG_CHARS
  let truncated = false
  const codepoints = Array.from(content)
  if (codepoints.length > maxLogChars) {
    content = codepoints.slice(0, maxLogChars).join("") + TRUNCATION_MARKER
    truncated = true
  }

  return { content, redactedSecrets, strippedLinks, truncated, promptInjectionSuspected }
}
