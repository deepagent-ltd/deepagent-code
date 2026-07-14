export * as CommandIntent from "./command-intent"

// Command intent classification for the Plan Gate (U1/U9). The gate soft/hard-blocks MUTATING tools
// while the plan latch is stale, but a shell command that only INSPECTS the world (ls, cat, grep,
// git status, curl probes, …) must never be blocked — those are the agent's eyes, and blocking them
// would make a stale plan impossible to diagnose and repair. This module decides whether a shell
// command string is provably read-only.
//
// FAIL-SAFE CONTRACT (load-bearing): this classifier is used to RELAX the gate, so it must never
// misclassify a mutating command as read-only. Any ambiguity — an unknown command, an unparseable
// segment, a redirection, a write-capable operator, elevated privilege — resolves to `mutating`.
// It is acceptable (merely slightly conservative) to classify a read-only command as mutating; it is
// NOT acceptable to classify a mutating command as read-only. Every branch below is written so the
// default answer is `mutating`.
//
// This is a pure, lexical analyzer (no tree-sitter): core has no shell-parser dependency, and a
// lexical pass is the right tool for a fail-safe gate — it cannot "successfully parse" a hostile
// command into a benign shape. deepagent-code's shell tool keeps its own tree-sitter path for
// permission scanning; this is deliberately independent and stricter.

export type CommandIntent = "read_only" | "mutating"

// Prefix → arity: how many leading tokens define the "command" for a read-only match. Flags between
// the command word and its subcommand are skipped by the matcher, so `git --no-pager status` still
// matches the `git status` (arity 2) entry. Only commands that CANNOT mutate the filesystem, process
// table, network state, or environment in a persistent way belong here. When in doubt, leave it out.
const READ_ONLY_PREFIXES: ReadonlyArray<readonly string[]> = [
  // ── filesystem inspection ──
  ["ls"],
  ["cat"],
  ["bat"],
  ["head"],
  ["tail"],
  ["wc"],
  ["file"],
  ["stat"],
  ["du"],
  ["df"],
  ["tree"],
  ["realpath"],
  ["readlink"],
  ["basename"],
  ["dirname"],
  ["pwd"],
  ["find"], // read-only UNLESS it carries an action flag (guarded separately below)
  // ── content search ──
  ["grep"],
  ["egrep"],
  ["fgrep"],
  ["rg"],
  ["ag"],
  ["ripgrep"],
  // ── environment / introspection (query forms only) ──
  ["which"],
  ["whereis"],
  ["type"],
  ["echo"],
  ["printf"],
  ["date"],
  ["whoami"],
  ["id"],
  ["hostname"],
  ["uname"],
  ["env"], // read-only ONLY with no assignment/command args (guarded below)
  ["printenv"],
  ["locale"],
  ["uptime"],
  ["ps"],
  ["top"],
  ["htop"],
  ["free"],
  ["df"],
  ["lsof"],
  ["jobs"],
  ["history"],
  // ── version / help probes ──
  ["node", "--version"],
  ["node", "-v"],
  ["python", "--version"],
  ["python3", "--version"],
  ["go", "version"],
  ["rustc", "--version"],
  ["java", "-version"],
  // ── git (read-only subcommands only) ──
  ["git", "status"],
  ["git", "log"],
  ["git", "diff"],
  ["git", "show"],
  ["git", "branch"],
  ["git", "tag"],
  ["git", "remote"],
  ["git", "rev-parse"],
  ["git", "rev-list"],
  ["git", "describe"],
  ["git", "blame"],
  ["git", "ls-files"],
  ["git", "ls-remote"],
  ["git", "cat-file"],
  ["git", "config", "--get"],
  ["git", "config", "--list"],
  ["git", "config", "-l"],
  ["git", "shortlog"],
  ["git", "reflog"],
  ["git", "whatchanged"],
  // ── container / orchestration (query verbs only) ──
  ["docker", "ps"],
  ["docker", "images"],
  ["docker", "logs"],
  ["docker", "inspect"],
  ["docker", "version"],
  ["docker", "info"],
  ["kubectl", "get"],
  ["kubectl", "describe"],
  ["kubectl", "logs"],
  ["kubectl", "version"],
  // ── package-manager query verbs ──
  ["npm", "ls"],
  ["npm", "list"],
  ["npm", "view"],
  ["npm", "outdated"],
  ["pip", "list"],
  ["pip", "show"],
  ["pip", "freeze"],
  ["cargo", "tree"],
  ["brew", "list"],
  ["brew", "info"],
  // ── network probes (read-only unless they write a file; guarded below) ──
  ["curl"], // mutating if it carries -o/-O/--output/--remote-name (guarded)
]

// After fd-duplication spans (2>&1, 1>&2, >&2) are stripped, ANY remaining `>` is a file-writing
// redirection (> truncate, >> append, <> read-write), which makes the segment mutating. Input `<`
// alone is not mutating. We check for a bare `>` on the stripped text.

// Command words that are inherently mutating no matter their flags. Fast reject before prefix match.
const MUTATING_COMMANDS = new Set<string>([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "dd",
  "mkdir",
  "touch",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "truncate",
  "shred",
  "tee",
  "install",
  "sed", // sed alone is read-only, but `sed -i` mutates; treat as mutating unless we prove otherwise (guarded)
  "kill",
  "killall",
  "pkill",
  "reboot",
  "shutdown",
  "mkfs",
  "mount",
  "umount",
  "export",
  "unset",
  "set",
  "source",
  ".",
  "eval",
  "exec",
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pacman",
  "systemctl",
  "service",
  "crontab",
])

// Extract the shell segments that run as their own command. We split on the operators that separate
// commands: && || ; | & (background) and newlines. This is intentionally coarse: a segment that
// contains anything we cannot prove read-only makes the WHOLE command mutating.
const SEGMENT_SPLIT = /(?:&&|\|\||[;\n|&])/

