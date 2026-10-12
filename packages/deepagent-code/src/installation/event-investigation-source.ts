export * as EventInvestigationSource from "./event-investigation-source"

import { Effect, Scope } from "effect"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"

const unavailable = () =>
  new WorkAuthoritySchema.Error({
    code: "PROFILE_UNAVAILABLE",
    message: "Current same-root investigation source or execution is unavailable",
  })

/** This is a structural gate, never a source grant. A server_rule may only reach the
 * independently verified investigation receipt; it cannot borrow another Work profile. */
export function requireBinding(input: unknown, options: { allowLoopbackHTTP?: boolean } = {}) {
  const checked = WorkAuthorityPolicy.validateBinding(input, options)
  if (!checked.ok) throw checked.error
  const binding = checked.value
  if (
    binding.schemaVersion !== "work-execution.v2" ||
    binding.source.kind !== "server_rule" ||
    binding.profile.id !== WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.id ||
    binding.parentWorkID !== undefined ||
    binding.rootWorkID !== binding.workID
  )
    throw unavailable()
  return binding
}

/** One private holder resolves the installation/execution dependency cycle. Root captures
 * its already-built SessionExecution service; neither a Session ID nor a new runner builds it. */
export const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope
  const owner: { active: boolean; execution?: SessionExecution.Interface } = { active: true }
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      owner.active = false
      delete owner.execution
    }),
  )
  const requireExecution = Effect.gen(function* () {
    if (!owner.active || !owner.execution) return yield* unavailable()
    return owner.execution
  })
  return {
    executionCurrent: () => owner.active && owner.execution !== undefined,
    captureExecution: (execution: SessionExecution.Interface) =>
      Effect.gen(function* () {
        if (!owner.active || (owner.execution && owner.execution !== execution)) return yield* unavailable()
        owner.execution = execution
      }),
    requireExecution,
    interrupt: (sessionID: string) =>
      Effect.gen(function* () {
        const execution = yield* requireExecution
        yield* execution.interrupt(SessionSchema.ID.make(sessionID))
      }),
    // A leaf belongs to the interrupted owner's descendant chain. Joining that owner
    // here would deadlock its shutdown; Root owns this existing-service cancellation.
    interruptFromLeaf: (sessionID: string) =>
      Effect.gen(function* () {
        const execution = yield* requireExecution
        yield* execution.interrupt(SessionSchema.ID.make(sessionID)).pipe(Effect.forkIn(scope))
      }),
  }
})
