export * as TaskTool from "./task"

import { ToolFailure } from "@deepagent-code/llm"
import Ajv from "ajv"
import { Option } from "effect"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { SessionSchema, SessionV2 } from "../session"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { Delegation } from "./delegation"
import { Tool } from "./tool"
import { Tools } from "./tools"
import DESCRIPTION from "./task.txt"

export const name = "task"

/**
 * Delegation slot (see tool/delegation.ts for the pattern rationale): the V2 session service
 * lives in the process root and Location-scoped settle fibers cannot see root services. The
 * execution coordinator provides the per-root holder into every drain fiber; the tool reads
 * through it.
 */
export const { DelegationSlot, delegationSlotLayer } = Delegation

/** Root-side capture: requires both the slot and the live SessionV2 service, wires them together. */
export const captureDelegationServiceLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const slot = yield* DelegationSlot
    slot.service = yield* SessionV2.Service
  }),
)

/** V1 parity (deepagent-code subagent-permissions): hard delegation depth ceiling. */
export const MAX_SUBAGENT_DEPTH = 3

const Input = Schema.Struct({
  description: Schema.String.annotate({
    description: "A short (3-5 words) description of the task. Keep it unique — the user sees it.",
  }),
  prompt: Schema.String.annotate({
    description:
      "The task for the agent to perform. For a fresh start this must be a highly detailed description of what the agent should do autonomously, including exactly what information it must return in its final message.",
  }),
  subagent_type: Schema.String.annotate({
    description: "The agent type to launch (e.g. general, explore, researcher, reviewer).",
  }),
  output_schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description:
      "Optional JSON schema the agent's final answer must satisfy. When given, the result is returned as strict JSON validated against this schema.",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "Resume a prior subagent session (it continues with its previous messages and tool outputs). Must be a task_id returned by a task launched in THIS session; omit to start a fresh subagent.",
  }),
})

const Output = Schema.Struct({
  task_id: Schema.String,
  text: Schema.String,
})
export type Output = typeof Output.Type

const toolFailure = (message: string) => new ToolFailure({ message })

/** Port of deepagent-code's task-structured-output extractor (fenced/raw JSON recovery). */
function extractStructuredText(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const objectStart = trimmed.indexOf("{")
  const objectEnd = trimmed.lastIndexOf("}")
  const arrayStart = trimmed.indexOf("[")
  const arrayEnd = trimmed.lastIndexOf("]")
  return [
    trimmed,
    fenced,
    objectStart !== -1 && objectEnd > objectStart ? trimmed.slice(objectStart, objectEnd + 1) : undefined,
    arrayStart !== -1 && arrayEnd > arrayStart ? trimmed.slice(arrayStart, arrayEnd + 1) : undefined,
  ]
    .filter((candidate): candidate is string => candidate !== undefined)
    .map((candidate) => Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(candidate)))
    .find((candidate) => candidate !== undefined)
}

/** Port of deepagent-code's Ajv validation (allErrors, $schema stripped). */
function validateStructuredOutput(schema: Record<string, unknown>, value: unknown) {
  const { $schema: _, ...document } = schema
  const validate = new Ajv({ allErrors: true, strict: false }).compile(document)
  if (validate(value)) return undefined
  return (
    validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ??
    "schema validation failed"
  )
}

/**
 * Depth by parentID chain walk (V1 resolveSessionDepth parity, fail-closed): unknown session,
 * cycles, or an over-long chain all read as MAX so the next spawn refuses.
 */
const sessionDepth = (sessions: SessionV2.Interface, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const session = yield* sessions.get(sessionID).pipe(Effect.option)
    if (Option.isNone(session)) return MAX_SUBAGENT_DEPTH
    const visited = new Set<string>([sessionID])
    let cursor = session.value.parentID
    let chainDepth = 0
    const chainLimit = MAX_SUBAGENT_DEPTH + 4
    for (let i = 0; i < chainLimit && cursor !== undefined; i++) {
      if (visited.has(cursor)) return MAX_SUBAGENT_DEPTH
      visited.add(cursor)
      const parent = yield* sessions.get(cursor).pipe(Effect.option)
      if (Option.isNone(parent)) break
      chainDepth++
      cursor = parent.value.parentID
    }
    if (cursor !== undefined) return MAX_SUBAGENT_DEPTH
    return chainDepth
  })

