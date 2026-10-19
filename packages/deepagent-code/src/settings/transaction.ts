export * as SettingsTransaction from "./transaction"

import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { Global } from "@deepagent-code/core/global"
import { ConfigFileWrite } from "../config/file-write"
import { SettingsStore } from "./store"
import { SettingsPrivateFile } from "./private-file"

export class Error extends globalThis.Error {
  readonly _tag = "SettingsTransactionError"
  constructor(readonly reason: "unknown" | "changed" | "invalid" | "unavailable" | "capacity") {
    super(
      reason === "unknown"
        ? "Settings change is partially committed. Retry the same change to reconcile the original files."
        : `Settings transaction ${reason}`,
    )
  }
}

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const State = Schema.Struct({ before: Schema.NullOr(Hash), after: Schema.NullOr(Hash) })
const Operation = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  requestHash: Hash,
  config: Schema.NullOr(Schema.Struct({ path: Schema.String, ...State.fields })),
  settings: State,
  createdAt: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
})
const Receipt = Schema.Struct({ version: Schema.Literal(1), id: Schema.String, operationHash: Hash })
type Operation = typeof Operation.Type
type Plan<A> = {
  readonly config?: { readonly file: ConfigFileWrite.File; readonly text: string }
  readonly settings: SettingsStore.Settings
  readonly value: A
}

export const paths = () => ({
  settings: SettingsStore.file(),
  operation: path.join(Global.Path.config, ".settings-operation.json"),
  receipt: path.join(Global.Path.config, ".settings-receipt.json"),
})

/** The two fixed journals are written once each in this lock window. This is a recoverable
 * file protocol, not a multi-file atomic rename or an authorization/credential receipt. */
type Input<A> = {
  readonly request: unknown
  readonly prepare: (tx: ConfigFileWrite.Transaction, settings: SettingsStore.Settings) => Plan<A>
}

export const apply = <A>(input: Input<A> & { readonly files: readonly string[] }) => {
  const names = paths()
  return ConfigFileWrite.transaction(
    [...input.files, ...globalFiles(), names.settings, names.operation, names.receipt],
    (tx) => applyIn(tx, input),
  )
}

/** Reuse the same protocol inside a caller's canonical transaction. The caller must
 * include globalFiles() and all paths() leaves in that transaction's lock set. */