// Lexical tokenizer that keeps quoted spans intact (mirrors the tokenizer in tool/bash.ts).
const tokenize = (segment: string): string[] => segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []

const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2")

// A token is a "flag" if it begins with `-` (short/long option).
const isFlag = (token: string) => token.startsWith("-")

// Does the segment's leading command match a read-only prefix? Returns the matched prefix length (in
// tokens consumed), or 0 if no read-only prefix matches. Intervening flags that are NOT part of the
// prefix are skipped, so `git --no-pager status` still resolves to `git status`. A flag that IS the
// next expected prefix component (e.g. the `--version` in `node --version`, the `--get` in
// `git config --get`) is matched normally rather than skipped.
const matchReadOnlyPrefix = (tokens: string[]): number => {
  const words = tokens.map(unquote)
  for (const prefix of READ_ONLY_PREFIXES) {
    let matched = 0
    let tokenCursor = 0
    for (; tokenCursor < words.length && matched < prefix.length; tokenCursor++) {
      const token = words[tokenCursor]
      if (token === prefix[matched]) {
        matched++
        continue
      }
      // Skip a non-matching flag only when the expected component is itself NOT a flag — otherwise a
      // flag-typed prefix component (--version/--get) could be silently skipped past.
      if (isFlag(token) && !isFlag(prefix[matched])) continue
      break
    }
    if (matched === prefix.length) return tokenCursor
  }
  return 0
}

// `find` is read-only unless it carries an action predicate that executes or deletes.
const FIND_MUTATING_ACTIONS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf"])

// `env` is read-only only as a bare query (`env`); `env FOO=bar cmd` runs a command with a mutated
// environment, so anything past the command word makes it mutating.
const isReadOnlySegment = (segment: string): boolean => {
  const trimmed = segment.trim()
  if (trimmed === "") return true // empty segment (e.g. trailing operator) is inert

  // Any output redirection in the segment → mutating. Strip fd-duplication (2>&1, 1>&2, >&2) first,
  // which is not a file write, then look for a real `>`. Only a NUMERIC right-hand side is an fd-dup;
  // `>&file`/`>&out.txt` (word RHS) is bash shorthand for redirecting both stdout+stderr to a FILE, so
  // it must NOT be stripped — its `>` has to survive the write-check below.
  const withoutFdDup = trimmed.replace(/\d*>&\d/g, " ")
  if (withoutFdDup.includes(">")) return false

  const tokens = tokenize(trimmed)
  if (tokens.length === 0) return false

  // Command substitution / process substitution / backticks can smuggle an arbitrary command — we
  // cannot prove those read-only lexically, so fail safe.
  if (/\$\(|<\(|>\(|`/.test(trimmed)) return false

  const head = unquote(tokens[0])

  // A leading `VAR=value` assignment prefix (env inline) means a command runs with a mutated env, or
  // the assignment itself persists in the shell — fail safe.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) return false

  // Inherently mutating command word → mutating.
  if (MUTATING_COMMANDS.has(head)) return false

  const prefixLen = matchReadOnlyPrefix(tokens)
  if (prefixLen === 0) return false // unknown/unlisted command → fail safe to mutating

  // Command-specific guards for read-only prefixes that have mutating variants.
  const words = tokens.map(unquote)
  if (head === "find" && words.some((token) => FIND_MUTATING_ACTIONS.has(token))) return false
  if (head === "env") {
    // Only a bare `env` (optionally with -i/-u flags but no command/assignment) is read-only.
    const rest = words.slice(1).filter((token) => !isFlag(token))
    if (rest.length > 0) return false
  }
  // curl writes a file with -o/-O/--output/--remote-name. A short-flag TOKEN can glue or bundle the
  // output flag (`-ofile.txt`, `-sofile`), and since curl short flags are single-letter and `o`/`O`
  // are only ever the output flags, any single-dash bundle containing `o`/`O` writes a file. Match a
  // `-…o`/`-…O` short bundle (not a `--long` option, which is covered by the explicit long forms).
  if (head === "curl" && (/(?:^|\s)-[a-zA-Z]*[oO]/.test(trimmed) || /--output\b|--remote-name\b/.test(trimmed)))
    return false

  return true
}

/**
 * Classify a shell command string as read-only or mutating for the Plan Gate.
 *
 * The command is split into segments on shell command separators; EVERY segment must be provably
 * read-only for the whole command to be read-only. Any segment that is mutating, unknown, or
 * unparseable makes the entire command `mutating` (fail-safe).
 */
export const classifyCommand = (command: string): CommandIntent => {
  if (typeof command !== "string" || command.trim() === "") return "mutating"
  // Mask fd-duplication spans (2>&1, 1>&2, >&2) before splitting so their internal `&` is not
  // mistaken for a background/`&&` command separator. Spans are captured by index and restored
  // exactly per-segment; the placeholder holds no separator or `>` char so it survives the split,
  // and isReadOnlySegment strips fd-dup again defensively.
  const fdSpans: string[] = []
  const masked = command.replace(/\d*>&\d/g, (m) => {
    const token = " fd" + fdSpans.length + "fd "
    fdSpans.push(m)
    return token
  })
  const restore = (segment: string) => segment.replace(/ fd(\d+)fd /g, (_, idx) => fdSpans[Number(idx)] ?? "")
  const segments = masked.split(SEGMENT_SPLIT)
  for (const rawSegment of segments) {
    const segment = restore(rawSegment)
    if (!isReadOnlySegment(segment)) return "mutating"
  }
  return "read_only"
}

export const isReadOnlyCommand = (command: string): boolean => classifyCommand(command) === "read_only"
