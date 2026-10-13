export * as WindowsWorkWrite from "./windows-work-write"

import { randomBytes, randomUUID, createHmac, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { WorkFileCapability } from "@deepagent-code/core/session/work-file-capability"
import { WorkWriteStage } from "@deepagent-code/core/session/work-write-stage"
import { WorkWriteStageSchema } from "@deepagent-code/core/session/work-write-stage.schema"
import { WorkStorageCleanup } from "@deepagent-code/core/session/work-storage-cleanup"
import { WorkStorageCleanupSchema } from "@deepagent-code/core/session/work-storage-cleanup.schema"
import { WorkStorageCleanupWindowsWriteSchema } from "@deepagent-code/core/session/work-storage-cleanup-windows-write.schema"
import { WorkToolPolicy } from "@deepagent-code/core/session/work-tool-policy"
import { WorkWindowsPathSchema } from "@deepagent-code/core/session/work-windows-path.schema"
import { LocalAuthority } from "../installation/local-authority"
import { NativeWindowsWorkFactory } from "./windows-work-factory"

const WireIdentity = Schema.Struct({ kind: Schema.Literal("windows"),
  volume_serial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
  file_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)) })
const WireFile = Schema.Struct({ relative: Schema.Literals(["payload", "previous"]), identity: WireIdentity,
  sha256: WorkWriteStageSchema.Digest, bytes: WorkWriteStageSchema.Count.check(Schema.isLessThanOrEqualTo(16_777_216)),
  retained_unlinked: Schema.Boolean })
export const Stage = Schema.Struct({ version: Schema.Literal(1), directory: WorkWindowsPathSchema.Absolute,
  data: WireIdentity, base: WireIdentity, stage: WireIdentity, root: WireIdentity,
  files: Schema.Array(WireFile).check(Schema.isMaxLength(2)), retained_bytes: WorkWriteStageSchema.Count,
}).check(Schema.makeFilter((value) => value.retained_bytes === value.files.reduce((bytes, file) => bytes + file.bytes, 0) &&
  new Set(value.files.map((file) => file.relative)).size === value.files.length &&
  new Set(value.files.map((file) => `${file.identity.volume_serial}:${file.identity.file_id}`)).size === value.files.length &&
  value.files.every((file) => file.retained_unlinked === (file.relative === "previous")) &&
  [value.data, value.base, value.stage].every((identity) => identity.volume_serial === value.root.volume_serial)))
const Prepared = Schema.Struct({ parent: WireIdentity, stage: WireIdentity })
const Published = Schema.Struct({ parent: WireIdentity, stage: WireIdentity, file: WireIdentity,
  sha256: WorkWriteStageSchema.Digest, bytes: WorkWriteStageSchema.Count,
  previous: Schema.Union([Schema.Struct({ kind: Schema.Literal("missing") }), Schema.Struct({ kind: Schema.Literal("observed"),
    identity: WireIdentity, sha256: WorkWriteStageSchema.Digest, bytes: WorkWriteStageSchema.Count })]),
  publication: Schema.Literal("optimistic_namespace_publish") })
const Reply = Schema.Struct({ version: Schema.Literal(1), id: Schema.String, status: Schema.String, code: Schema.NullOr(Schema.String),
  root: Schema.NullOr(WireIdentity), observation: Schema.Null, payload_bytes: Schema.Literal(0),
  allocated_bytes: Schema.optional(WorkWriteStageSchema.Count), preparation: Schema.optional(Prepared), write: Schema.optional(Published),
  write_stage: Schema.optional(Stage),
})
type Input = Parameters<NonNullable<WorkFileCapability.Interface["write"]>>[1]
export type Channel = Readonly<{
  current: Effect.Effect<void, WorkFileCapability.Error>
  request: (input: object, permission: Input["checkPermission"]) => Effect.Effect<{ value: unknown; bytes: Buffer }, WorkFileCapability.Error>
}>
export type Root = Readonly<{
  binding: typeof WorkAuthoritySchema.ProjectBinding.Type; bindingHash: string; controlRevision: number; helperHash: string
  current: Effect.Effect<void, WorkFileCapability.Error>
  currentBinding: Effect.Effect<void, WorkFileCapability.Error>
  openChannel: () => Effect.Effect<Channel, WorkFileCapability.Error>
}>
type Owned = { root: WorkFileCapability.Root; channel: Channel; original: Root; record: WorkWriteStageSchema.Record;
  stage: typeof Stage.Type; cleanupStarted: boolean; captured: boolean; description?: WorkFileCapability.WriteDescription }
