import { Effect } from "effect"
import type { AgentV2 } from "../../agent"
import { PermissionV2 } from "../../permission"
import { CapabilityCatalog } from "../../system-context/capability-catalog"
import { DeepAgentCodeToolInventory } from "../../system-context/capability-manifest"
import { SystemContext } from "../../system-context/index"
import type { SystemContextRegistry } from "../../system-context/registry"
import type { SkillGuidance } from "../../skill/guidance"
import type { ToolRegistry } from "../../tool/registry"
import type { SessionSchema } from "../schema"
import { PlanningPermissions } from "../planning-permissions"

/** Shared observation only: materialize registered definitions, never execute a tool or admit an epoch. */
export const loadPromptContext = (
  services: {
    tools: ToolRegistry.Interface
    systemContext: SystemContextRegistry.Interface
    skillGuidance: SkillGuidance.Interface
  },
  agent: AgentV2.Selection,
  session: SessionSchema.Info,
  modelSupportsTools: boolean | undefined,
) =>
  Effect.gen(function* () {
    const rulesets = [agent.info?.permissions ?? [], session.permissions, PlanningPermissions.forAgent(agent.id)]
    const availableToolNames = new Set(
      modelSupportsTools === false
        ? []
        : (yield* services.tools.materialize({
            rulesets,
            allowedToolIDs: agent.id === "plan" ? PlanningPermissions.allowedTools : undefined,
          })).definitions.map((definition) => definition.name),
    )
    return yield* Effect.all([services.systemContext.load(), services.skillGuidance.load(agent)], {
      concurrency: 2,
    }).pipe(
      Effect.map(SystemContext.combine),
      Effect.provideService(CapabilityCatalog.CurrentAvailableToolNames, availableToolNames),
      Effect.provideService(
        CapabilityCatalog.CurrentGrantedPermissions,
        new Set(
          modelSupportsTools === false
            ? []
            : [...DeepAgentCodeToolInventory.permissionActions].filter(
                (permission) => !PermissionV2.isActionWhollyDenied(permission, ...rulesets),
              ),
        ),
      ),
    )
  })
