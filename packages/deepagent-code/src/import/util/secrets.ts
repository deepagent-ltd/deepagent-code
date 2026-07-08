/**
 * Secret detection and file exclusion for imports.
 *
 * Source trees (especially `~/.claude`, `~/.codex`) routinely contain live
 * credentials: `settings.json` with an `ANTHROPIC_AUTH_TOKEN`, `auth.json`,
 * `.env` files, etc. Importing these would leak secrets into the deepagent-code
 * database / knowledge store. This module centralises every exclusion rule so
 * both parsers and the memory writer consult the same policy.
 */

/** Basenames / globs that are never read from a source tree. */
export const EXCLUDED_FILES = new Set<string>([
  "settings.json",
  "auth.json",
  ".env",
  "credentials.json",
  "oauth-credentials.json",
  "installation_id",
])

/** Basename patterns that imply a credential / state file. */
const EXCLUDED_PATTERNS = [
  /\.env(\..*)?$/i,
  /(^|[/_])token/i,
  /(^|[/_])secret/i,
  /(^|[/_])credential/i,
  /(^|[/_])\.git\/./,
  /\.sqlite(-\w+)?$/i,
  /\.db$/i,
]

/** Heuristic secret patterns to scrub out of imported text bodies. */
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /sk-[A-Za-z0-9_\-]{16,}/g, label: "OpenAI-style key" },
  { re: /sk-ant-[A-Za-z0-9_\-]{16,}/g, label: "Anthropic key" },
  { re: /Bearer\s+[A-Za-z0-9_\-\.]{16,}/gi, label: "Bearer token" },
  { re: /(?:ANTHROPIC|OPENAI|DEEPSEEK)[A-Z_]*TOKEN\s*[:=]\s*["']?[A-Za-z0-9_\-]{8,}/gi, label: "env token" },
  { re: /gh[pousr]_[A-Za-z0-9]{16,}/g, label: "GitHub token" },
  { re: /AIza[0-9A-Za-z_\-]{20,}/g, label: "Google API key" },
]

export function isExcludedFile(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? relPath
  if (EXCLUDED_FILES.has(base)) return true
  return EXCLUDED_PATTERNS.some((re) => re.test(relPath))
}

export interface RedactionResult {
  text: string
  hits: string[]
}

/** Replace likely-secret substrings with `[REDACTED:<label>]`. */
export function redactSecrets(input: string): RedactionResult {
  const hits: string[] = []
  let text = input
  for (const { re, label } of SECRET_PATTERNS) {
    text = text.replace(re, (match) => {
      hits.push(`${label}:${match.slice(0, 6)}…`)
      return `[REDACTED:${label}]`
    })
  }
  return { text, hits }
}

/** True if a body contains anything that looks like a credential. */
export function looksLikeSecret(input: string): boolean {
  return SECRET_PATTERNS.some(({ re }) => re.test(input))
}