const failure = (code: WorkFileCapability.Error["code"] = "WORK_FILE_UNAVAILABLE") => new WorkFileCapability.Error({
  code, message: "Original Windows write stage is unavailable, changed or retains unknown custody",
})
const fromWire = (identity: typeof WireIdentity.Type) => ({ kind: "windows" as const,
  volumeSerial: identity.volume_serial, fileID: identity.file_id })
const wire = (identity: WorkFileCapability.Identity) => identity.kind === "windows" ? {
  kind: "windows" as const, volume_serial: identity.volumeSerial, file_id: identity.fileID,
} : undefined
const same = (left: unknown, right: unknown) => CanonicalJson.stringify(left) === CanonicalJson.stringify(right)

/** Only the original WorkFileHelper Root supplies channel closures. A decoded
 * stage observation supplies facts, never the child/stage lifetime authority. */
export const make = Effect.fn("WindowsWorkWrite.make")(function* (lookup: (root: WorkFileCapability.Root) => Root | undefined) {
  const database = yield* Database.Service
  const global = yield* Global.Service
  const factory = yield* Effect.serviceOption(NativeWindowsWorkFactory.Service)
  const context = yield* Effect.context()
  const lifetime = { active: true }
  const owned = new WeakMap<WorkFileCapability.Root, Owned>()
  const observations = new WeakMap<WorkFileCapability.WriteObservation, Owned>()
  yield* Effect.addFinalizer(() => Effect.sync(() => { lifetime.active = false }))
  const available = Effect.gen(function* () {
    if (process.platform !== "win32" || !lifetime.active || Option.isNone(factory)) return yield* failure()
    yield* factory.value.current.pipe(Effect.mapError(() => failure("WORK_FILE_CHANGED")))
    return factory.value
  })
  const exchange = (channel: Channel, payload: object, permission: Input["checkPermission"]) => Effect.gen(function* () {
    const reply = yield* channel.request(payload, permission)
    const decoded = Schema.decodeUnknownOption(Reply, { onExcessProperty: "error" })(reply.value)
    if (reply.bytes.length !== 0 || Option.isNone(decoded)) return yield* failure("WORK_FILE_UNKNOWN")
    return decoded.value
  })
  const inspect = (state: Owned, permission: Input["checkPermission"]) => Effect.gen(function* () {
    const reply = yield* exchange(state.channel, { op: "inspect_write_stage", version: 1, id: randomUUID() }, permission)
    if (reply.status !== "stage_observed" || reply.code !== null || !reply.write_stage ||
      !same(reply.write_stage.root, wire(state.original.binding.projectScope.rootIdentity)) ||
      !same(reply.write_stage.stage, wire(state.record.stageIdentity!)) || reply.write_stage.directory !== state.stage.directory ||
      !same(reply.write_stage.data, state.stage.data) || !same(reply.write_stage.base, state.stage.base)) return yield* failure("WORK_FILE_UNKNOWN")
    state.stage = reply.write_stage
    return reply.write_stage
  })
  const capture = (state: Owned) => Effect.scoped(Effect.gen(function* () {
    const stage = yield* inspect(state, Effect.void)
    if (!["prepared", "refused"].includes(state.record.state) || stage.files.length > 1 ||
      stage.files.some((file) => file.relative !== "payload" || file.retained_unlinked || file.bytes > state.record.nextBytes) ||
      (state.record.state === "prepared" && (stage.files.length !== 1 || stage.files[0]?.bytes !== state.record.nextBytes ||
        stage.files[0]?.sha256 !== state.record.nextHash)))
      return yield* failure("WORK_FILE_UNKNOWN")
    const witness = yield* WorkToolPolicy.storageProducer("write", state.record.admissionID)
    if (!witness) return yield* failure("WORK_FILE_UNKNOWN")
    const native = yield* available
    const installation = yield* LocalAuthority.readInstallation.pipe(Effect.mapError(() => failure()))
    if (installation.instanceID !== state.record.instanceID) return yield* failure("WORK_FILE_UNKNOWN")
    const decoded = Schema.decodeUnknownOption(WorkStorageCleanupWindowsWriteSchema.Manifest, { onExcessProperty: "error" })({
      version: 2, target: native.description.target, purpose: "work_write", kind: "write", captureKind: "native_live",
      stagePhase: state.record.state === "prepared" ? "prepared_payload" : stage.files.length === 0 ? "refused_empty" : "refused_payload",
      admissionID: state.record.admissionID, instanceID: installation.instanceID, workID: state.record.workID,
      rootWorkID: state.record.rootWorkID, sessionID: state.record.sessionID, inputID: state.record.inputID,
      activityID: state.record.activityID, providerReceiptID: state.record.providerReceiptID, providerAttemptID: state.record.providerAttemptID,
      toolCallID: state.record.toolCallID, ownerToken: state.record.ownerToken, sessionClaimToken: state.record.sessionClaimToken,
      bindingHash: state.record.bindingHash, controlRevision: state.record.controlRevision, custodyID: state.record.stageID,
      sourceRequestHash: state.record.requestHash, helperHash: state.record.helperHash, snapshotHash: null,
      project: state.original.binding.projectScope.canonicalRoot, projectIdentity: state.record.rootIdentity,
      data: global.data, dataIdentity: fromWire(stage.data), baseIdentity: fromWire(stage.base), containerIdentity: fromWire(stage.stage),
      basename: state.record.basename, files: stage.files.map((file) => ({ relative: file.relative, identity: fromWire(file.identity),
        sha256: file.sha256, bytes: file.bytes, retainedUnlinked: file.retained_unlinked })),
      directories: [{ relative: "", identity: fromWire(stage.stage) }], createdAt: Date.now(),
    })
    if (Option.isNone(decoded)) return yield* failure("WORK_FILE_UNKNOWN")
    const manifest = decoded.value
    const secret = Buffer.from(installation.secret, "hex")
    const sign = (value: unknown) => createHmac("sha256", secret).update("dac-work-windows-write-manifest.v2\0")
      .update(CanonicalJson.stringify([installation.instanceID, value])).digest("hex")
    const prepared = Object.freeze(Object.create(null)) as WorkStorageCleanup.Prepared
    const authority = WorkStorageCleanup.Authority.of({
      prepareManifest: () => Effect.fail(WorkStorageCleanup.failure("STORAGE_UNSUPPORTED")),
      manifest: (tx, actual) => Effect.gen(function* () {
        if (!lifetime.active || actual !== prepared || !native.isCurrent()) return yield* WorkStorageCleanup.failure("STORAGE_UNAVAILABLE")
        const current = yield* WorkToolPolicy.requireStorageProducer(tx, witness, "write", state.record.admissionID)
        const record = yield* WorkWriteStage.get(tx, state.record.admissionID)
        if (!record || !same(record, state.record) || current.work.binding_hash !== manifest.bindingHash)
          return yield* WorkStorageCleanup.failure("STORAGE_CONFLICT")
        return { value: manifest, mac: sign(manifest) }
      }).pipe(Effect.mapError((error) => error instanceof WorkStorageCleanupSchema.Error ? error : WorkStorageCleanup.failure("STORAGE_UNAVAILABLE"))),
      verifyManifest: (value, stored) => Effect.gen(function* () {
        if (!lifetime.active || !Schema.is(WorkStorageCleanupWindowsWriteSchema.Manifest)(value) ||
          !Schema.is(WorkWriteStageSchema.Digest)(stored) || !timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(sign(value), "hex")))
          return yield* WorkStorageCleanup.failure("STORAGE_INVALID")
      }),
      prepare: () => Effect.fail(WorkStorageCleanup.failure("STORAGE_UNSUPPORTED")),
      current: () => Effect.fail(WorkStorageCleanup.failure("STORAGE_UNSUPPORTED")),
      execute: () => Effect.fail(WorkStorageCleanup.failure("STORAGE_UNSUPPORTED")),
      verifyJournal: () => Effect.fail(WorkStorageCleanup.failure("STORAGE_UNSUPPORTED")),
      verifyProof: () => Effect.fail(WorkStorageCleanup.failure("STORAGE_UNSUPPORTED")),
    })
    // Native IO and factory observation finish before the last short source
    // fence. SQL consumes the captured witness/current facts without remote IO.
    yield* state.original.currentBinding.pipe(Effect.andThen(WorkStorageCleanup.capture(database.db, prepared)
      .pipe(Effect.provideService(WorkStorageCleanup.Authority, authority))),
      Effect.mapError(() => failure("WORK_FILE_UNKNOWN")), Effect.ensuring(Effect.sync(() => secret.fill(0))))
    state.captured = true
  }).pipe(Effect.provide(context), Effect.mapError((error) => error instanceof WorkFileCapability.Error ? error : failure("WORK_FILE_UNKNOWN"))))
  return {
    write: (root: WorkFileCapability.Root, input: Input) => Effect.gen(function* () {
      const native = yield* available
      const current = lookup(root)
      const content = Buffer.from(input.content, "utf8")
      if (!current || owned.has(root) || current.binding.projectScope.rootIdentity.kind !== "windows" ||
        !Schema.is(WorkWindowsPathSchema.Relative)(input.relative) || !Schema.is(WorkWriteStageSchema.Expected)(input.expected) ||
        (input.expected.kind === "observed" && input.expected.identity.kind !== "windows") ||
        content.length > WorkWriteStageSchema.MAX_CONTENT_BYTES || content.toString("utf8") !== input.content) return yield* failure()
      const match = (rule: { kind: "file" | "tree"; path: string }) => input.relative === rule.path ||
        (rule.kind === "tree" && input.relative.startsWith(`${rule.path}/`))
      if (current.binding.toolPolicy.fileScope.deny.some(match) || !current.binding.toolPolicy.fileScope.write.some(match) ||
        content.length > current.binding.toolPolicy.fileScope.maxWriteBytes) return yield* failure()
      yield* current.current
      yield* input.checkPermission
      const channel = yield* current.openChannel()
      const capable = yield* exchange(channel, { op: "write_stage_capabilities", version: 1, id: randomUUID() }, input.checkPermission)
      if (capable.status !== "work_write_stage_v2" || capable.code !== null ||
        !same(capable.root, wire(current.binding.projectScope.rootIdentity)) || native.description.helper.sha256 !== current.helperHash)
        return yield* failure()
      const installation = yield* LocalAuthority.readInstallation.pipe(Effect.mapError(() => failure()))
      const basename = randomBytes(16).toString("hex")
      const directory = path.win32.join(global.data, "work-write-stage", basename)
      const prepareID = randomUUID()
      const expected = input.expected.kind === "missing" ? { kind: "missing" as const } : {
        kind: "observed" as const, identity: wire(input.expected.identity), sha256: input.expected.sha256, bytes: input.expected.bytes,
      }
      const payload = { op: "prepare_write", version: 1, id: prepareID, relative: input.relative,
        stage: directory, content: input.content, expected, deadline_ms: 10_000 }
      if (Buffer.byteLength(JSON.stringify(payload)) + 256 > 65_536) return yield* failure("WORK_FILE_CAPACITY")
      // The ordinary SQL meter reserves the worst old-file byte obligation.
      // Original held deny-WRITE handles prevent growth after the native pin;
      // cold unknown reservations are kept, never re-opened as live channels.
      yield* WorkWriteStage.custody(database.db, installation.instanceID).pipe(Effect.mapError(() => failure("WORK_FILE_CAPACITY")))
      yield* current.currentBinding
      const reserved = yield* WorkWriteStage.reserve(database.db, { stageID: `stage_${Hash.sha256(CanonicalJson.stringify([
        installation.instanceID, input.admissionID]))}`, instanceID: installation.instanceID,
        workID: current.binding.workID, rootWorkID: current.binding.rootWorkID, sessionID: current.binding.sessionID,
        inputID: current.binding.inputID, activityID: input.activityID, providerReceiptID: input.providerReceiptID,
        providerAttemptID: input.providerAttemptID, admissionID: input.admissionID, toolCallID: input.toolCallID,
        ownerToken: input.ownerToken, sessionClaimToken: input.sessionClaimToken, bindingHash: current.bindingHash,
        controlRevision: current.controlRevision, requestHash: Hash.sha256(CanonicalJson.stringify({ relative: input.relative,
          expected: input.expected, nextHash: Hash.sha256(content), nextBytes: content.length, admissionID: input.admissionID,
          definitionHash: input.definitionHash })), definitionHash: input.definitionHash, helperHash: current.helperHash,
        relative: input.relative, basename, rootIdentity: current.binding.projectScope.rootIdentity, expected: input.expected,
        nextHash: Hash.sha256(content), nextBytes: content.length,
      }).pipe(Effect.mapError((error) => failure(error.code === "WRITE_STAGE_CAPACITY" ? "WORK_FILE_CAPACITY" : "WORK_FILE_UNKNOWN")))
      if (reserved.replayed) return yield* failure("WORK_FILE_UNKNOWN")
      const stage = yield* exchange(channel, { op: "prepare_write_stage", version: 1, id: randomUUID(),
        data: global.data, basename }, input.checkPermission)
      if (stage.status !== "stage_ready" || stage.code !== null || !stage.write_stage || stage.write_stage.directory !== directory ||
        !same(stage.write_stage.root, wire(current.binding.projectScope.rootIdentity)) || stage.write_stage.retained_bytes !== 0 ||
        stage.write_stage.files.length !== 0) return yield* failure("WORK_FILE_UNKNOWN")
      yield* current.currentBinding
      const state: Owned = { root, channel, original: current, record: yield* WorkWriteStage.located(database.db, reserved.record,
        fromWire(stage.write_stage.stage)).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN"))),
        stage: stage.write_stage, cleanupStarted: false, captured: false }
      owned.set(root, state)
      const observe = (outcome: WorkFileCapability.WriteDescription["outcome"], identity: WorkFileCapability.Identity | null) => Effect.gen(function* () {
        const retained = yield* inspect(state, Effect.void)
        state.record = yield* WorkWriteStage.settled(database.db, state.record, outcome === "published" ? "published" : "refused",
          retained.retained_bytes).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
        if (outcome === "refused_before_publish" && !state.captured) yield* capture(state)
        state.description = Object.freeze({ record: state.record, outcome, fileIdentity: identity, observedAt: Date.now() })
        const observation = Object.freeze(Object.create(null)) as WorkFileCapability.WriteObservation
        observations.set(observation, state)
        return { observation, outcome }
      })
      const prepared = yield* exchange(channel, { ...payload, stage_identity: state.stage.stage }, input.checkPermission)
      if (prepared.status === "refused" && prepared.code === "FILE_SCOPE_UNAVAILABLE") return yield* observe("refused_before_publish", null)
      if (prepared.status !== "prepared" || prepared.code !== null || !prepared.preparation || !same(prepared.preparation.stage, state.stage.stage))
        return yield* failure("WORK_FILE_UNKNOWN")
      yield* current.currentBinding
      state.record = yield* WorkWriteStage.prepared(database.db, state.record, { parentIdentity: fromWire(prepared.preparation.parent),
        stageIdentity: fromWire(state.stage.stage) }).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
      yield* capture(state)
      yield* current.current
      yield* input.checkPermission
      yield* current.currentBinding
      state.record = yield* WorkWriteStage.beginPublication(database.db, state.record).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
      const published = yield* exchange(channel, { op: "publish_write", version: 1, id: randomUUID(), prepared_id: prepareID }, input.checkPermission)
      if (published.status === "refused" && published.code === "FILE_SCOPE_UNAVAILABLE") return yield* observe("refused_before_publish", null)
      if (published.status !== "published" || published.code !== null || !published.write || published.write.sha256 !== state.record.nextHash ||
        published.write.bytes !== state.record.nextBytes || !same(published.write.previous, expected) ||
        !same(published.write.parent, wire(state.record.parentIdentity!)) || !same(published.write.stage, state.stage.stage))
        return yield* failure("WORK_FILE_UNKNOWN")
      return yield* observe("published", fromWire(published.write.file))
    }).pipe(Effect.provide(context)),
    cleanupWrite: (root: WorkFileCapability.Root, observation: WorkFileCapability.WriteObservation) => Effect.gen(function* () {
      yield* available
      const state = observations.get(observation)
      if (!state || state.root !== root || owned.get(root) !== state || state.cleanupStarted || !state.description || !lookup(root)) return yield* failure()
      yield* state.original.current
      const actual = yield* WorkWriteStage.get(database.db, state.record.admissionID).pipe(Effect.mapError(() => failure()))
      if (!actual || !same(actual, state.record) || !["published", "refused"].includes(actual.state) || actual.releasedAt !== null) return yield* failure()
      yield* inspect(state, Effect.void)
      state.cleanupStarted = true
      const cleaned = yield* exchange(state.channel, { op: "cleanup_write", version: 1, id: randomUUID() }, Effect.void)
      if (cleaned.status !== "cleaned" || cleaned.code !== null) return yield* failure("WORK_FILE_UNKNOWN")
      // Only the original helper's exact stage/old-handle retirement permits
      // the SQL quota release. Unknown or historical records never reach here.
      yield* WorkWriteStage.released(database.db, actual).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
    }).pipe(Effect.provide(context)),
    describeWrite: (root: WorkFileCapability.Root, observation: WorkFileCapability.WriteObservation) => {
      const state = observations.get(observation)
      return lifetime.active && lookup(root) && state?.root === root && owned.get(root) === state ? state.description : undefined
    },
  }
})
