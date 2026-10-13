export * as WorkCommandSchema from "./work-command.schema"

import { Schema } from "effect"

const bounded = (limit: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(limit),
  Schema.makeFilter((value: string) => Buffer.byteLength(value, "utf8") <= limit && !/[\u0000-\u001f\u007f]/.test(value)))
const Text = bounded(512)
const Argument = Schema.String.check(Schema.isMaxLength(2048),
  Schema.makeFilter((value: string) => Buffer.byteLength(value, "utf8") <= 2048 && !value.includes("\0")))
const Relative = bounded(2048).check(Schema.makeFilter((value: string) => !value.includes("\\") && !value.includes(":") &&
  value.split("/").length <= 16 && value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  ![".dac-home", ".dac-tmp"].includes(value.split("/")[0]!)))
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Decimal = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/))

export const Identity = Schema.Struct({ kind: Schema.Literal("posix"), device: Decimal, inode: Decimal })
export const Parameter = Schema.Struct({ key: Text, choices: Schema.Array(Argument).check(Schema.isMinLength(1), Schema.isMaxLength(32)) })

/** Explicit new grant data. Neither legacy command hashes nor a caller-created Recipe
 * mint an executor: the installed host must resolve the actual asset and current Work. */
export const Recipe = Schema.Struct({
  schemaVersion: Schema.Literal("work-command-recipe.v1"),
  logicalID: Text,
  revision: Positive,
  executable: Schema.Struct({ assetPath: Relative, sha256: Digest,
    bytes: Positive.check(Schema.isLessThanOrEqualTo(268_435_456)), platform: Schema.Literal("darwin-arm64"), identity: Identity }),
  argv: Schema.Array(Schema.Union([
    Schema.Struct({ kind: Schema.Literal("literal"), value: Argument }),
    Schema.Struct({ kind: Schema.Literal("parameter"), parameter: Text }),
  ])).check(Schema.isMaxLength(64)),
  parameters: Schema.Array(Parameter).check(Schema.isMaxLength(8)),
  cwd: Schema.NullOr(Relative),
  inputs: Schema.Array(Relative).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  outputs: Schema.Array(Relative).check(Schema.isMaxLength(32)),
  environment: Schema.Array(Schema.Struct({
    name: Schema.Literals(["CI", "LANG", "LC_ALL", "TZ", "NO_COLOR", "FORCE_COLOR", "SOURCE_DATE_EPOCH"]),
    value: bounded(128),
  })).check(Schema.isMaxLength(7)),
  workspace: Schema.Literal("private_explicit_files.v1"),
  sandbox: Schema.Struct({ id: Schema.Literal("darwin-single-process-workspace-v1"), revision: Schema.Literal(1),
    network: Schema.Literal("deny"), processes: Schema.Literal(1), openFiles: Schema.Literal(64),
    maxInputFiles: Schema.Literal(256), maxInputFileBytes: Schema.Literal(16_777_216), maxInputBytes: Schema.Literal(67_108_864),
    maxDepth: Schema.Literal(16), maxOutputFiles: Schema.Literal(32), maxOutputFileBytes: Schema.Literal(1_048_576),
    maxOutputBytes: Schema.Literal(33_554_432) }),
  timeoutMs: Positive.check(Schema.isLessThanOrEqualTo(600_000)),
  stdoutBytes: Positive.check(Schema.isLessThanOrEqualTo(1_048_576)),
  stderrBytes: Positive.check(Schema.isLessThanOrEqualTo(1_048_576)),
}).check(Schema.makeFilter((value) => {
  const paths = [...value.inputs, ...value.outputs]
  const keys = value.parameters.map((parameter) => parameter.key)
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= 32_768 &&
    new Set(paths).size === paths.length && new Set(keys).size === keys.length &&
    new Set(value.environment.map((entry) => entry.name)).size === value.environment.length &&
    paths.reduce((sum, relative) => sum + Buffer.byteLength(relative), 0) <= 8192 &&
    !paths.some((relative) => paths.some((parent) => relative.startsWith(`${parent}/`))) &&
    value.argv.every((argument) => argument.kind === "literal" || keys.includes(argument.parameter)) &&
    value.argv.reduce((sum, argument) => sum + (argument.kind === "literal" ? Buffer.byteLength(argument.value) :
      Math.max(...value.parameters.find((parameter) => parameter.key === argument.parameter)!.choices.map((choice) => Buffer.byteLength(choice)))), 0) <= 16_384
}))
export type Recipe = typeof Recipe.Type
/** Policy files select the installed runtime; approval supplies its real identity. */
export const RecipeRequest = Schema.Struct({ ...Recipe.fields, executable: Schema.Literal("installed-bun-v1") })
export type RecipeRequest = typeof RecipeRequest.Type

