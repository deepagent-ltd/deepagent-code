export * as ShellDialect from "./dialect"

// POSIX-script → shell-dialect compatibility checks (D-W2). Validation commands derived from
// AGENTS.md or supplied by the user are POSIX-dialect scripts; on hosts without a POSIX shell
// they may only run under a PowerShell/cmd dialect when every construct they use is provably
// expressible there. The three rule families — quoting/escaping, env passing, pipeline semantics —
// are parameterized per dialect. Anything ambiguous fails closed: the runner reports
// unsupported_dialect instead of guessing a translation (bug-405-002 RC-2).

export type Dialect = "posix" | "pwsh" | "powershell" | "cmd"

export type Rule = "quoting" | "env" | "pipeline"

export type Issue = {
  readonly rule: Rule
  readonly detail: string
}

export type Check = { readonly ok: true } | { readonly ok: false; readonly issues: readonly Issue[] }

// Shell path/name → dialect. Normalizes win32 and posix spellings on any host so injected probes
// are testable off-Windows.
export const ofShellName = (shell: string): Dialect => {
  const base = (shell.split(/[\\/]/).pop() ?? shell).toLowerCase().replace(/\.exe$/, "")
  if (base === "pwsh") return "pwsh"
  if (base === "powershell") return "powershell"
  if (base === "cmd") return "cmd"
  return "posix"
}

type Quote = "none" | "single" | "double" | "mixed"

type Word = {
  readonly raw: string
  readonly text: string
  readonly quote: Quote
  readonly expansion: boolean // $-reference outside single quotes
  readonly backtick: boolean
  readonly doubleEscape: boolean // backslash escape inside a double-quoted span
}

type Token =
  | { readonly type: "word"; readonly word: Word }
  | { readonly type: "op"; readonly op: string }

// Command separators: after one of these the next word starts a new command.
const SEPARATORS = new Set(["&&", "||", ";", "|", "&", "\n"])

// POSIX shell builtins and control keywords that no win32 dialect can express.
const POSIX_ONLY_WORDS = new Set([
  "export",
  "unset",
  "source",
  ".",
  "alias",
  "unalias",
  "shopt",
  "declare",
  "local",
  "readonly",
  "umask",
  "ulimit",
  "trap",
  "eval",
  "exec",
  "set",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "select",
  "[",
  "[[",
])

const OPS = ["&&", "||", "|&", ">>", "<<<", "<<", ">&", ";", "&", "|", ">", "<", "(", ")", "{", "}"]

function tokenize(script: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = script.length
  while (i < n) {
    const c = script[i]!
    if (c === " " || c === "\t" || c === "\r") {
      i++
      continue
    }
    if (c === "\n") {
      tokens.push({ type: "op", op: "\n" })
      i++
      continue
    }
    // comment: only at a token boundary (a `#` inside a word is literal)
    if (c === "#") {
      while (i < n && script[i] !== "\n") i++
      continue
    }

    // fd-aware redirection with an explicit numeric fd: 2>&1, 2>file, ...
    const fd = script.slice(i).match(/^\d+>&\d+|^\d+>>|^\d+>|^\d+</)
    if (fd) {
      tokens.push({ type: "op", op: fd[0] })
      i += fd[0].length
      continue
    }

    const op = OPS.find((candidate) => script.startsWith(candidate, i))
    if (op) {
      tokens.push({ type: "op", op })
      i += op.length
      continue
    }

    // word: consumes until an unquoted separator/operator character
    let raw = ""
    let text = ""
    let single = false
    let double = false
    let quotedSingle = false
    let quotedDouble = false
    let expansion = false
    let backtick = false
    let doubleEscape = false
    while (i < n) {
      const ch = script[i]!
      if (!single && !double) {
        if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") break
        if (/[<>]/.test(ch)) break
        if (ch === "&" || ch === "|" || ch === ";" || ch === "(" || ch === ")" || ch === "{" || ch === "}") break
      }
      if (ch === "'" && !double) {
        single = !single
        quotedSingle = true
        raw += ch
        i++
        continue
      }
      if (ch === '"' && !single) {
        double = !double
        quotedDouble = true
        raw += ch
        i++
        continue
      }
      if (ch === "`") {
        backtick = true
        raw += ch
        text += ch
        i++
        continue
      }
      if (ch === "\\") {
        if (single) {
          raw += ch
          text += ch
          i++
          continue
        }
        const next = script[i + 1]
        if (double) doubleEscape = true
        raw += ch + (next ?? "")
        text += ch + (next ?? "")
        i += next ? 2 : 1
        continue
      }
      if (ch === "$" && !single) expansion = true
      raw += ch
      text += ch
      i++
    }
    const quote: Quote = quotedSingle && quotedDouble ? "mixed" : quotedSingle ? "single" : quotedDouble ? "double" : "none"
    if (raw !== "") tokens.push({ type: "word", word: { raw, text, quote, expansion, backtick, doubleEscape } })
  }
  return tokens
}

