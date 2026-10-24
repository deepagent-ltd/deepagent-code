export * as BrowserSchema from "./schema"

import { Option, Schema } from "effect"
import { Hash } from "../util/hash"
import { CanonicalJson } from "../util/canonical-json"
import { BrowserFileSchema } from "./file-exchange.schema"

export const PROFILE = "managed-loopback-preview-v1"
export const INTERACTION_PROFILE = "managed-loopback-interaction-v1"
export const PUBLIC_READONLY_PROFILE = "managed-public-readonly-v1"
export const PUBLIC_INTERACTION_PROFILE = "managed-public-interaction-v1"
export const API_POST_PROFILE = "managed-public-api-v1"
export const API_POST_ACTION_TAG = "browser-api-post.v1"
export const FILE_EXCHANGE_PROFILE = BrowserFileSchema.PROFILE
export const MAX_POST_BYTES = 65_536
export const MAX_INPUT_BYTES = 16_384
export const MAX_SCRIPT_BYTES = 8_192
export const MAX_SCRIPT_RESULT_BYTES = 65_536
export const MAX_SCRIPT_MS = 2_000
export const MAX_SCRIPT_WORLDS = 32
export const MAX_PROGRAM_STEPS = 16
export const MAX_CLIPBOARD_READ_BYTES = 16_384
export const MAX_CLIPBOARD_WRITE_BYTES = 8_192
// Re-enable only after the actual native confirmation boundary is verified.
export const CLIPBOARD_NATIVE_AVAILABLE = false
export const MAX_CONTROL_BYTES = 16_384
export const MAX_ACTION_BYTES = 131_072
export const TERMINAL_RESERVE_BYTES = 4_096
export const MAX_CONTROLS = 256
export const MAX_ACTIONS = 4_096
// Logical allocation includes the full future record and conservative row/index overhead.
// It is not a physical SQLite disk limit. Existing IDs are never evicted to free capacity.
export const ROW_OVERHEAD_BYTES = 4_096
export const MAX_RESERVED_BYTES = 67_108_864
export const MAX_ACTIVE_CONTROLS = 4
export const MAX_TABS = 4
export const MAX_FRAMES = 64
export const MAX_SNAPSHOT_TARGETS = 500
export const MAX_WAITING = 16
export const DEFAULT_TIMEOUT_MS = 10_000
export const MAX_TIMEOUT_MS = 30_000
export const MAX_AX_BYTES = 65_536
export const MAX_PNG_BYTES = 5_242_880
export const MAX_PIXELS = 16_000_000

export const ID = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter((value: string) => new TextEncoder().encode(value).byteLength <= 512),
)
export const Address = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2048),
  Schema.makeFilter((value: string) => new TextEncoder().encode(value).byteLength <= 2048),
)
export const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
export const Revision = Count.check(Schema.isGreaterThan(0))
export const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
export const Profile = Schema.Literals([PROFILE, INTERACTION_PROFILE, PUBLIC_READONLY_PROFILE, FILE_EXCHANGE_PROFILE, PUBLIC_INTERACTION_PROFILE, API_POST_PROFILE])
export const PostPath = Address.check(
  Schema.makeFilter((value: string) => {
    if (
      !value.startsWith("/") ||
      value.startsWith("//") ||
      /[?#\\\u0000]/.test(value) ||
      /%(?:2f|5c|00|25)/i.test(value) ||
      /%(?![0-9a-f]{2})/i.test(value)
    )
      return false
    return URL.canParse(value, "http://127.0.0.1") && new URL(value, "http://127.0.0.1").pathname === value
  }),
)
export const PostPaths = Schema.Array(PostPath).check(
  Schema.isMaxLength(8),
  Schema.makeFilter((values) => new Set(values).size === values.length),
)
const PreviewPolicy = { profile: Schema.Literal(PROFILE) }
export const ScriptGrants = Schema.Array(Schema.Struct({ scriptHash: Digest, argsHash: Digest, readOnly: Schema.Literal(true) })).check(
  Schema.isMaxLength(8),
  Schema.makeFilter((values) => new Set(values.map((value) => `${value.scriptHash}/${value.argsHash}`)).size === values.length),
)
export const ProgramOperation = Schema.Literals(["fill", "select", "click", "press", "scroll", "drag"])
export const ProgramGrants = Schema.Array(Schema.Struct({ scriptHash: Digest, argsHash: Digest,
  operations: Schema.Array(ProgramOperation).check(Schema.isMinLength(1), Schema.isMaxLength(6),
    Schema.makeFilter((values) => new Set(values).size === values.length)),
  maxSteps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PROGRAM_STEPS })),
})).check(Schema.isMaxLength(8),
  Schema.makeFilter((values) => new Set(values.map((value) => `${value.scriptHash}/${value.argsHash}`)).size === values.length))
