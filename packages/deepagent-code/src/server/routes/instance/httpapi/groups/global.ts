import { Config } from "@/config/config"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { EventV2 } from "@deepagent-code/core/event"
import { ProjectV2 } from "@deepagent-code/core/project"
import { InstanceDisposed } from "@/server/event"
import "@deepagent-code/core/account"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
})

// Capabilities / version handshake for the Server Edition. A desktop client
// connecting through the gateway `/w` proxy hits `/w/global/capabilities` to
// confirm it is talking to a compatible data-plane before driving the app.
// `protocolVersion` is the IM/session wire-protocol contract version (V3.8);
// `version` is the deepagent-code build. `features` advertises optional
// subsystems the client can gate UI on.
const GlobalCapabilities = Schema.Struct({
  protocolVersion: Schema.String,
  version: Schema.String,
  features: Schema.Struct({
    im: Schema.Boolean,
    sessions: Schema.Boolean,
    pty: Schema.Boolean,
    workspaces: Schema.Boolean,
    // V3.9 §C/§D — independently-gated experimental subsystems the client gates UI on.
    expertPanel: Schema.Boolean,
    goalLoop: Schema.Boolean,
    wiki: Schema.Boolean,
    // V4.0 §H3 — the event-driven Agent-OS feature flags (all default OFF). Advertised so the client
    // can gate V4 UI (Oversight Dashboard / Approval Queue / proactive-push surface / thread + file
    // upload) exactly where the routes fail-close. Optional so older clients tolerate their absence.
    v4EventDrivenIm: Schema.optional(Schema.Boolean),
    v4AgentPushEnabled: Schema.optional(Schema.Boolean),
    v4MultiAgentRuntime: Schema.optional(Schema.Boolean),
    v4AgentAutonomyLevel2: Schema.optional(Schema.Boolean),
    v4ThreadEnabled: Schema.optional(Schema.Boolean),
    v4FileUploadEnabled: Schema.optional(Schema.Boolean),
  }),
})

const SyncEventSchemas = EventV2.registry
  .values()
  .flatMap((definition) => {
    if (!definition.sync) return []
    return [
      Schema.Struct({
        type: Schema.Literal("sync"),
        id: EventV2.ID,
        syncEvent: Schema.Struct({
          type: Schema.Literal(EventV2.versionedType(definition.type, definition.sync.version)),
          id: EventV2.ID,
          seq: Schema.Finite,
          aggregateID: Schema.String,
          data: definition.data,
        }),
      }).annotate({ identifier: `SyncEvent.${definition.type}` }),
    ]
  })
  .toArray()

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([
    ...EventV2.registry
      .values()
      .map((definition) =>
        Schema.Struct({ id: EventV2.ID, type: Schema.Literal(definition.type), properties: definition.data }),
      )
      .toArray(),
    InstanceDisposed,
    ...SyncEventSchemas,
  ]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.optional(Schema.String),
})

export const ImportRequestSchema = Schema.Struct({
  source: Schema.Literals(["codex", "claude"]),
  sourcePath: Schema.optional(Schema.String),
  scopes: Schema.optional(Schema.Array(Schema.Literals(["session", "memory", "skill"]))),
  dryRun: Schema.optional(Schema.Boolean),
  copyLiveDb: Schema.optional(Schema.Boolean),
  cwdFilter: Schema.optional(Schema.String),
}).annotate({ identifier: "ImportRequest" })

export const ProjectListItemSchema = Schema.Struct({
  id: Schema.String,
  worktree: Schema.String,
  name: Schema.optional(Schema.String),
}).annotate({ identifier: "ProjectListItem" })

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

export const GlobalPaths = {
  health: "/global/health",
  capabilities: "/global/capabilities",
  event: "/global/event",
  config: "/global/config",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
  import: "/global/import",
  projects: "/global/projects",
  projectDelete: "/global/projects/:projectID",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the DeepAgent Code server.",
        }),
      ),
      HttpApiEndpoint.get("capabilities", GlobalPaths.capabilities, {
        success: described(GlobalCapabilities, "Server capabilities and protocol version"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.capabilities",
          summary: "Get capabilities",
          description:
            "Report the data-plane protocol version, build version, and available features. Used by Server Edition clients to verify compatibility through the gateway proxy before driving the app.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the DeepAgent Code system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(ConfigV1.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global DeepAgent Code configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: ConfigV1.Info,
        success: described(ConfigV1.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global DeepAgent Code configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all DeepAgent Code instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: [HttpApiSchema.NoContent, GlobalUpgradeInput],
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade deepagent-code",
          description: "Upgrade deepagent-code to the specified version or latest if not specified.",
        }),
      ),
      HttpApiEndpoint.post("import", GlobalPaths.import, {
        success: Schema.String,
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.import",
          summary: "Import history from Codex / Claude Code",
          description:
            "Hot-import chat history, memory, and skills from a Codex or Claude Code installation. The body is an ImportRequest JSON object; progress is streamed back as server-sent events (text/event-stream), one JSON ImportProgress object per event, ending with a `done` event carrying the ImportReport.",
        }),
      ),
      HttpApiEndpoint.get("projects", GlobalPaths.projects, {
        success: Schema.Array(ProjectListItemSchema),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.projects",
          summary: "List all known projects",
          description:
            "List every project row in the database (including imported / not-yet-opened projects), so the History Projects view can surface sessions that do not belong to a currently-active project.",
        }),
      ),
      HttpApiEndpoint.delete("projectDelete", GlobalPaths.projectDelete, {
        params: { projectID: ProjectV2.ID },
        success: HttpApiSchema.NoContent,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.projectDelete",
          summary: "Delete a project",
          description:
            "Permanently delete a project row and, by database cascade, all of its sessions, messages, and parts. Any running instances rooted at the project's known directories are disposed first. Idempotent: deleting an unknown project succeeds. Does NOT touch files on disk — only the DeepAgent Code database record.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