export const applyIn = <A>(tx: ConfigFileWrite.Transaction, input: Input<A>) => {
  const names = paths()
  return Effect.gen(function* () {
    const current = yield* SettingsPrivateFile.readEffect(names.settings).pipe(Effect.mapError(privateError))
    if ((current?.hash ?? null) !== (ConfigFileWrite.digest(tx.file(names.settings)) ?? null))
      return yield* Effect.fail(new Error("changed"))
    const settings = SettingsStore.decode(current?.text)
    const original = yield* journals(
      names,
      globalFiles().map((file) => tx.file(file).path),
    )
    // Preparation includes all caller schema/source checks before the intent or settings write.
    const plan = yield* Effect.try({ try: () => input.prepare(tx, settings), catch: (error) => error }).pipe(
      Effect.catch((error) => Effect.die(error)),
    )
    const text =
      JSON.stringify(settings) === JSON.stringify(plan.settings) ? current?.text : SettingsStore.encode(plan.settings)
    const settingsHash = text === undefined ? null : digest(text)
    const request = JSON.stringify(["dac.settings.cross-store.request.v1", canonical(input.request)])
    if (Buffer.byteLength(request, "utf8") > 16_777_216) return yield* Effect.fail(new Error("capacity"))
    const requestHash = digest(request)
    const config = plan.config && {
      path: plan.config.file.path,
      before: plan.config.file.stamp?.digest ?? null,
      after: digest(plan.config.text),
    }
    const priorStates = original.operation
      ? [
          { current: current?.hash ?? null, expected: original.operation.settings },
          ...(original.operation.config
            ? [
                {
                  current: tx.file(original.operation.config.path).stamp?.digest ?? null,
                  expected: original.operation.config,
                },
              ]
            : []),
        ]
      : []
    const priorMatches = original.operation && priorStates.every((state) => state.current === state.expected.after)
    const reconcile =
      original.operation &&
      (!completed(original.operation, original.receipt) ||
        (!priorMatches &&
          priorStates.every(
            (state) => state.current === state.expected.before || state.current === state.expected.after,
          )))
    const pending =
      original.operation && reconcile && (original.operation.requestHash === requestHash || !priorMatches)
        ? original.operation
        : undefined
    if (pending && pending.requestHash !== requestHash) return yield* Effect.fail(new Error("unknown"))
    if (pending && pending.config?.path !== config?.path) return yield* Effect.fail(new Error("changed"))
    const operation = pending ?? {
      version: 1 as const,
      id: randomUUID(),
      requestHash,
      config: config ?? null,
      settings: { before: current?.hash ?? null, after: settingsHash },
      createdAt: Date.now(),
    }
    if (pending && (operation.settings.after !== settingsHash || operation.config?.after !== config?.after))
      return yield* Effect.fail(new Error("changed"))
    if (
      operation.config &&
      !globalFiles()
        .map((file) => tx.file(file).path)
        .includes(operation.config.path)
    )
      return yield* Effect.fail(new Error("invalid"))
    const states = [
      { current: current?.hash ?? null, expected: operation.settings },
      ...(operation.config ? [{ current: plan.config?.file.stamp?.digest ?? null, expected: operation.config }] : []),
    ]
    if (
      pending &&
      states.some((state) => state.current !== state.expected.before && state.current !== state.expected.after)
    )
      return yield* Effect.fail(new Error("changed"))
    const changed = states.some((state) => state.current !== state.expected.after)
    // An exact completed retry verifies both real files, not the completion marker alone.
    if (
      !pending &&
      original.operation?.requestHash === requestHash &&
      completed(original.operation, original.receipt)
    ) {
      if (
        original.operation.settings.after !== (current?.hash ?? null) ||
        original.operation.config?.after !== (plan.config?.file.stamp?.digest ?? undefined)
      )
        return yield* Effect.fail(new Error("changed"))
      return { value: plan.value, changed: false, settings }
    }
    if (!changed && !pending) return { value: plan.value, changed: false, settings }
    yield* SettingsPrivateFile.parentEffect(names.settings).pipe(Effect.mapError(privateError))
    if (!pending) yield* tx.write(tx.file(names.operation), JSON.stringify(operation))
    // All post-intent failures keep the durable intent; there is no compensating overwrite.
    return yield* Effect.gen(function* () {
      if (text !== undefined && (current?.hash ?? null) !== operation.settings.after)
        yield* tx.write(tx.file(names.settings), text)
      if (plan.config && plan.config.file.stamp?.digest !== operation.config?.after)
        yield* tx.write(plan.config.file, plan.config.text)
      const actualSettings = yield* SettingsPrivateFile.readEffect(names.settings).pipe(Effect.mapError(privateError))
      const actualConfig = plan.config ? yield* ConfigFileWrite.read(plan.config.file.path) : undefined
      if (!matches(operation, actualSettings?.hash ?? null, actualConfig?.stamp?.digest))
        return yield* Effect.fail(new Error("changed"))
      const receipt = { version: 1, id: operation.id, operationHash: digest(JSON.stringify(operation)) }
      yield* tx.write(tx.file(names.receipt), JSON.stringify(receipt))
      const actual = yield* journals(
        names,
        globalFiles().map((file) => tx.file(file).path),
      )
      if (
        !actual.operation ||
        !completed(actual.operation, actual.receipt) ||
        digest(JSON.stringify(actual.operation)) !== digest(JSON.stringify(operation))
      )
        return yield* Effect.fail(new Error("changed"))
      SettingsStore.invalidate()
      return { value: plan.value, changed, settings: plan.settings }
    }).pipe(
      Effect.catchCause(() => {
        if (process.platform === "win32") console.warn("Settings boundary stage=post-intent outcome=unknown")
        return Effect.fail(new Error("unknown"))
      }),
    )
  })
}

