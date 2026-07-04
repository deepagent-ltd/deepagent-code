import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/ws/im"

export const IMWebSocketPaths = {
  group: `${root}/group/:groupId`,
} as const

// WebSocket 端点
export const IMWebSocketApi = HttpApi.make("im-websocket").add(
  HttpApiGroup.make("im-websocket")
    .add(
      HttpApiEndpoint.get("connect", IMWebSocketPaths.group, {
        params: { groupId: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(Schema.String, "WebSocket connection"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "im.websocket.connect",
          summary: "Connect to IM WebSocket",
          description: "Establish a WebSocket connection to receive real-time IM events for a group.",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