export const ClipboardPolicy = Schema.Struct({ read: Schema.Boolean, write: Schema.Boolean }).check(
  Schema.makeFilter((value) => value.read || value.write),
)
const InteractionPolicy = { profile: Schema.Literal(INTERACTION_PROFILE), postPaths: PostPaths,
  scriptGrants: Schema.optional(ScriptGrants), programGrants: Schema.optional(ProgramGrants),
  clipboardPolicy: Schema.optional(ClipboardPolicy) }
const FilePolicy = { profile: Schema.Literal(FILE_EXCHANGE_PROFILE), postPaths: PostPaths,
  filePolicy: BrowserFileSchema.Policy }
export const Origin = Address.check(
  Schema.makeFilter((value: string) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      (url.port === "" || Number(url.port) > 0) &&
      !url.username &&
      !url.password &&
      value === url.origin
    )
  }),
)
export const PublicOrigin = Address.check(
  Schema.makeFilter((value: string) => {
    if (!URL.canParse(value) || new TextEncoder().encode(value).byteLength > 512) return false
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && value === url.origin &&
      !url.hostname.endsWith(".") && url.hostname.includes(".") &&
      !url.hostname.endsWith(".localhost") && !url.hostname.startsWith("[") &&
      !/^[\d.]+$/.test(url.hostname) && /^[a-z\d.-]+$/.test(url.hostname) &&
      url.hostname.split(".").every((part) => part.length > 0 && part.length <= 63 &&
        /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(part))
  }),
)
export const ApprovedOrigins = Schema.Array(PublicOrigin).check(
  Schema.isMinLength(1), Schema.isMaxLength(8),
  Schema.makeFilter((values) => new Set(values).size === values.length &&
    Buffer.byteLength(JSON.stringify(values), "utf8") <= 4096),
)
export const ResolverPolicy = Schema.Literals(["system", "cloudflare_doh_v1", "alidns_doh_v1"])
const PublicPolicy = { profile: Schema.Literal(PUBLIC_READONLY_PROFILE), origin: PublicOrigin,
  approvedOrigins: ApprovedOrigins, resolverPolicy: ResolverPolicy }
export const PublicPageMode = Schema.Literals(["static", "dynamic"])
export const PublicPostTargets = Schema.Array(Schema.Struct({ origin: PublicOrigin, path: PostPath })).check(
  Schema.isMaxLength(8),
  Schema.makeFilter((values) => new Set(values.map((value) => `${value.origin}${value.path}`)).size === values.length),
)
const PublicInteractionPolicy = { ...PublicPolicy, profile: Schema.Literal(PUBLIC_INTERACTION_PROFILE),
  pageMode: PublicPageMode, postTargets: PublicPostTargets }
export const ApiPostURL = Address.check(Schema.makeFilter((value) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return value === url.href && !url.username && !url.password && !value.includes("#") &&
    Option.isSome(Schema.decodeUnknownOption(PublicOrigin)(url.origin))
}))
export const ApiPostContentType = Schema.Literals(["application/json", "application/x-www-form-urlencoded", "text/plain"])
export const ApiPostTargets = Schema.Array(Schema.Struct({ url: ApiPostURL,
  contentTypes: Schema.Array(ApiPostContentType).check(Schema.isMinLength(1), Schema.isMaxLength(3),
    Schema.makeFilter((values) => new Set(values).size === values.length)),
  maxBodyBytes: Revision.check(Schema.isLessThanOrEqualTo(MAX_POST_BYTES)),
})).check(Schema.isMaxLength(8), Schema.makeFilter((values) => new Set(values.map((value) => value.url)).size === values.length))
const ApiPostPolicy = { ...PublicPolicy, profile: Schema.Literal(API_POST_PROFILE),
  pageMode: PublicPageMode, apiPostTargets: ApiPostTargets }
