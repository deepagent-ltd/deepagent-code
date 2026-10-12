import { Schema } from "effect"

export const LIMIT_MS = 300_000
export const REQUEST_BYTES = 32_768
export const Name = Schema.NonEmptyString.check(Schema.isMaxLength(256))
export const Ticket = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Action = Schema.Literals(["connect", "disconnect", "authenticate", "startAuth", "finishAuth", "clearAuth"])
export type Action = typeof Action.Type
export const Command = Schema.Struct({
  ticket: Ticket,
  action: Action,
  callback: Schema.optional(
    Schema.Struct({
      code: Schema.NonEmptyString.check(Schema.isMaxLength(8192)),
      oauthState: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
      iss: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(8192))),
    }),
  ),
})
export type Command = typeof Command.Type
export const Prepared = Schema.Struct({
  ticket: Ticket,
  name: Name,
  type: Schema.Literals(["local", "remote"]),
  target: Schema.String.check(Schema.isMaxLength(4096)),
  oauth: Schema.Boolean,
  manual: Schema.Boolean,
  expiresAt: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
})
export type Prepared = typeof Prepared.Type
export const Result = Schema.Struct({
  authorizationUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(16384))),
  oauthState: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
})
export type Result = typeof Result.Type

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly unknownOutcome = false,
  ) {
    super(message)
  }
}

/** Private native protocol only. This module cannot create operator authority. */
export type Transport = {
  prepare(name: string, signal?: AbortSignal): Promise<Prepared>
  send(command: Command, signal?: AbortSignal): Promise<Result>
  release(ticket: string): Promise<void>
  whenSettled(): Promise<void>
}

export function decode<A>(schema: Schema.Decoder<A>, input: unknown): A {
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input)
}

export * as McpOperatorClient from "./operator-client"
