export * as EventTurnRunner from "./event-turn-runner"

import path from "node:path"
import { Duration, Effect, Exit, Option } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import type { Database } from "@deepagent-code/core/database/database"
import { Location } from "@deepagent-code/core/location"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { TaskWorkspace } from "@deepagent-code/core/session/task-workspace"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { cleanupAgentWorktree, createAgentWorktree } from "./agent-worktree"
import type { SubagentTurnInput, SubagentTurnResult, SubagentTurnRunner } from "./goal-loop-wiring"

export interface Dependencies {
  readonly sessions: SessionV2.Interface
  readonly instanceStore: InstanceStore.Interface
  /** Production event DAGs require this durable receipt store; absent only in injected runner unit tests. */
  readonly db?: Database.Interface["db"]
  readonly createWorktree?: typeof createAgentWorktree
  readonly cleanupWorktree?: typeof cleanupAgentWorktree
}

const failed = (reason: string): SubagentTurnResult => ({
  ok: false,
  reason,
  structured: undefined,
  text: "",
  tokensUsed: 0,
  cost: 0,
})

const idsFor = (input: SubagentTurnInput) => {
  if (!input.eventID || !input.taskID || input.generation === undefined || !Number.isSafeInteger(input.generation))
    return undefined
  const anchor = [input.eventID, input.taskID, input.generation]
  return {
    sessionID: SessionV2.ID.make(`ses_v4_${contentDigest(["event-turn-session", ...anchor]).slice(0, 40)}`),
    messageID: SessionMessage.ID.make(
      `msg_${contentDigest(["event-turn-prompt", ...anchor, input.prompt]).slice(0, 40)}`,
    ),
  }
}

const completedTurn = (
  messages: ReadonlyArray<SessionMessage.Message>,
  messageID: SessionMessage.ID,
  sessionID: SessionV2.ID,
): SubagentTurnResult | undefined => {
  const userIndex = messages.findIndex((message) => message.id === messageID && message.type === "user")
  if (userIndex < 0) return undefined
  const projected = messages
    .slice(userIndex + 1)
    .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
  const last = projected.at(-1)
  if (!last?.time.completed || last.finish === "tool-calls" || last.error) return undefined
  const assistants = projected.filter((message) => message.time.completed !== undefined)
  const usage = assistants.reduce(
    (total, message) => ({
      tokensUsed:
        total.tokensUsed +
        (message.tokens ? Math.max(0, message.tokens.input + message.tokens.output + message.tokens.reasoning) : 0),
      cost: total.cost + (message.cost != null && Number.isFinite(message.cost) ? message.cost : 0),
    }),
    { tokensUsed: 0, cost: 0 },
  )
  return {
    ok: true,
    structured: undefined,
    text:
      assistants
        .flatMap((message) => message.content)
        .filter((part): part is SessionMessage.AssistantText => part.type === "text")
        .at(-1)?.text ?? "",
    sessionID,
    ...usage,
  }
}

