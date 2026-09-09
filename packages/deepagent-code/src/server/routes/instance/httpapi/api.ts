import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { EventV2 } from "@deepagent-code/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceDisposed } from "@/server/event"
import { Question } from "@/question"
import { ConfigApi } from "./groups/config"
import { ControlApi } from "./groups/control"
import { ControlPlaneApi } from "./groups/control-plane"
import { DeepAgentApi } from "./groups/deepagent"
import { OversightApi } from "./groups/oversight"
import { WebhookApi } from "./groups/webhook"
import { EventApi } from "./groups/event"
import { ExperimentalApi } from "./groups/experimental"
import { DebugApi } from "./groups/debug"
import { FileApi } from "./groups/file"
import { ProfileApi } from "./groups/profile"
import { InstanceApi } from "./groups/instance"
import { McpApi } from "./groups/mcp"
import { PermissionApi } from "./groups/permission"
import { ProjectApi } from "./groups/project"
import { ProjectCopyApi } from "./groups/project-copy"
import { ProviderApi } from "./groups/provider"
import { PtyApi, PtyConnectApi } from "./groups/pty"
import { QuestionApi } from "./groups/question"
import { ReferenceApi } from "./groups/reference"
import { SessionApi } from "./groups/session"
import { SyncApi } from "./groups/sync"
import { TuiApi } from "./groups/tui"
import { WorkspaceApi } from "./groups/workspace"
import { WorkspaceConfigApi } from "./groups/workspace-config"
import { IMApi } from "./groups/im"
import { IMWebSocketApi } from "./groups/im-websocket"
import { Api } from "@deepagent-code/server/api"
// GlobalEventSchema snapshots the registry after event-producing groups register their variants.
import { GlobalApi } from "./groups/global"
import { MaintenanceApi } from "./groups/maintenance"
import { CapabilityApi } from "./groups/capability"
import { ContextApi } from "./groups/context"
import { SystemContextApi } from "./groups/system-context"
import { Authorization } from "./middleware/authorization"
import { SchemaErrorMiddleware } from "./middleware/schema-error"

// The client-facing event stream is delivered through the EventV2Bridge egress adapter, which
// rewrites native higher-version facts to their V1 compatibility wire shape for the adapted
// types (see compatibilityEgressTypes). Declare that wire shape for those types — every other
// type is delivered raw at its published version and stays at the registry's latest version.
const EventSchema = Schema.Union([
  ...EventV2.registry
    .values()
    .map((definition) => {
      const wire = EventV2Bridge.compatibilityEgressDefinition(definition.type) ?? definition
      return Schema.Struct({
        id: EventV2.ID,
        type: Schema.Literal(wire.type),
        properties: wire.data,
      }).annotate({ identifier: `Event.${wire.type}` })
    })
    .toArray(),
  InstanceDisposed,
]).annotate({ identifier: "Event" })

export const RootHttpApi = HttpApi.make("deepagent-code-root")
  .addHttpApi(ControlApi)
  .addHttpApi(ControlPlaneApi)
  .addHttpApi(GlobalApi)
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)

export const InstanceHttpApi = HttpApi.make("deepagent-code-instance")
  .addHttpApi(ConfigApi)
  .addHttpApi(DebugApi)
  .addHttpApi(ProfileApi)
  .addHttpApi(DeepAgentApi)
  .addHttpApi(OversightApi)
  .addHttpApi(WebhookApi)
  .addHttpApi(ExperimentalApi)
  .addHttpApi(FileApi)
  .addHttpApi(IMApi)
  .addHttpApi(InstanceApi)
  .addHttpApi(CapabilityApi)
  .addHttpApi(ContextApi)
  .addHttpApi(SystemContextApi)
  .addHttpApi(McpApi)
  .addHttpApi(ProjectApi)
  .addHttpApi(ProjectCopyApi)
  .addHttpApi(PtyApi)
  .addHttpApi(QuestionApi)
  .addHttpApi(PermissionApi)
  .addHttpApi(ProviderApi)
  .addHttpApi(ReferenceApi)
  .addHttpApi(SessionApi)
  .addHttpApi(SyncApi)
  .addHttpApi(TuiApi)
  .addHttpApi(WorkspaceApi)
  .addHttpApi(WorkspaceConfigApi)
  .middleware(SchemaErrorMiddleware)

export const DeepAgentCodeHttpApi = HttpApi.make("deepagent-code")
  .addHttpApi(RootHttpApi)
  .addHttpApi(EventApi)
  .addHttpApi(MaintenanceApi)
  .addHttpApi(InstanceHttpApi)
  .addHttpApi(IMWebSocketApi)
  .addHttpApi(Api)
  .addHttpApi(PtyConnectApi)
  .annotate(HttpApi.AdditionalSchemas, [EventSchema, Question.Replied, Question.Rejected])

export type RootHttpApiType = typeof RootHttpApi
export type InstanceHttpApiType = typeof InstanceHttpApi
