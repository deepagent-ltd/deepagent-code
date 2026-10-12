import { Schema } from "effect"

export const DOMAIN = "dac.native-installation.v1"
export const NODE_DOMAIN = "dac.native-node-installation.v1"
export const SIDECAR_SUFFIX = ".native-installation.json"
export const MANIFEST_LIMIT = 16_384
export const COMPONENTS_LIMIT = 1_048_576
export const EXECUTABLE_LIMIT = 1_073_741_824

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const Target = Schema.String.check(Schema.isPattern(/^(darwin|linux|win32)-(arm64|x64)$/))
const Bytes = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(EXECUTABLE_LIMIT),
)

export class Component extends Schema.Class<Component>("NativeInstallationComponent")({
  // Percent is a literal filename character (Bun patch names contain %2F), never URL decoded.
  path: Schema.String.check(
    Schema.isMaxLength(512),
    Schema.isPattern(/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_.@%+-]+(?:\/[A-Za-z0-9_.@%+-]+)*$/),
  ),
  bytes: Bytes,
  sha256: Digest,
}) {}

/** The release signer attests this build input inventory; runtime does not recover source from machine code. */
export class Components extends Schema.Class<Components>("NativeInstallationComponents")({
  schemaVersion: Schema.Literal("dac.native-components.v1"),
  target: Target,
  sourceCommit: Commit,
  sourceTree: Commit,
  components: Schema.Array(Component).check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
}) {}

export class Executable extends Schema.Class<Executable>("NativeInstallationExecutable")({
  bytes: Bytes,
  sha256: Digest,
}) {}

export class Payload extends Schema.Class<Payload>("NativeInstallationPayload")({
  domain: Schema.Literal(DOMAIN),
  releaseID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128), Schema.isPattern(/^[A-Za-z0-9_.-]+$/)),
  target: Target,
  sourceCommit: Commit,
  sourceTree: Commit,
  componentsHash: Digest,
  executable: Executable,
}) {}

export class Manifest extends Schema.Class<Manifest>("NativeInstallationManifest")({
  payload: Payload,
  signature: Schema.String.check(Schema.isPattern(/^[a-f0-9]{128}$/)),
}) {}

// Node's installed entry and its actual interpreter are separate artifacts. The
// signer must attest both; a signed source module cannot attest an arbitrary runtime.
export class NodePayload extends Schema.Class<NodePayload>("NativeNodeInstallationPayload")({
  domain: Schema.Literal(NODE_DOMAIN),
  releaseID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128), Schema.isPattern(/^[A-Za-z0-9_.-]+$/)),
  target: Target,
  sourceCommit: Commit,
  sourceTree: Commit,
  componentsHash: Digest,
  executable: Executable,
  runtime: Executable,
}) {}

export class NodeManifest extends Schema.Class<NodeManifest>("NativeNodeInstallationManifest")({
  payload: NodePayload,
  signature: Schema.String.check(Schema.isPattern(/^[a-f0-9]{128}$/)),
}) {}

export const ErrorCode = Schema.Literals([
  "NATIVE_INSTALLATION_UNAVAILABLE",
  "NATIVE_MANIFEST_INVALID",
  "NATIVE_SIGNATURE_INVALID",
  "NATIVE_COMPONENTS_MISMATCH",
  "NATIVE_TARGET_MISMATCH",
  "NATIVE_BYTES_MISMATCH",
  "NATIVE_IDENTITY_CHANGED",
  "NATIVE_HANDLE_INVALID",
])

/** No filesystem, parser, crypto or request cause is retained in this public error. */
export class Error extends Schema.TaggedErrorClass<Error>()("NativeInstallationError", {
  code: ErrorCode,
  message: Schema.String,
}) {}

export * as NativeInstallationSchema from "./native-installation.schema"