/** One event subtask is one durable V2 admission followed by an explicit Session drain join. */
export const makeEventTurnRunnerV2 =
  (deps: Dependencies): SubagentTurnRunner =>
  (input) =>
    Effect.gen(function* () {
      const ids = idsFor(input)
      if (!ids || !input.parentSessionID) return failed("runner_failed")
      const directory =
        input.directory ?? (input.workspaceID && !input.workspaceID.startsWith("wrk") ? input.workspaceID : undefined)
      if (!directory || !path.isAbsolute(directory)) return failed("isolation_unavailable")
      const workspaceID = input.workspaceID?.startsWith("wrk") ? WorkspaceV2.ID.make(input.workspaceID) : undefined
      const parentLocation = Location.Ref.make({
        directory: AbsolutePath.make(directory),
        ...(workspaceID ? { workspaceID } : {}),
      })
      const parentContext = yield* deps.instanceStore.load({ directory })
      const withParent = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(InstanceRef, parentContext), Effect.provideService(WorkspaceRef, workspaceID))
      const parentID = SessionV2.ID.make(input.parentSessionID)
      const existingParent = yield* withParent(deps.sessions.get(parentID)).pipe(Effect.option)
      const parent = Option.isSome(existingParent)
        ? existingParent.value
        : yield* withParent(
            deps.sessions.create({
              id: parentID,
              location: parentLocation,
              title: `V4 event ${input.eventID}`,
              metadata: { correlationID: input.correlationID ?? input.eventID },
            }),
          )
      const existingChild = yield* deps.sessions.get(ids.sessionID).pipe(Effect.option)
      if (Option.isSome(existingChild) && input.requiresWriteIsolation && !deps.db) return failed("runner_failed")
      const durable = input.requiresWriteIsolation && deps.db
        ? yield* TaskWorkspace.prepareEvent(deps.db, {
            eventID: input.eventID!, taskID: input.taskID!, generation: input.generation!,
            parentDirectory: directory,
            ...(input.baseRef ? { baseRef: input.baseRef } : {}),
          }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const worktree = input.requiresWriteIsolation && !deps.db
        ? yield* Effect.tryPromise({
            try: () =>
              (deps.createWorktree ?? createAgentWorktree)({
                eventDirectory: directory,
                label: input.taskID ?? "event-turn",
                ...(input.baseRef ? { baseRef: input.baseRef } : {}),
              }),
            catch: () => null,
          })
        : undefined
      if (input.requiresWriteIsolation && !durable && !worktree) return failed("isolation_unavailable")
      if (durable?.continuationRef && Option.isNone(existingChild)) return failed("runner_failed")
      if (durable && deps.db) {
        const admissible = yield* TaskWorkspace.requireEventAdmissible(deps.db, {
          eventID: input.eventID!, taskID: input.taskID!, generation: input.generation!,
        }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!admissible) return failed("isolation_unavailable")
      }
      const childDirectory = durable?.directory ?? worktree?.directory ?? directory
      const childLocation = Location.Ref.make({
        directory: AbsolutePath.make(childDirectory),
        ...(workspaceID ? { workspaceID } : {}),
      })
      const turn = Effect.gen(function* () {
        const childContext = durable || worktree ? yield* deps.instanceStore.load({ directory: childDirectory }) : parentContext
        const withChild = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(InstanceRef, childContext),
            Effect.provideService(WorkspaceRef, workspaceID),
          )
        const child = Option.isSome(existingChild)
          ? existingChild.value
          : yield* withChild(
              deps.sessions.create({
                id: ids.sessionID,
                parentID: parent.id,
                location: childLocation,
                title: `${input.agentType} (event ${input.taskID})`,
                agent: AgentV2.ID.make(input.agentType),
                // The event parent is a lineage anchor. Forward only its ceilings; an allow from an
                // unrelated parent agent must not grant a subagent permission beyond its own roster.
                permissions: parent.permissions.flatMap((rule) =>
                  rule.effect === "allow" ? [] : [{ ...rule, effect: "deny" as const }],
                ),
                metadata: {
                  correlationID: input.correlationID ?? input.eventID,
                  eventID: input.eventID,
                  taskID: input.taskID,
                  generation: input.generation,
                },
              }),
            )
        if (child.parentID !== parent.id || child.location.directory !== childLocation.directory)
          return failed("runner_failed")
        const before = yield* withChild(deps.sessions.messages({ sessionID: child.id, order: "asc" }))
        const replay = completedTurn(before, ids.messageID, child.id)
        // Admit-only input is durable before it becomes a projected user message. A crash in
        // that window must not convert an exact prompt retry into implicit provider execution.
        const prior = deps.db ? yield* SessionInput.find(deps.db, ids.messageID) : undefined
        if (!replay && (prior || before.some((message) => message.id === ids.messageID)))
          return failed("runner_failed")
        yield* withChild(
          deps.sessions.prompt({
            id: ids.messageID,
            sessionID: child.id,
            prompt: new Prompt({ text: input.prompt }),
            delivery: "queue",
            resume: false,
          }),
        )
        if (replay) return replay
        const interruptChild = deps.sessions.interrupt(child.id).pipe(Effect.ignore)
        yield* withChild(deps.sessions.resume(child.id)).pipe(Effect.onError(() => interruptChild))
        return (
          completedTurn(
            yield* withChild(deps.sessions.messages({ sessionID: child.id, order: "asc" })),
            ids.messageID,
            child.id,
          ) ?? failed("runner_failed")
        )
      })
      const timed = turn.pipe(Effect.timeoutOption(Duration.millis(input.maxTurnDurationMs ?? 30 * 60_000)))
      if (!durable && !worktree) return Option.getOrElse(yield* timed, () => failed("turn_timeout"))
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* restore(timed).pipe(Effect.exit)
          const cleanup = durable && deps.db
            ? yield* TaskWorkspace.settleEvent(deps.db, {
                eventID: input.eventID!, taskID: input.taskID!, generation: input.generation!,
              }).pipe(Effect.catchCause(() => Effect.succeed(null)))
            : yield* Effect.tryPromise({
                try: () => (deps.cleanupWorktree ?? cleanupAgentWorktree)(worktree!),
                catch: () => null,
              })
          if (!cleanup) return failed("isolation_preservation_failed")
          if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
          const result = Option.getOrElse(exit.value, () => failed("turn_timeout"))
          return result.ok
            ? { ...result, continuationRef: cleanup.continuationRef, artifacts: cleanup.artifacts }
            : result
        }),
      )
    }).pipe(Effect.catchCause(() => Effect.succeed(failed("runner_failed"))))
