export * as ProjectDocsSync from "./project-docs-sync"

import { dirname, join, parse } from "path"
import { DateTime, Effect, Option } from "effect"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { ProjectDocs } from "../system-context/project-docs"
import { writeFileAtomic } from "./atomic-write"
import { GOAL_PLAN_FILE, parseGoalPlanFile } from "./goal-plan-file"

// W10 write side: the session settle tail and the `deepagent docs sync` CLI both run the SAME
// generation logic here. Writing project files is opt-in (env DEEPAGENT_CODE_PROJECT_DOCS_SYNC or
// the `docs_sync` config, default false); reading via `deepagent/project-docs` needs no switch.

/** Environment switch for automatic writes after a session settles (default off). */
export const SYNC_ENV_FLAG = "DEEPAGENT_CODE_PROJECT_DOCS_SYNC"

export const envEnabled = (env: Record<string, string | undefined> = process.env) =>
  env[SYNC_ENV_FLAG] === "true" || env[SYNC_ENV_FLAG] === "1"

const PROMPT_MAX = 280
const PROGRESS_MAX = 600
const MAX_PROMPTS = 6
const MAX_PROGRESS = 3

export interface GoalStepInfo {
  readonly title: string
  readonly status: string
}

export interface GoalDocInfo {
  readonly objective: string
  readonly criteria: readonly string[]
  readonly steps: readonly GoalStepInfo[]
}

