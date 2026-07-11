export * as WorkspaceConfig from "./workspace-config"

import { Context, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { WorkspaceConfigTable } from "./workspace-config-sql"
import { DeepAgentEvent } from "./deepagent-event"

// V4.0 — the per-workspace config service. Reads/writes the single JSON `config` blob per workspace and
// exposes it as a validated, defaulted `Settings`. Four V4 subsystems consume it:
//   §A3 retention sweep, §E4 quiet-hours digest gate, §E2 rate-limit ceilings, §E1 trusted-source gate.
// DESIGN: an ABSENT row (or a partial blob) resolves to lenient DEFAULTS — so turning V4 on for an
// existing workspace never changes behavior until an operator writes a config. The blob is
// schema-versioned (`v`) for forward-compat.
//
// LAYERING: `core`. Pure durable state; the runtime + HTTP layer read/write it.

// §E4 quiet-hours window (local hours + tz offset). start===end ⇒ no quiet window.
export const QuietHoursConfig = Schema.Struct({
  startHour: Schema.Int, // 0-23 local
  endHour: Schema.Int, // 0-23 local (wraps midnight if end < start)
  tzOffsetMinutes: Schema.Int, // minutes east of UTC (e.g. +480 for UTC+8, -300 for UTC-5)
})
export type QuietHoursConfig = Schema.Schema.Type<typeof QuietHoursConfig>

// §E2 per-workspace rate-limit overrides (omitted ⇒ the code defaults apply).
export const RateLimitConfig = Schema.Struct({
  eventPublishPerMinute: Schema.optional(Schema.Int),
  agentPushPerHour: Schema.optional(Schema.Int),
  agentExecConcurrent: Schema.optional(Schema.Int),
})
export type RateLimitConfig = Schema.Schema.Type<typeof RateLimitConfig>

// The full per-workspace settings. Every field OPTIONAL so a partial blob is valid; `resolve` fills
// defaults. `v` is the blob schema version.
export const Settings = Schema.Struct({
  v: Schema.optional(Schema.Int),
  // §A3 retention: days of durable events/audit to keep. Omitted ⇒ DEFAULT_RETENTION_DAYS.
  retentionDays: Schema.optional(Schema.Int),
  // §E4 quiet hours. Omitted ⇒ no quiet window (never quiet).
  quietHours: Schema.optional(QuietHoursConfig),
  // §E2 rate-limit overrides.
  rateLimits: Schema.optional(RateLimitConfig),
  // §E1 trusted event sources (security-gate layer 1). Omitted ⇒ DEFAULT_TRUSTED_SOURCES.
  trustedSources: Schema.optional(Schema.Array(DeepAgentEvent.EventSource)),
})
export type Settings = Schema.Schema.Type<typeof Settings>

// §A3 — default retention: 30 days (spec default), lenient.
export const DEFAULT_RETENTION_DAYS = 30
// §E1 — default trusted sources. Internal/first-party sources are trusted by default; external webhook
// sources (git/ci/pr) that a workspace hasn't explicitly vouched for are ALSO trusted by default here
// (lenient per the standing "don't over-restrict" constraint) — an operator tightens per deploy by
// writing an explicit trustedSources list.
export const DEFAULT_TRUSTED_SOURCES: ReadonlyArray<DeepAgentEvent.EventSource> = [
  "im",
  "git",
  "ci",
  "pr",
  "monitor",
  "schedule",
  "system",
]

// The fully-resolved (defaults-applied) view the subsystems consume.
export interface Resolved {
  readonly workspaceID: string
  readonly retentionDays: number
  readonly quietHours?: QuietHoursConfig
  readonly rateLimits: {
    readonly eventPublishPerMinute?: number
    readonly agentPushPerHour?: number
    readonly agentExecConcurrent?: number
  }
  readonly trustedSources: ReadonlyArray<DeepAgentEvent.EventSource>
}

const resolveSettings = (workspaceID: string, settings: Settings): Resolved => ({
  workspaceID,
  retentionDays:
    settings.retentionDays != null && settings.retentionDays > 0 ? settings.retentionDays : DEFAULT_RETENTION_DAYS,
  ...(settings.quietHours != null ? { quietHours: settings.quietHours } : {}),
  rateLimits: {
    ...(settings.rateLimits?.eventPublishPerMinute != null
      ? { eventPublishPerMinute: settings.rateLimits.eventPublishPerMinute }
      : {}),
    ...(settings.rateLimits?.agentPushPerHour != null ? { agentPushPerHour: settings.rateLimits.agentPushPerHour } : {}),
    ...(settings.rateLimits?.agentExecConcurrent != null
      ? { agentExecConcurrent: settings.rateLimits.agentExecConcurrent }
      : {}),
  },
  trustedSources:
    settings.trustedSources != null && settings.trustedSources.length > 0
      ? settings.trustedSources
      : DEFAULT_TRUSTED_SOURCES,
})

export interface Interface {
  /** Resolved settings (defaults applied) for a workspace. Never fails on a missing/partial row. */
  readonly get: (workspaceID: string) => Effect.Effect<Resolved>
  /** Merge a partial Settings patch into the workspace's config (upsert). Returns the resolved view. */
  readonly set: (workspaceID: string, patch: Settings) => Effect.Effect<Resolved>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/WorkspaceConfig") {}

export interface LayerOptions {
  readonly now?: () => number
}

const decodeSettings = Schema.decodeUnknownSync(Settings)

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = options?.now ?? Date.now

      const readSettings = (workspaceID: string) =>
        db
          .select({ config: WorkspaceConfigTable.config })
          .from(WorkspaceConfigTable)
          .where(eq(WorkspaceConfigTable.workspace_id, workspaceID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row): Settings => {
              if (!row) return {}
              // a corrupt/legacy blob decodes to {} (lenient defaults) rather than crashing a reader.
              try {
                return decodeSettings(row.config)
              } catch {
                return {}
              }
            }),
          )

      const get: Interface["get"] = (workspaceID) =>
        readSettings(workspaceID).pipe(Effect.map((s) => resolveSettings(workspaceID, s)))

      const set: Interface["set"] = (workspaceID, patch) =>
        Effect.gen(function* () {
          const current = yield* readSettings(workspaceID)
          // shallow-merge the patch over the current blob (nested objects replace wholesale — a caller
          // sets the full quietHours/rateLimits object, matching a settings-form save).
          const merged: Settings = {
            v: 1,
            ...current,
            ...patch,
            ...(patch.quietHours !== undefined ? { quietHours: patch.quietHours } : {}),
            ...(patch.rateLimits !== undefined ? { rateLimits: patch.rateLimits } : {}),
            ...(patch.trustedSources !== undefined ? { trustedSources: patch.trustedSources } : {}),
          }
          const at = now()
          yield* db
            .insert(WorkspaceConfigTable)
            .values([{ workspace_id: workspaceID, config: merged, created_at: at, updated_at: at }])
            .onConflictDoUpdate({
              target: WorkspaceConfigTable.workspace_id,
              set: { config: merged, updated_at: at },
            })
            .run()
            .pipe(Effect.orDie)
          return resolveSettings(workspaceID, merged)
        })

      return Service.of({ get, set })
    }),
  )

export const layer = layerWith()

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
