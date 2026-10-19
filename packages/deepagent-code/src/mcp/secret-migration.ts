export * as McpSecretMigration from "./secret-migration"

import path from "node:path"
import fs from "node:fs/promises"
import { randomBytes, createHash } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { modify, applyEdits } from "jsonc-parser"
import { Global } from "@deepagent-code/core/global"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { ConfigFileWrite } from "@/config/file-write"
import { Config } from "@/config/config"
import { SettingsTransaction } from "@/settings/transaction"
import { SecretStore } from "./secret-store"
import { SecretRefScope } from "./secret-ref-scope"
import { McpAuthStore } from "./auth-store"
import { McpWindowsStorage } from "./windows-storage"

export class Error extends Schema.TaggedErrorClass<Error>()("McpSecretMigrationError", {
  reason: Schema.Literals(["unavailable", "invalid", "changed", "unknown", "capacity", "work_unsettled"]),
}) {
  override get message() {
    return `MCP credential migration ${this.reason}`
  }
}
const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const Tag = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Stamp = Schema.Struct({
  device: Schema.Number,
  inode: Schema.Number,
  bytes: Schema.Number,
  mtime: Schema.Number,
  ctime: Schema.Number,
  mode: Schema.Number,
  digest: Tag,
})
const Move = Schema.Struct({ field: SecretRefScope.Field, key: Label, account: Schema.String, valueTag: Tag })
const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  requestID: Label,
  binding: SecretRefScope.Binding,
  before: Schema.Struct({ path: Schema.String, stamp: Schema.optional(Stamp) }),
  afterDigest: Tag,
  moves: Schema.Array(Move).check(Schema.isMaxLength(32)),
  state: Schema.Literals(["prepared", "stored", "committed", "changed"]),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