export interface SessionSummary {
  readonly sessionID: string
  readonly title: string
  readonly updated: string
  readonly prompts: readonly string[]
  readonly progress: readonly string[]
  readonly toolCalls: number
  readonly errors: number
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** Summarizes a session's history into the deterministic inputs the four documents render from. */
export function summarize(session: SessionSchema.Info, messages: readonly SessionMessage.Message[]): SessionSummary {
  const prompts: string[] = []
  const progress: string[] = []
  let toolCalls = 0
  let errors = 0
  for (const message of messages) {
    if (message.type === "user" || message.type === "synthetic") {
      const text = message.text.trim()
      if (text.length > 0) prompts.push(clip(text, PROMPT_MAX))
      continue
    }
    if (message.type !== "assistant") continue
    if (message.error) errors++
    let text = ""
    for (const part of message.content) {
      if (part.type === "text") text += part.text
      else if (part.type === "tool") toolCalls++
    }
    const trimmed = text.trim()
    if (trimmed.length > 0) progress.push(clip(trimmed, PROGRESS_MAX))
  }
  return {
    sessionID: session.id,
    title: session.title,
    updated: new Date(DateTime.toEpochMillis(session.time.updated)).toISOString(),
    prompts: prompts.slice(-MAX_PROMPTS),
    progress: progress.slice(-MAX_PROGRESS),
    toolCalls,
    errors,
  }
}

const readGoalDoc = Effect.fn("ProjectDocsSync.readGoalDoc")(function* (root: string, fs: FSUtil.Interface) {
  const contents = yield* fs.readFileStringSafe(join(root, GOAL_PLAN_FILE))
  if (!contents) return undefined
  const parsed = parseGoalPlanFile("sync", contents)
  if (!parsed) return undefined
  const criteria = [
    ...new Set(
      parsed.criteria.map((criterion) => {
        switch (criterion.kind) {
          case "tests_pass":
            return `tests pass: ${criterion.commands.join(", ")}`
          case "no_diagnostics":
            return `no diagnostics${criterion.severityAtMost ? ` above ${criterion.severityAtMost}` : ""}`
          case "reviewer_clean":
            return `reviewer clean${criterion.maxSeverity ? ` (max ${criterion.maxSeverity})` : ""}`
          case "panel_approves":
            return "panel approves"
          case "plan_complete":
            return "plan complete"
        }
      }),
    ),
  ]
  return {
    objective: parsed.plan.goal,
    criteria,
    steps: parsed.plan.steps.map((step) => ({ title: step.title, status: step.status })),
  } satisfies GoalDocInfo
})

const readExisting = Effect.fn("ProjectDocsSync.readExisting")(function* (
  root: string,
  fs: FSUtil.Interface,
) {
  const dir = join(root, ProjectDocs.DOCS_DIRECTORY)
  if (!(yield* fs.isDir(dir))) return {} as Partial<Record<ProjectDocs.DocName, string>>
  const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
  const existing: Partial<Record<ProjectDocs.DocName, string>> = {}
  for (const name of ProjectDocs.DOC_NAMES) {
    const file = ProjectDocs.discoverFile(dir, name, entries)
    if (!file) continue
    const text = yield* fs.readFileStringSafe(file)
    if (text !== undefined) existing[name] = text
  }
  return existing
})

const revisionHeader = (revision: string) => `> revision: ${revision}`

const logMarker = (sessionID: string) => `<!-- session: ${sessionID} -->`

const goalOrPlaceholder = (goal: GoalDocInfo | undefined, intent: "design" | "plan") => {
  if (goal === undefined) {
    return [
      "> 未建立 goal 文档（.deepagent-code/plans/goal+plan.md）。",
      "",
      intent === "design"
        ? "未生成设计信息。建立 goal 文档后重新运行 `deepagent docs sync` 会在此生成设计说明。"
        : "未生成实施步骤。建立 goal 文档后重新运行 `deepagent docs sync` 会在此生成实施方案。",
    ].join("\n")
  }
  return [
    "## Goal 目标",
    "",
    goal.objective,
    ...(intent === "plan" && goal.criteria.length > 0
      ? ["", "## Criteria 完成标准", "", ...goal.criteria.map((criterion) => `- ${criterion}`)]
      : []),
  ].join("\n")
}

const renderHandoff = (input: {
  root: string
  revision: string
  branch?: string | undefined
  session: SessionSummary
  goal: GoalDocInfo | undefined
}) => {
  const latestPrompt = input.session.prompts.at(-1) ?? "(无)"
  const latestProgress = input.session.progress.at(-1) ?? "(无)"
  const nextStep =
    input.goal?.steps.find((step) => step.status === "pending" || step.status === "active")?.title ?? "(无)"
  return [
    revisionHeader(input.revision),
    "",
    "# Handoff 交接文档",
    "",
    "> 项目文档索引、环境速查与最近工作状态。换线程 1 分钟恢复现场。",
    "",
    "## Index 索引",
    "",
    "- HANDOFF.md — 交接文档：索引 + 环境速查 + 最近工作",
    "- DESIGN.md — 设计文档：项目目标与原则性指导",
    "- PLAN.md — 实施方案：步骤与状态",
    "- LOG.md — 工程日志：按时间倒序",
    "",
    "## Environment 环境速查",
    "",
    `- project root: ${input.root}`,
    `- branch: ${input.branch ?? "unknown"}`,
    `- platform: ${process.platform}`,
    "",
    "## Recent session 最近会话",
    "",
    `- session: ${input.session.title} (\`${input.session.sessionID}\`, updated ${input.session.updated})`,
    `- goal 目标: ${latestPrompt}`,
    `- progress 进度: ${latestProgress}`,
    `- next 下一步: ${nextStep}`,
    `- tool calls: ${input.session.toolCalls}`,
    ...(input.session.errors > 0 ? [`- errors: ${input.session.errors}`] : []),
  ].join("\n")
}

const renderDesign = (input: { revision: string; goal: GoalDocInfo | undefined }) =>
  [
    revisionHeader(input.revision),
    "",
    "# Design 设计文档",
    "",
    goalOrPlaceholder(input.goal, "design"),
  ].join("\n")

const statusMark = (status: string) =>
  ({ done: "x", active: ">", cancelled: "-", blocked: "!" })[status] ?? " "

const renderPlan = (input: { revision: string; goal: GoalDocInfo | undefined }) => {
  const steps =
    input.goal === undefined
      ? undefined
      : input.goal.steps.map((step) => `- [${statusMark(step.status)}] ${step.title}`).join("\n")
  return [
    revisionHeader(input.revision),
    "",
    "# Plan 实施方案",
    "",
    goalOrPlaceholder(input.goal, "plan"),
    ...(steps === undefined ? [] : ["", "## Steps 步骤", "", steps]),
  ].join("\n")
}

/**
 * Renders the four documents. LOG is idempotent: an existing entry marked for this session id is
 * left untouched (no duplicate append); all other documents are regenerated deterministically.
 *
 * Low-4 ruling — replayed session ids: a resumed session (same id) keeps its original LOG entry
 * verbatim, so the entry's title/updated stamp can lag the session's current state. That is
 * deliberate: the id is the identity ("the same session, carried on"), HANDOFF/DESIGN/PLAN are
 * regenerated fresh every sync, and the LOG records the session's first (creation) entry — a
 * replay is not a new "change", so no duplicate is appended and the entry is not rewritten.
 */
export function renderDocs(input: {
  root: string
  revision: string
  branch?: string | undefined
  session: SessionSummary
  goal: GoalDocInfo | undefined
  existing: Partial<Record<ProjectDocs.DocName, string>>
}): Record<ProjectDocs.DocName, string> {
  const logExisting = input.existing.LOG
  if (logExisting?.includes(logMarker(input.session.sessionID))) {
    return {
      HANDOFF: renderHandoff(input),
      DESIGN: renderDesign(input),
      PLAN: renderPlan(input),
      LOG: logExisting,
    }
  }
  const entry = [
    logMarker(input.session.sessionID),
    `## ${input.session.updated} · ${input.session.title}`,
    `- session: \`${input.session.sessionID}\``,
    `- goal 目标: ${input.session.prompts.at(-1) ?? "(无)"}`,
    `- progress 进展: ${input.session.progress.at(-1) ?? "(无)"}`,
    `- tool calls: ${input.session.toolCalls}`,
    ...(input.session.errors > 0 ? [`- errors: ${input.session.errors}`] : []),
  ].join("\n")
  return {
    HANDOFF: renderHandoff(input),
    DESIGN: renderDesign(input),
    PLAN: renderPlan(input),
    LOG: insertLogEntry(input.revision, logExisting, entry),
  }
}

/**
 * Prepends one entry into the LOG (newest first) and keeps the file bounded:
 * - Low-1: a blank/empty LOG is rebuilt with the canonical header; otherwise the entry is INSERTED
 *   into the existing text — existing content is never dropped for lacking a heading.
 * - High-1: the insertion point is positional, not "always the top": the entry lands between the
 *   first newer and first older `## <updated> · ` stamp, so any traversal order (or a LOG that was
 *   written by a single-session settle) still yields newest-first. Unparseable content falls back
 *   to the prepend-below-header position — hand-written logs are never reordered.
 * - Med-2: after the insert, the log rotates at LOG_MAX_ENTRIES (newest window kept, note at tail).
 */
function insertLogEntry(revision: string, existing: string | undefined, entry: string): string {
  if (existing === undefined || existing.trim() === "") {
    return [
      revisionHeader(revision),
      "",
      "# Log 工程日志",
      "",
      "> 按时间倒序记录最新进展与实现日志。",
      "",
      entry,
    ].join("\n")
  }
  const lines = existing.split(/\r?\n/)
  const heading = lines.findIndex((line) => /^#{1,3}\s/.test(line))
  let i = heading + 1
  while (i < lines.length && (lines[i].trim() === "" || lines[i].startsWith(">"))) i++
  const insertAt = logInsertionPoint(lines, i, entry)
  const next = [...lines.slice(0, insertAt), entry, ...lines.slice(insertAt)].join("\n")
  return rotateLog(next.replace(/^> revision:.*$/m, revisionHeader(revision)))
}

/** The `## <ISO timestamp> · <title>` stamp our entries carry. */
const ENTRY_STAMP = /^## (\S+) · /

/**
 * Insertion index for `entry` inside `lines` scanning from `start` (below the header block).
 * Returns the index of the marker line of the first entry whose stamp is not newer than the new
 * entry's stamp — the slot that keeps entries newest-first (see insertLogEntry). When every parsed
 * entry is strictly newer, the new entry belongs at the BOTTOM of the entry block (before a
 * trailing rotation note, if any); with no parseable entries the prepend slot is kept.
 */
function logInsertionPoint(lines: string[], start: number, entry: string): number {
  const entryStamp = ENTRY_STAMP.exec(entry.split(/\r?\n/)[1] ?? "")?.[1]
  if (entryStamp === undefined) return start
  let marker = start
  let lastStamp = -1
  for (let j = start; j < lines.length; j++) {
    const line = lines[j]
    if (line.startsWith("<!-- session: ")) marker = j
    const stamp = ENTRY_STAMP.exec(line)?.[1]
    if (stamp === undefined) continue
    lastStamp = j
    if (stamp <= entryStamp) return marker
  }
  if (lastStamp === -1) return start
  // All parsed entries are newer: append the entry after the last entry's body, before a
  // trailing rotation note (the only trailing `> ` line our writer emits).
  let end = lines.length
  if (lines[end - 1]?.startsWith("> ")) {
    end -= 1
    if (lines[end - 1] === "") end -= 1
  }
  return end
}

/** Med-2: keep at most this many session entries in LOG.md (newest window). */
export const LOG_MAX_ENTRIES = 500

/**
 * Bounds LOG.md after an insert. Older entries beyond the newest `LOG_MAX_ENTRIES` are dropped and
 * the tail notes the rotation. Note: a rotated-out session's marker disappears, so a later sync of
 * that session re-appends its (now-old) entry at the bottom of the window — the file stays bounded
 * either way; the log is a rolling window, not an archive.
 */
function rotateLog(text: string): string {
  const markers = [...text.matchAll(/<!-- session: /g)]
  if (markers.length <= LOG_MAX_ENTRIES) return text
  const kept = text.slice(0, markers[LOG_MAX_ENTRIES].index).trimEnd()
  return `${kept}\n\n> log rotated: kept the newest ${LOG_MAX_ENTRIES} session entries (older entries dropped)`
}

export const writeDocs = Effect.fn("ProjectDocsSync.writeDocs")(function* (
  root: string,
  docs: Record<ProjectDocs.DocName, string>,
) {
  const dir = join(root, ProjectDocs.DOCS_DIRECTORY)
  yield* Effect.forEach(ProjectDocs.DOC_NAMES, (name) =>
    Effect.sync(() => writeFileAtomic(join(dir, `${name}.md`), docs[name])),
  )
  return docs
})

/** Shared generation + write for one session's data with explicitly supplied services. */
export const syncSessionDataFor =
  (deps: { fs: FSUtil.Interface; git?: Git.Interface | undefined }) =>
  Effect.fn("ProjectDocsSync.syncSessionData")(function* (input: {
    root: string
    session: SessionSchema.Info
    messages: readonly SessionMessage.Message[]
  }) {
    const branch = deps.git
      ? Option.getOrUndefined(yield* deps.git.branch(input.root).pipe(Effect.option))
      : undefined
    const goal = yield* readGoalDoc(input.root, deps.fs)
    const existing = yield* readExisting(input.root, deps.fs)
    const docs = renderDocs({
      root: input.root,
      revision: new Date().toISOString(),
      ...(branch === undefined ? {} : { branch }),
      session: summarize(input.session, input.messages),
      goal,
      existing,
    })
    yield* writeDocs(input.root, docs)
    return docs
  })

/** Service-resolving convenience used by the CLI (`AppServices` provides FSUtil). */
export const syncSessionData = Effect.fn("ProjectDocsSync.syncSessionData")(function* (input: {
  root: string
  session: SessionSchema.Info
  messages: readonly SessionMessage.Message[]
}) {
  const fs = yield* FSUtil.Service
  const git = Option.getOrUndefined(yield* Effect.serviceOption(Git.Service))
  return yield* syncSessionDataFor({ fs, ...(git === undefined ? {} : { git }) })(input)
})

/** Whether automatic writes are enabled (env flag OR the `docs_sync` config; default false). */
export function writingEnabled(docsSync: boolean | undefined): boolean {
  return envEnabled() || docsSync === true
}

/**
 * High-2: where the settle hook writes. `root` comes from `location.project.directory`, which
 * `Project.resolve` sets to the FILESYSTEM ROOT when no git repo is found (core/src/project.ts).
 * A real project root is writable as-is (docs are created there when absent). An undetermined root
 * is used only when a `docs/deepagent` directory already exists as the nearest ancestor of the
 * session directory — otherwise undefined (skip). The filesystem root itself is NEVER a write
 * target, so a no-git location can never create `/docs/deepagent`.
 */
const resolveWriteRoot = Effect.fn("ProjectDocsSync.resolveWriteRoot")(function* (
  sessionDirectory: string,
  root: string,
  fs: FSUtil.Interface,
) {
  const fsRoot = parse(sessionDirectory).root
  if (root !== fsRoot) return root
  let current = sessionDirectory
  while (true) {
    if (current !== fsRoot && (yield* fs.isDir(join(current, ProjectDocs.DOCS_DIRECTORY)))) return current
    const parent = dirname(current)
    if (parent === current || parent === fsRoot) return undefined
    current = parent
  }
})

/**
 * Session settle tail (called from SessionRunner.run once the drain chain settles): best-effort
 * project docs maintenance. Only primary sessions (subagent sessions carry a parent id) and only
 * when `enabled` is true. Never fails the settle: sync failures are logged and ignored.
 *
 * Low-2 note (message-source difference): this tail summarizes `store.context` — the
 * `SessionHistory.load` window, which is filtered to post-compaction messages — while
 * `deepagent docs sync` regenerates from the CLI's FULL `messages` listing. That is deliberate:
 * the settle tail maintains the recent working window and never has to resurrect compacted-away
 * history, whereas the CLI is the authoritative full-history regeneration on demand.
 */
export const afterSessionNow = Effect.fn("ProjectDocsSync.afterSessionNow")(function* (input: {
  sessionID: SessionSchema.ID
  root: string
  enabled: boolean
  store: SessionStore.Interface
  fs: FSUtil.Interface
  git?: Git.Interface | undefined
}) {
  const sync = Effect.fn("ProjectDocsSync.afterSessionNow.syncSessionData")(function* () {
    const session = yield* input.store.get(input.sessionID)
    if (!session || session.parentID !== undefined) return
    if (!input.enabled) return
    const writeRoot = yield* resolveWriteRoot(session.location.directory, input.root, input.fs)
    if (writeRoot === undefined) {
      yield* Effect.logDebug(
        "project docs sync skipped: no docs/deepagent ancestor and the project root is undetermined",
        { sessionID: input.sessionID, root: input.root },
      )
      return
    }
    const messages = yield* input.store.context(input.sessionID).pipe(Effect.catch(() => Effect.succeed([])))
    yield* syncSessionDataFor({ fs: input.fs, git: input.git })({
      root: writeRoot,
      session,
      messages,
    })
  })
  // `return`-ing the inner effect would only succeed with the effect as a VALUE (never running
  // it); `yield*` executes it — the settle tail must actually run.
  yield* sync().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("project docs sync after session failed", {
        sessionID: input.sessionID,
        cause: Option.some(String(cause)),
      }),
    ),
  )
})
