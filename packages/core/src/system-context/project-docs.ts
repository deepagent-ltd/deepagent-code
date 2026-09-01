export * as ProjectDocs from "./project-docs"

import { basename, extname, join } from "path"
import { Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { Location } from "../location"
import { SystemContext } from "./index"
import { SystemContextRegistry } from "./registry"

// W10 project documentation suite: `docs/deepagent/{HANDOFF,DESIGN,PLAN,LOG}.md` inside the
// project root. This module is the READ side — a `deepagent/project-docs` System Context source
// that makes the four documents part of every V2 session context. Writing happens through
// `deepagent/project-docs-sync` (settle hook + `deepagent docs sync`)
// (spec: docs/core-v2.0-beta/v2.0-design.md §W10).
//
// W10.1 semantic ruling: a missing docs directory or a partial document set is the normal state of
// a fresh project, so the source never reports `unavailable` for it — absent documents are part of
// the observed domain value (absent contents fields) and render as an empty-state baseline instead
// of blocking context initialization. Registry `unavailable` semantics would fail the first
// provider turn on a project without docs, which defeats the default-on reading source; only real
// observation failures (e.g. an IO error) still surface as `unavailable` through the layer guard.

/** The docs directory relative to a project root. */
export const DOCS_DIRECTORY = "docs/deepagent"

/** The four canonical project documents, in rendering order. */
export const DOC_NAMES = ["HANDOFF", "DESIGN", "PLAN", "LOG"] as const
export type DocName = (typeof DOC_NAMES)[number]

/**
 * One observed document, keyed by its canonical name. A document that is not present in the
 * project has an absent field rather than an empty string, so a blank but existing file and a
 * missing file stay distinguishable.
 */
export class Contents extends Schema.Class<Contents>("ProjectDocs.Contents")({
  HANDOFF: Schema.optional(Schema.String),
  DESIGN: Schema.optional(Schema.String),
  PLAN: Schema.optional(Schema.String),
  LOG: Schema.optional(Schema.String),
}) {}

/** The durable source value: where the docs live and what they contain. */
export class Observed extends Schema.Class<Observed>("ProjectDocs.Observed")({
  root: Schema.String,
  branch: Schema.optional(Schema.String),
  contents: Contents,
}) {}

export const registryKey = SystemContext.Key.make("deepagent/project-docs")

/**
 * Finds one document file inside `dir` for `name`, preferring the literal `NAME.md`.
 * Falls back to case-insensitive `NAME.<md|markdown|mdx>` and extension-less `NAME` so a suffix
 * spelling mismatch ("灵活处理") still resolves, while the literal spelling wins.
 */
export function discoverFile(dir: string, name: DocName, entries: FSUtil.DirEntry[]): string | undefined {
  if (entries.some((entry) => entry.name === `${name}.md`)) return join(dir, `${name}.md`)
  const withExt = entries.find((entry) => {
    if (entry.type !== "file") return false
    const ext = extname(entry.name).toLowerCase()
    return [".md", ".markdown", ".mdx"].includes(ext) && basename(entry.name, extname(entry.name)).toLowerCase() === name.toLowerCase()
  })
  if (withExt) return join(dir, withExt.name)
  const bare = entries.find((entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.type === "file")
  if (bare) return join(dir, bare.name)
  return undefined
}

/**
 * Observation state for one docs directory: full contents of the documents that exist + env facts.
 * A missing directory or missing documents are not an observation failure — the absent fields
 * render as the not-set-up empty state (W10.1).
 */
export const observeDir = Effect.fn("ProjectDocs.observeDir")(function* (
  docsDir: string,
  fs: FSUtil.Interface,
) {
  const entries = yield* fs.readDirectoryEntries(docsDir).pipe(Effect.catch(() => Effect.succeed([])))
  const texts: Partial<Record<DocName, string>> = {}
  for (const name of DOC_NAMES) {
    const file = discoverFile(docsDir, name, entries)
    if (file === undefined) continue
    const text = yield* fs.readFileStringSafe(file)
    if (text === undefined) continue // listed but gone by read time; treat as absent
    texts[name] = text
  }
  return yield* observed({
    root: docsDir.slice(0, -(DOCS_DIRECTORY.length + 1)),
    contents: new Contents({ ...texts }),
  })
})

/**
 * Observes the project docs under `root`. Always succeeds: a missing docs directory or a partial
 * document set is a valid observation whose missing fields render the empty state (W10.1).
 */
export const observeFor = (root: string, fs: FSUtil.Interface) => observeDir(join(root, DOCS_DIRECTORY), fs)

const observed = Effect.fn("ProjectDocs.observed")(function* (input: {
  root: string
  contents: Contents
}) {
  const git = Option.getOrUndefined(yield* Effect.serviceOption(Git.Service))
  const branch =
    git === undefined
      ? undefined
      : Option.getOrUndefined(yield* git.branch(input.root).pipe(Effect.option))
  return new Observed({
    root: input.root,
    ...(branch === undefined ? {} : { branch }),
    contents: input.contents,
  })
})

/** Upward discovery: the nearest `docs/deepagent` directory between `start` and `stop` (inclusive). */
export const discoverDocsDir = Effect.fn("ProjectDocs.discoverDocsDir")(function* (
  start: string,
  stop: string,
  fs: FSUtil.Interface,
) {
  const found = yield* fs.up({
    targets: [DOCS_DIRECTORY],
    start: FSUtil.resolve(start),
    stop: FSUtil.resolve(stop),
  })
  return found[0]
})

const excerpt = (text: string, maxLines = 40, maxChars = 6000) => {
  const lines = text.split(/\r?\n/)
  const head = lines.slice(0, maxLines).join("\n")
  const body = head.length > maxChars ? head.slice(0, maxChars) : head
  const truncated = lines.length > maxLines || head.length > maxChars
  return truncated ? `${body}\n… (truncated)` : body
}

/** The first meaningful title line of a doc (skips the `> revision:` stamp and blanks). */
const docTitle = (content: string | undefined) =>
  content === undefined
    ? "(missing)"
    : content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith(">")) ?? "(empty)"

/** The first LOG entry (heading + following bullet lines), used as the "recent changes" fact. */
const recentLogEntry = (content: string | undefined) => {
  if (content === undefined) return undefined
  const lines = content.split(/\r?\n/)
  const start = lines.findIndex((line) => /^#{1,3}\s/.test(line))
  if (start === -1) return undefined
  const body = lines.slice(start, start + 8).join("\n").trim()
  return body.length > 0 ? body : undefined
}

const allMissing = (observed: Observed) => DOC_NAMES.every((name) => observed.contents[name] === undefined)

function renderIndex(observed: Observed) {
  return DOC_NAMES.map((name) => `- ${name}.md — ${docTitle(observed.contents[name])}`).join("\n")
}

function renderEnvironment(observed: Observed) {
  const facts = [`- project root: ${observed.root}`, `- branch: ${observed.branch ?? "unknown"}`]
  facts.push(`- documents: ${DOC_NAMES.map((name) => `${name}.md`).join(", ")}`)
  const missing = DOC_NAMES.filter((name) => observed.contents[name] === undefined)
  if (missing.length > 0) facts.push(`- missing: ${missing.map((name) => `${name}.md`).join(", ")}`)
  const recent = recentLogEntry(observed.contents.LOG)
  if (recent) facts.push(`- recent changes (LOG.md):\n  ${recent.replaceAll("\n", "\n  ")}`)
  return facts.join("\n")
}

function renderExcerpts(observed: Observed) {
  return DOC_NAMES.flatMap((name) => {
    const content = observed.contents[name]
    if (content === undefined) return []
    const divider = "─".repeat(24)
    return [`${divider} ${name}.md ${divider}`, excerpt(content)].join("\n")
  }).join("\n\n")
}

export const renderBaseline = (observed: Observed) => {
  if (allMissing(observed)) {
    return ["Project documents (docs/deepagent):", "", "未建立项目文档（运行 `deepagent docs sync` 可生成）"].join("\n")
  }
  return [
    "Project documents (docs/deepagent):",
    "",
    "Index:",
    renderIndex(observed),
    "",
    "Environment quick facts:",
    renderEnvironment(observed),
    "",
    "Document excerpts:",
    renderExcerpts(observed),
  ].join("\n")
}

/** Which documents differ between two observations, in canonical name order. */
function changedDocs(previous: Observed, current: Observed): DocName[] {
  return DOC_NAMES.filter((name) => previous.contents[name] !== current.contents[name])
}

export const renderUpdate = (previous: Observed, current: Observed) => {
  if (allMissing(current)) return "Project documents not set up yet — run `deepagent docs sync`"
  const changed = changedDocs(previous, current)
  if (changed.length === 0) return `Project documents updated.\n\n${renderExcerpts(current)}`
  const rendered = changed
    .map((name) => {
      const content = current.contents[name]
      const divider = "─".repeat(24)
      const body = content === undefined ? `(missing)` : excerpt(content)
      return [`${divider} ${name}.md ${divider}`, body].join("\n")
    })
    .join("\n\n")
  return `Project documents updated (${changed.map((name) => `${name}.md`).join(", ")}):\n\n${rendered}`
}

/** Closes an observation effect into the `deepagent/project-docs` System Context source. */
export function source(load: Effect.Effect<Observed | SystemContext.Unavailable>): SystemContext.SystemContext {
  return SystemContext.make({
    key: registryKey,
    codec: Schema.toCodecJson(Observed),
    load,
    baseline: renderBaseline,
    update: renderUpdate,
  })
}

/** Closes an already-observed value (or unavailable) into the source. */
export function sourceOf(value: Observed | SystemContext.Unavailable): SystemContext.SystemContext {
  return source(Effect.succeed(value))
}

/**
 * Location node that registers the project docs source. Discovery walks up from the session
 * directory to the project root and observes the four documents; a missing set is a valid
 * observation that renders the not-set-up empty state (W10.1). Only genuine observation failures
 * (IO errors) fall back to `unavailable`, the registry's transient-failure semantics.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const registry = yield* SystemContextRegistry.Service
    const observe = Effect.fn("ProjectDocs.observe")(function* () {
      const docsDir = yield* discoverDocsDir(location.directory, location.project.directory, fs)
      if (!docsDir) {
        // No `docs/deepagent` under the project: still ready — the source renders the not-set-up
        // state instead of blocking context initialization (W10.1).
        return yield* observed({ root: location.project.directory, contents: new Contents({}) })
      }
      return yield* observeDir(docsDir, fs)
    })
    yield* registry.register({
      key: registryKey,
      load: observe().pipe(
        Effect.map((value) => sourceOf(value)),
        Effect.catch(() => Effect.succeed(sourceOf(SystemContext.unavailable))),
        Effect.catchDefect(() => Effect.succeed(sourceOf(SystemContext.unavailable))),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "system-context-project-docs",
  layer,
  deps: [FSUtil.node, Location.node, Git.node, SystemContextRegistry.node],
})
