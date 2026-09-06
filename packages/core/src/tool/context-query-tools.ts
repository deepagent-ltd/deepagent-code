export * as ContextQueryTools from "./context-query-tools"

import { ToolFailure } from "@deepagent-code/llm"
import { Effect, Layer, Schema } from "effect"
import { ContextFederationContract } from "../context-federation/contract"
import { ContextToolRuntime } from "../context-federation/tool-runtime"
import { RuntimeFeatures } from "../flag/runtime-features"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import CODE_INTEL_DESCRIPTION from "./code-intel.txt"
import CONTEXT_QUERY_DESCRIPTION from "./context-query.txt"

export const codeIntelName = ContextFederationContract.Tool.codeIntel.id
export const contextQueryName = ContextFederationContract.Tool.contextQuery.id

const Output = Schema.Struct({ output: Schema.String })
const toModelOutput = ({ output }: typeof Output.Type) => [{ type: "text" as const, text: output }]

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!RuntimeFeatures.enabled("context_query_tools_v2")) return
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* ContextToolRuntime.Service

    yield* tools
      .register({
        [codeIntelName]: Tool.make({
          description: CODE_INTEL_DESCRIPTION,
          input: ContextFederationContract.CodeIntelInput,
          output: Output,
          toModelOutput: ({ output }) => toModelOutput(output),
          execute: (request, context) =>
            permission
              .assert({
                action: codeIntelName,
                resources: [request.intent],
                save: [request.intent],
                metadata: { intent: request.intent },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${codeIntelName}` })),
                Effect.andThen(runtime.codeIntel({ request, sessionID: context.sessionID, agent: context.agent })),
                Effect.map((output) => ({ output })),
              ),
        }),
        [contextQueryName]: Tool.make({
          description: CONTEXT_QUERY_DESCRIPTION,
          input: ContextFederationContract.ContextQueryInput,
          output: Output,
          toModelOutput: ({ output }) => toModelOutput(output),
          execute: (request, context) =>
            permission
              .assert({
                action: contextQueryName,
                resources: [request.intent],
                save: [request.intent],
                metadata: { intent: request.intent },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${contextQueryName}` })),
                Effect.andThen(runtime.contextQuery({ request, sessionID: context.sessionID, agent: context.agent })),
                Effect.map((output) => ({ output })),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