export const Scope = Schema.Struct({
  principal: ID,
  securityNamespaceID: ID,
  locationKey: ID,
  projectScopeKey: ID,
  namespaceBindingHash: Digest,
  sessionID: ID,
  projectID: ID,
  directory: Address,
  workspaceID: Schema.Null,
})
export type Scope = typeof Scope.Type
const CreateFields = { requestID: ID, sessionID: ID, origin: Origin, expiresAt: Revision }
export const Create = Schema.Union([
  Schema.Struct({ ...CreateFields, ...PreviewPolicy }),
  Schema.Struct({ ...CreateFields, ...InteractionPolicy }),
  Schema.Struct({ ...CreateFields, ...FilePolicy }),
  Schema.Struct({ ...CreateFields, ...PublicPolicy }).check(
    Schema.makeFilter((value) => value.approvedOrigins.includes(value.origin)),
  ),
  Schema.Struct({ ...CreateFields, ...PublicInteractionPolicy }).check(
    Schema.makeFilter((value) => value.approvedOrigins.includes(value.origin) &&
      value.postTargets.every((target) => target.origin === value.origin)),
  ),
  Schema.Struct({ ...CreateFields, ...ApiPostPolicy }).check(
    Schema.makeFilter((value) => value.approvedOrigins.includes(value.origin) &&
      value.apiPostTargets.every((target) => new URL(target.url).origin === value.origin)),
  ),
])
export type Create = typeof Create.Type
export const Cancel = Schema.Struct({ requestID: ID, expectedRevision: Revision })
export type Cancel = typeof Cancel.Type
export const ControlState = Schema.Literals(["creating", "active", "cancel_requested", "stopped", "unknown"])
const ControlFields = {
  version: Schema.Literal(1),
  controlID: ID,
  requestID: ID,
  requestDigest: Digest,
  scope: Scope,
  hostID: ID,
  hostIncarnation: ID,
  resourceID: ID,
  // Process-private credential generation binding, not a cold authorization or a signature.
  credentialBinding: Digest,
  origin: Origin,
  revision: Revision,
  epoch: Revision,
  policyRevision: Revision,
  state: ControlState,
  expiresAt: Revision,
  createdAt: Count,
  updatedAt: Count,
  cancel: Schema.NullOr(Schema.Struct({ requestID: ID, expectedRevision: Revision, requestedAt: Count })),
  stopConfirmedAt: Schema.NullOr(Count),
}
export const Control = Schema.Union([
  Schema.Struct({ ...ControlFields, ...PreviewPolicy }),
  Schema.Struct({ ...ControlFields, ...InteractionPolicy }),
  Schema.Struct({ ...ControlFields, ...FilePolicy }),
  Schema.Struct({ ...ControlFields, ...PublicPolicy }).check(
    Schema.makeFilter((value) => value.approvedOrigins.includes(value.origin)),
  ),
  Schema.Struct({ ...ControlFields, ...PublicInteractionPolicy }).check(
    Schema.makeFilter((value) => value.approvedOrigins.includes(value.origin) &&
      value.postTargets.every((target) => target.origin === value.origin)),
  ),
  Schema.Struct({ ...ControlFields, ...ApiPostPolicy }).check(
    Schema.makeFilter((value) => value.approvedOrigins.includes(value.origin) &&
      value.apiPostTargets.every((target) => new URL(target.url).origin === value.origin)),
  ),
])
export type Control = typeof Control.Type

const ElementTarget = { tabID: ID, generation: Count, frameID: ID, observationRevision: Revision, ref: ID }
const ObservationTarget = { tabID: ID, generation: Count, frameID: ID, observationRevision: Revision }
const ApiPostText = Schema.String.check(Schema.makeFilter((value) =>
  value.isWellFormed() && Buffer.byteLength(value, "utf8") <= MAX_POST_BYTES))
export const ClipboardWriteText = Schema.String.check(Schema.makeFilter((value: string) =>
  value.isWellFormed() && Buffer.byteLength(value, "utf8") <= MAX_CLIPBOARD_WRITE_BYTES))
