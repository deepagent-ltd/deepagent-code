export * as GoalChildC1Fixture from "./goal-child-c1"

import { Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../../src/agent"
import { Database } from "../../src/database/database"
import { GoalChildPolicy } from "../../src/deepagent/goal-child-policy"
import { GoalTickCheckpoint } from "../../src/deepagent/goal-tick-checkpoint"
import { GoalControl } from "../../src/deepagent/goal-control"
import { PermissionSchema } from "../../src/permission/schema"
import { PermissionV2 } from "../../src/permission"
import { PermissionSaved } from "../../src/permission/saved"
import { Location } from "../../src/location"
import { AbsolutePath } from "../../src/schema"
import { SessionV2 } from "../../src/session"
import { Prompt } from "../../src/session/prompt"
import { GoalChildFixture } from "./goal-child"
import { location } from "./location"

export function isolated<A, E>(
  body: (input: {
    directory: string
    filename: string
    state: GoalChildFixture.State
  }) => Effect.Effect<A, E, GoalChildFixture.Services | AgentV2.Service>,
) {
  return GoalChildFixture.isolated((input) => body(input).pipe(Effect.provide(AgentV2.layer)))
}
export const prepare = (
  directory: string,
  options: {
    parent?: PermissionSchema.Ruleset
    parentSession?: PermissionSchema.Ruleset
    child?: PermissionSchema.Ruleset
    mode?: "plain" | "structured"
  } = {},
) =>
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.update((editor) => {
      editor.update(AgentV2.defaultID, (agent) => {
        agent.permissions = [...(options.parent ?? [{ action: "*", resource: "*", effect: "allow" }])]
      })
      editor.update(AgentV2.ID.make("worker"), (agent) => {
        agent.mode = "subagent"
        agent.permissions = [...(options.child ?? [{ action: "*", resource: "*", effect: "allow" }])]
      })
      editor.goalRole(AgentV2.ID.make("worker"), { version: "owned-goal-v2", kind: "worker", planWriteOwnGoal: true })
    })
    const source = yield* GoalChildFixture.prepare(directory)
    if (options.parentSession)
      yield* (yield* SessionV2.Service).setPermissions({
        sessionID: source.parent.id,
        permissions: options.parentSession,
      })
    const parent = yield* agents.snapshot!(source.parent.agent)
    const child = yield* agents.snapshot!("worker")
    const mode = options.mode ?? "plain"
    const role = {
      key: source.admission.roleKey,
      agent: "worker",
      kind: "worker" as const,
      ordinal: 0,
      criterion: null,
      round: null,
      lens: null,
      mode,
      promptHash: GoalControl.fingerprint(new Prompt({ text: source.admission.text })),
      policyHash: GoalChildPolicy.roleHash(parent, child)!,
    }
    const checkpoint = yield* GoalTickCheckpoint.begin((yield* Database.Service).db, {
      permitID: source.permit.permit_id,
      permitToken: source.permit.token,
      roles: [role],
      budgets: { resultSlots: mode === "plain" ? 1 : 3, effectSlots: 0, mirrors: [], nextStateBytes: 4096 },
    })
    return {
      ...source,
      checkpoint,
      role,
      admission: {
        ...source.admission,
        agent: "worker",
        mode,
        stage: mode === "plain" ? ("plain" as const) : ("research" as const),
      },
    }
  })
export function permissions<A, E, R>(directory: string, effect: Effect.Effect<A, E, R | PermissionV2.Service>) {
  return effect.pipe(
    Effect.provide(
      PermissionV2.layer.pipe(
        Layer.provide(PermissionSaved.layer),
        Layer.provide(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
      ),
    ),
  )
}
