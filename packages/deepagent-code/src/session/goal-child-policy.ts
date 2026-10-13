export * as GoalChildPolicyHost from "./goal-child-policy"

import { Effect, Option } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Database } from "@deepagent-code/core/database/database"
import { GoalChild } from "@deepagent-code/core/deepagent/goal-child"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { GoalChildPolicy } from "@deepagent-code/core/deepagent/goal-child-policy"
import { GoalChildSchema } from "@deepagent-code/core/deepagent/goal-child.schema"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalTickCheckpoint } from "@deepagent-code/core/deepagent/goal-tick-checkpoint"
import { GoalTickCheckpointV2 } from "@deepagent-code/core/deepagent/goal-tick-checkpoint-v2"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { PluginBoot } from "@deepagent-code/core/plugin/boot"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"

/** C1 native adapter only. No production Goal caller is switched by installing this module. */
export const prepare = (input: Parameters<typeof GoalChildPolicy.prepare>[2]) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const checkpoint =
      input.version === 3
        ? yield* GoalTickCheckpointV2.read(db, input.permitID)
        : yield* GoalTickCheckpoint.read(db, input.permitID)
    if (!checkpoint)
      return yield* new GoalChildSchema.Error({
        code: "GOAL_CHILD_UNAVAILABLE",
        message: "Goal checkpoint has not been accepted",
      })
    const parent = yield* GoalControl.session(db, checkpoint.journal.parent.sessionID)
    const locations = yield* Effect.serviceOption(LocationServiceMap)
    if (Option.isNone(locations))
      return yield* new GoalChildSchema.Error({
        code: "GOAL_CHILD_UNAVAILABLE",
        message: "Actual V2 Location roster is unavailable",
      })
    return yield* Effect.gen(function* () {
      const boot = yield* PluginBoot.Service
      yield* boot.wait()
      return yield* GoalChildPolicy.prepare(db, yield* AgentV2.Service, input)
    }).pipe(
      Effect.provide(
        locations.value.get({
          directory: AbsolutePath.make(parent.directory),
          ...(parent.workspace_id ? { workspaceID: WorkspaceV2.ID.make(parent.workspace_id) } : {}),
        }),
      ),
    )
  })

/** Native internal preparation: fixed exact resource and the same four-rule evaluator, before wake. */
export const prepareScratch = (unitID: string, policy: GoalChildPolicy.Snapshot) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const source = yield* GoalChild.executionSource(db, unitID)
    const locations = yield* LocationServiceMap
    return yield* Effect.gen(function* () {
      const permission = yield* PermissionV2.Service
      if (!permission.prepareGoalScratch)
        return yield* new GoalChildSchema.Error({
          code: "GOAL_CHILD_UNAVAILABLE",
          message: "Native scratch preparation is unavailable",
        })
      return yield* permission.prepareGoalScratch({ unitID, policy })
    }).pipe(
      Effect.provide(
        locations.get({
          directory: AbsolutePath.make(source.session.directory),
          ...(source.session.workspace_id ? { workspaceID: WorkspaceV2.ID.make(source.session.workspace_id) } : {}),
        }),
      ),
    )
  })