const lastAssistantText = (messages: readonly SessionMessage.Message[]) =>
  messages
    .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
    .flatMap((message) => message.content)
    .filter((part): part is SessionMessage.AssistantText => part.type === "text")
    .at(-1)?.text ?? ""

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const agents = yield* AgentV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description: DESCRIPTION,
            input: Input,
            output: Output,
            execute: (params, context) =>
              Effect.gen(function* () {
                // Root service access flows through the delegation slot (see DelegationSlot):
                // Location-scoped settle fibers cannot see the process-root SessionV2 service.
                const slot = Option.getOrUndefined(yield* Effect.serviceOption(DelegationSlot))
                const sessions = slot?.service
                if (!sessions)
                  return yield* toolFailure(
                    "task is unavailable: the root composition did not capture the V2 session service for delegation",
                  )
                const resolved = yield* agents.resolve(params.subagent_type)
                if (resolved === undefined)
                  return yield* toolFailure(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
                const parent = yield* sessions.get(context.sessionID).pipe(Effect.orDie)
                const callerDepth = yield* sessionDepth(sessions, context.sessionID)
                if (callerDepth >= MAX_SUBAGENT_DEPTH)
                  return yield* toolFailure(
                    `Cannot launch task: subagent depth ${callerDepth} is at the hard limit (MAX_SUBAGENT_DEPTH=${MAX_SUBAGENT_DEPTH}).`,
                  )

                // Resume contract (V1 parity): only a DIRECT child of this session with the same
                // agent type may be continued by task_id.
                if (params.task_id !== undefined) {
                  const target = yield* sessions.get(SessionSchema.ID.make(params.task_id)).pipe(Effect.option)
                  if (Option.isNone(target))
                    return yield* toolFailure(`Cannot resume task "${params.task_id}": unknown session.`)
                  if (String(target.value.parentID ?? "") !== String(context.sessionID))
                    return yield* toolFailure(
                      `Cannot resume task "${params.task_id}": it is not a direct child of the current session.`,
                    )
                  if (target.value.agent !== undefined && String(target.value.agent) !== params.subagent_type)
                    return yield* toolFailure(
                      `Cannot resume task "${params.task_id}": its agent type is "${target.value.agent}" but this call requests "${params.subagent_type}".`,
                    )
                }
                const childID =
                  params.task_id !== undefined
                    ? SessionSchema.ID.make(params.task_id)
                    : (
                        yield* sessions
                          .create({
                            parentID: context.sessionID,
                            agent: resolved.id,
                            title: `task: ${params.description}`,
                            location: parent.location,
                            permissions: resolved.permissions,
                          })
                          .pipe(Effect.orDie)
                      ).id

                const drive = (text: string) =>
                  Effect.gen(function* () {
                    // P1-1 contract: admit-only, then an EXPLICIT awaited drain. An advisory wake
                    // (resume: true) races `wait` — the forked drain may not have started when
                    // awaitIdle observes the still-idle child, silently returning an empty result.
                    yield* sessions
                      .prompt({ sessionID: childID, prompt: new Prompt({ text }), resume: false })
                      .pipe(Effect.orDie)
                    yield* sessions.resume(childID).pipe(Effect.orDie)
                    return lastAssistantText(
                      yield* sessions.messages({ sessionID: childID, order: "asc" }).pipe(Effect.orDie),
                    )
                  }).pipe(
                    // An interrupted parent turn must not leave the child draining unsupervised; an
                    // idle child interrupt is a no-op per the V2 contract.
                    Effect.onInterrupt(() => sessions.interrupt(childID).pipe(Effect.ignore)),
                  )

                const research = yield* drive(params.prompt)
                if (!params.output_schema) return { task_id: childID, text: research }

                // Structured contract (V1 finalizer parity): the schema rides the prompt text — V2
                // has no provider-side format — with one bounded correction attempt.
                const boundedRaw = research.slice(0, 24_000)
                let correction: string | undefined
                for (const attempt of [1, 2] as const) {
                  const finalizerText = [
                    attempt === 1
                      ? "Convert the persisted research result below into the requested StructuredOutput schema."
                      : "Return exactly one JSON value matching the output schema below. Do not use Markdown or explanatory prose.",
                    "Do not continue research and do not add facts that are absent from the result.",
                    ...(correction ? [`Previous validation error: ${correction}`] : []),
                    `<output_schema>${JSON.stringify(params.output_schema)}</output_schema>`,
                    "<research_result>",
                    boundedRaw,
                    "</research_result>",
                  ].join("\n")
                  const candidate = extractStructuredText(yield* drive(finalizerText))
                  if (candidate === undefined) {
                    correction = "Model did not return a JSON value."
                    continue
                  }
                  const error = validateStructuredOutput(params.output_schema, candidate)
                  if (!error) return { task_id: childID, text: JSON.stringify(candidate) }
                  correction = error.slice(0, 1_000)
                }
                return yield* toolFailure(
                  `Subagent completed but its final answer never validated against the output schema${correction ? `: ${correction}` : ""}. Task id ${childID} holds the raw turns.`,
                )
              }),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)