export const InputKey = Schema.Literals([
  "Tab",
  "Shift+Tab",
  "Enter",
  "Space",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
  "SelectAll",
])
export const ProgramTargetName = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/))
export const ProgramTargets = Schema.Array(Schema.Struct({ name: ProgramTargetName, ref: ID })).check(
  Schema.isMinLength(1), Schema.isMaxLength(MAX_PROGRAM_STEPS),
  Schema.makeFilter((values) => new Set(values.map((value) => value.name)).size === values.length),
)
export const ProgramStep = Schema.Union([
  Schema.Struct({ type: Schema.Literal("fill"), target: ProgramTargetName,
    text: Schema.String.check(Schema.makeFilter((value: string) =>
      value.isWellFormed() && Buffer.byteLength(value, "utf8") <= MAX_INPUT_BYTES)) }),
  Schema.Struct({ type: Schema.Literal("select"), target: ProgramTargetName,
    values: Schema.Array(Schema.String.check(Schema.makeFilter((value: string) =>
      value.isWellFormed() && Buffer.byteLength(value, "utf8") <= 256))).check(Schema.isMinLength(1), Schema.isMaxLength(32)) }),
  Schema.Struct({ type: Schema.Literal("click"), target: ProgramTargetName, count: Schema.optional(Schema.Literals([1, 2])),
    waitForNavigation: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal("press"), target: ProgramTargetName, key: InputKey,
    waitForNavigation: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal("scroll"), target: ProgramTargetName,
    deltaX: Schema.Int.check(Schema.isBetween({ minimum: -4096, maximum: 4096 })),
    deltaY: Schema.Int.check(Schema.isBetween({ minimum: -4096, maximum: 4096 })) }),
  Schema.Struct({ type: Schema.Literal("drag"), target: ProgramTargetName, targetTo: ProgramTargetName,
    steps: Schema.optional(Revision.check(Schema.isLessThanOrEqualTo(20))) }),
])
export const ProgramPlan = Schema.Struct({ version: Schema.Literal(1),
  steps: Schema.Array(ProgramStep).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PROGRAM_STEPS)),
}).check(Schema.makeFilter((value) => value.steps.every((step, index) =>
  !("waitForNavigation" in step) || !step.waitForNavigation || index === value.steps.length - 1 &&
  (step.type === "click" || step.type === "press" && step.key === "Enter"))))
const ScriptSource = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SCRIPT_BYTES),
  Schema.makeFilter((value: string) => value.isWellFormed() && Buffer.byteLength(value, "utf8") <= MAX_SCRIPT_BYTES))
const ScriptArgsJSON = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SCRIPT_BYTES),
  Schema.makeFilter((value: string) => value.isWellFormed() && Buffer.byteLength(value, "utf8") <= MAX_SCRIPT_BYTES &&
    Option.isSome(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value))))
