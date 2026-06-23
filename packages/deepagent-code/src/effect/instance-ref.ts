import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@deepagent-code/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~deepagent-code/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~deepagent-code/WorkspaceRef", {
  defaultValue: () => undefined,
})
