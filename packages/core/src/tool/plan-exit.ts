export * as PlanExitTool from "./plan-exit"

import { ToolFailure, toolText } from "@deepagent-code/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { DeepAgentPlanStore } from "../deepagent/plan-store"
import { DocumentStore } from "../deepagent/document-store"
import { ModelV2 } from "../model"
import { Database } from "../database/database"
import { Hash } from "../util/hash"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { SessionInput } from "../session/input"
import { Delegation } from "./delegation"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "plan_exit"
export const Input = Schema.Struct({})
export const Output = Schema.Struct({
  queued: Schema.Boolean,
  planID: Schema.String,
  version: Schema.Number,
  hash: Schema.String,
  messageID: Schema.optional(Schema.String),
})

const Record = Schema.Struct({
  sessionID: Schema.String,
  callID: Schema.String,
  documentID: Schema.String,
  planID: Schema.String,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  body: Schema.String,
  hash: Schema.String,
  model: Schema.optional(ModelV2.Ref),
})

export const capture = (context: Tool.Context, model?: ModelV2.Ref) =>
  Effect.try({
    try: () => {
      const id = DocumentStore.logicalID(
        "decision",
        null,
        `plan-approval-${Hash.sha256(JSON.stringify([context.sessionID, context.toolCallID])).slice(0, 32)}`,
      )
      const documents = DocumentStore.openExactForCreate(DeepAgentPlanStore.planStoreRoot(context.sessionID), [id])
      const stored = documents.get(id)
      if (stored) {
        const record = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Record))(stored.body))
        const plan = record ? DeepAgentPlanStore.decodePlanDoc(record.body) : null
        if (
          !record ||
          !plan ||
          plan.session_id !== context.sessionID ||
          plan.plan_id !== record.planID ||
          record.sessionID !== context.sessionID ||
          record.callID !== context.toolCallID ||
          Buffer.byteLength(record.body) > 131072 ||
          record.hash !== Hash.sha256(record.body) ||
          stored.version !== 1 ||
          stored.scope !== DeepAgentPlanStore.planScope(context.sessionID)
        )
          throw new Error("The original plan approval snapshot is unavailable or conflicting")
        return Object.freeze(record)
      }
      const snapshot = DeepAgentPlanStore.approvalSnapshot(context.sessionID)
      if (!snapshot) throw new Error("Create a valid plan before requesting execution approval")
      const record = {
        ...snapshot,
        sessionID: context.sessionID,
        callID: context.toolCallID,
        ...(model ? { model } : {}),
      }
      documents.projectExact(
        {
          id,
          type: "decision",
          scope: DeepAgentPlanStore.planScope(context.sessionID),
          status: "draft",
          version: 1,
          superseded_by: null,
          created_round: null,
          domain: null,
          tags: [],
          description: "Immutable displayed plan approval snapshot",
          provenance: { source: "runner", run_ref: DeepAgentPlanStore.planScope(context.sessionID) },
          links: [],
          body: JSON.stringify(record),
        },
        null,
      )
      return Object.freeze(record)
    },
    catch: (error) =>
      new ToolFailure({ message: error instanceof Error ? error.message : "Plan approval capture is unavailable" }),
  })

