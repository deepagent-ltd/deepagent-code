#!/usr/bin/env bun
// Brand-residue audit gate (W11).
//
// Scans every git-tracked file and fails when a legacy brand token survives:
//   opencode / anomalyco / lessweb / deepagent-code.ai   (case-insensitive)
//
// Detection windows
//   - text files (full-content regex): extensions md/mdx/sh/ps1/yml/yaml/json/txt/jsonc,
//     plus any tracked file whose name contains "config" (parsed as UTF-8 text;
//     binaries with a NUL byte are skipped).
//   - source strings (packages/**/*.ts and .tsx): only brand tokens inside string
//     literals and template-literal content are reported. Comments are never
//     reported, and identifiers such as `OpencodeClient` are not string
//     literals, so they are intentionally out of scope (public SDK
//     compatibility surface, not branding).
//   Known limitations of the naive scanner (documented on purpose):
//     - the `${...}` expression span of a template literal is not scanned
//       (prevents identifier false positives; a string there is missed)
//     - regex literals and JSX text nodes are not covered at all: they are
//       neither string nor template literals, so a brand token in `/lessweb/i`
//       or in `<p>lessweb</p>` is not reported
//     - fully \u-escaped spellings are missed
//     - a token distributed across multiple string-literal fragments on one
//       line IS reported (a line's fragments are scanned as one joined
//       window, so "less" + "web" is caught); the same split across lines is
//       missed
//
// Exemption model: a hit word on a line is skipped only when that word has a
// line-level marker for this path and the line carries it; other words (or the
// same word in another file) still fail. The whole-file exemption list below
// skips entire files.

const repoRoot = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: import.meta.dir }).stdout.toString().trim()
if (!repoRoot) {
  console.error("audit-branding: not inside a git worktree")
  process.exit(2)
}

const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: repoRoot }).stdout.toString().split("\n").filter(Boolean)

const BRAND_WORDS = ["opencode", "anomalyco", "lessweb", "deepagent-code.ai"]

// Whole-file exemptions: files whose historical/upstream content legitimately
// carries brand tokens regardless of any single line.
const WHOLE_FILE_EXEMPT = new Set([
  "NOTICE",
  "LICENSE",
  // Gitleaks baseline: machine-recorded commit-message history snapshots.
  // Rewriting historical text would falsify the record and churn the baseline.
  "packages/desktop/gitleaks.baseline.json",
  // The gate's own file: its detection vocabulary (BRAND_WORDS) and exemption
  // table are string literals by construction, so it self-references the brand
  // words. It is audit infrastructure, not residue.
  "packages/deepagent-code/script/audit-branding.ts",
  // The gate's negative fixtures: brand words appear there by design as
  // injected test data. Same class as the script itself (audit infrastructure).
  "packages/deepagent-code/test/audit-branding.test.ts",
])

// Line-level exemptions keyed by exact tracked path; a hit of `word` on a line
// is skipped only when the line also carries one of `word`'s markers. The word
// binding keeps one marker from silently exempting unrelated brand tokens on
// the same line.
const LINE_EXEMPTIONS: Record<string, Record<string, string[]>> = {
  // "derived from [opencode](...)" upstream-attribution paragraph (README)
  "README.md": { opencode: ["derived from"] },
  // 基于 [opencode](...) upstream-attribution paragraph (README.zh.md)
  "README.zh.md": { opencode: ["基于"] },
  // opencode foundation notes in the design overview (diagram + attribution)
  "design/README.md": { opencode: ["opencode"] },
  // MIT attribution lines in the in-app About panel
  "packages/app/src/components/settings-v2/about.tsx": { opencode: ["opencode"] },
  // "keeps the opencode runtime foundation" architecture note (same class as
  // design/README.md foundation note)
  "packages/deepagent-code/README.md": { opencode: ["opencode"] },
  // Upstream opencode-ecosystem fork URLs (tree-sitter wasm/queries hosted by
  // the upstream org; no deepagent-ltd mirror exists, rewriting would break the
  // runtime download)
  "packages/tui/src/parsers-config.ts": { anomalyco: ["anomalyco"] },
  // Upstream fork dependency (github:anomalyco/ghostty-web#main); same origin
  // rationale as parsers-config.ts
  "packages/app/package.json": { anomalyco: ["anomalyco"] },
  // Lockfiles record dependency coordinates verbatim (github:anomalyco/ghostty-web
  // and its resolved hash entry) — same upstream-fork rationale as package.json;
  // workspace NAMES are still audited (the stale "opencode" root-name class).
  "bun.lock": { anomalyco: ["anomalyco"] },
  "sdks/vscode/bun.lock": { anomalyco: ["anomalyco"] },
  // describe() label quoting the public SDK compatibility export name
  // `OpencodePlugin` (identifier is out of scope; only its stringified label
  // shows up here)
  "packages/core/test/plugin/provider-deepagent-code.test.ts": { opencode: ["OpencodePlugin"] },
  // Public SDK compatibility exports documented on the SDK pages:
  // `createOpencode` / `createOpencodeClient` are real exports of the JS SDK
  // (compatibility aliases, not branding).
  "packages/web/src/content/docs/sdk.mdx": { opencode: ["createOpencode"] },
  ...Object.fromEntries(
    ["ar", "bs", "da", "de", "es", "fr", "it", "ja", "ko", "nb", "pl", "pt-br", "ru", "th", "tr", "zh-cn", "zh-tw"].map(
      (locale) => [`packages/web/src/content/docs/${locale}/sdk.mdx`, { opencode: ["createOpencode"] }],
    ),
  ),
}

