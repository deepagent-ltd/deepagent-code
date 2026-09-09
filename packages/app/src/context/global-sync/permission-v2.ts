import type { DeepAgentCodeClient, EventPermissionV2Asked, PermissionRequest } from "@deepagent-code/sdk/client"

// V2 asks carry the PermissionV2 vocabulary (action/resources/save); normalize to the legacy
// PermissionRequest shape the store and dock already render. Provenance is tracked separately
// (State.permission_v2) so replies can pick the right route.
export function permissionRequestFromV2(properties: EventPermissionV2Asked["properties"]): PermissionRequest {
  return {
    id: properties.id,
    sessionID: properties.sessionID,
    permission: properties.action,
    patterns: properties.resources,
    metadata: properties.metadata ?? {},
    always: properties.save ?? [],
    ...(properties.source
      ? {
          tool: {
            messageID: properties.source.messageID,
            callID: properties.source.callID,
          },
        }
      : {}),
  }
}

// V2 asks settle through the session-scoped V2 route: PermissionV2 keeps its own pending map, so
// the legacy respond route 404s on V2 request IDs. Reject feedback (`message`) is only carried by
// the V2 route — the legacy respond body has no field for it.
export function replyPermission(
  client: DeepAgentCodeClient,
  input: {
    sessionID: string
    requestID: string
    response: "once" | "always" | "reject"
    directory?: string
    message?: string
    v2?: boolean
  },
) {
  if (input.v2) {
    return client.v2.session.permission.reply({
      sessionID: input.sessionID,
      requestID: input.requestID,
      reply: input.response,
      ...(input.message ? { message: input.message } : {}),
    })
  }
  return client.permission.respond({
    sessionID: input.sessionID,
    permissionID: input.requestID,
    response: input.response,
    ...(input.directory ? { directory: input.directory } : {}),
  })
}
