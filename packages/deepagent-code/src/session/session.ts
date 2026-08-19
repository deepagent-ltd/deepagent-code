import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { Slug } from "@deepagent-code/core/util/slug"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { serviceUse } from "@deepagent-code/core/effect/service-use"
import path from "path"
import { BackgroundJob } from "@/background/job"
import { Decimal } from "decimal.js"
import type { ProviderMetadata, Usage } from "@deepagent-code/llm"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import { Database } from "@deepagent-code/core/database/database"
import { makeRuntime } from "@deepagent-code/core/effect/runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@deepagent-code/core/event"

import { NotFoundError } from "@/storage/storage"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"
import { gte } from "drizzle-orm"
import { gt } from "drizzle-orm"
import { isNull } from "drizzle-orm"
import { isNotNull } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { like } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import { notLike } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { getTableColumns } from "drizzle-orm"
import {
  MessageTable,
  PartTable,
  SessionForkAdmissionTable,
  SessionForkIntentTable,
  SessionHistoryStateTable,
  SessionIntentTable,
  SessionPartIntegrityQuarantineTable,
  SessionPromptEpochMessageTable,
  SessionSteerTable,
  SessionTable,
  SessionWorldStateBaselineTable,
} from "@deepagent-code/core/session/sql"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { Log } from "@deepagent-code/core/util/log"
import { MessageV2 } from "./message-v2"
import {
  collectSessionWorldStateBaseline,
  forwardLedgerOnForkRequired,
  loadForkOrigin,
  persistForkOriginRequired,
} from "./context-ledger"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { ProjectV2 } from "@deepagent-code/core/project"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { SessionID, MessageID, PartID } from "./schema"
import { Worktree } from "@/worktree"
import { Identifier } from "@/id/id"

import type { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { Global } from "@deepagent-code/core/global"
import { DateTime, Effect, Exit, Layer, Option, Context, Schema, Types } from "effect"
import { AbsolutePath, NonNegativeInt, optionalOmitUndefined } from "@deepagent-code/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { Location } from "@deepagent-code/core/location"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { Hash } from "@deepagent-code/core/util/hash"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { SessionPromptEpochTable } from "./prompt-epoch.sql"
import { HistoryAuthority } from "./history-authority"
import { Data } from "effect"
import { KeyedMutex } from "@deepagent-code/core/effect/keyed-mutex"

const log = Log.create({ service: "session" })
const runtime = makeRuntime(Database.Service, Database.defaultLayer)
const forkLocks = KeyedMutex.makeUnsafe<string>()

const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "
const TASK_DROPPED_CONTEXT_SOURCES = new Set(["world_state", "runtime_instruction", "compaction_continue", "fork_hint"])

const contextProvenanceSource = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined
  const deepagent = (value as Record<string, unknown>).deepagent
  if (!deepagent || typeof deepagent !== "object") return undefined
  const provenance = (deepagent as Record<string, unknown>).contextProvenance
  if (!provenance || typeof provenance !== "object") return undefined
  const source = (provenance as Record<string, unknown>).source
  return typeof source === "string" ? source : undefined
}

const isTaskRuntimeMessage = (message: SessionV1.WithParts): boolean => {
  const messageSource = contextProvenanceSource(message.info.role === "user" ? message.info.metadata : undefined)
  return Boolean(messageSource && TASK_DROPPED_CONTEXT_SOURCES.has(messageSource))
}

const sanitizeTaskHistory = (messages: readonly SessionV1.WithParts[]): SessionV1.WithParts[] => {
  const candidates = messages
    .filter((message) => !isTaskRuntimeMessage(message))
    .map((message) => ({
      ...message,
      parts: message.parts.filter((part) => {
        const source = contextProvenanceSource("metadata" in part ? part.metadata : undefined)
        return (
          !(source && TASK_DROPPED_CONTEXT_SOURCES.has(source)) &&
          !(part.type === "text" && (part.synthetic || part.metadata?.compaction_continue === true))
        )
      }),
    }))
    .filter((message) => message.parts.length > 0)
  const keptIDs = new Set(candidates.map((message) => message.info.id))
  return candidates.filter(
    (message) => message.info.role !== "assistant" || !message.info.parentID || keptIDs.has(message.info.parentID),
  )
}

export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}

const { summary_diffs: _, ...sessionClientColumns } = getTableColumns(SessionTable)
type SessionRow = Omit<typeof SessionTable.$inferSelect, "summary_diffs"> & {
  summary_diffs?: typeof SessionTable.$inferSelect.summary_diffs
}

export function fromRow(row: SessionRow): Info {
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
          diffManifest: row.summary_diff_manifest ?? undefined,
        }
      : undefined
  const share = row.share_url ? { url: row.share_url } : undefined
  const revert = row.revert ?? undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    path: row.path ?? undefined,
    parentID: row.parent_id ?? undefined,
    title: row.title,
    agent: row.agent ?? undefined,
    model: row.model
      ? {
          id: ModelV2.ID.make(row.model.id),
          providerID: ProviderV2.ID.make(row.model.providerID),
          variant: row.model.variant,
        }
      : undefined,
    version: row.version,
    summary,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    share,
    metadata: row.metadata ?? undefined,
    revert,
    permission: row.permission ? [...row.permission] : undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
    preview: row.preview ?? undefined,
  }
}

export function toRow(info: Info) {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs,
    summary_diff_manifest: info.summary?.diffManifest,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? EmptyTokens).input,
    tokens_output: (info.tokens ?? EmptyTokens).output,
    tokens_reasoning: (info.tokens ?? EmptyTokens).reasoning,
    tokens_cache_read: (info.tokens ?? EmptyTokens).cache.read,
    tokens_cache_write: (info.tokens ?? EmptyTokens).cache.write,
    revert: info.revert ?? null,
    permission: info.permission,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
    preview: info.preview,
  }
}

function getForkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) {
    const base = match[1]
    const num = parseInt(match[2], 10)
    return `${base} (fork #${num + 1})`
  }
  return `${title} (fork #1)`
}

// Fork lineage is capped at MAX_FORK_DEPTH levels (root → fork → fork-of-fork = 3), i.e. at most two
// successive forks. The tree UI mirrors this cap when nesting sessions under their origin.
export const MAX_FORK_DEPTH = 3
const LEGACY_FOREGROUND_FORK_MIGRATION_VERSION = 1
const LEGACY_FOREGROUND_FORK_MIGRATION_PREFIX = "legacy_foreground_fork_migration_"

type LegacyForegroundForkOrigin = {
  parentSessionID: SessionID
  parentTitle?: string
  cutoffMessageID?: MessageID
  forkedAt: number
  forkIntentID?: string
  manifestState?: string
  legacyMigrationVersion?: number
}

function legacyForegroundForkOrigin(metadata: Info["metadata"]): LegacyForegroundForkOrigin | undefined {
  const value = metadata?.forkedFrom
  if (!value || typeof value !== "object") return
  const origin = value as Record<string, unknown>
  if (typeof origin.parentSessionID !== "string") return
  if (typeof origin.forkedAt !== "number" || !Number.isFinite(origin.forkedAt)) return
  if (origin.cutoffMessageID !== undefined && typeof origin.cutoffMessageID !== "string") return
  if (origin.parentTitle !== undefined && typeof origin.parentTitle !== "string") return
  if (
    (origin.manifestVersion !== undefined || origin.forkIntentID !== undefined) &&
    !(
      origin.legacyMigrationVersion === LEGACY_FOREGROUND_FORK_MIGRATION_VERSION &&
      origin.manifestState === "prepared" &&
      typeof origin.forkIntentID === "string"
    )
  )
    return
  return {
    parentSessionID: SessionID.make(origin.parentSessionID),
    ...(typeof origin.parentTitle === "string" ? { parentTitle: origin.parentTitle } : {}),
    ...(typeof origin.cutoffMessageID === "string" ? { cutoffMessageID: MessageID.make(origin.cutoffMessageID) } : {}),
    forkedAt: origin.forkedAt,
    ...(typeof origin.forkIntentID === "string" ? { forkIntentID: origin.forkIntentID } : {}),
    ...(typeof origin.manifestState === "string" ? { manifestState: origin.manifestState } : {}),
    ...(typeof origin.legacyMigrationVersion === "number"
      ? { legacyMigrationVersion: origin.legacyMigrationVersion }
      : {}),
  }
}

function legacyForkProjectionFingerprint(messages: readonly SessionV1.WithParts[]) {
  const ordinals = new Map(messages.map((message, ordinal) => [message.info.id, ordinal]))
  return `lfp${LEGACY_FOREGROUND_FORK_MIGRATION_VERSION}_${Hash.sha256(
    CanonicalJson.stringify({
      version: LEGACY_FOREGROUND_FORK_MIGRATION_VERSION,
      messages: messages.map((message, messageOrdinal) => ({
        created: message.info.time.created,
        info:
          message.info.role === "user"
            ? {
                id: messageOrdinal,
                role: message.info.role,
                format: message.info.format,
                agent: message.info.agent,
                model: message.info.model,
                system: message.info.system,
                tools: message.info.tools,
                metadata: message.info.metadata,
              }
            : {
                id: messageOrdinal,
                role: message.info.role,
                error: message.info.error,
                parentID: ordinals.get(message.info.parentID) ?? `external:${message.info.parentID}`,
                modelID: message.info.modelID,
                providerID: message.info.providerID,
                providerAttemptID: message.info.providerAttemptID,
                mode: message.info.mode,
                agent: message.info.agent,
                path: message.info.path,
                summary: message.info.summary,
                structured: message.info.structured,
                variant: message.info.variant,
                finish: message.info.finish,
              },
        parts: message.parts.map((part, partOrdinal) => ({
          ...Object.fromEntries(
            Object.entries(part).filter(
              ([key]) => key !== "id" && key !== "sessionID" && key !== "messageID" && key !== "time",
            ),
          ),
          id: `${messageOrdinal}:${partOrdinal}`,
          ...(part.type === "compaction" && part.tail_start_id
            ? { tail_start_id: ordinals.get(part.tail_start_id) ?? `external:${part.tail_start_id}` }
            : {}),
        })),
      })),
    }),
  )}`
}

function legacyForkSourcePrefix(
  messages: readonly SessionV1.WithParts[],
  origin: LegacyForegroundForkOrigin,
): SessionV1.WithParts[] | undefined {
  if (origin.cutoffMessageID) {
    if (!messages.some((message) => message.info.id === origin.cutoffMessageID)) return
    const cutoffIndex = messages.findIndex((message) => message.info.id >= origin.cutoffMessageID!)
    return cutoffIndex < 0 ? [...messages] : messages.slice(0, cutoffIndex)
  }
  return messages.filter((message) => message.info.time.created <= origin.forkedAt)
}

function sessionPath(worktree: string, cwd: string) {
  return path.relative(path.resolve(worktree), cwd).replaceAll("\\", "/")
}

const Summary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: optionalOmitUndefined(Schema.Array(Snapshot.FileDiff)),
  diffManifest: optionalOmitUndefined(
    Schema.Struct({
      completeness: Snapshot.DiffManifest.fields.completeness,
      truncationReasons: Snapshot.DiffManifest.fields.truncationReasons,
      manifestHash: Snapshot.DiffManifest.fields.manifestHash,
      totalFiles: Snapshot.DiffManifest.fields.totalFiles,
      totalFilesExact: Snapshot.DiffManifest.fields.totalFilesExact,
      statisticsExact: optionalOmitUndefined(Snapshot.DiffManifest.fields.statisticsExact),
      includedFiles: Snapshot.DiffManifest.fields.includedFiles,
      truncatedFiles: Snapshot.DiffManifest.fields.truncatedFiles,
    }),
  ),
})

const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

const EmptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const Share = Schema.Struct({
  url: Schema.String,
})

// Legacy HTTP accepted negative values here. Keep archive timestamps permissive
// while excluding non-finite values that cannot round-trip through JSON.
export const ArchivedTimestamp = Schema.Finite

const Time = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  compacting: optionalOmitUndefined(NonNegativeInt),
  // `null` clears the archived flag (unarchive); `undefined` still omits the key.
  archived: optionalOmitUndefined(Schema.NullOr(ArchivedTimestamp)),
})

const Revert = Schema.Struct({
  messageID: MessageID,
  partID: optionalOmitUndefined(PartID),
  snapshot: optionalOmitUndefined(Schema.String),
  diff: optionalOmitUndefined(Schema.String),
})

const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  variant: optionalOmitUndefined(Schema.String),
})

export const Metadata = Schema.Record(Schema.String, Schema.Any)

export const Info = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: ProjectV2.ID,
  workspaceID: optionalOmitUndefined(WorkspaceV2.ID),
  directory: Schema.String,
  path: optionalOmitUndefined(Schema.String),
  parentID: optionalOmitUndefined(SessionID),
  summary: optionalOmitUndefined(Summary),
  cost: optionalOmitUndefined(Schema.Finite),
  tokens: optionalOmitUndefined(Tokens),
  share: optionalOmitUndefined(Share),
  title: Schema.String,
  agent: optionalOmitUndefined(Schema.String),
  model: optionalOmitUndefined(Model),
  version: Schema.String,
  metadata: optionalOmitUndefined(Metadata),
  time: Time,
  permission: optionalOmitUndefined(PermissionV1.Ruleset),
  revert: optionalOmitUndefined(Revert),
  // Truncated, single-lined snapshot of the first user message, for archived-session list previews.
  // Set once from the first user message; never overwritten. GlobalInfo inherits it via Info.fields.
  preview: optionalOmitUndefined(Schema.String),
}).annotate({ identifier: "Session" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const ProjectInfo = Schema.Struct({
  id: ProjectV2.ID,
  name: optionalOmitUndefined(Schema.String),
  worktree: Schema.String,
}).annotate({ identifier: "ProjectSummary" })
export type ProjectInfo = Types.DeepMutable<Schema.Schema.Type<typeof ProjectInfo>>

export const GlobalInfo = Schema.Struct({
  ...Info.fields,
  project: Schema.NullOr(ProjectInfo),
}).annotate({ identifier: "GlobalSession" })
export type GlobalInfo = Types.DeepMutable<Schema.Schema.Type<typeof GlobalInfo>>

export const CreateInput = Schema.optional(
  Schema.Struct({
    parentID: Schema.optional(SessionID),
    title: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    model: Schema.optional(Model),
    metadata: Schema.optional(Metadata),
    permission: Schema.optional(PermissionV1.Ruleset),
    workspaceID: Schema.optional(WorkspaceV2.ID),
  }),
)
export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const ForkInput = Schema.Struct({
  sessionID: SessionID,
  // The retry identity is required at every admission boundary. Generating it inside fork() would
  // turn a response-loss retry into a second child instead of adopting the committed operation.
  intentID: Schema.NonEmptyString,
  messageID: Schema.optional(MessageID),
  // 附-D 阶段3: optionally fork into a specific directory instead of inheriting the source
  // session's directory. When omitted, fork behaves exactly as before (inherits ctx.directory).
  // This field is reachable from the public HTTP ForkPayload, so fork() enforces a fail-closed
  // boundary guard (containsPath) before adopting it — a client-supplied directory that escapes the
  // instance boundary is rejected. The stored `path` is additionally re-derived worktree-relative.
  directory: Schema.optional(Schema.String),
  // 附-D 阶段4: when "worktree", allocate a dedicated git worktree for the fork so parallel forks
  // don't collide on the same checkout. Resolved OPTIONALLY (serviceOption); non-git projects
  // degrade to a same-directory fork (WorktreeNotGitError tolerated).
  isolate: Schema.optional(Schema.Literal("worktree")),
})
export const GetInput = SessionID
export const ChildrenInput = SessionID
export const RemoveInput = SessionID
export const SetTitleInput = Schema.Struct({ sessionID: SessionID, title: Schema.String })
export const SetArchivedInput = Schema.Struct({
  sessionID: SessionID,
  time: Schema.optional(ArchivedTimestamp),
})
export const SetMetadataInput = Schema.Struct({
  sessionID: SessionID,
  metadata: Metadata,
})
export const SetPermissionInput = Schema.Struct({
  sessionID: SessionID,
  permission: PermissionV1.Ruleset,
})
export const SetRevertInput = Schema.Struct({
  sessionID: SessionID,
  revert: Schema.optional(Revert),
  summary: Schema.optional(Summary),
})
export const MessagesInput = Schema.Struct({
  sessionID: SessionID,
  limit: Schema.optional(NonNegativeInt),
})
export type ListInput = {
  directory?: string
  scope?: "project"
  path?: string
  workspaceID?: WorkspaceV2.ID
  roots?: boolean
  start?: number
  search?: string
  limit?: number
}

export type GlobalListInput = {
  directory?: string
  roots?: boolean
  start?: number
  cursor?: number
  search?: string
  limit?: number
  archived?: boolean
}

const CreatedEventSchema = Schema.Struct({
  sessionID: SessionID,
  info: Info,
})

const UpdatedShare = Schema.Struct({
  url: Schema.optional(Schema.NullOr(Schema.String)),
})

const UpdatedTime = Schema.Struct({
  created: Schema.optional(Schema.NullOr(NonNegativeInt)),
  updated: Schema.optional(Schema.NullOr(NonNegativeInt)),
  compacting: Schema.optional(Schema.NullOr(NonNegativeInt)),
  archived: Schema.optional(Schema.NullOr(ArchivedTimestamp)),
})

const UpdatedInfo = Schema.Struct({
  id: Schema.optional(Schema.NullOr(SessionID)),
  slug: Schema.optional(Schema.NullOr(Schema.String)),
  projectID: Schema.optional(Schema.NullOr(ProjectV2.ID)),
  workspaceID: Schema.optional(Schema.NullOr(WorkspaceV2.ID)),
  directory: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  parentID: Schema.optional(Schema.NullOr(SessionID)),
  summary: Schema.optional(Schema.NullOr(Summary)),
  cost: Schema.optional(Schema.Finite),
  tokens: Schema.optional(Tokens),
  share: Schema.optional(UpdatedShare),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  agent: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Model)),
  version: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Schema.NullOr(Metadata)),
  time: Schema.optional(UpdatedTime),
  permission: Schema.optional(Schema.NullOr(PermissionV1.Ruleset)),
  revert: Schema.optional(Schema.NullOr(Revert)),
})

