import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Cause, Effect, Exit } from "effect"
import { Global } from "@deepagent-code/core/global"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { ConfigFileWrite } from "@/config/file-write"
import { SettingsStore } from "@/settings/store"
import { SettingsTransaction } from "@/settings/transaction"
import { WindowsSettingsStorage } from "@/installation/windows-settings-storage"
import { WindowsPrivateStorage } from "@/installation/windows-private-storage"

const beforeConfig = '// original fixture comment\r\n{"model":"fixture/before"}\r\n'
const afterConfig = '// original fixture comment\r\n{"model":"fixture/after"}\r\n'
const beforeSettings = { deepagent: { agentMode: "general" as const, selfLearning: "manual" as const } }
const afterSettings = { deepagent: { agentMode: "high" as const, selfLearning: "auto" as const } }
const request = { version: 1, fixture: "windows-real-cross-store-partial-restart", model: "fixture/after", agentMode: "high" }

/** The original sealed utilityProcess supplies the real scoped Bootstrap Service and
 * WindowsSettingsStorage layer. This fixture never constructs a Registered port. */
export const run = (phase: "partial" | "restart") => Effect.gen(function* () {
  if (process.platform !== "win32" || !process.env.DEEPAGENT_CODE_TEST_HOME)
    throw new Error("Windows scoped fixture sandbox required")
  const original = yield* WindowsSettingsStorage.Current
  if (!original) throw new Error("Original Windows settings adapter required")
  const config = path.join(Global.Path.config, "config.jsonc")
  const events: { published: string[]; interrupted: boolean } = { published: [], interrupted: false }
  // All bytes and witnesses still come from the original Native held-handle port.
  // One fault is injected only after the actual settings namespace publication.
  const observed: WindowsSettingsStorage.Port = {
    read: original.read,
    parent: original.parent,
    publish: (name, text, expected) => original.publish(name, text, expected).pipe(
      Effect.flatMap((witness) => {
        events.published.push(name)
        if (phase === "partial" && name === "settings.json" && !events.interrupted) {
          events.interrupted = true
          return Effect.fail(new WindowsPrivateStorage.Error({ reason: "unknown" }))
        }
        return Effect.succeed(witness)
      }),
    ),
  }
  const apply = SettingsTransaction.apply({ files: [config], request,
    prepare: (tx) => ({ config: { file: tx.file(config), text: afterConfig }, settings: afterSettings, value: "joint" }) })
    .pipe(Effect.provideService(WindowsSettingsStorage.Current, observed),
      Effect.provide(FSUtil.defaultLayer), Effect.provide(EffectFlock.defaultLayer))
  if (phase === "partial") {
    if (yield* original.read("settings.json")) throw new Error("Fixture storage must be fresh")
    yield* original.publish("settings.json", SettingsStore.encode(beforeSettings), null)
    yield* Effect.promise(() => fs.writeFile(config, beforeConfig, { flag: "wx", mode: 0o600 }))
    const result = yield* Effect.exit(apply)
    requireUnknown(result)
    const operation = yield* original.read(".settings-operation.json")
    const settings = yield* original.read("settings.json")
    const receipt = yield* original.read(".settings-receipt.json")
    const actualConfig = yield* ConfigFileWrite.read(config)
    if (!operation || !settings || receipt || actualConfig.text !== beforeConfig ||
      settings.text !== SettingsStore.encode(afterSettings) || !events.interrupted ||
      JSON.stringify(events.published) !== JSON.stringify([".settings-operation.json", "settings.json"]))
      throw new Error("Original partial publication boundary mismatch")
    const content = JSON.parse(operation.text) as { id: string; config: { before: string; after: string }; settings: { before: string; after: string } }
    if (content.config.before !== digest(beforeConfig) || content.config.after !== digest(afterConfig) ||
      content.settings.before !== digest(SettingsStore.encode(beforeSettings)) || content.settings.after !== settings.hash)
      throw new Error("Original intent does not match actual bytes")
    return { phase, passed: true, realNativePrivatePublication: true, injectedAfterActualSettingsPublication: true,
      partialIntentSHA256: operation.hash, settingsSHA256: settings.hash, configSHA256: ConfigFileWrite.digest(actualConfig),
      publicationNames: events.published, receiptAbsent: true, unknownPreserved: true }
  }
  const operation = yield* original.read(".settings-operation.json")
  const settings = yield* original.read("settings.json")
  const receipt = yield* original.read(".settings-receipt.json")
  const actualConfig = yield* ConfigFileWrite.read(config)
  if (!operation || !settings || receipt || actualConfig.text !== beforeConfig || settings.text !== SettingsStore.encode(afterSettings))
    throw new Error("Fresh process did not retain the actual partial state")
  requireUnknown(yield* Effect.exit(SettingsStore.readEffect.pipe(Effect.provideService(WindowsSettingsStorage.Current, observed))))
  if (events.published.length) throw new Error("Cold read attempted a repair")
  const result = yield* apply
  if (!result.changed || result.value !== "joint") throw new Error("Exact original request did not reconcile")
  const finalOperation = yield* original.read(".settings-operation.json")
  const finalReceipt = yield* original.read(".settings-receipt.json")
  const finalSettings = yield* original.read("settings.json")
  const finalConfig = yield* ConfigFileWrite.read(config)
  if (!finalOperation || finalOperation.text !== operation.text || !finalReceipt || !finalSettings ||
    finalSettings.hash !== settings.hash ||
    JSON.stringify(WindowsPrivateStorage.describe(finalSettings.witness)?.identity) !== JSON.stringify(WindowsPrivateStorage.describe(settings.witness)?.identity) ||
    finalConfig.text !== afterConfig ||
    JSON.stringify(events.published) !== JSON.stringify([".settings-receipt.json"]))
    throw new Error("Reconciliation rewrote original intent or private settings")
  yield* SettingsStore.readEffect.pipe(Effect.provideService(WindowsSettingsStorage.Current, observed))
  const publicationCount = events.published.length
  const retry = yield* apply
  if (retry.changed || events.published.length !== publicationCount) throw new Error("Exact completed retry republished private bytes")
  const afterRetry = yield* ConfigFileWrite.read(config)
  if (!ConfigFileWrite.sameObservation(afterRetry, finalConfig)) throw new Error("Exact completed retry changed config identity")
  return { phase, passed: true, freshProcessColdUnknown: true, coldWrites: 0, exactRequestReconciled: true,
    originalIntentRetained: true, settingsIdentityRetained: true, partialIntentSHA256: operation.hash,
    receiptSHA256: finalReceipt.hash, settingsSHA256: finalSettings.hash, configSHA256: ConfigFileWrite.digest(finalConfig),
    publicationNames: events.published, completedRetryPrivatePublications: 0, completedRetryConfigUnchanged: true }
})

function requireUnknown<A, E>(result: Exit.Exit<A, E>) {
  if (Exit.isSuccess(result)) throw new Error("Partial settings publication became success")
  const error = Cause.squash(result.cause)
  if (!(error instanceof SettingsTransaction.Error) || error.reason !== "unknown")
    throw new Error("Partial settings publication lost its unknown classification")
}
function digest(text: string) { return createHash("sha256").update(text, "utf8").digest("hex") }
