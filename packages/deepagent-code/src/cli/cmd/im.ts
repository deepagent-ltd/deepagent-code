import { Cause, Effect, Exit } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { WorkKnownRecoverySchema } from "@deepagent-code/core/session/work-known-recovery.schema"
import { WorkStorageCleanupSchema } from "@deepagent-code/core/session/work-storage-cleanup.schema"
import { LocalAuthority } from "@/installation/local-authority"
import { ServerAuth } from "@/server/auth"
import { cmd } from "./cmd"

export const ImCommand = cmd({
  command: "im",
  describe: "explicit IM Work recovery controls",
  builder: (yargs) => yargs.command({
    command: "work",
    describe: "recover a known project Work without replaying previous effects",
    builder: (work) => work.command(RecoverKnownCommand).command(ResumeRecoveredCommand).command(CleanupKnownCommand).demandCommand(),
    handler() {},
  }).demandCommand(),
  handler() {},
})
const RecoverKnownCommand = cmd({
  command: "recover-known <workID>",
  describe: "authenticate known predecessors and release one old claim; no execution by default",
  builder: (yargs) => yargs.positional("workID", { type: "string", demandOption: true })
    .option("session-id", { type: "string", demandOption: true })
    .option("request-id", { type: "string", demandOption: true })
    .option("expected-claim-token", { type: "number", demandOption: true })
    .option("expected-control-revision", { type: "number", demandOption: true })
    .option("resume", { type: "boolean", default: false, describe: "explicitly continue once after recovery commits" }),
  async handler(args) {
    await run({ kind: "recover", request: { workID: args.workID, sessionID: args.sessionId, requestID: args.requestId,
      expectedClaimToken: args.expectedClaimToken, expectedControlRevision: args.expectedControlRevision,
      action: args.resume ? "recover_and_resume" : "recover_only" } })
  },
})
const ResumeRecoveredCommand = cmd({
  command: "resume-recovered <recoveryID>",
  describe: "record one explicit continuation of a recover-only receipt and use the original runner",
  builder: (yargs) => yargs.positional("recoveryID", { type: "string", demandOption: true })
    .option("request-id", { type: "string", demandOption: true })
    .option("expected-control-revision", { type: "number", demandOption: true }),
  async handler(args) {
    await run({ kind: "resume", request: { recoveryID: args.recoveryID, requestID: args.requestId,
      expectedControlRevision: args.expectedControlRevision } })
  },
})
type Command = { kind: "recover"; request: WorkKnownRecoverySchema.Request }
  | { kind: "resume"; request: WorkKnownRecoverySchema.ResumeRequest }
  | { kind: "cleanup"; request: WorkStorageCleanupSchema.Request }

const CleanupKnownCommand = cmd({
  command: "cleanup-known <recoveryID>",
  describe: "explicitly retire authenticated known private storage; never resume tools or a model",
  builder: (yargs) => yargs.positional("recoveryID", { type: "string", demandOption: true })
    .option("admission-id", { type: "string", demandOption: true })
    .option("request-id", { type: "string", demandOption: true })
    .option("expected-custody-revision", { type: "number", demandOption: true }),
  async handler(args) {
    await run({ kind: "cleanup", request: { recoveryID: args.recoveryID, admissionID: args.admissionId,
      requestID: args.requestId, expectedCustodyRevision: args.expectedCustodyRevision } })
  },
})

/** The CLI explicitly authenticates existing enrollment. This is not a listener auth override,
 * and neither localhost nor a persisted operator row manufactures a Mutation witness. */
export const command = Effect.fn("Cli.im.work")(function* (input: Command) {
  const { NativeWorkKnownRecovery } = yield* Effect.promise(() => import("@/installation/work-known-recovery"))
  const db = (yield* Database.Service).db
  const config = yield* ServerAuth.Config
  const configured = yield* LocalAuthority.configured(config)
  const witness = yield* LocalAuthority.authenticatePassword(db, configured.runtime, config.username, configured.password)
  if (input.kind === "cleanup") {
    const { NativeWorkStorageCleanup } = yield* Effect.promise(() => import("@/installation/work-storage-cleanup"))
    return yield* LocalAuthority.provide({ runtime: configured.runtime, witness }, NativeWorkStorageCleanup.cleanup(input.request))
  }
  if (input.kind === "recover") return yield* LocalAuthority.provide({ runtime: configured.runtime, witness },
    NativeWorkKnownRecovery.recover(input.request))
  return yield* LocalAuthority.provide({ runtime: configured.runtime, witness }, NativeWorkKnownRecovery.resume(input.request))
})
async function run(input: Command) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  const result = await AppRuntime.runPromise(command(input).pipe(Effect.provide(ServerAuth.Config.defaultLayer), Effect.exit))
  if (Exit.isFailure(result)) {
    const error = Cause.squash(result.cause)
    process.stderr.write(`${error instanceof WorkKnownRecoverySchema.Error || error instanceof WorkStorageCleanupSchema.Error ? error.code : "RECOVERY_UNAVAILABLE"}: recovery or cleanup was not confirmed. Reconcile the unchanged request; a retry never starts another drain.\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`${JSON.stringify(result.value)}\n`)
}