/** The model selects an approved logical recipe, never an executable, shell or env. */
export const Input = Schema.Struct({ commandID: Text,
  parameters: Schema.Array(Schema.Struct({ key: Text, value: Argument })).check(Schema.isMaxLength(8)) })
export type Input = typeof Input.Type

export const Stream = Schema.Struct({ sha256: Digest, bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)), capturedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_048_576)), truncated: Schema.Boolean, complete: Schema.Boolean, text: Schema.String })

export const OutputReference = Schema.Struct({ kind: Schema.Literal("command_output"), admissionID: Text,
  relative: Relative, sha256: Digest, bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_048_576)) })
export type OutputReference = typeof OutputReference.Type

export const Output = Schema.Struct({ outcome: Schema.Literals(["exited", "cancelled", "refused_before_dispatch", "unknown"]),
  exitCode: Schema.NullOr(Schema.Int), signal: Schema.NullOr(Text), stdout: Stream, stderr: Stream,
  stopConfirmed: Schema.Boolean, manifestHash: Digest,
  outputs: Schema.Array(OutputReference).check(Schema.isMaxLength(32)) })
export type Output = typeof Output.Type

export const MAX_RECORD_BYTES = 32_768
export const MAX_CUSTODY = 8
export const MAX_CUSTODY_BYTES = 822_607_872
export const MAX_AUDIT_RECORDS = 10_000
// Files, retained output and both captured streams plus bounded manifest/metadata.
export const RESERVATION_BYTES = 102_825_984
export class Error extends Schema.TaggedErrorClass<Error>()("WorkCommand.Error", {
  code: Schema.Literals(["WORK_COMMAND_UNAVAILABLE", "WORK_COMMAND_INVALID_RECORD", "WORK_COMMAND_CONFLICT",
    "WORK_COMMAND_CAPACITY", "WORK_COMMAND_UNKNOWN"]),
  message: Schema.String,
}) {}
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Time = Schema.NullOr(Positive)
const StreamSummary = Schema.Struct({ sha256: Digest, bytes: Count,
  capturedBytes: Count.check(Schema.isLessThanOrEqualTo(1_048_576)), truncated: Schema.Boolean, complete: Schema.Boolean })

/** Business intent/custody only; V2ToolEffect remains the sole tool dispatcher. A
 * durable PID or this record cannot reconstruct an OS handle or a known result proof.
 * SQL mirrors/transition constraints are generated separately by the migration owner. */
export const Record = Schema.Struct({
  version: Schema.Literal(1), commandID: Text, admissionID: Text,
  instanceID: Text, workID: Text, rootWorkID: Text, sessionID: Text, inputID: Text, activityID: Text,
  providerReceiptID: Text, providerAttemptID: Text, toolCallID: Text, ownerToken: Text,
  sessionClaimToken: Positive, bindingHash: Digest, controlRevision: Positive,
  recipeID: Text, recipeRevision: Positive, recipeHash: Digest, requestHash: Digest,
  helperHash: Digest, runtimeHash: Digest,
  workspaceBasename: Schema.String.check(Schema.isPattern(/^cmd_[a-f0-9]{32}$/)),
  workspaceIdentity: Schema.NullOr(Identity), snapshotHash: Schema.NullOr(Digest),
  state: Schema.Literals(["reserved", "prepared", "dispatching", "settled", "unknown"]),
  outcome: Schema.NullOr(Schema.Literals(["exited", "cancelled", "refused_before_dispatch"])),
  processIncarnation: Schema.NullOr(Text), processID: Schema.NullOr(Positive),
  exitCode: Schema.NullOr(Schema.Int), signal: Schema.NullOr(Text),
  stopConfirmed: Schema.Boolean,
  stdout: Schema.NullOr(StreamSummary), stderr: Schema.NullOr(StreamSummary),
  outputs: Schema.Array(Schema.Struct({ relative: Relative, identity: Identity, sha256: Digest,
    bytes: Count.check(Schema.isLessThanOrEqualTo(1_048_576)) })).check(Schema.isMaxLength(32)),
  createdAt: Positive, preparedAt: Time, dispatchedAt: Time, terminalAt: Time, updatedAt: Positive,
  releasedAt: Time, deadline: Positive, revision: Positive,
  reservedBytes: Count, observedRetainedBytes: Count,
}).check(Schema.makeFilter((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_RECORD_BYTES))
export type Record = typeof Record.Type