type Receipt = typeof Receipt.Type
const Ledger = Schema.Struct({
  version: Schema.Literal(1),
  receipts: Schema.Array(Receipt).check(Schema.isMaxLength(128)),
})
type Ledger = typeof Ledger.Type
export type Status = Readonly<{ requestID: string; name: string; state: Receipt["state"]; moved: number }>
export type Preview = Readonly<{
  previewID: string
  name: string
  source: string
  fields: readonly { field: SecretRefScope.Field; key: string }[]
}>
export interface Interface {
  readonly initialize: (name: string) => Effect.Effect<Readonly<{ name: string; source: string }>, Error>
  readonly previewBinding: (
    name: string,
  ) => Effect.Effect<SecretRefScope.BindingRepairPreview & Readonly<{ previewID: string }>, Error>
  readonly repairBinding: (
    previewID: string,
    name?: string,
  ) => Effect.Effect<Readonly<{ name: string; source: string; state: "repaired" }>, Error>
  readonly preview: (name: string) => Effect.Effect<Preview, Error>
  readonly commit: (input: { previewID: string; requestID: string; name?: string }) => Effect.Effect<Status, Error>
  readonly status: (requestID: string, name?: string) => Effect.Effect<Status | undefined, Error>
  readonly reconcile: (requestID: string, name?: string) => Effect.Effect<Status, Error>
  readonly resolveValue: (
    name: string,
    field: SecretRefScope.Field,
    key: string,
    value: string,
  ) => Effect.Effect<string | undefined, Error>
  readonly resolveRecord: (
    name: string,
    field: "environment" | "headers",
    record?: Record<string, string>,
  ) => Effect.Effect<Record<string, string>, Error>
}
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/McpSecretMigration") {}
export const ledgerPath = () => path.join(Global.Path.config, "mcp-secret-migration.json")
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scopes = yield* SecretRefScope.Service
    const store = yield* SecretStore.Service
    const config = yield* Config.Service
    const flock = yield* EffectFlock.Service
    const filesystem = yield* FSUtil.Service
    const windows = yield* McpWindowsStorage.Current
    const previews = new Map<
      string,
      { captured: SecretRefScope.Capture; fields: Preview["fields"]; expiresAt: number }
    >()
    const bindingPreviews = new Map<string, { captured: SecretRefScope.RepairCapture; expiresAt: number }>()
    const fileWrite = <A, E>(effect: Effect.Effect<A, E, EffectFlock.Service | FSUtil.Service>) =>
      effect.pipe(Effect.provideService(EffectFlock.Service, flock), Effect.provideService(FSUtil.Service, filesystem))
    const capture = (name: string, initialize = false) =>
      scopes.capture(name, initialize).pipe(
        Effect.mapError(safeError),
        Effect.flatMap((captured) =>
          // Receipt v1 persists ordinary file stamps. Never discard an original
          // Native witness or start storing secrets for an unsupported source.
          captured.file.nativeStamp ? Effect.fail(new Error({ reason: "unavailable" })) : Effect.succeed(captured),
        ),
      )
    const withLedger = <A>(body: (ledger: Ledger) => { ledger?: Ledger; value: A }) =>
      ConfigFileWrite.transaction([ledgerPath()], (tx) =>
        Effect.gen(function* () {
          const before = yield* safePromise(() => readLedger(windows))
          const result = yield* Effect.try({ try: () => body(before), catch: safeError })
          if (result.ledger) yield* tx.write(tx.file(ledgerPath()), encode(result.ledger))
          return result.value
        }),
      ).pipe(fileWrite, Effect.mapError(safeError))
    const update = (receipt: Receipt, state: Receipt["state"]) =>
      withLedger((ledger) => {
        const original = ledger.receipts.find((item) => item.requestID === receipt.requestID)
        if (!original || !same(original.binding, receipt.binding) || !same(original.moves, receipt.moves))
          throw new Error({ reason: "changed" })
        const next = { ...original, state, updatedAt: Date.now() }
        return {
          ledger: {
            ...ledger,
            receipts: ledger.receipts.map((item) => (item.requestID === next.requestID ? next : item)),
          },
          value: next,
        }
      })
    const stored = (receipt: Receipt, captured: SecretRefScope.Capture) =>
      Effect.gen(function* () {
        for (const move of receipt.moves) {
          const permit = yield* Effect.try({
            try: () => SecretRefScope.permit(captured, move.field, move.key, move.account),
            catch: safeError,
          })
          const actual = yield* store.resolveScoped(permit).pipe(Effect.mapError(safeError))
          if (actual === undefined || SecretRefScope.tag(captured, "value", actual) !== move.valueTag)
            return yield* new Error({ reason: "unknown" })
        }
      })
    const finish = (receipt: Receipt) =>
      Effect.gen(function* () {
        const captured = yield* capture(receipt.binding.name)
        if (!same(captured.binding, receipt.binding)) return yield* new Error({ reason: "changed" })
        yield* stored(receipt, captured)
        const globalFiles = SettingsTransaction.globalFiles()
        const global = (yield* Effect.forEach(globalFiles, ConfigFileWrite.read).pipe(Effect.mapError(safeError))).some(
          (file) => file.path === captured.file.path,
        )
        // A later legitimate sibling migration changes the whole-file digest. An already
        // committed exact retry requires its own current fields and store witnesses only.
        if (receipt.state === "committed") {
          if (!matchesMoves(captured, receipt)) return yield* new Error({ reason: "changed" })
          if (global) yield* SettingsTransaction.requireSettledEffect.pipe(Effect.mapError(safeError))
          return summary(receipt)
        }
        const published = digest(captured.file.text ?? "") === receipt.afterDigest
        if (published) {
          if (!matchesMoves(captured, receipt)) return yield* new Error({ reason: "changed" })
          if (!global) {
            const committed = yield* update(receipt, "committed")
            return summary(committed)
          }
        }
        if (!published && !ConfigFileWrite.sameObservation(captured.file, receipt.before))
          return yield* new Error({ reason: "changed" })
        const next = published ? captured.file.text! : patch(captured.file.text!, receipt)
        if (digest(next) !== receipt.afterDigest) return yield* new Error({ reason: "changed" })
        const state = yield* ConfigFileWrite.transaction(
          [
            captured.file.path,
            ledgerPath(),
            ...(global ? [...globalFiles, ...Object.values(SettingsTransaction.paths())] : []),
          ],
          (tx) =>
            Effect.gen(function* () {
              const current = tx.file(captured.file.path)
              if (
                published
                  ? digest(current.text ?? "") !== receipt.afterDigest
                  : !ConfigFileWrite.sameObservation(current, receipt.before)
              )
                return yield* new Error({ reason: "changed" })
              const before = yield* safePromise(() => readLedger(windows))
              const known = before.receipts.find((item) => item.requestID === receipt.requestID)
              if (
                !known ||
                !same(known.binding, receipt.binding) ||
                !same(known.moves, receipt.moves) ||
                known.state === "changed"
              )
                return yield* new Error({ reason: "changed" })
              const fresh = yield* capture(receipt.binding.name)
              if (!same(fresh.binding, receipt.binding)) return yield* new Error({ reason: "changed" })
              yield* stored(receipt, fresh)
              if (published && !matchesMoves(fresh, receipt)) return yield* new Error({ reason: "changed" })
              if (global)
                yield* SettingsTransaction.applyIn(tx, {
                  request: { kind: "mcp_secret_migration", requestID: receipt.requestID },
                  prepare: (tx, settings) => ({
                    config: { file: tx.file(current.path), text: next },
                    settings,
                    value: undefined,
                  }),
                })
              if (!global) yield* tx.write(current, next)
              const committed: Receipt = { ...known, state: "committed", updatedAt: Date.now() }
              // Config publication precedes the receipt commit. Its uncertain gap is reconciled by
              // the exact after digest and scoped-store verification, never a blind second put.
              yield* tx.write(
                tx.file(ledgerPath()),
                encode({
                  ...before,
                  receipts: before.receipts.map((item) => (item.requestID === receipt.requestID ? committed : item)),
                }),
              )
              return committed
            }),
        ).pipe(fileWrite, Effect.mapError(safeError), Effect.uninterruptible)
        yield* config.invalidate()
        return summary(state)
      })
    const readAuthorized = (requestID: string, name?: string) =>
      Effect.gen(function* () {
        const ledger = yield* safePromise(() => readLedger(windows))
        const receipt = ledger.receipts.find((item) => item.requestID === requestID)
        if (!receipt) return undefined
        if (name !== undefined && name !== receipt.binding.name) return yield* new Error({ reason: "changed" })
        const captured = yield* capture(receipt.binding.name)
        if (!same(captured.binding, receipt.binding)) return yield* new Error({ reason: "changed" })
        return { receipt, captured }
      })
    const resolveValue = (
      name: string,
      field: SecretRefScope.Field,
      key: string,
      value: string,
    ): Effect.Effect<string | undefined, Error> =>
      Effect.gen(function* () {
        if (!SecretStore.isScoped(value)) return yield* SecretStore.resolveValue(value, store)
        const captured = yield* capture(name)
        if (SecretRefScope.value(captured, field, key) !== value) return yield* new Error({ reason: "changed" })
        const account = SecretStore.handleAccount(value)
        const ledger = yield* safePromise(() => readLedger(windows))
        const receipt = ledger.receipts.find(
          (item) =>
            item.state === "committed" &&
            same(item.binding, captured.binding) &&
            item.moves.some((move) => move.field === field && move.key === key && move.account === account),
        )
        const move = receipt?.moves.find((move) => move.field === field && move.key === key && move.account === account)
        if (!receipt || !move) return yield* new Error({ reason: "changed" })
        const permit = yield* Effect.try({
          try: () => SecretRefScope.permit(captured, field, key, account),
          catch: safeError,
        })
        const secret = yield* store.resolveScoped(permit).pipe(Effect.mapError(safeError))
        if (secret === undefined || SecretRefScope.tag(captured, "value", secret) !== move.valueTag)
          return yield* new Error({ reason: "unavailable" })
        const after = yield* capture(name)
        if (!same(captured.binding, after.binding) || !ConfigFileWrite.sameObservation(captured.file, after.file))
          return yield* new Error({ reason: "changed" })
        return secret
      })
    return Service.of({
      initialize: (name) => capture(name, true).pipe(Effect.map((captured) => ({ name, source: captured.file.path }))),
      previewBinding: (name) =>
        Effect.gen(function* () {
          const captured = yield* scopes.inspectBinding(name).pipe(Effect.mapError(safeError))
          for (const [key, value] of bindingPreviews) if (value.expiresAt <= Date.now()) bindingPreviews.delete(key)
          if (bindingPreviews.size >= 8) return yield* new Error({ reason: "capacity" })
          const previewID = randomBytes(16).toString("hex")
          bindingPreviews.set(previewID, { captured, expiresAt: Date.now() + 300_000 })
          return { ...captured.preview, previewID }
        }),
      repairBinding: (previewID, name) =>
        Effect.gen(function* () {
          const preview = bindingPreviews.get(previewID)
          if (!preview || preview.expiresAt <= Date.now()) return yield* new Error({ reason: "unavailable" })
          if (name !== undefined && name !== preview.captured.preview.name)
            return yield* new Error({ reason: "changed" })
          const result = yield* scopes.repairBinding(preview.captured).pipe(Effect.mapError(safeError))
          bindingPreviews.delete(previewID)
          return result
        }),
      preview: (name) =>
        Effect.gen(function* () {
          const captured = yield* capture(name)
          const fields = candidates(captured)
          const previewID = randomBytes(16).toString("hex")
          for (const [key, value] of previews) if (value.expiresAt <= Date.now()) previews.delete(key)
          if (previews.size >= 8) return yield* new Error({ reason: "capacity" })
          previews.set(previewID, { captured, fields, expiresAt: Date.now() + 300_000 })
          return { previewID, name, source: captured.file.path, fields }
        }),
      commit: (input) =>
        Effect.gen(function* () {
          if (!Schema.is(Label)(input.requestID)) return yield* new Error({ reason: "invalid" })
          const existing = yield* readAuthorized(input.requestID, input.name)
          if (existing) {
            const supplied = previews.get(input.previewID)
            if (supplied && !same(supplied.captured.binding, existing.receipt.binding))
              return yield* new Error({ reason: "changed" })
            return yield* finish(existing.receipt)
          }
          const preview = previews.get(input.previewID)
          if (!preview || preview.expiresAt <= Date.now()) return yield* new Error({ reason: "unavailable" })
          if (input.name !== undefined && input.name !== preview.captured.binding.name)
            return yield* new Error({ reason: "changed" })
          const captured = yield* capture(preview.captured.binding.name)
          if (
            !same(captured.binding, preview.captured.binding) ||
            !ConfigFileWrite.sameObservation(captured.file, preview.captured.file)
          )
            return yield* new Error({ reason: "changed" })
          const values = yield* Effect.forEach(preview.fields, (field) =>
            Effect.gen(function* () {
              const original = SecretRefScope.value(captured, field.field, field.key)
              if (original === undefined) return yield* new Error({ reason: "changed" })
              const value = yield* SecretStore.resolveValue(original, store)
              if (value === undefined) return yield* new Error({ reason: "unavailable" })
              return {
                ...field,
                value,
                account: `${SecretRefScope.prefix(captured, field.field, field.key)}${randomBytes(16).toString("hex")}`,
              }
            }),
          )
          const prepared: Receipt = {
            version: 1,
            requestID: input.requestID,
            binding: captured.binding,
            before: { path: captured.file.path, stamp: captured.file.stamp },
            afterDigest: "0".repeat(64),
            moves: values.map((move) => ({
              field: move.field,
              key: move.key,
              account: move.account,
              valueTag: SecretRefScope.tag(captured, "value", move.value),
            })),
            state: "prepared",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          const receipt = { ...prepared, afterDigest: digest(patch(captured.file.text!, prepared)) }
          const reserved = yield* withLedger((ledger) => {
            const old = ledger.receipts.find((item) => item.requestID === input.requestID)
            if (old) {
              if (!same(old.binding, receipt.binding) || !same(old.before, receipt.before))
                throw new Error({ reason: "changed" })
              return { value: { receipt: old, fresh: false } }
            }
            return { ledger: { ...ledger, receipts: [...ledger.receipts, receipt] }, value: { receipt, fresh: true } }
          })
          if (!reserved.fresh) return yield* finish(reserved.receipt)
          for (const move of values) {
            const current = yield* capture(captured.binding.name)
            if (
              !same(current.binding, captured.binding) ||
              !ConfigFileWrite.sameObservation(current.file, receipt.before)
            )
              return yield* new Error({ reason: "changed" })
            const permit = yield* Effect.try({
              try: () => SecretRefScope.permit(current, move.field, move.key, move.account),
              catch: safeError,
            })
            yield* store.putScoped(permit, move.value).pipe(Effect.mapError(safeError))
          }
          yield* stored(receipt, captured)
          const persisted = yield* update(receipt, "stored")
          return yield* finish(persisted)
        }),
      status: (requestID, name) =>
        readAuthorized(requestID, name).pipe(Effect.map((value) => (value ? summary(value.receipt) : undefined))),
      reconcile: (requestID, name) =>
        Effect.gen(function* () {
          const value = yield* readAuthorized(requestID, name)
          if (!value) return yield* new Error({ reason: "unavailable" })
          return yield* finish(value.receipt)
        }),
      resolveValue,
      resolveRecord: (name, field, record) =>
        Effect.gen(function* () {
          const values = yield* Effect.forEach(Object.entries(record ?? {}), ([key, value]) =>
            resolveValue(name, field, key, value).pipe(
              Effect.map((value) => (value === undefined ? undefined : ([key, value] as const))),
            ),
          )
          return Object.fromEntries(values.filter((value) => value !== undefined))
        }),
    })
  }),
)
export const defaultLayer = layer.pipe(
  Layer.provide(SecretRefScope.defaultLayer),
  Layer.provide(SecretStore.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
)

function safeError(error: unknown) {
  if (error instanceof Error) return error
  if (error instanceof ConfigFileWrite.Error || error instanceof SettingsTransaction.Error)
    return new Error({
      reason:
        error.reason === "changed" ||
        error.reason === "unknown" ||
        error.reason === "capacity" ||
        error.reason === "invalid"
          ? error.reason
          : "unavailable",
    })
  if (error instanceof SecretRefScope.Error && (error.reason === "changed" || error.reason === "work_unsettled"))
    return new Error({ reason: error.reason })
  return new Error({ reason: "unavailable" })
}
function safePromise<A>(body: () => Promise<A>) {
  return Effect.tryPromise({ try: body, catch: safeError })
}
function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}
function digest(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}
function summary(receipt: Receipt): Status {
  return {
    requestID: receipt.requestID,
    name: receipt.binding.name,
    state: receipt.state,
    moved: receipt.state === "committed" ? receipt.moves.length : 0,
  }
}
function candidates(captured: SecretRefScope.Capture) {
  const keys = SecretStore.catalogSecretEnvKeys()
  const headers = new Set(["authorization", "x-api-key", "api-key"])
  const fields = (["environment", "headers", "oauth"] as const).flatMap((field) => {
    const value = captured.entry[field]
    if (!value || typeof value !== "object" || Array.isArray(value)) return []
    return Object.entries(value).flatMap(([key, value]) =>
      typeof value === "string" &&
      !SecretStore.containsEnvRef(value) &&
      !SecretStore.isScoped(value) &&
      (field === "environment"
        ? keys.has(key) || SecretStore.isHandle(value)
        : field === "headers"
          ? headers.has(key.toLowerCase()) || SecretStore.isHandle(value)
          : key === "clientSecret")
        ? [{ field, key }]
        : [],
    )
  })
  if (fields.length > 32) throw new Error({ reason: "capacity" })
  return fields
}
function patch(text: string, receipt: Receipt) {
  return receipt.moves.reduce(
    (text, move) =>
      applyEdits(
        text,
        modify(text, ["mcp", receipt.binding.name, move.field, move.key], SecretStore.makeHandle(move.account), {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      ),
    text,
  )
}
function matchesMoves(captured: SecretRefScope.Capture, receipt: Receipt) {
  return receipt.moves.every(
    (move) => SecretRefScope.value(captured, move.field, move.key) === SecretStore.makeHandle(move.account),
  )
}
async function readLedger(windows?: McpWindowsStorage.Port): Promise<Ledger> {
  if (process.platform === "win32") {
    if (!windows) throw new Error({ reason: "unavailable" })
    const current = await windows.read("mcp_secret_migration")
    return current
      ? Schema.decodeUnknownSync(Schema.fromJsonString(Ledger), { onExcessProperty: "error" })(current.text)
      : { version: 1, receipts: [] }
  }
  const parent = await fs.lstat(path.dirname(ledgerPath())).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!parent) return { version: 1, receipts: [] }
  const current = await McpAuthStore.read(ledgerPath())
  if (!current) return { version: 1, receipts: [] }
  return Schema.decodeUnknownSync(Schema.fromJsonString(Ledger), { onExcessProperty: "error" })(current.text)
}
function encode(ledger: Ledger) {
  const text = Schema.encodeSync(Schema.fromJsonString(Ledger))(ledger)
  if (Buffer.byteLength(text) > McpAuthStore.MAX_BYTES) throw new Error({ reason: "capacity" })
  return text
}