const UpdatedEventSchema = Schema.Struct({
  sessionID: SessionID,
  info: UpdatedInfo,
})

export const Event = {
  Created: SessionV1.Event.Created,
  Updated: SessionV1.Event.Updated,
  Deleted: SessionV1.Event.Deleted,
  Diff: EventV2.define({
    type: "session.diff",
    schema: {
      sessionID: SessionID,
      diff: Schema.Array(Snapshot.FileDiff),
      manifest: Schema.optional(
        Schema.Struct({
          completeness: Snapshot.DiffManifest.fields.completeness,
          truncationReasons: Snapshot.DiffManifest.fields.truncationReasons,
          manifestHash: Snapshot.DiffManifest.fields.manifestHash,
          totalFiles: Snapshot.DiffManifest.fields.totalFiles,
          totalFilesExact: Snapshot.DiffManifest.fields.totalFilesExact,
          statisticsExact: optionalOmitUndefined(Snapshot.DiffManifest.fields.statisticsExact),
          includedFiles: Snapshot.DiffManifest.fields.includedFiles,
          truncatedFiles: Snapshot.DiffManifest.fields.truncatedFiles,
        }),
      ),
    },
  }),
  Error: EventV2.define({
    type: "session.error",
    schema: {
      sessionID: Schema.optional(SessionID),
      // Reuses SessionV1.Assistant.fields.error (already Schema.optional) so
      // the derived schema keeps the same discriminated-union shape on the event stream.
      error: SessionV1.Assistant.fields.error,
    },
  }),
}

export function plan(input: { slug: string; time: { created: number } }, instance: InstanceContext) {
  const base = instance.project.vcs
    ? path.join(instance.worktree, ".deepagent-code", "plans")
    : path.join(Global.Path.data, "plans")
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}

export const getUsage = (input: { model: Provider.Model; usage: Usage; metadata?: ProviderMetadata }) => {
  const safe = (value: number) => {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, value)
  }
  const inputTokens = safe(input.usage.inputTokens ?? 0)
  const outputTokens = safe(input.usage.outputTokens ?? 0)
  const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

  const cacheReadInputTokens = safe(input.usage.cacheReadInputTokens ?? 0)
  const cacheWriteInputTokens = safe(
    Number(
      input.usage.cacheWriteInputTokens ??
        input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
        // google-vertex-anthropic returns metadata under "vertex" key
        // (AnthropicMessagesLanguageModel custom provider key from 'vertex.anthropic.messages')
        input.metadata?.["vertex"]?.["cacheCreationInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
        0,
    ),
  )

  // AI SDK v6 normalized inputTokens to include cached tokens across all providers
  // (including Anthropic/Bedrock which previously excluded them). Always subtract cache
  // tokens to get the non-cached input count for separate cost calculation.
  const adjustedInputTokens = safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)

  const total = input.usage.totalTokens

  const tokens = {
    total,
    input: adjustedInputTokens,
    output: safe(outputTokens - reasoningTokens),
    reasoning: reasoningTokens,
    cache: {
      write: cacheWriteInputTokens,
      read: cacheReadInputTokens,
    },
  }

  const contextTokens = inputTokens
  const costInfo =
    input.model.cost?.tiers
      ?.filter((item) => item.tier.type === "context" && contextTokens > item.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size)[0] ??
    (input.model.cost?.experimentalOver200K && contextTokens > 200_000
      ? input.model.cost.experimentalOver200K
      : input.model.cost)
  const totalNanoAiu = input.metadata?.["copilot"]?.["totalNanoAiu"]
  return {
    cost:
      typeof totalNanoAiu === "number" && Number.isFinite(totalNanoAiu) && totalNanoAiu >= 0
        ? new Decimal(totalNanoAiu).div(100_000_000_000).toNumber()
        : safe(
            new Decimal(0)
              .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
              .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
              .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
              .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
              // TODO: update models.dev to have better pricing model, for now:
              // charge reasoning tokens at the same rate as output tokens
              .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
              .toNumber(),
          ),
    tokens,
  }
}

export class BusyError extends Schema.TaggedErrorClass<BusyError>()("SessionBusyError", {
  sessionID: SessionID,
}) {}

export class ForkConflict extends Data.TaggedError("Session.ForkConflict")<{
  readonly intentID: string
  readonly reason: string
}> {}

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("SessionUnavailableError", {
  sessionID: SessionID,
  reason: Schema.String,
}) {}

export class PlacementChangeUnsupportedError extends Schema.TaggedErrorClass<PlacementChangeUnsupportedError>()(
  "SessionPlacementChangeUnsupportedError",
  {
    sessionID: SessionID,
    operation: Schema.Literals(["workspace", "directory"]),
    message: Schema.String,
  },
) {}

export type NotFound = NotFoundError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<Info[]>
  readonly listGlobal: (input?: GlobalListInput) => Effect.Effect<GlobalInfo[]>
  readonly create: (input?: {
    id?: SessionID
    parentID?: SessionID
    title?: string
    agent?: string
    model?: Schema.Schema.Type<typeof Model>
    metadata?: typeof Metadata.Type
    permission?: PermissionV1.Ruleset
    workspaceID?: WorkspaceV2.ID
    directory?: string
  }) => Effect.Effect<Info>
  readonly fork: (input: {
    sessionID: SessionID
    intentID: string
    messageID?: MessageID
    directory?: string
    isolate?: "worktree"
    forkMode?: "foreground" | "task"
    targetSessionID?: SessionID
    childDepth?: number
    taskRequestHash?: string
  }) => Effect.Effect<Info, NotFound | ForkConflict>
  readonly recoverForks: () => Effect.Effect<void>
  readonly assertRunnable: (sessionID: SessionID) => Effect.Effect<void, UnavailableError>
  readonly touch: (sessionID: SessionID) => Effect.Effect<void>
  readonly get: (id: SessionID) => Effect.Effect<Info, NotFound>
  readonly getMessage: (input: {
    sessionID: SessionID
    messageID: MessageID
  }) => Effect.Effect<SessionV1.WithParts, NotFound>
  readonly getClientMessage: (input: {
    sessionID: SessionID
    messageID: MessageID
  }) => Effect.Effect<SessionV1.WithParts, NotFound>
  readonly turnSnapshotRange: (input: {
    sessionID: SessionID
    parentID: MessageID
  }) => Effect.Effect<{ from?: string; to?: string }>
  readonly mutationEpoch: (sessionID: SessionID) => Effect.Effect<number, NotFound>
  readonly setTitle: (input: { sessionID: SessionID; title: string }) => Effect.Effect<void>
  readonly setPreview: (input: { sessionID: SessionID; preview: string }) => Effect.Effect<void>
  readonly setArchived: (input: { sessionID: SessionID; time?: number | null }) => Effect.Effect<void>
  readonly setMetadata: (input: typeof SetMetadataInput.Type) => Effect.Effect<void>
  readonly setPermission: (input: { sessionID: SessionID; permission: PermissionV1.Ruleset }) => Effect.Effect<void>
  readonly setRevert: (input: {
    sessionID: SessionID
    revert: Info["revert"]
    summary: Info["summary"]
  }) => Effect.Effect<void>
  readonly commitRevert: (input: {
    sessionID: SessionID
    revert: Info["revert"]
    summary: Info["summary"]
  }) => Effect.Effect<void>
  readonly commitUnrevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly clearRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly setSummary: (input: { sessionID: SessionID; summary: Info["summary"] }) => Effect.Effect<void>
  readonly setShare: (input: { sessionID: SessionID; share: Info["share"] }) => Effect.Effect<void>
  readonly setWorkspace: (input: {
    sessionID: SessionID
    workspaceID: Info["workspaceID"]
  }) => Effect.Effect<void, PlacementChangeUnsupportedError>
  /** Relocates a durable Session after a managed worktree has replaced its original checkout. */
  readonly setDirectory: (input: {
    sessionID: SessionID
    directory: string
  }) => Effect.Effect<void, PlacementChangeUnsupportedError>
  readonly diff: (sessionID: SessionID) => Effect.Effect<Snapshot.FileDiff[]>
  readonly messages: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<SessionV1.WithParts[], NotFound>
  readonly messagesPage: (input: {
    sessionID: SessionID
    limit: number
    before?: string
  }) => Effect.Effect<{ items: SessionV1.WithParts[]; more: boolean; cursor?: string }, NotFound>
  readonly messagesForwardPage: (input: {
    sessionID: SessionID
    limit: number
    after: string
  }) => Effect.Effect<{ items: SessionV1.WithParts[]; more: boolean; cursor?: string }>
  readonly snapshotRangeFromMessage: (input: {
    sessionID: SessionID
    messageID: MessageID
  }) => Effect.Effect<{ from?: string; to?: string }, NotFound>
  readonly children: (parentID: SessionID) => Effect.Effect<Info[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, NotFound>
  readonly updateMessage: <T extends SessionV1.Info>(msg: T) => Effect.Effect<T>
  readonly publishMessageProjection: (input: {
    sessionID: SessionID
    messageID: MessageID
  }) => Effect.Effect<SessionV1.Info | undefined>
  readonly removeMessage: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MessageID>
  readonly removePart: (input: { sessionID: SessionID; messageID: MessageID; partID: PartID }) => Effect.Effect<PartID>
  readonly getPart: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
  }) => Effect.Effect<SessionV1.Part | undefined>
  readonly updatePart: <T extends SessionV1.Part>(part: T) => Effect.Effect<T>
  readonly updatePartDelta: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    field: string
    delta: string
  }) => Effect.Effect<void>
  /** Finds the first message matching the predicate, searching newest-first. */
  readonly findMessage: (
    sessionID: SessionID,
    predicate: (msg: SessionV1.WithParts) => boolean,
  ) => Effect.Effect<Option.Option<SessionV1.WithParts>, NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Session") {}

export const use = serviceUse(Service)

export type Patch = Omit<Partial<Info>, "time" | "share" | "summary" | "revert" | "permission"> & {
  time?: Partial<Info["time"]>
  share?: Partial<NonNullable<Info["share"]>> | null
  summary?: Info["summary"] | null
  revert?: Info["revert"] | null
  permission?: Info["permission"] | null
}

