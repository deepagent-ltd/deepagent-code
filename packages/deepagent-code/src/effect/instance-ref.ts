import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@deepagent-code/core/workspace"

export type EventRoute = InstanceContext & { readonly workspaceID?: WorkspaceV2.ID }

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~deepagent-code/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~deepagent-code/WorkspaceRef", {
  defaultValue: () => undefined,
})

// Filesystem ownership and event supervision intentionally diverge for isolated
// subagents: InstanceRef points at the child worktree while EventRouteRef points
// at the root session instance consumed by the parent UI.
export const EventRouteRef = Context.Reference<EventRoute | undefined>("~deepagent-code/EventRouteRef", {
  defaultValue: () => undefined,
})