const TEXT_EXTS = new Set(["md", "mdx", "sh", "ps1", "yml", "yaml", "json", "txt", "jsonc", "lock"])
const ext = (path: string) => path.split(".").pop() ?? ""
const isTextScan = (path: string) => TEXT_EXTS.has(ext(path)) || path.split("/").pop()?.includes("config") === true
const isSourceScan = (path: string) => path.startsWith("packages/") && /\.(ts|tsx)$/.test(path)

interface Hit {
  path: string
  line: number
  word: string
  snippet: string
  category: "text" | "source-string"
}

interface Row {
  n: number
  raw: string
  window: string
}

const hits: Hit[] = []
const stats = { binary: 0, exemptLines: 0, text: 0, source: 0 }

// Returns the string/template-literal content of this line (the detection window
// for source scans) and advances the cross-line comment/template state.
function stringFragments(line: string, state: { inBlock: boolean; inTemplate: boolean; brace: number }): string {
  const fragments: string[] = []
  let i = 0
  let fragmentStart = -1
  const collect = (from: number, to: number) => {
    if (to > from) fragments.push(line.slice(from, to))
  }
  while (i < line.length) {
    const ch = line[i]
    const next = line[i + 1]
    if (state.inBlock) {
      if (ch === "*" && next === "/") {
        state.inBlock = false
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (state.inTemplate) {
      if (state.brace > 0) {
        // Inside a `${...}` expression span: braces are counted, but string
        // literals are skipped so a `}` inside quotes cannot close the
        // expression early and re-open the content window inside it.
        if (ch === "'" || ch === '"') {
          const quote = ch
          let j = i + 1
          while (j < line.length && line[j] !== quote) {
            if (line[j] === "\\") j += 2
            else j += 1
          }
          i = j < line.length ? j + 1 : j
          continue
        }
        if (ch === "{") state.brace += 1
        if (ch === "}") state.brace -= 1
        i += 1
        continue
      }
      if (ch === "$" && next === "{") {
        // Expression span of the template: close the current content window
        // (if any) and skip the whole `${...}` span, so identifiers in the
        // expression are never reported as content.
        if (fragmentStart !== -1) {
          collect(fragmentStart, i)
          fragmentStart = -1
        }
        state.brace = 1
        i += 2
        continue
      }
      if (ch === "\\") {
        i += 2
        continue
      }
      if (ch === "`") {
        state.inTemplate = false
        if (fragmentStart !== -1) {
          collect(fragmentStart, i)
          fragmentStart = -1
        }
        i += 1
        continue
      }
      if (fragmentStart === -1) fragmentStart = i
      i += 1
      continue
    }
    if (ch === "/" && next === "/") break // line comment: nothing further is literal
    if (ch === "/" && next === "*") {
      state.inBlock = true
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      let closed = false
      while (j < line.length && !closed) {
        if (line[j] === "\\") {
          j += 2
          continue
        }
        if (line[j] === quote) closed = true
        j += 1
      }
      collect(i + 1, closed ? j - 1 : line.length)
      i = j
      continue
    }
    if (ch === "`") {
      state.inTemplate = true
      fragmentStart = i + 1
      i += 1
      continue
    }
    i += 1
  }
  if (state.inTemplate && fragmentStart !== -1) collect(fragmentStart, line.length)
  return fragments.join("")
}

function recordHits(path: string, category: "text" | "source-string", rows: Row[]) {
  if (WHOLE_FILE_EXEMPT.has(path)) return
  const wordMarkers = LINE_EXEMPTIONS[path]
  for (const row of rows) {
    const window = row.window.toLowerCase()
    for (const word of BRAND_WORDS) {
      let at = window.indexOf(word)
      while (at !== -1) {
        if (wordMarkers?.[word]?.some((marker) => row.raw.includes(marker))) {
          stats.exemptLines += 1
        } else {
          const slice = row.window.slice(Math.max(0, at - 30), at + word.length + 30).replace(/[\r\n\t]/g, " ")
          hits.push({ path, line: row.n, word, snippet: `…${slice}…`, category })
        }
        at = window.indexOf(word, at + word.length)
      }
    }
  }
}

async function textScan(rel: string) {
  const bytes = new Uint8Array(await Bun.file(`${repoRoot}/${rel}`).arrayBuffer())
  if (bytes.includes(0)) {
    stats.binary += 1
    return
  }
  const lines = new TextDecoder().decode(bytes).split("\n")
  recordHits(rel, "text", lines.map((raw, index) => ({ n: index + 1, raw, window: raw })))
}

async function sourceScan(rel: string) {
  const lines = (await Bun.file(`${repoRoot}/${rel}`).text()).split("\n")
  const state = { inBlock: false, inTemplate: false, brace: 0 }
  recordHits(
    rel,
    "source-string",
    lines.map((raw, index) => ({ n: index + 1, raw, window: stringFragments(raw, state) })),
  )
}

for (const rel of tracked) {
  if (isTextScan(rel)) {
    stats.text += 1
    await textScan(rel)
  } else if (isSourceScan(rel)) {
    stats.source += 1
    await sourceScan(rel)
  }
}

if (hits.length > 0) {
  console.error(`branding audit FAILED: ${hits.length} finding(s)`)
  for (const hit of hits) {
    console.error(`${hit.path}:${hit.line}: matched "${hit.word}" in ${hit.category} ${hit.snippet}`)
  }
  process.exit(1)
}

console.log(
  `branding audit clean: ${stats.text} text file(s), ${stats.source} source file(s), ` +
    `${stats.exemptLines} exempt line(s) skipped, ${stats.binary} binary file(s) skipped`,
)