/** Cold and normal reads never repair files. A partial intent gives a safe, retryable error. */
export const requireSettledEffect = Effect.gen(function* () {
  const current = yield* journals(paths())
  if (!current.operation) return
  const settings = yield* SettingsPrivateFile.readEffect(paths().settings).pipe(Effect.mapError(privateError))
  const config = current.operation.config ? yield* ConfigFileWrite.read(current.operation.config.path) : undefined
  const after = yield* journals(paths())
  if (
    digest(JSON.stringify(current)) !== digest(JSON.stringify(after)) ||
    !matches(current.operation, settings?.hash ?? null, config?.stamp?.digest)
  )
    return yield* Effect.fail(new Error("unknown"))
})

export async function requireSettled() {
  const exit = await Effect.runPromiseExit(requireSettledEffect)
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
}

const journals = (names: ReturnType<typeof paths>, configPaths?: readonly string[]) =>
  Effect.gen(function* () {
    const operation = yield* SettingsPrivateFile.readEffect(names.operation).pipe(Effect.mapError(privateError))
    const receipt = yield* SettingsPrivateFile.readEffect(names.receipt).pipe(Effect.mapError(privateError))
    // Transactions store their canonical file identity, including POSIX parent aliases.
    // Cold reads derive the same bounded trusted candidates instead of trusting journal paths.
    const allowed =
      configPaths ??
      (operation
        ? yield* Effect.forEach(globalFiles(), (file) =>
            ConfigFileWrite.read(file).pipe(Effect.map((current) => current.path)),
          )
        : [])
    return yield* Effect.try({
      try: () => decodeJournals(operation?.text, receipt?.text, allowed),
      catch: privateError,
    })
  })

function decodeJournals(operation: string | undefined, receipt: string | undefined, configPaths: readonly string[]) {
  const decode = <A>(schema: Schema.Decoder<A, never>, text: string | undefined) => {
    if (text === undefined) return undefined
    const parsed = Option.flatMap(
      Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text),
      Schema.decodeUnknownOption(schema, { onExcessProperty: "error" }),
    )
    if (Option.isNone(parsed)) throw new Error("invalid")
    return parsed.value
  }
  const original = decode(Operation, operation)
  const done = decode(Receipt, receipt)
  if (!original && done) throw new Error("invalid")
  if (original && (original.id.length > 128 || (original.config && !configPaths.includes(original.config.path))))
    throw new Error("invalid")
  return { operation: original, receipt: done }
}

export function globalFiles() {
  return ["config.jsonc", "config.json", "deepagent-code.jsonc", "deepagent-code.json"].map((name) =>
    path.join(Global.Path.config, name),
  )
}

function matches(operation: Operation, settingsHash: string | null, configHash: string | null | undefined) {
  return operation.settings.after === settingsHash && operation.config?.after === configHash
}

function completed(operation: Operation, receipt: typeof Receipt.Type | undefined) {
  return receipt?.id === operation.id && receipt.operationHash === digest(JSON.stringify(operation))
}

function digest(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function canonical(value: unknown, depth = 0, budget = { nodes: 0 }): readonly unknown[] {
  if (depth > 64 || ++budget.nodes > 100_000) throw new Error("capacity")
  if (value === undefined) return ["undefined"]
  if (value === null) return ["null"]
  if (Array.isArray(value)) return ["array", value.map((item) => canonical(item, depth + 1, budget))]
  if (typeof value === "object")
    return [
      "object",
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item, depth + 1, budget)]),
    ]
  if (["string", "number", "boolean"].includes(typeof value)) return [typeof value, value]
  throw new Error("invalid")
}

function privateError(error: unknown) {
  return error instanceof Error
    ? error
    : new Error(error instanceof SettingsPrivateFile.Error ? error.reason : "unavailable")
}
