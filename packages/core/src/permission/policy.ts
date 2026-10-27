export * as PermissionPolicy from "./policy"

import type { PermissionSchema } from "./schema"
import { Wildcard } from "../util/wildcard"

// Shared policy evaluation must not load the permission runtime or SessionStore.
export function evaluate(
  action: string,
  resource: string,
  ...rulesets: PermissionSchema.Ruleset[]
): PermissionSchema.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}