export const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("api.post"), actionTag: Schema.Literal(API_POST_ACTION_TAG),
    profileVersion: Schema.Literal(1), ...ObservationTarget, url: ApiPostURL, contentType: ApiPostContentType, body: ApiPostText }),
  Schema.Struct({ type: Schema.Literal("program"), ...ObservationTarget, scriptHash: Digest,
    source: ScriptSource, argsJSON: ScriptArgsJSON, targets: ProgramTargets }),
  Schema.Struct({ type: Schema.Literal("clipboard.read"), ...ObservationTarget }),
  Schema.Struct({ type: Schema.Literal("clipboard.write"), ...ObservationTarget, text: ClipboardWriteText }),
  Schema.Struct({ type: Schema.Literal("files.list"), cursor: Schema.optional(ID),
    limit: Schema.optional(Revision.check(Schema.isLessThanOrEqualTo(BrowserFileSchema.MAX_FILES))) }),
  Schema.Struct({ type: Schema.Literal("file.upload"), ...ElementTarget, grantIDs: BrowserFileSchema.GrantIDs }),
  Schema.Struct({ type: Schema.Literal("file.download"), ...ElementTarget, grantID: ID }),
  Schema.Struct({ type: Schema.Literal("tabs.list") }),
  Schema.Struct({ type: Schema.Literal("tabs.create"), url: Schema.optional(Address) }),
  Schema.Struct({ type: Schema.Literal("tabs.select"), tabID: ID, generation: Count }),
  Schema.Struct({ type: Schema.Literal("tabs.close"), tabID: ID, generation: Count }),
  Schema.Struct({ type: Schema.Literal("back"), tabID: ID, generation: Count }),
  Schema.Struct({ type: Schema.Literal("forward"), tabID: ID, generation: Count }),
  Schema.Struct({ type: Schema.Literal("reload"), tabID: ID, generation: Count }),
  Schema.Struct({ type: Schema.Literal("stop"), tabID: ID, generation: Count }),
  Schema.Struct({ type: Schema.Literal("frames.list"), tabID: ID, generation: Count }),
  Schema.Struct({ type: Schema.Literal("navigate"), tabID: ID, generation: Count, url: Address }),
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    tabID: ID,
    generation: Count,
    frameID: Schema.optional(ID),
    depth: Schema.optional(Count.check(Schema.isLessThanOrEqualTo(16))),
    limit: Schema.optional(Revision.check(Schema.isLessThanOrEqualTo(MAX_SNAPSHOT_TARGETS))),
  }),
  Schema.Struct({ type: Schema.Literal("screenshot"), tabID: ID, generation: Count }),
  Schema.Struct({
    type: Schema.Literal("evaluate"), tabID: ID, generation: Count, frameID: ID, observationRevision: Revision,
    scriptHash: Digest,
    source: ScriptSource,
    argsJSON: ScriptArgsJSON,
  }),
  Schema.Struct({
    type: Schema.Literal("fill"),
    ...ElementTarget,
    text: Schema.String.check(
      Schema.makeFilter((value: string) => Buffer.byteLength(value, "utf8") <= MAX_INPUT_BYTES),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("select"),
    ...ElementTarget,
    values: Schema.Array(
      Schema.String.check(Schema.makeFilter((value: string) => Buffer.byteLength(value, "utf8") <= 256)),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  }),
  Schema.Struct({
    type: Schema.Literal("click"),
    ...ElementTarget,
    count: Schema.optional(Schema.Literals([1, 2])),
    waitForNavigation: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("scroll"),
    ...ElementTarget,
    deltaX: Schema.Int.check(Schema.isBetween({ minimum: -4096, maximum: 4096 })),
    deltaY: Schema.Int.check(Schema.isBetween({ minimum: -4096, maximum: 4096 })),
  }),
  Schema.Struct({
    type: Schema.Literal("drag"),
    ...ElementTarget,
    targetRef: ID,
    steps: Schema.optional(Revision.check(Schema.isLessThanOrEqualTo(20))),
  }),
  Schema.Struct({
    type: Schema.Literal("press"),
    ...ElementTarget,
    key: InputKey,
    waitForNavigation: Schema.optional(Schema.Boolean),
  }),
])
export type Command = typeof Command.Type
export function allowsApiPost(control: Control, command: Extract<Command, { type: "api.post" }>) {
  return control.profile === API_POST_PROFILE && control.apiPostTargets.some((target) =>
    target.url === command.url && target.contentTypes.includes(command.contentType) &&
    command.body.isWellFormed() && Buffer.byteLength(command.body, "utf8") <= target.maxBodyBytes)
}
export function apiPostMetadata(command: Extract<Command, { type: "api.post" }>) {
  return { actionTag: command.actionTag, profileVersion: command.profileVersion, url: command.url,
    method: "POST", contentType: command.contentType, bodySha256: Hash.sha256(command.body),
    bodyBytes: Buffer.byteLength(command.body, "utf8"), commandHash: Hash.sha256(CanonicalJson.stringify(command)) }
}
export function allowsProgram(control: Control, command: Extract<Command, { type: "program" }>) {
  return control.profile === INTERACTION_PROFILE && command.scriptHash === Hash.sha256(command.source) &&
    control.programGrants?.some((grant) => grant.scriptHash === command.scriptHash &&
      grant.argsHash === Hash.sha256(command.argsJSON)) === true
}
export function allowsClipboard(control: Control, command: Command) {
  return control.profile === INTERACTION_PROFILE &&
    (command.type === "clipboard.read" && control.clipboardPolicy?.read === true ||
      command.type === "clipboard.write" && control.clipboardPolicy?.write === true)
}
export function allowsScript(control: Control, command: Extract<Command, { type: "evaluate" }>) {
  return control.profile === INTERACTION_PROFILE && command.scriptHash === Hash.sha256(command.source) &&
    control.scriptGrants?.some((grant) => grant.scriptHash === command.scriptHash &&
      grant.argsHash === Hash.sha256(command.argsJSON)) === true
}
export const Invoke = Schema.Struct({
  controlID: ID,
  command: Command,
  timeoutMs: Schema.optional(Revision.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))),
})
export type Invoke = typeof Invoke.Type
export const Tab = Schema.Struct({
  tabID: ID,
  generation: Count,
  url: Address,
  title: Schema.String.check(Schema.isMaxLength(256)),
  selected: Schema.optional(Schema.Boolean),
  canGoBack: Schema.optional(Schema.Boolean),
  canGoForward: Schema.optional(Schema.Boolean),
})
export type Tab = typeof Tab.Type
export const FileGrantView = BrowserFileSchema.GrantSummary
export const ClipboardResult = Schema.Union([
  Schema.Struct({ direction: Schema.Literal("read"), bytes: Count.check(Schema.isLessThanOrEqualTo(MAX_CLIPBOARD_READ_BYTES)),
    sha256: Digest, text: Schema.String.check(Schema.makeFilter((value: string) =>
      value.isWellFormed() && Buffer.byteLength(value, "utf8") <= MAX_CLIPBOARD_READ_BYTES)) }).check(
        Schema.makeFilter((value) => value.bytes === Buffer.byteLength(value.text, "utf8") && value.sha256 === Hash.sha256(value.text))),
  Schema.Struct({ direction: Schema.Literal("write"), bytes: Count.check(Schema.isLessThanOrEqualTo(MAX_CLIPBOARD_WRITE_BYTES)), sha256: Digest }),
])
export const ProgramResult = Schema.Struct({ version: Schema.Literal(1), planHash: Digest,
  totalSteps: Revision.check(Schema.isLessThanOrEqualTo(MAX_PROGRAM_STEPS)),
  completedSteps: Revision.check(Schema.isLessThanOrEqualTo(MAX_PROGRAM_STEPS)),
  steps: Schema.Array(Schema.Struct({ ordinal: Count.check(Schema.isLessThan(MAX_PROGRAM_STEPS)),
    operation: ProgramOperation })).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PROGRAM_STEPS)),
}).check(Schema.makeFilter((value) => value.completedSteps === value.totalSteps && value.steps.length === value.totalSteps &&
  value.steps.every((step, index) => step.ordinal === index) && Buffer.byteLength(JSON.stringify(value), "utf8") <= 4096))