export const approve = Effect.fn("PlanExit.approve")(function* (context: Tool.Context) {
  const permission = yield* PermissionV2.Service
  yield* permission
    .assert({
      sessionID: context.sessionID,
      agent: context.agent,
      action: name,
      resources: ["*"],
      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
    })
    .pipe(
      Effect.mapError(
        (error) =>
          PermissionV2.permissionToolFailure(error) ?? new ToolFailure({ message: "Plan approval is not permitted" }),
      ),
    )
  const slot = yield* Effect.serviceOption(Delegation.DelegationSlot)
  const sessions = Option.isSome(slot) ? slot.value.service : undefined
  if (!sessions) return yield* new ToolFailure({ message: "Plan execution admission is unavailable in this runtime" })
  const session = yield* sessions
    .get(context.sessionID)
    .pipe(Effect.mapError(() => new ToolFailure({ message: "The original Session is unavailable" })))
  const assistant = yield* sessions.message({ sessionID: context.sessionID, messageID: context.assistantMessageID })
  const snapshot = yield* capture(context, assistant?.type === "assistant" ? assistant.model : session.model)
  const messageID = SessionMessage.ID.make(
    `msg_${Hash.sha256(JSON.stringify([context.sessionID, context.toolCallID, snapshot.hash])).slice(0, 40)}`,
  )
  const prompt = new Prompt({
    agent: "auto",
    ...(snapshot.model
      ? { model: { providerID: snapshot.model.providerID, id: snapshot.model.id, variant: snapshot.model.variant } }
      : {}),
    text: `The user approved the exact plan below for execution under the existing permissions. This approved snapshot is the execution request; later drafts are observations, not substitutes for the approved scope.\nPlan: ${snapshot.planID}; version: ${snapshot.version}; SHA256: ${snapshot.hash}\n\n${snapshot.body}`,
    metadata: {
      dac_plan_approval: {
        documentID: snapshot.documentID,
        planID: snapshot.planID,
        version: snapshot.version,
        hash: snapshot.hash,
      },
    },
  })
  const database = yield* Database.Service
  const prior = yield* SessionInput.find(database.db, messageID)
  if (prior) {
    if (!SessionInput.equivalent(prior, { sessionID: context.sessionID, prompt, delivery: "queue" }))
      return yield* new ToolFailure({ message: "The approved plan input conflicts with an existing durable request" })
    return { queued: true, planID: snapshot.planID, version: snapshot.version, hash: snapshot.hash, messageID }
  }
  const question = yield* QuestionV2.Service
  const answers = yield* question
    .ask({
      sessionID: context.sessionID,
      tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
      questions: [
        {
          header: "Execute plan",
          question: `Approve plan ${snapshot.planID}, version ${snapshot.version} (${snapshot.hash})? Approval queues this exact version in the same Session. Later drafts will not replace it.\n\n${snapshot.body}`,
          custom: false,
          options: [
            {
              label: "Execute this version",
              description: "Queue this approved plan for ordinary DAC execution under your existing tool permissions.",
            },
            { label: "Keep designing", description: "Continue planning without admitting execution." },
          ],
        },
      ],
    })
    .pipe(Effect.mapError(() => new ToolFailure({ message: "Plan approval was dismissed; no execution was admitted" })))
  if (answers[0]?.length !== 1 || answers[0][0] !== "Execute this version")
    return { queued: false, planID: snapshot.planID, version: snapshot.version, hash: snapshot.hash }
  yield* sessions
    .prompt({
      sessionID: context.sessionID,
      id: messageID,
      delivery: "queue",
      prompt,
    })
    .pipe(
      Effect.mapError(
        (error) => new ToolFailure({ message: `Plan execution could not be admitted: ${error.message}` }),
      ),
    )
  return { queued: true, planID: snapshot.planID, version: snapshot.version, hash: snapshot.hash, messageID }
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const question = yield* QuestionV2.Service
    const database = yield* Database.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Display the current immutable plan version and ask the user to approve its queued execution. Approval keeps existing tool permissions and uses the same Session; rejection continues planning.",
          input: Input,
          output: Output,
          execute: (_input, context) =>
            approve(context).pipe(
              Effect.provideService(PermissionV2.Service, permission),
              Effect.provideService(QuestionV2.Service, question),
              Effect.provideService(Database.Service, database),
            ),
          toModelOutput: ({ output }) => [
            toolText({
              type: "text",
              text: output.queued
                ? `Approved plan version ${output.version} queued in this Session as ${output.messageID}. Wait for the current planning activity to finish; do not implement it in this turn.`
                : "Execution was not approved. Continue designing; no execution input was admitted.",
            }),
          ],
        }),
      })
      .pipe(Effect.orDie)
  }),
)
