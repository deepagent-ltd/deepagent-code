import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"

/**
 * The identity of the acting principal for IM operations.
 *
 * deepagent-code is a single-user, self-hosted server: the `Authorization`
 * middleware gates access with one shared server password (see
 * `packages/deepagent-code/src/server/auth.ts`), and there is no multi-user
 * account system. The "user" for IM purposes is therefore the single server
 * operator, represented by this stable identifier. Group membership and message
 * authorship are keyed off it.
 *
 * If a real multi-user account system is ever introduced, this is the single
 * place that must change to derive the id from the authenticated principal.
 */
export const SERVER_USER_ID = "server"

/**
 * Resolve the workspace and acting-user context for an IM request.
 *
 * The workspace is taken from the server-resolved routing context
 * (`InstanceState.workspaceID`), NOT from a client-supplied query parameter —
 * trusting the client here would let a request address a workspace it wasn't
 * routed to. The authorization middleware has already gated the request.
 *
 * When the request is routed by directory only (no explicit workspace — the
 * common case for the single-user local server, and how the frontend now calls
 * IM), there is no distinct workspace id. We fall back to the resolved working
 * directory as the workspace identity: it is stable per project and is exactly
 * the grouping key IM needs. This mirrors the session stack, which also treats a
 * routed directory as sufficient and does not require a separate workspace id.
 *
 * `directory` is the resolved instance working directory (the real filesystem
 * path), needed when an agent session must run against the project files.
 */
export function getWorkspaceContext(_query?: unknown) {
  return Effect.gen(function* () {
    const directory = yield* InstanceState.directory
    const routedWorkspaceID = yield* InstanceState.workspaceID
    const workspaceID = routedWorkspaceID ?? directory
    if (!workspaceID) return yield* Effect.die(new Error("Workspace ID or directory is required for IM requests"))
    return { workspaceID, directory, userID: SERVER_USER_ID }
  })
}
