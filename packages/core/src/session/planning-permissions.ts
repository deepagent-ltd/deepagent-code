import type { PermissionSchema } from "../permission/schema"

// A separate ruleset is a ceiling: config, saved permissions and Session allow rules
// may narrow these capabilities, but cannot turn a planning turn into execution.
export const allowedTools = Object.freeze(["read", "grep", "glob", "git_read", "question", "plan", "plan_exit"])

const ceiling: PermissionSchema.Ruleset = [
  { action: "*", resource: "*", effect: "deny" },
  ...allowedTools.map((action) => ({
    action,
    resource: "*",
    effect: "allow" as const,
  })),
]

export const forAgent = (agent?: string): PermissionSchema.Ruleset => (agent === "plan" ? ceiling : [])

export * as PlanningPermissions from "./planning-permissions"