// A leading NAME=value run before the command word is POSIX inline env passing.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

export function checkPosixScript(script: string, dialect: Dialect): Check {
  if (dialect === "posix") return { ok: true }
  const ps = dialect === "pwsh" || dialect === "powershell"
  const issues: Issue[] = []
  const tokens = tokenize(script)
  let commandStart = true

  for (const token of tokens) {
    if (token.type === "op") {
      const op = token.op
      if (SEPARATORS.has(op)) commandStart = true
      if ((op === "&&" || op === "||") && dialect === "powershell")
        issues.push({ rule: "pipeline", detail: `Windows PowerShell 5.1 has no "${op}" chain operator` })
      if (op === "&" || op === "|&")
        issues.push({ rule: "pipeline", detail: `POSIX "${op}" background/pipe-both semantics do not exist in ${dialect}` })
      if (op === ";" && dialect === "cmd")
        issues.push({ rule: "pipeline", detail: `cmd.exe has no ";" command separator` })
      if (op === "<<" || op === "<<<")
        issues.push({ rule: "pipeline", detail: `heredoc/herestring "${op}" cannot be expressed in ${dialect}` })
      if (op === "<" && ps)
        issues.push({ rule: "pipeline", detail: `stdin redirection "<" is not supported by ${dialect}` })
      if (op === ">&")
        issues.push({ rule: "pipeline", detail: `ambiguous fd duplication ">&" is not portable to ${dialect}` })
      if (op === "(" || op === ")" || op === "{" || op === "}")
        issues.push({ rule: "pipeline", detail: `POSIX grouping "${op}" cannot be expressed in ${dialect}` })
      continue
    }

    const word = token.word
    if (commandStart && word.quote === "none" && ASSIGNMENT.test(word.text)) {
      issues.push({ rule: "env", detail: `inline env assignment "${word.raw.split("=")[0]}=…" requires POSIX env passing` })
      continue
    }
    if (commandStart && word.quote === "none" && POSIX_ONLY_WORDS.has(word.text))
      issues.push({ rule: "pipeline", detail: `"${word.text}" is a POSIX shell builtin/keyword without a ${dialect} equivalent` })
    commandStart = false

    if (word.expansion)
      issues.push({ rule: "quoting", detail: `\`$\` expansion in "${word.raw}" binds differently (or not at all) in ${dialect}` })
    if (word.backtick)
      issues.push({ rule: "quoting", detail: `backtick in "${word.raw}" is command substitution in POSIX but an escape in PowerShell` })
    if (word.doubleEscape)
      issues.push({ rule: "quoting", detail: `backslash escape inside double quotes in "${word.raw}" is not honored by ${dialect}` })
    if (dialect === "cmd") {
      if (word.quote === "single" || word.quote === "mixed")
        issues.push({ rule: "quoting", detail: `single quotes in "${word.raw}" do not group arguments in cmd.exe` })
      if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(word.text))
        issues.push({ rule: "quoting", detail: `"%NAME%" in "${word.raw}" would be env-expanded by cmd.exe` })
      if (word.quote === "none" && word.text.startsWith("~"))
        issues.push({ rule: "quoting", detail: `tilde expansion in "${word.raw}" does not exist in cmd.exe` })
      if (word.quote === "none" && word.text.startsWith("/"))
        issues.push({ rule: "quoting", detail: `POSIX path "${word.raw}" reads as a switch to cmd.exe` })
    }
    if (ps && word.quote === "none" && /^\/(dev|proc|sys|tmp|etc|usr|bin|var)\//.test(word.text))
      issues.push({ rule: "quoting", detail: `POSIX absolute path "${word.raw}" does not exist under ${dialect}` })
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true }
}
