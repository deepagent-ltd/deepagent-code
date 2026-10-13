export * as ManagedCommandTool from "./work-command"

import { ToolFailure, toolText } from "@deepagent-code/llm"
import { Effect, Layer } from "effect"
import { PermissionV2 } from "../permission"
import { Policy } from "../policy"
import { ServerCapabilities } from "../server-capabilities"
import { WorkCommandSchema } from "../session/work-command.schema"
import { WorkFileCapability } from "../session/work-file-capability"
import { WorkToolPolicy } from "../session/work-tool-policy"
import { CanonicalJson } from "../util/canonical-json"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "managed_command"
const nativeCommands = new WeakSet<object>()
export function isNativeCommand(tool: object) { return nativeCommands.has(tool) }
export const Input = WorkCommandSchema.Input
export const Output = WorkCommandSchema.Output

export const layer = Layer.effectDiscard(Effect.gen(function* () {
  const tools = yield* Tools.Service
  const permission = yield* PermissionV2.Service
  const policy = yield* Policy.Service
  const tool = Tool.withPermission(Tool.make({
    description: "Run an explicitly approved command recipe in its private, bounded workspace. Select its logical commandID and declared parameter choices. No shell, executable, environment or working-directory override is accepted. Outputs are authenticated references for a separate approved write; command exit does not publish project files.",
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [toolText({ type: "text", text: CanonicalJson.stringify(output) })],
    execute: (input, context) => Effect.scoped(Effect.gen(function* () {
      const resource = yield* WorkToolPolicy.commandResource(context, input).pipe(Effect.orDie)
      if (!permission.authorizeAction || !permission.checkAction)
        return yield* new ToolFailure({ message: "Managed command approval is unavailable" })
      if (policy.hasStatements() &&
        (yield* policy.evaluate(ServerCapabilities.Actions.shell, resource, "allow")) === "deny")
        return yield* new ToolFailure({ message: "Command execution is disabled by the server administrator." })
      const request = { action: "bash", resources: [resource], save: [resource], sessionID: context.sessionID,
        agent: context.agent, source: { type: "tool" as const, messageID: context.assistantMessageID, callID: context.toolCallID } }
      const permit = yield* permission.authorizeAction(request)
      return yield* WorkToolPolicy.command(context, input, permission.checkAction(permit, request).pipe(
        Effect.mapError(() => new WorkFileCapability.Error({ code: "WORK_FILE_CHANGED", message: "Managed command approval changed" })),
      )).pipe(Effect.orDie)
    })).pipe(Effect.mapError((error) => error instanceof ToolFailure ? error :
      PermissionV2.permissionToolFailure(error) ?? new ToolFailure({ message: "Managed command approval is unavailable" }))),
  }), "bash")
  nativeCommands.add(tool)
  yield* tools.register({ [name]: tool }).pipe(Effect.orDie)
}))
