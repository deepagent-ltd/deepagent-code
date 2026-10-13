import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Result, Scope } from "effect"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { WorkAuthorityPolicy } from "@deepagent-code/core/session/work-authority-policy"
import { EventInvestigationFixture } from "../../../core/test/fixture/event-investigation"
import { EventInvestigationSource } from "../../src/installation/event-investigation-source"
import { testEffect } from "../lib/effect"

const it = testEffect(SessionExecution.noopLayer)

it.live("the private investigation holder requires the exact captured root service and expires with its owner", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const holder = yield* EventInvestigationSource.make.pipe(Effect.provideService(Scope.Scope, scope))
    const missing = yield* holder.requireExecution.pipe(Effect.result)
    expect(Result.isFailure(missing)).toBe(true)
    const execution = yield* SessionExecution.Service
    yield* holder.captureExecution(execution)
    yield* holder.captureExecution(execution)
    expect(yield* holder.requireExecution).toBe(execution)
    expect(Result.isFailure(yield* holder.captureExecution({ ...execution }).pipe(Effect.result))).toBe(true)
    expect(yield* holder.requireExecution).toBe(execution)
    yield* Scope.close(scope, Exit.void)
    expect(Result.isFailure(yield* holder.requireExecution.pipe(Effect.result))).toBe(true)
    expect(Result.isFailure(yield* holder.captureExecution(execution).pipe(Effect.result))).toBe(true)
    expect(Result.isFailure(yield* holder.interrupt("ses_idle").pipe(Effect.result))).toBe(true)
    expect((yield* execution.active).size).toBe(0)
  }),
)

it.live("a leaf cancellation runs in the captured root scope and scope closure joins its finalizer", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const holder = yield* EventInvestigationSource.make.pipe(Effect.provideService(Scope.Scope, scope))
    const started = yield* Deferred.make<void>()
    const blocked = yield* Deferred.make<void>()
    const calls = { sessions: [] as string[], stopped: 0 }
    const existing = yield* SessionExecution.Service
    // Lifecycle probe only. The effect runs in the actual Scope implementation; this is
    // neither a runner/native authority fixture nor investigation execution acceptance.
    yield* holder.captureExecution({
      ...existing,
      interrupt: (sessionID) =>
        Effect.gen(function* () {
          calls.sessions.push(sessionID)
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(blocked)
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              calls.stopped++
            }),
          ),
        ),
    })
    yield* holder.interruptFromLeaf("ses_exact_leaf")
    yield* Deferred.await(started).pipe(Effect.timeout(3000))
    expect(calls.sessions).toEqual(["ses_exact_leaf"])
    expect(calls.stopped).toBe(0)
    yield* Scope.close(scope, Exit.void)
    expect(calls.stopped).toBe(1)
    expect(Result.isFailure(yield* holder.interruptFromLeaf("ses_late").pipe(Effect.result))).toBe(true)
    expect(calls.sessions).toEqual(["ses_exact_leaf"])
  }),
)

test("server_rule candidate data cannot borrow a project profile or manufacture host authority", () => {
  const binding = EventInvestigationFixture.binding()
  // Candidate validation grants no source authority; production delegates to the durable core receipt verifier.
  expect(EventInvestigationSource.requireBinding(binding).profile.id).toBe("event_investigate_v1")
  const project = {
    ...binding,
    profile: { id: "project_work_v1", version: 1, hash: WorkAuthorityPolicy.PROJECT_PROFILE_HASH },
  }
  expect(WorkAuthorityPolicy.validateBinding(project).ok).toBe(true)
  expect(() => EventInvestigationSource.requireBinding(project)).toThrow()
  const rejected = [
    { ...binding, authorized: true },
    { ...binding, native: { approved: true } },
    { ...binding, source: { ...binding.source, kind: "server_operator" } },
    { ...binding, schemaVersion: "work-execution.v1" },
    { ...binding, parentWorkID: "parent", rootWorkID: "parent" },
    { ...binding, profile: { ...binding.profile, hash: "f".repeat(64) } },
  ]
  rejected.forEach((input) => expect(() => EventInvestigationSource.requireBinding(input)).toThrow())
})