export const layer: Layer.Layer<
  Service,
  never,
  BackgroundJob.Service | RuntimeFlags.Service | Database.Service | EventV2Bridge.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const database = yield* Database.Service
    const background = yield* BackgroundJob.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const createNext = Effect.fn("Session.createNext")(function* (input: {
      id?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      parentID?: SessionID
      workspaceID?: WorkspaceV2.ID
      directory: string
      path?: string
      metadata?: typeof Metadata.Type
      permission?: PermissionV1.Ruleset
    }) {
      const ctx = yield* InstanceState.context
      const result: Info = {
        id: SessionID.descending(input.id),
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: ctx.project.id,
        directory: input.directory,
        path: input.path,
        workspaceID: input.workspaceID,
        parentID: input.parentID,
        title: input.title ?? (input.parentID ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString(),
        agent: input.agent,
        model: input.model,
        metadata: input.metadata,
        permission: input.permission ? [...input.permission] : undefined,
        cost: 0,
        tokens: EmptyTokens,
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
      log.info("created", result)

      yield* events.publish(SessionV1.Event.Created, { sessionID: result.id, info: result })

      return result
    })

    const get = Effect.fn("Session.get")(function* (id: SessionID) {
      const row = yield* db
        .select(sessionClientColumns)
        .from(SessionTable)
        .where(eq(SessionTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${id}` }))
      return fromRow(row)
    })

    const getMessage: Interface["getMessage"] = (input) =>
      MessageV2.get(input).pipe(Effect.provideService(Database.Service, database))
    const getClientMessage: Interface["getClientMessage"] = (input) =>
      MessageV2.clientGet(input).pipe(Effect.provideService(Database.Service, database))

    const turnSnapshotRange: Interface["turnSnapshotRange"] = Effect.fn("Session.turnSnapshotRange")(function* (input) {
      const message = or(
        eq(MessageTable.id, input.parentID),
        eq(sql<string>`json_extract(${MessageTable.data}, '$.parentID')`, input.parentID),
      )
      const start = yield* db
        .select({ snapshot: sql<string | null>`json_extract(${PartTable.data}, '$.snapshot')` })
        .from(PartTable)
        .innerJoin(
          MessageTable,
          and(eq(MessageTable.id, PartTable.message_id), eq(MessageTable.session_id, PartTable.session_id)),
        )
        .where(
          and(
            eq(MessageTable.session_id, input.sessionID),
            message,
            eq(sql<string>`json_extract(${PartTable.data}, '$.type')`, "step-start"),
          ),
        )
        .orderBy(asc(MessageTable.time_created), asc(MessageTable.id), asc(PartTable.id))
        .get()
        .pipe(Effect.orDie)
      const finish = yield* db
        .select({ snapshot: sql<string | null>`json_extract(${PartTable.data}, '$.snapshot')` })
        .from(PartTable)
        .innerJoin(
          MessageTable,
          and(eq(MessageTable.id, PartTable.message_id), eq(MessageTable.session_id, PartTable.session_id)),
        )
        .where(
          and(
            eq(MessageTable.session_id, input.sessionID),
            message,
            eq(sql<string>`json_extract(${PartTable.data}, '$.type')`, "step-finish"),
          ),
        )
        .orderBy(desc(MessageTable.time_created), desc(MessageTable.id), desc(PartTable.id))
        .get()
        .pipe(Effect.orDie)
      return {
        ...(start?.snapshot ? { from: start.snapshot } : {}),
        ...(finish?.snapshot ? { to: finish.snapshot } : {}),
      }
    })

    const mutationEpoch = Effect.fn("Session.mutationEpoch")(function* (sessionID: SessionID) {
      const row = yield* db
        .select({ mutationEpoch: SessionTable.mutation_epoch })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${sessionID}` }))
      return row.mutationEpoch
    })

    const list = Effect.fn("Session.list")(function* (input?: ListInput) {
      const ctx = yield* InstanceState.context
      return yield* listByProject(db, {
        projectID: ctx.project.id,
        experimentalWorkspaces: flags.experimentalWorkspaces,
        ...input,
      })
    })

    const listGlobal = Effect.fn("Session.listGlobal")(function* (input?: GlobalListInput) {
      const conditions: SQL[] = []
      if (input?.directory) conditions.push(eq(SessionTable.directory, input.directory))
      if (input?.roots) conditions.push(isNull(SessionTable.parent_id))
      if (input?.start) conditions.push(gte(SessionTable.time_updated, input.start))
      if (input?.cursor) conditions.push(lt(SessionTable.time_updated, input.cursor))
      if (input?.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
      if (input?.archived) conditions.push(isNotNull(SessionTable.time_archived))
      else conditions.push(isNull(SessionTable.time_archived))

      const query =
        conditions.length > 0
          ? db
              .select(sessionClientColumns)
              .from(SessionTable)
              .where(and(...conditions))
          : db.select(sessionClientColumns).from(SessionTable)
      const rows = yield* query
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .limit(input?.limit ?? 100)
        .all()
        .pipe(Effect.orDie)
      const ids = [...new Set(rows.map((row) => row.project_id))]
      const projects = new Map<string, ProjectInfo>()
      if (ids.length > 0) {
        const items = yield* db
          .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
          .from(ProjectTable)
          .where(inArray(ProjectTable.id, ids))
          .all()
          .pipe(Effect.orDie)
        for (const item of items) {
          projects.set(item.id, {
            id: item.id,
            name: item.name ?? undefined,
            worktree: item.worktree,
          })
        }
      }
      return rows.map((row) => ({ ...fromRow(row), project: projects.get(row.project_id) ?? null }))
    })

    const children = Effect.fn("Session.children")(function* (parentID: SessionID) {
      const rows = yield* db
        .select(sessionClientColumns)
        .from(SessionTable)
        .where(and(eq(SessionTable.parent_id, parentID)))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const remove: Interface["remove"] = Effect.fnUntraced(function* (sessionID: SessionID) {
      const session = yield* get(sessionID)
      try {
        // `remove` needs to work in all cases, such as broken sessions that
        // run cleanup without instance state.
        const hasInstance = yield* InstanceState.directory.pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        )

        if (hasInstance) yield* cancelBackgroundJobs(background, sessionID)
        const kids = yield* children(sessionID)
        for (const child of kids) {
          yield* remove(child.id)
        }

        yield* events.publish(SessionV1.Event.Deleted, { sessionID, info: session })
        yield* events.remove(sessionID)
      } catch (e) {
        log.error(e)
      }
    })

    const updateMessage = <T extends SessionV1.Info>(msg: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        const existing = yield* db
          .select({ session_id: MessageTable.session_id })
          .from(MessageTable)
          .where(eq(MessageTable.id, msg.id))
          .get()
          .pipe(Effect.orDie)
        if (existing && existing.session_id !== msg.sessionID)
          return yield* Effect.die(`Session.updateMessage: message ${msg.id} belongs to another Session`)
        yield* events.publish(
          SessionV1.Event.MessageUpdated,
          {
            sessionID: msg.sessionID,
            info: MessageV2.clientProjection(MessageV2.stripActivityProgress(msg)),
          },
          {
            commit: () =>
              // QUAL-007: upsert, not plain update — messages created through updateMessage (fork
              // fixtures, synthetic boundaries) must land in MessageTable; #115's commit callback
              // dropped the insert half of the old projector's insert-or-update semantics.
              db
                .insert(MessageTable)
                .values({
                  id: msg.id,
                  session_id: msg.sessionID,
                  time_created: msg.time.created,
                  time_updated: msg.time.created,
                  data: Object.fromEntries(
                    Object.entries(msg).filter(([key]) => key !== "id" && key !== "sessionID"),
                  ) as typeof MessageTable.$inferInsert.data,
                })
                .onConflictDoUpdate({
                  target: MessageTable.id,
                  set: {
                    data: Object.fromEntries(
                      Object.entries(msg).filter(([key]) => key !== "id" && key !== "sessionID"),
                    ) as typeof MessageTable.$inferInsert.data,
                  },
                })
                .run()
                .pipe(Effect.orDie),
          },
        )
        return msg
      }).pipe(Effect.withSpan("Session.updateMessage"))

    const publishMessageProjection: Interface["publishMessageProjection"] = Effect.fn(
      "Session.publishMessageProjection",
    )(function* (input) {
      const message = yield* MessageV2.get(input).pipe(
        Effect.provideService(Database.Service, database),
        Effect.catchIf(NotFoundError.isInstance, () =>
          Effect.logWarning("cannot publish activity progress for a missing assistant message").pipe(
            Effect.annotateLogs(input),
            Effect.as(undefined),
          ),
        ),
      )
      if (!message) return
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: input.sessionID,
        info: MessageV2.clientProjection(message.info),
      })
      return message.info
    })

    const updatePart = <T extends SessionV1.Part>(part: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        yield* requireMessageOwnership({ sessionID: part.sessionID, messageID: part.messageID }).pipe(Effect.orDie)
        const existing = yield* db
          .select({ message_id: PartTable.message_id, session_id: PartTable.session_id })
          .from(PartTable)
          .where(eq(PartTable.id, part.id))
          .get()
          .pipe(Effect.orDie)
        if (existing && (existing.message_id !== part.messageID || existing.session_id !== part.sessionID))
          return yield* Effect.die(`Session.updatePart: part ${part.id} belongs to another message or Session`)
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID: part.sessionID,
          part: structuredClone(part),
          time: Date.now(),
        })
        return part
      }).pipe(Effect.withSpan("Session.updatePart"))

    const requireMessageOwnership = Effect.fn("Session.requireMessageOwnership")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const row = yield* db
        .select({ id: MessageTable.id })
        .from(MessageTable)
        .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
    })

    const requirePartOwnership = Effect.fn("Session.requirePartOwnership")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
    }) {
      const row = yield* db
        .select({ id: PartTable.id })
        .from(PartTable)
        .where(
          and(
            eq(PartTable.id, input.partID),
            eq(PartTable.message_id, input.messageID),
            eq(PartTable.session_id, input.sessionID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ message: `Part not found: ${input.partID}` })
    })

    const getPart: Interface["getPart"] = Effect.fn("Session.getPart")(function* (input) {
      const row = yield* db
        .select()
        .from(PartTable)
        .where(
          and(
            eq(PartTable.session_id, input.sessionID),
            eq(PartTable.message_id, input.messageID),
            eq(PartTable.id, input.partID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return {
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      } as SessionV1.Part
    })

    const create = Effect.fn("Session.create")(function* (input?: {
      id?: SessionID
      parentID?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      metadata?: typeof Metadata.Type
      permission?: PermissionV1.Ruleset
      workspaceID?: WorkspaceV2.ID
      // U5: optionally run this session in a different directory (e.g. a per-subagent worktree). When
      // omitted, inherits the instance directory (existing behavior). path is derived from the
      // instance worktree root + the chosen directory.
      directory?: string
    }) {
      const ctx = yield* InstanceState.context
      const workspace = yield* InstanceState.workspaceID
      const directory = input?.directory ?? ctx.directory
      return yield* createNext({
        id: input?.id,
        parentID: input?.parentID,
        directory,
        path: sessionPath(ctx.worktree, directory),
        title: input?.title,
        agent: input?.agent,
        model: input?.model,
        metadata: input?.metadata,
        permission: input?.permission,
        workspaceID: input?.workspaceID ?? workspace,
      })
    })

    const deliverForkEvents = Effect.fn("Session.deliverForkEvents")(function* (intentID: string) {
      const owner = `fork-delivery:${Identifier.ascending("event")}`
      const waitDeadline = Date.now() + 35_000
      let claimed: typeof SessionForkIntentTable.$inferSelect | undefined
      while (!claimed) {
        const candidate = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const row = yield* tx
                  .select()
                  .from(SessionForkIntentTable)
                  .where(eq(SessionForkIntentTable.intent_id, intentID))
                  .get()
                if (!row) return yield* Effect.die(new Error(`fork intent missing after commit: ${intentID}`))
                if (row.state === "complete") return row
                if (row.state === "recovery_required") {
                  return yield* Effect.fail(
                    new ForkConflict({ intentID, reason: row.recovery_reason ?? "fork delivery requires recovery" }),
                  )
                }
                if (row.state === "publishing" && row.lease_expires_at && row.lease_expires_at > Date.now()) return row
                return yield* tx
                  .update(SessionForkIntentTable)
                  .set({
                    state: "publishing",
                    delivery_owner: owner,
                    lease_expires_at: Date.now() + 30_000,
                    delivery_attempts: sql`${SessionForkIntentTable.delivery_attempts} + 1`,
                    time_updated: Date.now(),
                  })
                  .where(eq(SessionForkIntentTable.intent_id, intentID))
                  .returning()
                  .get()
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        if (candidate.state === "complete") return yield* get(candidate.target_session_id)
        if (candidate.delivery_owner === owner) {
          claimed = candidate
          continue
        }
        if (Date.now() >= waitDeadline) {
          return yield* Effect.fail(
            new ForkConflict({ intentID, reason: "fork delivery did not settle before timeout" }),
          )
        }
        yield* Effect.sleep("25 millis")
      }

      return yield* Effect.gen(function* () {
        const target = yield* get(claimed.target_session_id)
        const targetProjection = yield* MessageV2.promptHistoryProjectionEffect(target.id).pipe(
          Effect.provideService(Database.Service, database),
          Effect.mapError(
            (error) =>
              new ForkConflict({
                intentID,
                reason: `target history validation failed: ${
                  error instanceof MessageV2.HistoryAuthorityError ? error.reason : error.message
                }`,
              }),
          ),
        )
        const targetWorldState = yield* MessageV2.promptWorldStateProjectionEffect(target.id).pipe(
          Effect.provideService(Database.Service, database),
          Effect.mapError(
            (error) =>
              new ForkConflict({
                intentID,
                reason: `target World State validation failed: ${
                  error instanceof MessageV2.HistoryAuthorityError ? error.reason : error.message
                }`,
              }),
          ),
        )
        if (
          targetProjection.epoch !== claimed.target_prompt_epoch ||
          targetProjection.window.windowID !== claimed.target_window_id ||
          targetProjection.effectiveHistoryHash !== claimed.target_effective_history_hash ||
          targetWorldState?.hash !== claimed.target_world_state_baseline_hash
        ) {
          const quarantined = yield* db
            .update(SessionForkIntentTable)
            .set({
              state: "recovery_required",
              recovery_reason: "target projection no longer matches committed fork manifest",
              delivery_owner: null,
              lease_expires_at: null,
              time_updated: Date.now(),
            })
            .where(
              and(
                eq(SessionForkIntentTable.intent_id, intentID),
                eq(SessionForkIntentTable.delivery_owner, owner),
                eq(SessionForkIntentTable.state, "publishing"),
              ),
            )
            .returning({ intent_id: SessionForkIntentTable.intent_id })
            .get()
            .pipe(Effect.orDie)
          if (!quarantined) {
            return yield* Effect.fail(new ForkConflict({ intentID, reason: "fork delivery ownership was lost" }))
          }
          return yield* Effect.fail(
            new ForkConflict({ intentID, reason: "target projection no longer matches committed fork manifest" }),
          )
        }

        const rows = yield* messages({ sessionID: target.id })
        let cursor = claimed.event_cursor
        let ordinal = 0
        const publishOnce = Effect.fn("Session.deliverForkEvent")(function* (
          publish: (commit: (seq: number) => Effect.Effect<void>) => Effect.Effect<unknown>,
        ) {
          const current = ordinal++
          if (current < cursor) return
          if (current !== cursor || current >= claimed.event_count) {
            return yield* Effect.die(
              new Error(`fork event cursor is not contiguous for ${intentID}: ${current}/${cursor}`),
            )
          }
          const next = current + 1
          yield* publish(() =>
            db
              .update(SessionForkIntentTable)
              .set({ event_cursor: next, lease_expires_at: Date.now() + 30_000, time_updated: Date.now() })
              .where(
                and(
                  eq(SessionForkIntentTable.intent_id, intentID),
                  eq(SessionForkIntentTable.delivery_owner, owner),
                  eq(SessionForkIntentTable.state, "publishing"),
                  eq(SessionForkIntentTable.event_cursor, current),
                ),
              )
              .returning({ intent_id: SessionForkIntentTable.intent_id })
              .get()
              .pipe(
                Effect.orDie,
                Effect.flatMap((advanced) =>
                  advanced
                    ? Effect.void
                    : Effect.die(new ForkConflict({ intentID, reason: "fork delivery ownership was lost" })),
                ),
              ),
          )
          cursor = next
        })

        for (const row of rows) {
          const message = MessageV2.clientProjection(MessageV2.stripActivityProgress(row.info))
          const messageEventID = EventV2.ID.make(
            `evt_${Hash.sha256(`fork-event:v1:${intentID}:message:${row.info.id}`).slice(0, 26)}`,
          )
          yield* publishOnce((commit) =>
            events.publish(
              SessionV1.Event.MessageUpdated,
              { sessionID: target.id, info: message },
              { id: messageEventID, idempotent: true, commit },
            ),
          )
          for (const part of row.parts) {
            const projectedPart = MessageV2.stripActivityProgressPart(part)
            const partEventID = EventV2.ID.make(
              `evt_${Hash.sha256(`fork-event:v1:${intentID}:part:${part.id}`).slice(0, 26)}`,
            )
            yield* publishOnce((commit) =>
              events.publish(
                SessionV1.Event.PartUpdated,
                {
                  sessionID: target.id,
                  part: projectedPart,
                  time:
                    projectedPart.type === "text"
                      ? (projectedPart.time?.start ?? row.info.time.created)
                      : row.info.time.created,
                },
                { id: partEventID, idempotent: true, commit },
              ),
            )
          }
        }

        const complete = {
          ...target,
          metadata:
            claimed.fork_mode === "task"
              ? {
                  ...target.metadata,
                  deepagent: {
                    ...(target.metadata?.deepagent as Record<string, unknown> | undefined),
                    task_fork_manifest: {
                      ...((target.metadata?.deepagent as Record<string, unknown> | undefined)?.task_fork_manifest as
                        | Record<string, unknown>
                        | undefined),
                      manifestState: "complete",
                    },
                  },
                }
              : {
                  ...target.metadata,
                  forkedFrom: {
                    ...(target.metadata?.forkedFrom as Record<string, unknown>),
                    manifestState: "complete",
                  },
                },
          time: { ...target.time, updated: claimed.time_committed ?? claimed.time_created },
        }
        const completeEventID = EventV2.ID.make(`evt_${Hash.sha256(`fork-event:v1:${intentID}:complete`).slice(0, 26)}`)
        yield* publishOnce((commit) =>
          events.publish(
            SessionV1.Event.Updated,
            { sessionID: target.id, info: complete },
            { id: completeEventID, idempotent: true, commit },
          ),
        )
        if (cursor !== claimed.event_count) {
          return yield* Effect.die(
            new Error(`fork delivery count mismatch for ${intentID}: ${cursor}/${claimed.event_count}`),
          )
        }
        const completed = yield* db
          .update(SessionForkIntentTable)
          .set({
            state: "complete",
            event_cursor: cursor,
            delivery_owner: null,
            lease_expires_at: null,
            time_updated: Date.now(),
            time_completed: Date.now(),
          })
          .where(
            and(
              eq(SessionForkIntentTable.intent_id, intentID),
              eq(SessionForkIntentTable.delivery_owner, owner),
              eq(SessionForkIntentTable.state, "publishing"),
            ),
          )
          .returning({ intent_id: SessionForkIntentTable.intent_id })
          .get()
          .pipe(Effect.orDie)
        if (!completed) {
          return yield* Effect.fail(new ForkConflict({ intentID, reason: "fork delivery ownership was lost" }))
        }
        return complete
      }).pipe(
        Effect.onError(() =>
          db
            .update(SessionForkIntentTable)
            .set({ state: "committed", delivery_owner: null, lease_expires_at: null, time_updated: Date.now() })
            .where(
              and(
                eq(SessionForkIntentTable.intent_id, intentID),
                eq(SessionForkIntentTable.delivery_owner, owner),
                eq(SessionForkIntentTable.state, "publishing"),
              ),
            )
            .run()
            .pipe(Effect.orDie),
        ),
      )
    })

    const completeForkSideEffects = Effect.fn("Session.completeForkSideEffects")(function* (
      intent: typeof SessionForkIntentTable.$inferSelect,
    ) {
      if (intent.side_effects_completed_at) return
      if (intent.fork_mode === "foreground") {
        yield* forwardLedgerOnForkRequired({
          parentSessionID: intent.source_session_id,
          forkSessionID: intent.target_session_id,
        })
        yield* persistForkOriginRequired({
          forkSessionID: intent.target_session_id,
          origin: {
            parentSessionID: intent.source_session_id,
            ...(intent.source_cutoff_message_id ? { cutoffMessageID: intent.source_cutoff_message_id } : {}),
            forkedAt: intent.time_created,
          },
        })
      }
      const completed = yield* db
        .update(SessionForkIntentTable)
        .set({ side_effects_completed_at: Date.now(), time_updated: Date.now() })
        .where(
          and(
            eq(SessionForkIntentTable.intent_id, intent.intent_id),
            eq(SessionForkIntentTable.state, "complete"),
            isNull(SessionForkIntentTable.side_effects_completed_at),
          ),
        )
        .returning({ intent_id: SessionForkIntentTable.intent_id })
        .get()
        .pipe(Effect.orDie)
      if (completed) return
      const current = yield* db
        .select({ side_effects_completed_at: SessionForkIntentTable.side_effects_completed_at })
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.intent_id, intent.intent_id))
        .get()
        .pipe(Effect.orDie)
      if (current?.side_effects_completed_at) return
      return yield* Effect.fail(
        new ForkConflict({ intentID: intent.intent_id, reason: "fork side effects are not committable" }),
      )
    })

    function migrateLegacyForegroundFork(
      sessionID: SessionID,
      lineage: readonly SessionID[] = [],
    ): Effect.Effect<void, ForkConflict, never> {
      return Effect.gen(function* () {
        if (lineage.includes(sessionID) || lineage.length >= MAX_FORK_DEPTH) {
          return yield* new ForkConflict({
            intentID: `${LEGACY_FOREGROUND_FORK_MIGRATION_PREFIX}${sessionID}`,
            reason: "legacy foreground fork lineage contains a cycle or exceeds the depth limit",
          })
        }
        const target = yield* get(sessionID).pipe(
          Effect.mapError(
            (error) =>
              new ForkConflict({
                intentID: `${LEGACY_FOREGROUND_FORK_MIGRATION_PREFIX}${sessionID}`,
                reason: `legacy fork child is unavailable: ${error.message}`,
              }),
          ),
        )
        const origin = legacyForegroundForkOrigin(target.metadata)
        if (!origin) {
          return yield* new ForkConflict({
            intentID: `${LEGACY_FOREGROUND_FORK_MIGRATION_PREFIX}${sessionID}`,
            reason: "legacy foreground fork manifest is not compatible with migration",
          })
        }
        if (target.parentID) {
          return yield* new ForkConflict({
            intentID: `${LEGACY_FOREGROUND_FORK_MIGRATION_PREFIX}${sessionID}`,
            reason: "legacy foreground fork has a task parent binding",
          })
        }
        const intentID =
          origin.forkIntentID ??
          `${LEGACY_FOREGROUND_FORK_MIGRATION_PREFIX}${Hash.sha256(
            CanonicalJson.stringify({
              version: LEGACY_FOREGROUND_FORK_MIGRATION_VERSION,
              sessionID,
              parentSessionID: origin.parentSessionID,
              cutoffMessageID: origin.cutoffMessageID,
              forkedAt: origin.forkedAt,
            }),
          ).slice(0, 32)}`
        const existingIntent = yield* db
          .select()
          .from(SessionForkIntentTable)
          .where(eq(SessionForkIntentTable.intent_id, intentID))
          .get()
          .pipe(Effect.orDie)
        if (existingIntent?.state === "complete" && existingIntent.side_effects_completed_at !== null) return
        if (existingIntent) {
          return yield* new ForkConflict({
            intentID,
            reason: existingIntent.recovery_reason ?? `legacy migration intent is ${existingIntent.state}`,
          })
        }

        const parent = yield* get(origin.parentSessionID).pipe(
          Effect.mapError(
            (error) =>
              new ForkConflict({
                intentID,
                reason: `legacy fork parent is unavailable: ${error.message}`,
              }),
          ),
        )
        if (parent.projectID !== target.projectID || parent.id === target.id) {
          return yield* new ForkConflict({
            intentID,
            reason: "legacy fork parent and child are not in the same project",
          })
        }
        const parentOrigin = legacyForegroundForkOrigin(parent.metadata)
        if (parentOrigin) yield* migrateLegacyForegroundFork(parent.id, [...lineage, sessionID])

        const quarantinedPart = yield* db
          .select({ part_id: SessionPartIntegrityQuarantineTable.part_id })
          .from(SessionPartIntegrityQuarantineTable)
          .where(
            or(
              eq(SessionPartIntegrityQuarantineTable.part_session_id, target.id),
              eq(SessionPartIntegrityQuarantineTable.message_session_id, target.id),
              eq(SessionPartIntegrityQuarantineTable.part_session_id, parent.id),
              eq(SessionPartIntegrityQuarantineTable.message_session_id, parent.id),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (quarantinedPart) {
          return yield* new ForkConflict({
            intentID,
            reason: `legacy fork history contains quarantined Part ${quarantinedPart.part_id}`,
          })
        }

        const sourceProjection = yield* MessageV2.promptHistoryProjectionEffect(parent.id).pipe(
          Effect.provideService(Database.Service, database),
          Effect.mapError(
            (error) =>
              new ForkConflict({
                intentID,
                reason: `legacy fork source history is unavailable: ${
                  error instanceof MessageV2.HistoryAuthorityError ? error.reason : error.message
                }`,
              }),
          ),
        )
        const sourceSession = yield* db
          .select({ mutation_epoch: SessionTable.mutation_epoch })
          .from(SessionTable)
          .where(eq(SessionTable.id, parent.id))
          .get()
          .pipe(Effect.orDie)
        if (!sourceSession) return yield* new ForkConflict({ intentID, reason: "legacy fork parent row disappeared" })

        const sourcePhysical = yield* MessageV2.stream(parent.id).pipe(
          Effect.provideService(Database.Service, database),
          Effect.map((messages) => messages.reverse()),
        )
        const targetPhysical = yield* MessageV2.stream(target.id).pipe(
          Effect.provideService(Database.Service, database),
          Effect.map((messages) => messages.reverse()),
        )
        const sourcePrefix = legacyForkSourcePrefix(sourcePhysical, origin)
        if (!sourcePrefix) {
          return yield* new ForkConflict({
            intentID,
            reason: origin.cutoffMessageID
              ? `legacy fork cutoff ${origin.cutoffMessageID} is absent from the parent history`
              : "legacy fork parent history cannot be bounded at fork time",
          })
        }
        if (target.time.created < origin.forkedAt) {
          return yield* new ForkConflict({ intentID, reason: "legacy fork child predates its fork timestamp" })
        }
        const targetPrefix = targetPhysical.slice(0, sourcePrefix.length)
        if (
          targetPrefix.length !== sourcePrefix.length ||
          legacyForkProjectionFingerprint(sourcePrefix) !== legacyForkProjectionFingerprint(targetPrefix)
        ) {
          return yield* new ForkConflict({
            intentID,
            reason: "legacy fork child prefix does not match the verified parent cutoff projection",
          })
        }
        const sourcePrefixHash = legacyForkProjectionFingerprint(sourcePrefix)
        const targetPrefixHash = legacyForkProjectionFingerprint(targetPrefix)
        const targetPhysicalHash = HistoryAuthority.hash(targetPhysical)
        const requestHash = Hash.sha256(
          CanonicalJson.stringify({
            version: LEGACY_FOREGROUND_FORK_MIGRATION_VERSION,
            sourceSessionID: parent.id,
            targetSessionID: target.id,
            sourcePromptEpoch: sourceProjection.epoch,
            sourceWindowID: sourceProjection.window.windowID,
            sourceEffectiveHistoryHash: sourceProjection.effectiveHistoryHash,
            sourceMutationEpoch: sourceSession.mutation_epoch,
            sourceMessageCount: sourceProjection.messages.length,
            sourceCutoffMessageID: origin.cutoffMessageID,
            projectionVersion: sourceProjection.projectionVersion,
            sourcePrefixHash,
            targetPrefixHash,
            targetPhysicalHash,
            targetPhysicalMessageCount: targetPhysical.length,
            clonedMessageCount: sourcePrefix.length,
            clonedPartCount: targetPrefix.reduce((total, message) => total + message.parts.length, 0),
          }),
        )
        const preparedMetadata = {
          ...target.metadata,
          forkedFrom: {
            ...(target.metadata?.forkedFrom as Record<string, unknown>),
            manifestVersion: 1,
            manifestState: "prepared",
            forkIntentID: intentID,
            forkMode: "foreground",
            parentSessionID: parent.id,
            parentTitle: parent.title,
            ...(origin.cutoffMessageID ? { cutoffMessageID: origin.cutoffMessageID } : {}),
            sourcePromptEpoch: sourceProjection.epoch,
            sourceWindowID: sourceProjection.window.windowID,
            sourceEffectiveHistoryHash: sourceProjection.effectiveHistoryHash,
            sourceMutationEpoch: sourceSession.mutation_epoch,
            sourceMessageCount: sourceProjection.messages.length,
            projectionVersion: sourceProjection.projectionVersion,
            sanitationPolicyVersion: 1,
            legacyMigrationVersion: LEGACY_FOREGROUND_FORK_MIGRATION_VERSION,
            legacySourcePrefixHash: sourcePrefixHash,
            legacyTargetPrefixHash: targetPrefixHash,
            legacyTargetPhysicalHash: targetPhysicalHash,
            legacyTargetPhysicalMessageCount: targetPhysical.length,
            legacyClonedMessageCount: sourcePrefix.length,
            legacyClonedPartCount: targetPrefix.reduce((total, message) => total + message.parts.length, 0),
            legacyMigrationRequestHash: requestHash,
            forkedAt: origin.forkedAt,
          },
        }

        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const currentIntent = yield* tx
                  .select()
                  .from(SessionForkIntentTable)
                  .where(eq(SessionForkIntentTable.intent_id, intentID))
                  .get()
                if (currentIntent?.state === "complete" && currentIntent.side_effects_completed_at !== null) return
                if (currentIntent)
                  return yield* Effect.fail(
                    new ForkConflict({
                      intentID,
                      reason: currentIntent.recovery_reason ?? `legacy migration intent is ${currentIntent.state}`,
                    }),
                  )
                const currentAdmission = yield* tx
                  .select()
                  .from(SessionForkAdmissionTable)
                  .where(eq(SessionForkAdmissionTable.intent_id, intentID))
                  .get()
                if (currentAdmission) {
                  if (currentAdmission.request_hash !== requestHash || currentAdmission.state !== "ready")
                    return yield* Effect.fail(
                      new ForkConflict({
                        intentID,
                        reason:
                          currentAdmission.recovery_reason ?? `legacy migration admission is ${currentAdmission.state}`,
                      }),
                    )
                } else {
                  yield* tx
                    .insert(SessionForkAdmissionTable)
                    .values({
                      intent_id: intentID,
                      request_hash: requestHash,
                      fork_mode: "foreground",
                      source_session_id: parent.id,
                      source_prompt_epoch: sourceProjection.epoch,
                      source_window_id: sourceProjection.window.windowID,
                      source_effective_history_hash: sourceProjection.effectiveHistoryHash,
                      source_mutation_epoch: sourceSession.mutation_epoch,
                      source_message_count: sourceProjection.messages.length,
                      source_cutoff_message_id: origin.cutoffMessageID ?? null,
                      projection_version: sourceProjection.projectionVersion,
                      sanitation_policy_version: 1,
                      requested_directory: target.directory,
                      isolation_mode: "none",
                      requested_target_session_id: target.id,
                      target_session_id: target.id,
                      child_depth: null,
                      task_request_hash: null,
                      worktree_directory: null,
                      worktree_branch: null,
                      worktree_base_commit: null,
                      state: "ready",
                      recovery_reason: null,
                      time_created: Date.now(),
                      time_updated: Date.now(),
                    })
                    .run()
                }
                const history = yield* tx
                  .select({ state: SessionHistoryStateTable.state, reason: SessionHistoryStateTable.reason })
                  .from(SessionHistoryStateTable)
                  .where(eq(SessionHistoryStateTable.session_id, target.id))
                  .get()
                if (history?.state === "recovery_required") {
                  if (history.reason !== "legacy foreground fork has no verifiable source projection manifest")
                    return yield* Effect.fail(
                      new ForkConflict({ intentID, reason: history.reason ?? "legacy fork history requires recovery" }),
                    )
                  yield* tx
                    .delete(SessionPromptEpochMessageTable)
                    .where(eq(SessionPromptEpochMessageTable.session_id, target.id))
                    .run()
                  yield* tx
                    .delete(SessionWorldStateBaselineTable)
                    .where(eq(SessionWorldStateBaselineTable.session_id, target.id))
                    .run()
                  yield* tx
                    .delete(SessionPromptEpochTable)
                    .where(eq(SessionPromptEpochTable.session_id, target.id))
                    .run()
                  yield* tx
                    .delete(SessionHistoryStateTable)
                    .where(eq(SessionHistoryStateTable.session_id, target.id))
                    .run()
                }
                yield* tx
                  .update(SessionTable)
                  .set({ metadata: preparedMetadata })
                  .where(eq(SessionTable.id, target.id))
                  .run()
              }),
            { behavior: "immediate" },
          )
          .pipe(
            Effect.mapError((error) =>
              error instanceof ForkConflict
                ? error
                : new ForkConflict({
                    intentID,
                    reason: `legacy migration admission transaction failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  }),
            ),
          )
        const completed = yield* Effect.gen(function* () {
          const targetProjection = yield* MessageV2.promptHistoryProjectionEffect(target.id).pipe(
            Effect.provideService(Database.Service, database),
            Effect.mapError(
              (error) =>
                new ForkConflict({
                  intentID,
                  reason: `legacy fork target history migration failed: ${
                    error instanceof MessageV2.HistoryAuthorityError ? error.reason : error.message
                  }`,
                }),
            ),
          )
          if (!targetProjection.worldStateBaselineHash) {
            return yield* new ForkConflict({
              intentID,
              reason: "legacy fork target history has no World State baseline after migration",
            })
          }
          const targetWorldState = yield* MessageV2.promptWorldStateProjectionEffect(target.id).pipe(
            Effect.provideService(Database.Service, database),
            Effect.mapError(
              (error) =>
                new ForkConflict({
                  intentID,
                  reason: `legacy fork target World State validation failed: ${
                    error instanceof MessageV2.HistoryAuthorityError ? error.reason : error.message
                  }`,
                }),
            ),
          )
          if (!targetWorldState || targetWorldState.hash !== targetProjection.worldStateBaselineHash) {
            return yield* new ForkConflict({ intentID, reason: "legacy fork World State baseline hash mismatch" })
          }
          if (!loadForkOrigin(target.id)) {
            yield* forwardLedgerOnForkRequired({ parentSessionID: parent.id, forkSessionID: target.id })
          }
          yield* persistForkOriginRequired({
            forkSessionID: target.id,
            origin: {
              parentSessionID: parent.id,
              ...(origin.cutoffMessageID ? { cutoffMessageID: origin.cutoffMessageID } : {}),
              forkedAt: origin.forkedAt,
            },
          })
          return yield* db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  const admission = yield* tx
                    .select()
                    .from(SessionForkAdmissionTable)
                    .where(eq(SessionForkAdmissionTable.intent_id, intentID))
                    .get()
                  if (!admission || admission.state !== "ready" || admission.request_hash !== requestHash)
                    return yield* Effect.fail(
                      new ForkConflict({ intentID, reason: "legacy migration admission changed during recovery" }),
                    )
                  const sourceMutation = yield* tx
                    .select({ mutation_epoch: SessionTable.mutation_epoch })
                    .from(SessionTable)
                    .where(eq(SessionTable.id, parent.id))
                    .get()
                  if (!sourceMutation || sourceMutation.mutation_epoch !== sourceSession.mutation_epoch)
                    return yield* Effect.fail(
                      new ForkConflict({ intentID, reason: "legacy fork source changed during migration" }),
                    )
                  const currentTarget = yield* tx
                    .select({ metadata: SessionTable.metadata })
                    .from(SessionTable)
                    .where(eq(SessionTable.id, target.id))
                    .get()
                  const currentManifest =
                    currentTarget?.metadata?.forkedFrom && typeof currentTarget.metadata.forkedFrom === "object"
                      ? (currentTarget.metadata.forkedFrom as Record<string, unknown>)
                      : undefined
                  if (
                    currentManifest?.legacyMigrationRequestHash !== requestHash ||
                    currentManifest.manifestState !== "prepared"
                  )
                    return yield* Effect.fail(
                      new ForkConflict({ intentID, reason: "legacy migration manifest changed during recovery" }),
                    )
                  const now = Date.now()
                  yield* tx
                    .insert(SessionForkIntentTable)
                    .values({
                      intent_id: intentID,
                      request_hash: requestHash,
                      fork_mode: "foreground",
                      source_session_id: parent.id,
                      source_prompt_epoch: sourceProjection.epoch,
                      source_window_id: sourceProjection.window.windowID,
                      source_effective_history_hash: sourceProjection.effectiveHistoryHash,
                      source_mutation_epoch: sourceSession.mutation_epoch,
                      source_message_count: sourceProjection.messages.length,
                      source_cutoff_message_id: origin.cutoffMessageID ?? null,
                      projection_version: sourceProjection.projectionVersion,
                      sanitation_policy_version: 1,
                      target_session_id: target.id,
                      target_prompt_epoch: targetProjection.epoch,
                      target_window_id: targetProjection.window.windowID,
                      target_effective_history_hash: targetProjection.effectiveHistoryHash,
                      target_world_state_baseline_hash: targetWorldState.hash,
                      cloned_message_count: sourcePrefix.length,
                      cloned_part_count: targetPrefix.reduce((total, message) => total + message.parts.length, 0),
                      state: "complete",
                      event_cursor: 0,
                      event_count: 0,
                      delivery_owner: null,
                      lease_expires_at: null,
                      delivery_attempts: 0,
                      recovery_reason: null,
                      time_created: now,
                      time_updated: now,
                      time_committed: now,
                      time_completed: now,
                      side_effects_completed_at: null,
                    })
                    .run()
                  yield* tx
                    .update(SessionForkIntentTable)
                    .set({ side_effects_completed_at: now, time_updated: now })
                    .where(eq(SessionForkIntentTable.intent_id, intentID))
                    .run()
                  yield* tx
                    .update(SessionForkAdmissionTable)
                    .set({ state: "manifest_committed", recovery_reason: null, time_updated: now })
                    .where(
                      and(
                        eq(SessionForkAdmissionTable.intent_id, intentID),
                        eq(SessionForkAdmissionTable.state, "ready"),
                      ),
                    )
                    .run()
                  yield* tx
                    .update(SessionTable)
                    .set({
                      metadata: {
                        ...target.metadata,
                        forkedFrom: {
                          ...currentManifest,
                          manifestState: "complete",
                          targetPromptEpoch: targetProjection.epoch,
                          targetWindowID: targetProjection.window.windowID,
                          targetEffectiveHistoryHash: targetProjection.effectiveHistoryHash,
                          targetWorldStateBaselineHash: targetWorldState.hash,
                          legacyMigrationCompletedAt: now,
                        },
                      },
                    })
                    .where(eq(SessionTable.id, target.id))
                    .run()
                  return
                }),
              { behavior: "immediate" },
            )
            .pipe(
              Effect.mapError((error) =>
                error instanceof ForkConflict
                  ? error
                  : new ForkConflict({
                      intentID,
                      reason: `legacy migration completion transaction failed: ${
                        error instanceof Error ? error.message : String(error)
                      }`,
                    }),
              ),
            )
        }).pipe(
          Effect.catch((error: unknown) =>
            Effect.gen(function* () {
              const reason =
                error instanceof ForkConflict ? error.reason : error instanceof Error ? error.message : String(error)
              yield* db
                .update(SessionForkAdmissionTable)
                .set({ state: "recovery_required", recovery_reason: reason, time_updated: Date.now() })
                .where(
                  and(eq(SessionForkAdmissionTable.intent_id, intentID), eq(SessionForkAdmissionTable.state, "ready")),
                )
                .run()
                .pipe(Effect.orDie)
              return yield* new ForkConflict({ intentID, reason })
            }),
          ),
        )
        if (completed) return
      })
    }

    const forkUnlocked = Effect.fn("Session.fork")(function* (input: {
      sessionID: SessionID
      intentID: string
      messageID?: MessageID
      directory?: string
      isolate?: "worktree"
      forkMode?: "foreground" | "task"
      targetSessionID?: SessionID
      childDepth?: number
      taskRequestHash?: string
    }) {
      const forkMode = input.forkMode ?? "foreground"
      const intentID = input.intentID
      const requestHash = Hash.sha256(
        CanonicalJson.stringify({
          version: 2,
          forkMode,
          sourceSessionID: input.sessionID,
          cutoffMessageID: input.messageID,
          directory: input.directory,
          isolate: input.isolate,
          targetSessionID: input.targetSessionID,
          childDepth: input.childDepth,
          taskRequestHash: input.taskRequestHash,
        }),
      )
      const retry = yield* db
        .select()
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.intent_id, intentID))
        .get()
        .pipe(Effect.orDie)
      if (retry) {
        if (retry.request_hash !== requestHash) {
          return yield* Effect.fail(
            new ForkConflict({ intentID, reason: "fork intent was reused with different input" }),
          )
        }
        const delivered = yield* deliverForkEvents(intentID)
        const committed = yield* db
          .select()
          .from(SessionForkIntentTable)
          .where(eq(SessionForkIntentTable.intent_id, intentID))
          .get()
          .pipe(Effect.orDie)
        if (!committed) return yield* Effect.die(new Error(`fork intent disappeared during retry: ${intentID}`))
        yield* completeForkSideEffects(committed)
        return delivered
      }
      const existingAdmission = yield* db
        .select()
        .from(SessionForkAdmissionTable)
        .where(eq(SessionForkAdmissionTable.intent_id, intentID))
        .get()
        .pipe(Effect.orDie)
      if (existingAdmission?.request_hash !== undefined && existingAdmission.request_hash !== requestHash)
        return yield* Effect.fail(
          new ForkConflict({ intentID, reason: "fork admission was reused with different input" }),
        )
      if (existingAdmission?.state === "recovery_required")
        return yield* Effect.fail(
          new ForkConflict({
            intentID,
            reason: existingAdmission.recovery_reason ?? "fork admission requires recovery",
          }),
        )
      if (existingAdmission?.state === "manifest_committed")
        return yield* Effect.fail(
          new ForkConflict({ intentID, reason: "fork admission committed without a readable child manifest" }),
        )
      if (input.targetSessionID && !existingAdmission) {
        const target = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.targetSessionID))
          .get()
          .pipe(Effect.orDie)
        if (target) {
          return yield* Effect.fail(
            new ForkConflict({ intentID, reason: "target session exists without the matching fork intent" }),
          )
        }
      }

      const ctx = yield* InstanceState.context
      const original = yield* get(input.sessionID)
      const title = getForkedTitle(original.title)
      const sourceProjection = yield* (
        input.messageID
          ? MessageV2.promptHistoryCutoffProjectionEffect({
              sessionID: input.sessionID,
              cutoffMessageID: input.messageID,
            })
          : MessageV2.promptHistoryProjectionEffect(input.sessionID)
      ).pipe(
        Effect.provideService(Database.Service, database),
        Effect.mapError(
          (error) =>
            new ForkConflict({
              intentID,
              reason: `source history is unavailable: ${
                error instanceof MessageV2.HistoryAuthorityError ? error.reason : error.message
              }`,
            }),
        ),
      )
      const sourceSession = yield* db
        .select({ mutation_epoch: SessionTable.mutation_epoch })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!sourceSession) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
      const sourceMessages =
        forkMode === "task" ? sanitizeTaskHistory(sourceProjection.messages) : sourceProjection.messages
      const sourceUsesCheckpoint = sourceProjection.epoch > 0 && !sourceProjection.recoveryResolutionID
      if (sourceUsesCheckpoint && sourceMessages.length < 2) {
        return yield* Effect.fail(new ForkConflict({ intentID, reason: "fork would omit the active checkpoint pair" }))
      }
      if (
        forkMode === "task" &&
        sourceUsesCheckpoint &&
        (sourceMessages[0]?.info.role !== "user" ||
          sourceMessages[1]?.info.role !== "assistant" ||
          !sourceMessages[1].info.summary)
      ) {
        return yield* Effect.fail(new ForkConflict({ intentID, reason: "task sanitation removed the checkpoint pair" }))
      }

      // Depth guard (max 3 levels ⇒ at most 2 forks deep). A fork's lineage is recorded in
      // `metadata.forkedFrom.parentSessionID` (foreground-safe: unlike `parentID`, it does NOT
      // trigger subagent semantics — notification suppression, disabled followup queue). Walk the
      // chain up from the source; if the source already sits at depth 2 (i.e. is itself a
      // fork-of-a-fork), a further fork would be depth 3 → reject fail-closed. Bounded by
      // MAX_FORK_DEPTH iterations so a corrupted cycle can't loop forever.
      const sourceDepth = yield* Effect.gen(function* () {
        let depth = 0
        let cursor: SessionID | undefined = input.sessionID
        for (let i = 0; i < MAX_FORK_DEPTH && cursor; i++) {
          const node: Info = cursor === input.sessionID ? original : yield* get(cursor)
          const parent = (node.metadata?.forkedFrom as { parentSessionID?: string } | undefined)?.parentSessionID
          if (!parent) break
          depth++
          cursor = SessionID.make(parent)
        }
        return depth
      })
      if (sourceDepth >= MAX_FORK_DEPTH - 1) {
        return yield* Effect.fail(
          new NotFoundError({
            message: `Fork depth limit reached (max ${MAX_FORK_DEPTH} levels): ${input.sessionID}`,
          }),
        )
      }

      // Freeze the exact child/resource identity before provisioning anything external. The admission
      // row has no FK to the not-yet-created child, which is intentional: it is the crash boundary that
      // the committed child manifest cannot represent.
      const worktreeOpt =
        input.isolate === "worktree" ? yield* Effect.serviceOption(Worktree.Service) : Option.none<Worktree.Interface>()
      if (input.directory !== undefined && !containsPath(input.directory, ctx)) {
        return yield* Effect.die(new Error(`Fork directory escapes the project boundary: ${input.directory}`))
      }
      const proposedTargetSessionID = existingAdmission
        ? SessionID.make(existingAdmission.target_session_id)
        : SessionID.descending(input.targetSessionID)
      if (input.targetSessionID && proposedTargetSessionID !== input.targetSessionID)
        return yield* Effect.fail(new ForkConflict({ intentID, reason: "fork target Session ID changed on retry" }))
      const plannedWorktree =
        existingAdmission?.isolation_mode === "worktree"
          ? {
              operationKey: intentID,
              name: path.basename(existingAdmission.worktree_directory!),
              worktreeBranch: existingAdmission.worktree_branch!,
              directory: existingAdmission.worktree_directory!,
              baseCommit: existingAdmission.worktree_base_commit!,
            }
          : input.isolate === "worktree" && Option.isSome(worktreeOpt)
            ? yield* worktreeOpt.value
                .planExact({ operationKey: intentID, name: `fork-${Hash.sha256(intentID).slice(0, 16)}` })
                .pipe(
                  Effect.catchTag("WorktreeNotGitError", () => Effect.succeed(undefined)),
                  Effect.mapError((error) => new ForkConflict({ intentID, reason: error.message })),
                )
            : undefined
      const now = Date.now()
      const insertedAdmission = existingAdmission
        ? undefined
        : yield* db
            .insert(SessionForkAdmissionTable)
            .values({
              intent_id: intentID,
              request_hash: requestHash,
              fork_mode: forkMode,
              source_session_id: input.sessionID,
              source_prompt_epoch: sourceProjection.epoch,
              source_window_id: sourceProjection.window.windowID,
              source_effective_history_hash: sourceProjection.effectiveHistoryHash,
              source_mutation_epoch: sourceSession.mutation_epoch,
              source_message_count: sourceProjection.messages.length,
              source_cutoff_message_id: input.messageID ?? null,
              projection_version: sourceProjection.projectionVersion,
              sanitation_policy_version: forkMode === "task" ? 3 : 1,
              requested_directory: input.directory ?? null,
              isolation_mode: plannedWorktree ? "worktree" : "none",
              requested_target_session_id: input.targetSessionID ?? null,
              target_session_id: proposedTargetSessionID,
              child_depth: input.childDepth ?? null,
              task_request_hash: input.taskRequestHash ?? null,
              worktree_directory: plannedWorktree?.directory ?? null,
              worktree_branch: plannedWorktree?.worktreeBranch ?? null,
              worktree_base_commit: plannedWorktree?.baseCommit ?? null,
              state: plannedWorktree ? "admitted" : "ready",
              recovery_reason: null,
              time_created: now,
              time_updated: now,
            })
            .onConflictDoNothing()
            .returning()
            .get()
            .pipe(Effect.orDie)
      const admission =
        existingAdmission ??
        insertedAdmission ??
        (yield* db
          .select()
          .from(SessionForkAdmissionTable)
          .where(eq(SessionForkAdmissionTable.intent_id, intentID))
          .get()
          .pipe(Effect.orDie))
      if (!admission) {
        const targetOwner = yield* db
          .select({ intent_id: SessionForkAdmissionTable.intent_id })
          .from(SessionForkAdmissionTable)
          .where(eq(SessionForkAdmissionTable.target_session_id, proposedTargetSessionID))
          .get()
          .pipe(Effect.orDie)
        return yield* Effect.fail(
          new ForkConflict({
            intentID,
            reason: targetOwner
              ? `fork target Session is reserved by ${targetOwner.intent_id}`
              : "fork admission conflict did not resolve to a durable authority",
          }),
        )
      }
      if (admission.request_hash !== requestHash)
        return yield* Effect.fail(
          new ForkConflict({ intentID, reason: "fork admission was reused with different input" }),
        )
      const targetSessionID = SessionID.make(admission.target_session_id)
      if (input.targetSessionID && targetSessionID !== input.targetSessionID)
        return yield* Effect.fail(new ForkConflict({ intentID, reason: "fork target Session ID changed on retry" }))
      if (
        admission.source_prompt_epoch !== sourceProjection.epoch ||
        admission.source_window_id !== sourceProjection.window.windowID ||
        admission.source_effective_history_hash !== sourceProjection.effectiveHistoryHash ||
        admission.source_mutation_epoch !== sourceSession.mutation_epoch ||
        admission.source_message_count !== sourceProjection.messages.length ||
        admission.projection_version !== sourceProjection.projectionVersion
      ) {
        yield* db
          .update(SessionForkAdmissionTable)
          .set({
            state: "recovery_required",
            recovery_reason: "source history changed after fork admission",
            time_updated: now,
          })
          .where(eq(SessionForkAdmissionTable.intent_id, intentID))
          .run()
          .pipe(Effect.orDie)
        return yield* Effect.fail(new ForkConflict({ intentID, reason: "source history changed after fork admission" }))
      }
      if (plannedWorktree && Option.isNone(worktreeOpt)) {
        yield* db
          .update(SessionForkAdmissionTable)
          .set({
            state: "recovery_required",
            recovery_reason: "managed worktree service is unavailable during fork recovery",
            time_updated: Date.now(),
          })
          .where(eq(SessionForkAdmissionTable.intent_id, intentID))
          .run()
          .pipe(Effect.orDie)
        return yield* Effect.fail(
          new ForkConflict({ intentID, reason: "managed worktree service is unavailable during fork recovery" }),
        )
      }
      const worktreeInfo =
        plannedWorktree && Option.isSome(worktreeOpt)
          ? yield* Effect.gen(function* () {
              yield* db
                .update(SessionForkAdmissionTable)
                .set({ state: "provisioning", time_updated: Date.now() })
                .where(
                  and(
                    eq(SessionForkAdmissionTable.intent_id, intentID),
                    eq(SessionForkAdmissionTable.state, "admitted"),
                  ),
                )
                .run()
                .pipe(Effect.orDie)
              const provisioned = yield* worktreeOpt.value.ensureExact(plannedWorktree).pipe(
                Effect.mapError(
                  (error) =>
                    new ForkConflict({
                      intentID,
                      reason: error instanceof Worktree.WorktreeExactConflictError ? error.reason : error.message,
                    }),
                ),
                Effect.tapError((error) =>
                  db
                    .update(SessionForkAdmissionTable)
                    .set({ state: "recovery_required", recovery_reason: error.reason, time_updated: Date.now() })
                    .where(eq(SessionForkAdmissionTable.intent_id, intentID))
                    .run()
                    .pipe(Effect.orDie),
                ),
              )
              yield* db
                .update(SessionForkAdmissionTable)
                .set({ state: "ready", recovery_reason: null, time_updated: Date.now() })
                .where(
                  and(
                    eq(SessionForkAdmissionTable.intent_id, intentID),
                    eq(SessionForkAdmissionTable.state, "provisioning"),
                  ),
                )
                .run()
                .pipe(Effect.orDie)
              return provisioned
            })
          : undefined
      const directory = worktreeInfo?.directory ?? admission.requested_directory ?? ctx.directory
      const worldStateBaselineExit = yield* Effect.exit(collectSessionWorldStateBaseline({ workspacePath: directory }))
      if (Exit.isFailure(worldStateBaselineExit)) {
        yield* db
          .update(SessionForkAdmissionTable)
          .set({
            state: "recovery_required",
            recovery_reason: "world state baseline collection failed",
            time_updated: Date.now(),
          })
          .where(eq(SessionForkAdmissionTable.intent_id, intentID))
          .run()
          .pipe(Effect.orDie)
        return yield* Effect.failCause(worldStateBaselineExit.cause)
      }
      const worldStateBaseline = worldStateBaselineExit.value
      // Record the fork lineage on the new session's metadata so the client can (a) render a
      // "derived from ‹parent›" banner at the top of the transcript and (b) nest the fork under its
      // parent in the session tree. This is carried in `metadata` (already DB-persisted + synced to
      // the client + cloned by fork) rather than `parentID` — a fork is a foreground session, and
      // `parentID` would misclassify it as a background subagent. It mirrors the ForkOrigin marker
      // persisted below (context store), but travels with Session.Info so no extra IO/route is needed.
      const firstWindowID = HistoryAuthority.windowID()
      const targetWindowID = sourceUsesCheckpoint ? HistoryAuthority.windowID() : firstWindowID
      const messageIDMap = new Map(
        sourceMessages.map((message) => [
          message.info.id,
          MessageID.make(
            `msg_${message.info.id.replace(/^msg_?/, "")}_${Hash.sha256(`fork-map:v1:${intentID}:${message.info.id}`).slice(0, 12)}`,
          ),
        ]),
      )
      const cloned = sourceMessages.map((message) => {
        const id = messageIDMap.get(message.info.id)!
        const info = MessageV2.stripActivityProgress<SessionV1.Info>(
          message.info.role === "assistant"
            ? {
                ...message.info,
                id,
                sessionID: targetSessionID,
                parentID: messageIDMap.get(message.info.parentID)!,
              }
            : { ...message.info, id, sessionID: targetSessionID },
        )
        if (info.role === "assistant" && !info.parentID) {
          throw new ForkConflict({
            intentID,
            reason: `assistant ${message.info.id} has a parent outside the fork projection`,
          })
        }
        return {
          info,
          parts: message.parts.map((part) =>
            MessageV2.stripActivityProgressPart({
              ...part,
              id: PartID.make(
                `prt_${part.id.replace(/^prt_?/, "")}_${Hash.sha256(`fork-map:v1:${intentID}:${part.id}`).slice(0, 12)}`,
              ),
              messageID: id,
              sessionID: targetSessionID,
              ...(part.type === "compaction"
                ? { tail_start_id: part.tail_start_id ? messageIDMap.get(part.tail_start_id) : undefined }
                : {}),
            }),
          ) as SessionV1.Part[],
        }
      })
      const targetEffectiveHistoryHash = HistoryAuthority.hash(cloned)
      const forkedFrom = {
        manifestVersion: 1,
        manifestState: "prepared",
        forkIntentID: intentID,
        forkMode,
        parentSessionID: input.sessionID,
        parentTitle: original.title,
        ...(input.messageID ? { cutoffMessageID: input.messageID } : {}),
        sourcePromptEpoch: sourceProjection.epoch,
        sourceWindowID: sourceProjection.window.windowID,
        sourceEffectiveHistoryHash: sourceProjection.effectiveHistoryHash,
        sourceMutationEpoch: sourceSession.mutation_epoch,
        sourceMessageCount: sourceProjection.messages.length,
        projectionVersion: sourceProjection.projectionVersion,
        sanitationPolicyVersion: forkMode === "task" ? 3 : 1,
        ...(input.taskRequestHash ? { taskRequestHash: input.taskRequestHash } : {}),
        targetPromptEpoch: sourceUsesCheckpoint ? 1 : 0,
        targetWindowID,
        targetEffectiveHistoryHash,
        targetWorldStateBaselineHash: worldStateBaseline.hash,
        forkedAt: Date.now(),
      }
      const session: Info = {
        id: targetSessionID,
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: ctx.project.id,
        directory,
        path: sessionPath(ctx.worktree, directory),
        ...(forkMode === "task" ? { parentID: input.sessionID } : {}),
        workspaceID: original.workspaceID,
        title,
        metadata:
          forkMode === "task"
            ? {
                deepagent: {
                  task_fork_manifest: forkedFrom,
                  subagentDepth: input.childDepth ?? 0,
                },
              }
            : { ...structuredClone(original.metadata), forkedFrom },
        cost: 0,
        tokens: EmptyTokens,
        time: { created: Date.now(), updated: Date.now() },
      }
      const sourceCheckpointUserID = sourceUsesCheckpoint ? sourceMessages[0]?.info.id : undefined
      const sourceCheckpointAssistantID = sourceUsesCheckpoint ? sourceMessages[1]?.info.id : undefined
      const sourceMarker = sourceUsesCheckpoint ? sourceMessages[0] : undefined
      const sourceTailStartID = sourceMarker?.parts.find(
        (part): part is SessionV1.CompactionPart => part.type === "compaction",
      )?.tail_start_id
      const targetCheckpointUserID = sourceCheckpointUserID ? messageIDMap.get(sourceCheckpointUserID) : undefined
      const targetCheckpointAssistantID = sourceCheckpointAssistantID
        ? messageIDMap.get(sourceCheckpointAssistantID)
        : undefined
      const targetTailStartID = sourceTailStartID ? messageIDMap.get(sourceTailStartID) : undefined
      if (sourceUsesCheckpoint && (!targetCheckpointUserID || !targetCheckpointAssistantID)) {
        return yield* Effect.fail(
          new ForkConflict({ intentID, reason: "fork projection has an invalid checkpoint pair" }),
        )
      }

      yield* events
        .publish(
          SessionV1.Event.Created,
          { sessionID: session.id, info: session },
          {
            commit: () =>
              Effect.gen(function* () {
                const admitted = yield* db
                  .select({
                    state: SessionForkAdmissionTable.state,
                    target_session_id: SessionForkAdmissionTable.target_session_id,
                  })
                  .from(SessionForkAdmissionTable)
                  .where(eq(SessionForkAdmissionTable.intent_id, intentID))
                  .get()
                if (!admitted || admitted.state !== "ready" || admitted.target_session_id !== session.id)
                  return yield* Effect.die(
                    new ForkConflict({ intentID, reason: "fork admission is not ready for manifest commit" }),
                  )
                const currentSource = input.messageID
                  ? yield* MessageV2.promptHistoryCutoffProjectionInTransaction(db, {
                      sessionID: input.sessionID,
                      cutoffMessageID: input.messageID,
                    })
                  : yield* MessageV2.promptHistoryProjectionInTransaction(db, input.sessionID)
                const currentSession = yield* db
                  .select({ mutation_epoch: SessionTable.mutation_epoch })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, input.sessionID))
                  .get()
                if (
                  !currentSource ||
                  !currentSession ||
                  currentSession.mutation_epoch !== sourceSession.mutation_epoch ||
                  currentSource.epoch !== sourceProjection.epoch ||
                  currentSource.window.windowID !== sourceProjection.window.windowID ||
                  currentSource.effectiveHistoryHash !== sourceProjection.effectiveHistoryHash ||
                  currentSource.messages.length !== sourceProjection.messages.length
                ) {
                  return yield* Effect.die(new ForkConflict({ intentID, reason: "source history changed during fork" }))
                }
                const concurrent = yield* db
                  .select({ request_hash: SessionForkIntentTable.request_hash })
                  .from(SessionForkIntentTable)
                  .where(eq(SessionForkIntentTable.intent_id, intentID))
                  .get()
                if (concurrent) {
                  return yield* Effect.die(
                    new ForkConflict({ intentID, reason: "fork intent was committed concurrently" }),
                  )
                }

                for (const message of cloned) {
                  yield* db
                    .insert(MessageTable)
                    .values({
                      id: message.info.id,
                      session_id: session.id,
                      time_created: message.info.time.created,
                      time_updated: message.info.time.created,
                      data: Object.fromEntries(
                        Object.entries(message.info).filter(([key]) => key !== "id" && key !== "sessionID"),
                      ) as typeof MessageTable.$inferInsert.data,
                    })
                    .run()
                  for (const part of message.parts) {
                    yield* db
                      .insert(PartTable)
                      .values({
                        id: part.id,
                        message_id: message.info.id,
                        session_id: session.id,
                        time_created: message.info.time.created,
                        time_updated: message.info.time.created,
                        data: Object.fromEntries(
                          Object.entries(part).filter(
                            ([key]) => key !== "id" && key !== "messageID" && key !== "sessionID",
                          ),
                        ) as typeof PartTable.$inferInsert.data,
                      })
                      .run()
                  }
                }

                const now = Date.now()
                if (!sourceUsesCheckpoint) {
                  yield* db
                    .insert(SessionPromptEpochTable)
                    .values({
                      session_id: session.id,
                      epoch: 0,
                      state: "active",
                      checkpoint_user_id: null,
                      checkpoint_assistant_id: null,
                      retained_tail_start_id: null,
                      source_end_message_id: cloned.at(-1)?.info.id ?? null,
                      checkpoint_hash: targetEffectiveHistoryHash,
                      projection_version: HistoryAuthority.PROJECTION_VERSION,
                      canonicalization_version: HistoryAuthority.CANONICALIZATION_VERSION,
                      base_message_count: cloned.length,
                      effective_history_hash: targetEffectiveHistoryHash,
                      first_window_id: firstWindowID,
                      previous_window_id: null,
                      window_id: targetWindowID,
                      world_state_baseline_hash: worldStateBaseline.hash,
                      authority_state: "ready",
                      recovery_reason: null,
                      recovery_resolution_id: null,
                      reason: "bootstrap",
                      created_at: now,
                      retired_at: null,
                    })
                    .run()
                } else {
                  yield* db
                    .insert(SessionPromptEpochTable)
                    .values([
                      {
                        session_id: session.id,
                        epoch: 0,
                        state: "retired",
                        checkpoint_user_id: null,
                        checkpoint_assistant_id: null,
                        retained_tail_start_id: null,
                        source_end_message_id: null,
                        checkpoint_hash: HistoryAuthority.hash([]),
                        projection_version: HistoryAuthority.PROJECTION_VERSION,
                        canonicalization_version: HistoryAuthority.CANONICALIZATION_VERSION,
                        base_message_count: 0,
                        effective_history_hash: HistoryAuthority.hash([]),
                        first_window_id: firstWindowID,
                        previous_window_id: null,
                        window_id: firstWindowID,
                        world_state_baseline_hash: null,
                        authority_state: "ready",
                        recovery_reason: null,
                        recovery_resolution_id: null,
                        reason: "bootstrap",
                        created_at: now,
                        retired_at: now,
                      },
                      {
                        session_id: session.id,
                        epoch: 1,
                        state: "active",
                        checkpoint_user_id: targetCheckpointUserID!,
                        checkpoint_assistant_id: targetCheckpointAssistantID!,
                        retained_tail_start_id: targetTailStartID ?? null,
                        source_end_message_id: cloned.at(-1)?.info.id ?? null,
                        checkpoint_hash: targetEffectiveHistoryHash,
                        projection_version: HistoryAuthority.PROJECTION_VERSION,
                        canonicalization_version: HistoryAuthority.CANONICALIZATION_VERSION,
                        base_message_count: cloned.length,
                        effective_history_hash: targetEffectiveHistoryHash,
                        first_window_id: firstWindowID,
                        previous_window_id: firstWindowID,
                        window_id: targetWindowID,
                        world_state_baseline_hash: worldStateBaseline.hash,
                        authority_state: "ready",
                        recovery_reason: null,
                        recovery_resolution_id: null,
                        reason: "compaction",
                        created_at: now,
                        retired_at: null,
                      },
                    ])
                    .run()
                }
                if (cloned.length > 0) {
                  yield* db
                    .insert(SessionPromptEpochMessageTable)
                    .values(
                      cloned.map((message, ordinal) => ({
                        session_id: session.id,
                        prompt_epoch: sourceUsesCheckpoint ? 1 : 0,
                        ordinal,
                        message_id: message.info.id,
                      })),
                    )
                    .run()
                }
                yield* db
                  .insert(SessionWorldStateBaselineTable)
                  .values(
                    worldStateBaseline.sections.map((section) => ({
                      session_id: session.id,
                      prompt_epoch: sourceUsesCheckpoint ? 1 : 0,
                      section_id: section.sectionID,
                      snapshot: section.snapshot,
                      fragment: section.fragment,
                      fragment_hash: section.fragmentHash,
                      provenance: "fork_rebuilt" as const,
                      created_at: now,
                    })),
                  )
                  .run()
                yield* db
                  .insert(SessionHistoryStateTable)
                  .values({
                    session_id: session.id,
                    state: "ready",
                    reason: null,
                    time_created: now,
                    time_updated: now,
                  })
                  .run()
                yield* db
                  .insert(SessionForkIntentTable)
                  .values({
                    intent_id: intentID,
                    request_hash: requestHash,
                    fork_mode: forkMode,
                    source_session_id: input.sessionID,
                    source_prompt_epoch: sourceProjection.epoch,
                    source_window_id: sourceProjection.window.windowID,
                    source_effective_history_hash: sourceProjection.effectiveHistoryHash,
                    source_mutation_epoch: sourceSession.mutation_epoch,
                    source_message_count: sourceProjection.messages.length,
                    source_cutoff_message_id: input.messageID ?? null,
                    projection_version: sourceProjection.projectionVersion,
                    sanitation_policy_version: forkMode === "task" ? 3 : 1,
                    target_session_id: session.id,
                    target_prompt_epoch: sourceUsesCheckpoint ? 1 : 0,
                    target_window_id: targetWindowID,
                    target_effective_history_hash: targetEffectiveHistoryHash,
                    target_world_state_baseline_hash: worldStateBaseline.hash,
                    cloned_message_count: cloned.length,
                    cloned_part_count: cloned.reduce((total, message) => total + message.parts.length, 0),
                    state: "committed",
                    event_cursor: 0,
                    event_count: cloned.reduce((total, message) => total + message.parts.length + 1, 1),
                    delivery_owner: null,
                    lease_expires_at: null,
                    delivery_attempts: 0,
                    recovery_reason: null,
                    time_created: now,
                    time_updated: now,
                    time_committed: now,
                    time_completed: null,
                    side_effects_completed_at: null,
                  })
                  .run()
                const committedAdmission = yield* db
                  .update(SessionForkAdmissionTable)
                  .set({ state: "manifest_committed", recovery_reason: null, time_updated: now })
                  .where(
                    and(
                      eq(SessionForkAdmissionTable.intent_id, intentID),
                      eq(SessionForkAdmissionTable.state, "ready"),
                    ),
                  )
                  .returning({ intent_id: SessionForkAdmissionTable.intent_id })
                  .get()
                if (!committedAdmission)
                  return yield* Effect.die(
                    new ForkConflict({ intentID, reason: "fork admission ownership was lost during commit" }),
                  )
              }).pipe(Effect.orDie),
          },
        )
        .pipe(
          Effect.catchDefect((defect: unknown) =>
            defect instanceof ForkConflict ? Effect.fail(defect) : Effect.die(defect),
          ),
          Effect.onError(() =>
            db
              .update(SessionForkAdmissionTable)
              .set({
                state: "recovery_required",
                recovery_reason: "fork manifest commit failed after durable admission",
                time_updated: Date.now(),
              })
              .where(
                and(
                  eq(SessionForkAdmissionTable.intent_id, intentID),
                  inArray(SessionForkAdmissionTable.state, ["admitted", "provisioning", "ready"] as const),
                ),
              )
              .run()
              .pipe(Effect.ignore),
          ),
          Effect.catchIf(
            (error) => error instanceof ForkConflict && error.reason === "fork intent was committed concurrently",
            () =>
              Effect.gen(function* () {
                const concurrent = yield* db
                  .select({ request_hash: SessionForkIntentTable.request_hash })
                  .from(SessionForkIntentTable)
                  .where(eq(SessionForkIntentTable.intent_id, intentID))
                  .get()
                  .pipe(Effect.orDie)
                if (!concurrent) {
                  return yield* Effect.die(new Error(`concurrent fork intent disappeared: ${intentID}`))
                }
                if (concurrent.request_hash !== requestHash) {
                  return yield* Effect.fail(
                    new ForkConflict({ intentID, reason: "fork intent was reused with different input" }),
                  )
                }
              }),
          ),
        )

      const delivered = yield* deliverForkEvents(intentID)
      const committedIntent = yield* db
        .select()
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.intent_id, intentID))
        .get()
        .pipe(Effect.orDie)
      if (!committedIntent) return yield* Effect.die(new Error(`fork intent disappeared: ${intentID}`))
      yield* completeForkSideEffects(committedIntent)
      return delivered
    })

    const fork: Interface["fork"] = (input) => {
      return forkLocks.withLock(input.intentID)(forkUnlocked(input))
    }

    const recoverForks: Interface["recoverForks"] = Effect.fn("Session.recoverForks")(function* () {
      const now = Date.now()
      const ctx = yield* InstanceState.context
      const legacyAdmissions = yield* db
        .select({ target_session_id: SessionForkAdmissionTable.target_session_id })
        .from(SessionForkAdmissionTable)
        .innerJoin(SessionTable, eq(SessionTable.id, SessionForkAdmissionTable.source_session_id))
        .where(
          and(
            eq(SessionTable.project_id, ctx.project.id),
            like(SessionForkAdmissionTable.intent_id, `${LEGACY_FOREGROUND_FORK_MIGRATION_PREFIX}%`),
            eq(SessionForkAdmissionTable.state, "ready"),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        legacyAdmissions,
        ({ target_session_id }) =>
          migrateLegacyForegroundFork(SessionID.make(target_session_id)).pipe(Effect.catchCause(() => Effect.void)),
        { discard: true },
      )
      const recoverableAdmissions = yield* db
        .select({ admission: SessionForkAdmissionTable })
        .from(SessionForkAdmissionTable)
        .innerJoin(SessionTable, eq(SessionTable.id, SessionForkAdmissionTable.source_session_id))
        .where(
          and(
            eq(SessionTable.project_id, ctx.project.id),
            inArray(SessionForkAdmissionTable.state, ["admitted", "provisioning", "ready"] as const),
            notLike(SessionForkAdmissionTable.intent_id, `${LEGACY_FOREGROUND_FORK_MIGRATION_PREFIX}%`),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        recoverableAdmissions,
        ({ admission }) =>
          fork({
            sessionID: SessionID.make(admission.source_session_id),
            intentID: admission.intent_id,
            messageID: admission.source_cutoff_message_id
              ? MessageID.make(admission.source_cutoff_message_id)
              : undefined,
            directory: admission.requested_directory ?? undefined,
            isolate: admission.isolation_mode === "worktree" ? "worktree" : undefined,
            forkMode: admission.fork_mode,
            targetSessionID: admission.requested_target_session_id
              ? SessionID.make(admission.requested_target_session_id)
              : undefined,
            childDepth: admission.child_depth ?? undefined,
            taskRequestHash: admission.task_request_hash ?? undefined,
          }).pipe(Effect.catchCause(() => Effect.void)),
        { discard: true },
      )
      const brokenAdmissions = yield* db
        .select({ intent_id: SessionForkAdmissionTable.intent_id })
        .from(SessionForkAdmissionTable)
        .leftJoin(SessionForkIntentTable, eq(SessionForkIntentTable.intent_id, SessionForkAdmissionTable.intent_id))
        .where(and(eq(SessionForkAdmissionTable.state, "manifest_committed"), isNull(SessionForkIntentTable.intent_id)))
        .all()
        .pipe(Effect.orDie)
      if (brokenAdmissions.length > 0)
        yield* db
          .update(SessionForkAdmissionTable)
          .set({
            state: "recovery_required",
            recovery_reason: "fork admission committed without a child manifest",
            time_updated: now,
          })
          .where(
            inArray(
              SessionForkAdmissionTable.intent_id,
              brokenAdmissions.map((row) => row.intent_id),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      yield* db
        .update(SessionForkIntentTable)
        .set({
          state: "recovery_required",
          recovery_reason: "fork preparation was committed without an atomic child manifest",
          time_updated: now,
        })
        .where(eq(SessionForkIntentTable.state, "prepared"))
        .run()
        .pipe(Effect.orDie)
      const due = (yield* db
        .select()
        .from(SessionForkIntentTable)
        .where(
          or(
            inArray(SessionForkIntentTable.state, ["committed", "publishing"] as const),
            and(eq(SessionForkIntentTable.state, "complete"), isNull(SessionForkIntentTable.side_effects_completed_at)),
          ),
        )
        .all()
        .pipe(Effect.orDie)).filter(
        (intent) =>
          intent.state === "committed" ||
          intent.state === "complete" ||
          !intent.lease_expires_at ||
          intent.lease_expires_at <= now,
      )
      yield* Effect.forEach(
        due,
        (intent) =>
          Effect.gen(function* () {
            yield* deliverForkEvents(intent.intent_id)
            yield* completeForkSideEffects(intent)
          }).pipe(Effect.catchCause(() => Effect.void)),
        { discard: true },
      )
    })

    const assertRunnable: Interface["assertRunnable"] = Effect.fn("Session.assertRunnable")(function* (sessionID) {
      const quarantinedPart = yield* db
        .select({ part_id: SessionPartIntegrityQuarantineTable.part_id })
        .from(SessionPartIntegrityQuarantineTable)
        .where(
          or(
            eq(SessionPartIntegrityQuarantineTable.part_session_id, sessionID),
            eq(SessionPartIntegrityQuarantineTable.message_session_id, sessionID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (quarantinedPart)
        return yield* new UnavailableError({
          sessionID,
          reason: `legacy cross-session Part ${quarantinedPart.part_id} requires history repair`,
        })
      const intent = yield* db
        .select({
          intent_id: SessionForkIntentTable.intent_id,
          state: SessionForkIntentTable.state,
          recovery_reason: SessionForkIntentTable.recovery_reason,
          side_effects_completed_at: SessionForkIntentTable.side_effects_completed_at,
        })
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.target_session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (intent && (intent.state !== "complete" || intent.side_effects_completed_at === null))
        return yield* new UnavailableError({
          sessionID,
          reason: intent.recovery_reason ?? `fork manifest ${intent.intent_id} is ${intent.state}`,
        })
      if (!intent) {
        const admission = yield* db
          .select({ intent_id: SessionForkAdmissionTable.intent_id, state: SessionForkAdmissionTable.state })
          .from(SessionForkAdmissionTable)
          .where(eq(SessionForkAdmissionTable.target_session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (admission && admission.intent_id.startsWith(LEGACY_FOREGROUND_FORK_MIGRATION_PREFIX)) {
          if (admission.state !== "ready")
            return yield* new UnavailableError({
              sessionID,
              reason: `legacy fork migration admission ${admission.intent_id} is ${admission.state}`,
            })
          yield* migrateLegacyForegroundFork(sessionID).pipe(
            Effect.mapError(
              (error) =>
                new UnavailableError({
                  sessionID,
                  reason: error.reason,
                }),
            ),
          )
        } else if (admission)
          return yield* new UnavailableError({
            sessionID,
            reason: `fork admission ${admission.intent_id} is ${admission.state}`,
          })
        const session = yield* db
          .select({ metadata: SessionTable.metadata })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        const deepagent =
          session?.metadata?.deepagent && typeof session.metadata.deepagent === "object"
            ? (session.metadata.deepagent as Record<string, unknown>)
            : undefined
        if (deepagent?.task_fork_manifest || session?.metadata?.task_fork_manifest)
          return yield* new UnavailableError({
            sessionID,
            reason: "legacy task fork has no verifiable sanitation manifest",
          })
        if (session?.metadata?.forkedFrom) {
          yield* migrateLegacyForegroundFork(sessionID).pipe(
            Effect.mapError(
              (error) =>
                new UnavailableError({
                  sessionID,
                  reason: error.reason,
                }),
            ),
          )
        }
      }
      const history = yield* db
        .select({
          state: SessionHistoryStateTable.state,
          reason: SessionHistoryStateTable.reason,
        })
        .from(SessionHistoryStateTable)
        .where(eq(SessionHistoryStateTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (history?.state === "recovery_required")
        return yield* new UnavailableError({
          sessionID,
          reason: history.reason ?? "session history recovery is required",
        })
      const epoch = yield* db
        .select({
          authority_state: SessionPromptEpochTable.authority_state,
          recovery_reason: SessionPromptEpochTable.recovery_reason,
        })
        .from(SessionPromptEpochTable)
        .where(and(eq(SessionPromptEpochTable.session_id, sessionID), eq(SessionPromptEpochTable.state, "active")))
        .get()
        .pipe(Effect.orDie)
      if (epoch?.authority_state !== "recovery_required") return
      return yield* new UnavailableError({
        sessionID,
        reason: epoch.recovery_reason ?? "session history recovery is required",
      })
    })

    const patch = (sessionID: SessionID, info: Patch) =>
      Effect.gen(function* () {
        const current = yield* get(sessionID)
        const next = {
          ...current,
          ...info,
          time: info.time ? { ...current.time, ...info.time } : current.time,
          share: info.share === null ? undefined : info.share ? { ...current.share, ...info.share } : current.share,
          summary: info.summary === null ? undefined : (info.summary ?? current.summary),
          revert: info.revert === null ? undefined : (info.revert ?? current.revert),
          permission: info.permission === null ? undefined : (info.permission ?? current.permission),
        } as Info
        if (next.summary?.diffs !== undefined) {
          next.summary = {
            ...next.summary,
            diffs: next.summary.diffs.slice(0, MessageV2.ClientDiffLimits.files).map((item) => ({
              ...(item.file === undefined ? {} : { file: item.file }),
              additions: item.additions,
              deletions: item.deletions,
              ...(item.status === undefined ? {} : { status: item.status }),
            })),
          }
        }
        yield* events.publish(SessionV1.Event.Updated, { sessionID, info: next })
      })

    const touch = Effect.fn("Session.touch")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setTitle = Effect.fn("Session.setTitle")(function* (input: { sessionID: SessionID; title: string }) {
      yield* patch(input.sessionID, { title: input.title }).pipe(Effect.orDie)
    })

    // Write-once: the preview snapshots the FIRST user message only. Later prompts must not overwrite
    // it, so we skip if the session already has a preview (or the incoming text is empty/whitespace).
    const setPreview = Effect.fn("Session.setPreview")(function* (input: { sessionID: SessionID; preview: string }) {
      const trimmed = input.preview.trim()
      if (!trimmed) return
      const current = yield* get(input.sessionID).pipe(Effect.orDie)
      if (current.preview) return
      yield* patch(input.sessionID, { preview: trimmed }).pipe(Effect.orDie)
    })

    const setArchived = Effect.fn("Session.setArchived")(function* (input: {
      sessionID: SessionID
      time?: number | null
    }) {
      yield* patch(input.sessionID, { time: { archived: input.time } }).pipe(Effect.orDie)
    })

    const setMetadata = Effect.fn("Session.setMetadata")(function* (input: typeof SetMetadataInput.Type) {
      yield* patch(input.sessionID, { metadata: input.metadata, time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setDirectory = Effect.fn("Session.setDirectory")(function* (input: {
      sessionID: SessionID
      directory: string
    }) {
      const current = yield* get(input.sessionID).pipe(Effect.orDie)
      if (current.directory === input.directory) return
      if (current.workspaceID)
        return yield* new PlacementChangeUnsupportedError({
          sessionID: input.sessionID,
          operation: "directory",
          message: "Workspace Session relocation requires durable transfer admission and a target receipt",
        })
      yield* events.publish(SessionEvent.Moved, {
        sessionID: input.sessionID,
        location: Location.Ref.make({
          directory: AbsolutePath.make(input.directory),
          ...(current.workspaceID ? { workspaceID: current.workspaceID } : {}),
        }),
        timestamp: yield* DateTime.now,
      })
    })

    const setPermission = Effect.fn("Session.setPermission")(function* (input: {
      sessionID: SessionID
      permission: PermissionV1.Ruleset
    }) {
      yield* patch(input.sessionID, { permission: [...input.permission], time: { updated: Date.now() } }).pipe(
        Effect.orDie,
      )
    })

    const setRevert = Effect.fn("Session.setRevert")(function* (input: {
      sessionID: SessionID
      revert: Info["revert"]
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, {
        summary: input.summary,
        time: { updated: Date.now() },
        revert: input.revert,
      }).pipe(Effect.orDie)
    })

    const mutateRevert = Effect.fn("Session.mutateRevert")(function* (input: {
      sessionID: SessionID
      revert: Info["revert"] | null
      summary?: Info["summary"]
    }) {
      const now = Date.now()
      const updated = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select({ mutationEpoch: SessionTable.mutation_epoch })
                .from(SessionTable)
                .where(eq(SessionTable.id, input.sessionID))
                .get()
                .pipe(Effect.orDie)
              if (!current) return yield* Effect.die(`Session not found: ${input.sessionID}`)
              const mutationEpoch = current.mutationEpoch + 1
              const row = yield* tx
                .update(SessionTable)
                .set({
                  mutation_epoch: mutationEpoch,
                  revert: input.revert,
                  ...(input.summary
                    ? {
                        summary_additions: input.summary.additions,
                        summary_deletions: input.summary.deletions,
                        summary_files: input.summary.files,
                        summary_diffs: input.summary.diffs,
                        summary_diff_manifest: input.summary.diffManifest,
                      }
                    : {}),
                  time_updated: now,
                })
                .where(
                  and(eq(SessionTable.id, input.sessionID), eq(SessionTable.mutation_epoch, current.mutationEpoch)),
                )
                .returning(sessionClientColumns)
                .get()
                .pipe(Effect.orDie)
              if (!row) return yield* Effect.die("Session mutation epoch changed inside an IMMEDIATE transaction")
              yield* tx
                .update(SessionIntentTable)
                .set({
                  state: "superseded",
                  owner_token: null,
                  lease_expires_at: null,
                  time_updated: now,
                  version: sql`${SessionIntentTable.version} + 1`,
                })
                .where(
                  and(
                    eq(SessionIntentTable.session_id, input.sessionID),
                    inArray(SessionIntentTable.state, ["preparing", "admitting", "failed"]),
                    sql`${SessionIntentTable.mutation_epoch} < ${mutationEpoch}`,
                  ),
                )
                .run()
                .pipe(Effect.orDie)
              yield* tx
                .update(SessionSteerTable)
                .set({ superseded_at: now })
                .where(
                  and(
                    eq(SessionSteerTable.session_id, input.sessionID),
                    isNull(SessionSteerTable.consumed_seq),
                    isNull(SessionSteerTable.superseded_at),
                    sql`${SessionSteerTable.mutation_epoch} < ${mutationEpoch}`,
                  ),
                )
                .run()
                .pipe(Effect.orDie)
              return row
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      yield* events.publish(SessionV1.Event.Updated, { sessionID: input.sessionID, info: fromRow(updated) })
    })

    const commitRevert = Effect.fn("Session.commitRevert")(function* (input: {
      sessionID: SessionID
      revert: Info["revert"]
      summary: Info["summary"]
    }) {
      yield* mutateRevert(input)
    })

    const commitUnrevert = Effect.fn("Session.commitUnrevert")(function* (sessionID: SessionID) {
      yield* mutateRevert({ sessionID, revert: null })
    })

    const clearRevert = Effect.fn("Session.clearRevert")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() }, revert: null }).pipe(Effect.orDie)
    })

    const setSummary = Effect.fn("Session.setSummary")(function* (input: {
      sessionID: SessionID
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { time: { updated: Date.now() }, summary: input.summary }).pipe(Effect.orDie)
    })

    const setShare = Effect.fn("Session.setShare")(function* (input: { sessionID: SessionID; share: Info["share"] }) {
      yield* patch(input.sessionID, { share: input.share ?? null, time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setWorkspace = Effect.fn("Session.setWorkspace")(function* (input: {
      sessionID: SessionID
      workspaceID: Info["workspaceID"]
    }) {
      const current = yield* get(input.sessionID).pipe(Effect.orDie)
      if (current.workspaceID === input.workspaceID) return
      return yield* new PlacementChangeUnsupportedError({
        sessionID: input.sessionID,
        operation: "workspace",
        message: "Session workspace changes require durable transfer admission and a target receipt",
      })
    })

    const diff = Effect.fn("Session.diff")(function* (sessionID: SessionID) {
      void sessionID
      return [] as Snapshot.FileDiff[]
    })

    const messagesPage: Interface["messagesPage"] = (input) =>
      MessageV2.clientPage(input).pipe(Effect.provideService(Database.Service, database))

    const messagesForwardPage: Interface["messagesForwardPage"] = (input) =>
      MessageV2.forwardPage(input).pipe(Effect.provideService(Database.Service, database))

    const snapshotRangeFromMessage: Interface["snapshotRangeFromMessage"] = Effect.fn(
      "Session.snapshotRangeFromMessage",
    )(function* (input) {
      const target = yield* db
        .select({ id: MessageTable.id, time: MessageTable.time_created })
        .from(MessageTable)
        .where(and(eq(MessageTable.session_id, input.sessionID), eq(MessageTable.id, input.messageID)))
        .get()
        .pipe(Effect.orDie)
      if (!target) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
      const atOrAfter = or(
        gt(MessageTable.time_created, target.time),
        and(eq(MessageTable.time_created, target.time), gte(MessageTable.id, target.id)),
      )
      const start = yield* db
        .select({ snapshot: sql<string | null>`json_extract(${PartTable.data}, '$.snapshot')` })
        .from(PartTable)
        .innerJoin(
          MessageTable,
          and(eq(MessageTable.id, PartTable.message_id), eq(MessageTable.session_id, PartTable.session_id)),
        )
        .where(
          and(
            eq(MessageTable.session_id, input.sessionID),
            atOrAfter,
            eq(sql<string>`json_extract(${PartTable.data}, '$.type')`, "step-start"),
          ),
        )
        .orderBy(asc(MessageTable.time_created), asc(MessageTable.id), asc(PartTable.id))
        .get()
        .pipe(Effect.orDie)
      const finish = yield* db
        .select({ snapshot: sql<string | null>`json_extract(${PartTable.data}, '$.snapshot')` })
        .from(PartTable)
        .innerJoin(
          MessageTable,
          and(eq(MessageTable.id, PartTable.message_id), eq(MessageTable.session_id, PartTable.session_id)),
        )
        .where(
          and(
            eq(MessageTable.session_id, input.sessionID),
            atOrAfter,
            eq(sql<string>`json_extract(${PartTable.data}, '$.type')`, "step-finish"),
          ),
        )
        .orderBy(desc(MessageTable.time_created), desc(MessageTable.id), desc(PartTable.id))
        .get()
        .pipe(Effect.orDie)
      return {
        ...(start?.snapshot ? { from: start.snapshot } : {}),
        ...(finish?.snapshot ? { to: finish.snapshot } : {}),
      }
    })

    const messages: Interface["messages"] = Effect.fn("Session.messages")(function* (input) {
      if (input.limit) {
        return (yield* messagesPage({ sessionID: input.sessionID, limit: input.limit })).items
      }

      const size = 50
      const result = [] as SessionV1.WithParts[]
      let before: string | undefined
      while (true) {
        const page = yield* messagesPage({ sessionID: input.sessionID, limit: size, before })
        if (page.items.length === 0) break
        for (let i = page.items.length - 1; i >= 0; i--) {
          const item = page.items[i]
          if (item) result.push(item)
        }
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
      return result.reverse()
    })

    const removeMessage = Effect.fn("Session.removeMessage")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* requireMessageOwnership(input).pipe(Effect.orDie)
      yield* events.publish(SessionV1.Event.MessageRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    })

    const removePart = Effect.fn("Session.removePart")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
    }) {
      yield* requirePartOwnership(input).pipe(Effect.orDie)
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    })

    const updatePartDelta = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
      field: string
      delta: string
    }) {
      yield* requirePartOwnership(input).pipe(Effect.orDie)
      yield* events.publish(MessageV2.Event.PartDelta, input)
    })

    /** Finds the first message matching the predicate, searching newest-first. */
    const findMessage: Interface["findMessage"] = Effect.fn("Session.findMessage")(function* (sessionID, predicate) {
      const size = 50
      let before: string | undefined
      while (true) {
        const page = yield* MessageV2.clientPage({ sessionID, limit: size, before }).pipe(
          Effect.provideService(Database.Service, database),
        )
        if (page.items.length === 0) break
        for (let i = page.items.length - 1; i >= 0; i--) {
          const item = page.items[i]
          if (item && predicate(item)) return Option.some(item)
        }
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
      return Option.none<SessionV1.WithParts>()
    })

    return Service.of({
      list,
      listGlobal,
      create,
      fork,
      recoverForks,
      assertRunnable,
      touch,
      get,
      getMessage,
      getClientMessage,
      turnSnapshotRange,
      mutationEpoch,
      setTitle,
      setPreview,
      setArchived,
      setMetadata,
      setPermission,
      setRevert,
      commitRevert,
      commitUnrevert,
      clearRevert,
      setSummary,
      setShare,
      setWorkspace,
      setDirectory,
      diff,
      messages,
      messagesPage,
      messagesForwardPage,
      snapshotRangeFromMessage,
      children,
      remove,
      updateMessage,
      publishMessageProjection,
      removeMessage,
      removePart,
      updatePart,
      getPart,
      updatePartDelta,
      findMessage,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

const cancelBackgroundJobs = Effect.fn("Session.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  yield* Effect.forEach(
    jobs.filter((job) => {
      if (job.status !== "running") return false
      if (job.id === sessionID) return true
      if (job.metadata?.sessionId === sessionID) return true
      return job.metadata?.parentSessionId === sessionID
    }),
    (job) => background.cancel(job.id),
    { concurrency: "unbounded", discard: true },
  )
})

function listByProject(
  db: Database.Interface["db"],
  input: ListInput & {
    projectID: ProjectV2.ID
    experimentalWorkspaces: boolean
  },
) {
  const conditions = [eq(SessionTable.project_id, input.projectID)]

  if (input.workspaceID) {
    conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
  }
  if (input.path !== undefined) {
    if (input.path) {
      const conds = [
        eq(SessionTable.path, input.path),
        like(SessionTable.path, sql.param(`${input.path}/%`, SessionTable.path)),
      ]

      conditions.push(
        input.directory
          ? or(...conds, and(isNull(SessionTable.path), eq(SessionTable.directory, input.directory))!)!
          : or(...conds)!,
      )
    }
  } else if (input.scope !== "project") {
    if (input.directory) {
      conditions.push(eq(SessionTable.directory, input.directory))
    }
  }
  if (input.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }

  const limit = input.limit ?? 100

  return db
    .select(sessionClientColumns)
    .from(SessionTable)
    .where(and(...conditions))
    .orderBy(desc(SessionTable.time_updated))
    .limit(limit)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(fromRow)),
    )
}

export function* listGlobal(input?: {
  directory?: string
  roots?: boolean
  start?: number
  cursor?: number
  search?: string
  limit?: number
  archived?: boolean
}) {
  const conditions: SQL[] = []

  if (input?.directory) {
    conditions.push(eq(SessionTable.directory, input.directory))
  }
  if (input?.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input?.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input?.cursor) {
    conditions.push(lt(SessionTable.time_updated, input.cursor))
  }
  if (input?.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }
  if (input?.archived) {
    conditions.push(isNotNull(SessionTable.time_archived))
  } else {
    conditions.push(isNull(SessionTable.time_archived))
  }

  const limit = input?.limit ?? 100

  const rows = runtime.runSync(({ db }) => {
    const query =
      conditions.length > 0
        ? db
            .select(sessionClientColumns)
            .from(SessionTable)
            .where(and(...conditions))
        : db.select(sessionClientColumns).from(SessionTable)
    return query.orderBy(desc(SessionTable.time_updated), desc(SessionTable.id)).limit(limit).all().pipe(Effect.orDie)
  })

  const ids = [...new Set(rows.map((row) => row.project_id))]
  const projects = new Map<string, ProjectInfo>()

  if (ids.length > 0) {
    const items = runtime.runSync(({ db }) =>
      db
        .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
        .from(ProjectTable)
        .where(inArray(ProjectTable.id, ids))
        .all()
        .pipe(Effect.orDie),
    )
    for (const item of items) {
      projects.set(item.id, {
        id: item.id,
        name: item.name ?? undefined,
        worktree: item.worktree,
      })
    }
  }

  for (const row of rows) {
    const project = projects.get(row.project_id) ?? null
    yield { ...fromRow(row), project }
  }
}

export * as Session from "./session"