export const ApiPostResult = Schema.Struct({ version: Schema.Literal(1),
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  contentType: Schema.String.check(Schema.makeFilter((value) => value.isWellFormed() && Buffer.byteLength(value, "utf8") <= 256)),
  bytes: Count.check(Schema.isLessThanOrEqualTo(MAX_POST_BYTES)), sha256: Digest, text: Schema.optional(ApiPostText),
}).check(Schema.makeFilter((value) => value.text === undefined ||
  value.bytes === Buffer.byteLength(value.text, "utf8") && value.sha256 === Hash.sha256(value.text)))
export const Result = Schema.Struct({
  tabs: Schema.Array(Tab).check(Schema.isMaxLength(MAX_TABS)),
  apiPost: Schema.optional(ApiPostResult),
  program: Schema.optional(ProgramResult),
  clipboard: Schema.optional(ClipboardResult),
  files: Schema.optional(Schema.Array(BrowserFileSchema.Summary).check(Schema.isMaxLength(BrowserFileSchema.MAX_FILES))),
  fileGrants: Schema.optional(Schema.Array(FileGrantView).check(Schema.isMaxLength(BrowserFileSchema.MAX_FILES))),
  nextFileCursor: Schema.optional(ID),
  frames: Schema.optional(Schema.Array(Schema.Struct({
    frameID: ID, parentFrameID: Schema.NullOr(ID), url: Address,
  })).check(Schema.isMaxLength(MAX_FRAMES))),
  text: Schema.optional(
    Schema.String.check(Schema.makeFilter((value: string) => Buffer.byteLength(value, "utf8") <= MAX_AX_BYTES)),
  ),
  truncated: Schema.optional(Schema.Boolean),
  scriptResultJSON: Schema.optional(Schema.String.check(Schema.makeFilter((value: string) =>
    Buffer.byteLength(value, "utf8") <= MAX_SCRIPT_RESULT_BYTES &&
    Option.isSome(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value))))),
  scriptContextEvidence: Schema.optional(Schema.Struct({
    version: Schema.Literal(1),
    context: Schema.Literal("snapshot-json-v1"),
    sha256: Digest,
    bytes: Count.check(Schema.isLessThanOrEqualTo(1_048_576)),
    frameID: ID,
    observationRevision: Revision,
    generation: Count,
  })),
  frameID: Schema.optional(ID),
  observationRevision: Schema.optional(Revision),
  refs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ref: ID,
        frameID: ID,
        role: Schema.String.check(Schema.isMaxLength(256)),
        name: Schema.String.check(Schema.isMaxLength(512)),
      }),
    ).check(Schema.isMaxLength(500)),
  ),
  image: Schema.optional(
    Schema.Struct({
      mime: Schema.Literal("image/png"),
      hash: Digest,
      bytes: Revision.check(Schema.isLessThanOrEqualTo(MAX_PNG_BYTES)),
      width: Revision,
      height: Revision,
    }),
  ),
})
export type Result = typeof Result.Type
export function matchesApiPostResult(command: Command, result: Result) {
  if (command.type !== "api.post") return result.apiPost === undefined
  return result.apiPost !== undefined && (result.apiPost.status < 300 || result.apiPost.status >= 400)
}
export function matchesProgramResult(command: Command, result: Result) {
  return command.type === "program" ? result.program !== undefined : result.program === undefined
}
export function matchesClipboardResult(command: Command, result: Result) {
  if (command.type === "clipboard.read") return result.clipboard?.direction === "read"
  if (command.type !== "clipboard.write") return result.clipboard === undefined
  return result.clipboard?.direction === "write" && result.clipboard.bytes === Buffer.byteLength(command.text, "utf8") &&
    result.clipboard.sha256 === Hash.sha256(command.text)
}
export const ErrorCode = Schema.Literals([
  "BROWSER_UNAVAILABLE",
  "BROWSER_HOST_UNAVAILABLE",
  "BROWSER_NOT_FOUND",
  "BROWSER_CONFLICT",
  "BROWSER_INVALID_RECORD",
  "BROWSER_CAPACITY",
  "BROWSER_SCOPE_DENIED",
  "BROWSER_AUTHORITY_REQUIRED",
  "BROWSER_OWNER_LOST",
  "BROWSER_STALE_TARGET",
  "BROWSER_EXPIRED",
  "BROWSER_CANCELLED",
  "BROWSER_UNKNOWN",
  "BROWSER_NETWORK_DENIED",
  "BROWSER_OUTPUT_LIMIT",
  "BROWSER_DRIVER_UNAVAILABLE",
])
export class Error extends Schema.TaggedErrorClass<Error>()("Browser.Error", {
  code: ErrorCode,
  message: Schema.String,
}) {}
export const Outcome = Schema.Literals(["pending", "completed", "failed", "cancelled", "unknown"])
export const Action = Schema.Struct({
  version: Schema.Literal(1),
  actionID: ID,
  controlID: ID,
  requestID: ID,
  commandDigest: Digest,
  command: Command,
  admissionID: ID,
  providerReceiptID: ID,
  providerAttemptID: ID,
  toolCallID: ID,
  sessionID: ID,
  hostIncarnation: ID,
  resourceID: ID,
  controlEpoch: Revision,
  policyRevision: Revision,
  revision: Revision,
  deadline: Revision,
  outcome: Outcome,
  result: Schema.NullOr(Result),
  errorCode: Schema.NullOr(ErrorCode),
  createdAt: Count,
  updatedAt: Count,
  terminalAt: Schema.NullOr(Count),
  stopConfirmedAt: Schema.NullOr(Count),
})
export type Action = typeof Action.Type
export const ControlView = Schema.Struct({
  control: Control,
  availability: Schema.Literals(["available", "host_unavailable", "expired", "stopped"]),
  nativeVerification: Schema.Literals(["verified", "unavailable"]),
  stopConfirmed: Schema.Boolean,
})
export const ActionView = Schema.Struct({
  action: Action,
  effectID: Schema.NullOr(ID),
  effectState: Schema.NullOr(Schema.Literals(["settled", "failed"])),
  cancelRequested: Schema.Boolean,
  nativeVerification: Schema.Literals(["verified", "unavailable"]),
  observedOutcome: Outcome,
  stopConfirmed: Schema.Boolean,
})
