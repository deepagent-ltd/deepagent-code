export * as Tool from "./tool"

import { ToolDefinition, ToolFailure, ToolOutput, type ToolCall, type ToolFileSource } from "@deepagent-code/llm"
import { Effect, JsonSchema, Schema } from "effect"
import type { AgentV2 } from "../agent"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"
import type { McpAppInvocationSchema } from "../session/mcp-app-invocation.schema"

export interface Context {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
}

/** External App calls have no assistant/provider identity. Copies carry no execution witness. */
export interface AppContext {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly invocationID: string
  readonly source: McpAppInvocationSchema.Source
}
const appContexts = new WeakMap<AppContext, { readonly check: Effect.Effect<void, ToolFailure>; readonly current: () => boolean }>()
export const appContext = (input: AppContext, check: Effect.Effect<void, ToolFailure>, current: () => boolean) =>
  Effect.acquireRelease(Effect.sync(() => {
    const value = Object.freeze({ ...input, source: Object.freeze(structuredClone(input.source)) })
    appContexts.set(value, { check, current })
    return value
  }), (value) => Effect.sync(() => { appContexts.delete(value) }))
export const appContextCurrent = (value: AppContext) => appContexts.get(value)?.current() === true
export const checkAppContext = (value: AppContext) => Effect.suspend(() => {
  const saved = appContexts.get(value)
  return saved?.current() ? saved.check.pipe(Effect.andThen(() => saved.current() ? Effect.void : Effect.fail(new ToolFailure({ message: "App invocation source changed" }))))
    : Effect.fail(new ToolFailure({ message: "App invocation execution witness is unavailable" }))
})

export type SchemaType<A> = Schema.Codec<A, any, never, never>

declare const TypeId: unique symbol

export interface Definition<Input extends SchemaType<any>, Output extends SchemaType<any>> {
  readonly [TypeId]: {
    readonly _Input: Input
    readonly _Output: Output
  }
}

export type AnyTool = Definition<any, any>
export const Failure = ToolFailure
export type Failure = ToolFailure

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }
  | { readonly type: "file"; readonly source: ToolFileSource; readonly mime: string; readonly name?: string }

type Config<Input extends SchemaType<any>, Output extends SchemaType<any>> = {
  readonly description: string
  readonly input: Input
  readonly output: Output
  /** Opt-in protocol decoding for tools with distinct wire forms. Other tools retain
   * their existing schema parsing and excess-property compatibility. */
  readonly decodeInput?: (input: unknown) => Effect.Effect<Schema.Schema.Type<Input>, ToolFailure>
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: Context,
  ) => Effect.Effect<Schema.Schema.Type<Output>, ToolFailure>
  /** Retained metadata can omit bytes emitted separately as native model content. */
  readonly toStructuredOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => unknown
  readonly toModelOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => ReadonlyArray<Content>
}

type Runtime = {
  readonly permission?: string
  readonly definition: (name: string) => ToolDefinition
  readonly settle: (call: ToolCall, context: Context) => Effect.Effect<ToolOutput, ToolFailure>
}

const runtimes = new WeakMap<AnyTool, Runtime>()

export function make<Input extends SchemaType<any>, Output extends SchemaType<any>>(
  config: Config<Input, Output>,
): Definition<Input, Output> {
  const tool = Object.freeze({}) as Definition<Input, Output>
  const definitions = new Map<string, ToolDefinition>()
  runtimes.set(tool, {
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = ToolDefinition.make({
        name,
        description: config.description,
        inputSchema: toJsonSchema(config.input),
        outputSchema: toJsonSchema(config.output),
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      (config.decodeInput
        ? config.decodeInput(call.input)
        : Schema.decodeUnknownEffect(config.input)(call.input).pipe(
          Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
        )).pipe(
        Effect.flatMap((input) =>
          config.execute(input, context).pipe(
            Effect.flatMap((output) =>
              Schema.encodeEffect(config.output)(output).pipe(
                Effect.mapError(
                  (error) =>
                    new ToolFailure({
                      message: `Tool returned an invalid value for its output schema: ${error.message}`,
                    }),
                ),
              ),
            ),
            Effect.map((output) =>
              ToolOutput.make(
                config.toStructuredOutput ? config.toStructuredOutput({ input, output }) : output,
                config.toModelOutput?.({ input, output }).map((part) =>
                  part.type === "text"
                    ? { type: "text" as const, text: part.text }
                    : {
                        type: "file" as const,
                        source: "source" in part ? part.source : { type: "data" as const, data: part.data },
                        mime: part.mime,
                        name: part.name,
                      },
                ) ?? (typeof output === "string" ? [{ type: "text", text: output }] : []),
              ),
            ),
          ),
        ),
      ),
  })
  return tool
}

export const validateName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))

export interface DynamicConfig {
  readonly description: string
  /**
   * Raw JSON Schema for the model-facing input (hosts whose schemas arrive pre-built — MCP and
   * plugin bridges). The execute receives the undecoded call input: the REMOTE side owns
   * validation, so no Effect-schema decode runs here.
   */
  readonly inputJsonSchema: JsonSchema.JsonSchema | Record<string, unknown>
  readonly execute: (input: unknown, context: Context) => Effect.Effect<unknown, ToolFailure>
  /** Retained domain data, separate from media carried in model content. */
  readonly toStructuredOutput?: (input: { readonly input: unknown; readonly output: unknown }) => unknown
  readonly toModelOutput?: (input: { readonly input: unknown; readonly output: unknown }) => ReadonlyArray<Content>
}

/** Dynamic-tool variant of `make` for raw-JSON-Schema hosts; output passes through unvalidated. */
export function makeDynamic(config: DynamicConfig): Definition<any, any> {
  const tool = Object.freeze({}) as Definition<any, any>
  const definitions = new Map<string, ToolDefinition>()
  runtimes.set(tool, {
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = ToolDefinition.make({
        name,
        description: config.description,
        inputSchema: config.inputJsonSchema as JsonSchema.JsonSchema,
        outputSchema: toJsonSchema(Schema.Unknown),
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      config.execute(call.input, context).pipe(
        Effect.map((output) =>
          ToolOutput.make(
            config.toStructuredOutput ? config.toStructuredOutput({ input: call.input, output }) : output,
            config.toModelOutput?.({ input: call.input, output }).map((part) =>
              part.type === "text"
                ? { type: "text" as const, text: part.text }
                : {
                    type: "file" as const,
                    source: "source" in part ? part.source : { type: "data" as const, data: part.data },
                    mime: part.mime,
                    name: part.name,
                  },
            ) ?? (typeof output === "string" ? [{ type: "text", text: output }] : []),
          ),
        ),
      ),
  })
  return tool
}

export const withPermission = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  permission: string,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), permission })
  return decorated
}

export const permission = (tool: AnyTool, name: string) => runtimeOf(tool).permission ?? name
export const definition = (name: string, tool: AnyTool) => runtimeOf(tool).definition(name)
export const settle = (tool: AnyTool, call: ToolCall, context: Context) => runtimeOf(tool).settle(call, context)

function runtimeOf(tool: AnyTool) {
  const runtime = runtimes.get(tool)
  if (!runtime) throw new TypeError("Invalid Core Tool value")
  return runtime
}

function toJsonSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}
