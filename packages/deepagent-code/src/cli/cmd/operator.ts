import { Cause, Effect, Layer, Option, Schema } from "effect"
import { createHmac } from "node:crypto"
import fs from "node:fs/promises"
import { eq } from "drizzle-orm"
import { LocalOperatorAuthorityTable } from "@deepagent-code/core/im/local-operator.sql"
import { constants } from "node:fs"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { LocalOperator } from "@deepagent-code/core/im/local-operator"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { AuthRuntime } from "@/im/auth-runtime"
import { ServerAuth } from "@/server/auth"
import { cmd } from "./cmd"

// Deliberately outside AppRuntime: offline commands acquire the normal process-exclusive DB
// lifetime lock. They never attach to a running server, enroll over HTTP, or print credentials.
export const OperatorCommand = cmd({
  command: "operator <action>",
  describe: "offline local task operator enrollment, credential rotation, and revocation",
  builder: (yargs) =>
    yargs
      .positional("action", {
        choices: ["enroll", "rotate", "revoke", "approve-route", "revoke-route", "route-history", "event-rule"] as const,
        demandOption: true,
      })
      .option("request-id", { type: "string", demandOption: true, describe: "stable exact-retry operation ID" })
      .option("policy", { type: "string", describe: "explicit local target policy JSON file (required for enroll)" })
      .option("event-rule-command", { type: "string", describe: "private 0600 rule create/enable/pause/revoke JSON" })
      .option("target", { type: "string", describe: "registered target ID for route approval/revocation" })
      .option("snapshot", { type: "string", describe: "exact installed provider model snapshot" })
      .option("expires-at", { type: "number", describe: "route approval expiry as Unix milliseconds" })
      .option("expected-route-revision", { type: "number", describe: "current route revision (0 for first approval)" })
      .option("expected-revision", {
        type: "number",
        describe: "current operator revision (required for rotate/revoke)",
      })
      .option("previous-credential-file", {
        type: "string",
        describe: "private 0600 file containing the prior password, only for rotate",
      }),
  async handler(args) {
    const database = Database.defaultLayer
    const native = Layer.unwrap(Effect.gen(function* () {
      if (process.platform !== "win32") return Layer.empty
      const { windowsStorageLayer } = yield* Effect.promise(() => import("@/effect/root"))
      return windowsStorageLayer
    }))
    const result = await Effect.runPromise(
      command({
        action: args.action,
        operationID: args.requestId,
        policyPath: args.policy,
        expectedRevision: args.expectedRevision,
        previousCredentialPath: args.previousCredentialFile,
        targetID: args.target,
        snapshot: args.snapshot,
        expiresAt: args.expiresAt,
        expectedRouteRevision: args.expectedRouteRevision,
        eventRuleCommandPath: args.eventRuleCommand,
      }).pipe(
        Effect.provide(native),
        Effect.provide(LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))),
        Effect.provide(database),
        Effect.provide(ServerAuth.Config.defaultLayer),
        Effect.scoped,
        Effect.tapCause((cause) => Effect.gen(function* () {
          if (["approve-route", "revoke-route", "route-history"].includes(args.action)) {
            const { NativeRouteCapture } = yield* Effect.promise(() => import("@/installation/native-route-capture"))
            yield* NativeRouteCapture.reportDiagnostic("operator-command", cause)
            return
          }
          const error = Option.getOrUndefined(Cause.findErrorOption(cause))
          const known = Schema.decodeUnknownOption(LocalOperatorSchema.Error)(error)
          yield* Effect.try({
            try: () => process.stderr.write(`Local operator diagnostic: ${JSON.stringify({ version: 1,
              stage: "operator-command", kind: Cause.hasInterruptsOnly(cause) ? "interrupted" : Cause.hasDies(cause) ? "defect" : "failure",
              tag: Option.isSome(known) ? "LocalOperator.Error" : "unknown",
              code: Option.isSome(known) ? known.value.code : "UNCLASSIFIED" })}\n`),
            catch: () => undefined,
          }).pipe(Effect.ignore)
          // Reporting cannot replace the original refusal, interruption or defect.
        }).pipe(Effect.catchCause(() => Effect.void))),
        Effect.catchCause(() => Effect.succeed(undefined)),
      ),
    )
    if (!result) {
      process.stderr.write(
        "Local operator command refused. Check private credentials, policy, expected revision, and exclusive database availability.\n",
      )
      process.exitCode = 1
      return
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
  },
})

export const command = Effect.fn("Cli.operator")(function* (input: {
  action: "enroll" | "rotate" | "revoke" | "approve-route" | "revoke-route" | "route-history" | "event-rule"
  operationID: string
  policyPath?: string
  expectedRevision?: number
  previousCredentialPath?: string
  targetID?: string
  snapshot?: string
  expiresAt?: number
  expectedRouteRevision?: number
  eventRuleCommandPath?: string
}) {
  const config = yield* ServerAuth.Config
  if (!ServerAuth.required(config) || Option.isNone(config.password))
    return yield* LocalOperator.failure("LOCAL_OPERATOR_UNAVAILABLE", "A configured server password is required")
  const password = config.password.value
  const installation = yield* input.action === "enroll"
    ? LocalTaskAuthority.initializeInstallation()
    : LocalTaskAuthority.readInstallation
  const runtime = LocalTaskAuthority.binding(installation, config.username, password)
  const db = (yield* Database.Service).db
  const policy = input.policyPath
    ? yield* Effect.tryPromise({
        try: () => fs.readFile(input.policyPath!, "utf8"),
        catch: () =>
          new LocalOperatorSchema.Error({ code: "LOCAL_OPERATOR_INVALID", message: "Policy file is unavailable" }),
      }).pipe(Effect.flatMap((value) => LocalOperator.decode(Schema.UnknownFromJsonString, value)))
    : undefined
  if (input.action === "enroll") {
    if (!policy)
      return yield* LocalOperator.failure("LOCAL_OPERATOR_INVALID", "Enrollment requires an explicit target policy")
    const operatorID = `operator_${createHmac("sha256", Buffer.from(installation.secret, "hex")).update(`enroll:${input.operationID}`).digest("hex").slice(0, 32)}`
    const resolved = yield* resolvePolicy(policy, operatorID)
    const verifier = yield* credential(() => AuthRuntime.hash(password))
    return yield* LocalOperator.enroll(db, {
      operationID: input.operationID,
      operatorID,
      username: config.username,
      credentialVerifier: verifier,
      policy: resolved,
    }).pipe(Effect.provideService(LocalOperator.Runtime, runtime))
  }
  if (
    input.action !== "route-history" &&
    (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 1)
  )
    return yield* LocalOperator.failure("LOCAL_OPERATOR_INVALID", "An expected operator revision is required")
  const record = yield* db
    .select()
    .from(LocalOperatorAuthorityTable)
    .where(eq(LocalOperatorAuthorityTable.instance_id, runtime.instanceID))
    .get()
    .pipe(Effect.orDie)
  if (input.action === "revoke" && record?.state === "revoked") {
    if (
      record.installation_key_hash !== runtime.installationKeyHash ||
      record.credential_binding !== runtime.credentialBinding ||
      record.username !== config.username ||
      !(yield* credential(() => AuthRuntime.verify(password, record.credential_verifier)))
    )
      return yield* LocalOperator.failure(
        "LOCAL_OPERATOR_AUTH_REQUIRED",
        "Revocation receipt requires its enrolled credentials",
      )
    // Only the same completed command can reconcile; a new command still requires active Mutation.
    return yield* LocalOperator.revoke(db, {
      operationID: input.operationID,
      expectedRevision: input.expectedRevision!,
    }).pipe(Effect.provideService(LocalOperator.Runtime, runtime))
  }
  const current = yield* db
    .transaction((tx) => LocalOperator.requireCurrent(tx, input.action !== "rotate"))
    .pipe(Effect.provideService(LocalOperator.Runtime, runtime))
  const previous =
    input.action === "rotate" &&
    !(current.credential_binding === runtime.credentialBinding && current.revision > input.expectedRevision!)
      ? yield* privateCredential(input.previousCredentialPath)
      : password
  const witness = yield* LocalTaskAuthority.authenticatePassword(
    db,
    runtime,
    current.username,
    previous,
    input.action !== "rotate",
  )
  if (input.action === "event-rule") {
    if (current.revision !== input.expectedRevision) return yield* LocalOperator.failure("LOCAL_OPERATOR_REVISION_CONFLICT", "Operator revision changed")
    const { EventWorkRuleSchema } = yield* Effect.promise(() => import("@deepagent-code/core/deepagent/event-work-rule.schema"))
    const { EventWorkRule } = yield* Effect.promise(() => import("@deepagent-code/core/deepagent/event-work-rule"))
    const value = yield* Effect.tryPromise({ try: async () => {
      if (!input.eventRuleCommandPath) throw new Error("missing")
      const file = await fs.open(input.eventRuleCommandPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65_536 || stat.nlink !== 1) throw new Error("private rule command required")
        return new TextDecoder("utf-8", { fatal: true }).decode(await file.readFile())
      } finally { await file.close() }
    }, catch: () => new LocalOperatorSchema.Error({ code: "LOCAL_OPERATOR_INVALID", message: "Private rule command is unavailable" }) })
    const command = yield* LocalOperator.decode(Schema.fromJsonString(EventWorkRuleSchema.Command), value)
    const result = yield* LocalTaskAuthority.provide({ runtime, witness },
      EventWorkRule.command(db, { ...command, requestID: input.operationID }))
    return { ruleID: result.rule.ruleID, revision: result.rule.revision, epoch: result.rule.epoch,
      state: result.rule.state, expiresAt: result.rule.expiresAt, replayed: result.replayed,
      invalidatedSessionIDs: result.interruptedSessionIDs }
  }
  if (input.action === "approve-route" || input.action === "revoke-route" || input.action === "route-history") {
    if (
      !input.targetID ||
      (input.action === "revoke-route" && (input.snapshot !== undefined || input.expiresAt !== undefined)) ||
      (input.action !== "route-history" &&
        (!Number.isSafeInteger(input.expectedRouteRevision) || input.expectedRouteRevision! < 0)) ||
      (input.action === "approve-route" &&
        (!input.snapshot || !Number.isSafeInteger(input.expiresAt) || input.expiresAt! < 1))
    )
      return yield* LocalOperator.failure(
        "LOCAL_OPERATOR_INVALID",
        "Route command requires target, exact revision and bounded expiry",
      )
    const { OfflineNativeRouteApproval } = yield* Effect.promise(() => import("@/installation/native-route-approval"))
    const { ProviderCredentialBinding } = yield* Effect.promise(
      () => import("@/installation/provider-credential-binding"),
    )
    const { NativeRouteCapture } = yield* Effect.promise(() => import("@/installation/native-route-capture"))
    const credentials = ProviderCredentialBinding.layer.pipe(Layer.provideMerge(NativeRouteCapture.nativeLayer))
    const capture = NativeRouteCapture.layer.pipe(Layer.provideMerge(credentials))
    return yield* LocalTaskAuthority.provide(
      { runtime, witness },
      Effect.gen(function* () {
        const query = { targetID: input.targetID!, requestID: input.operationID }
        if (input.action === "route-history") return yield* OfflineNativeRouteApproval.history(query)
        const receipt = yield* input.action === "approve-route"
          ? OfflineNativeRouteApproval.approve({
              ...query,
              snapshot: input.snapshot!,
              expiresAt: input.expiresAt!,
              expectedRevision: input.expectedRouteRevision!,
              expectedOperatorRevision: input.expectedRevision!,
            })
          : OfflineNativeRouteApproval.revoke({
              ...query,
              expectedRevision: input.expectedRouteRevision!,
              expectedOperatorRevision: input.expectedRevision!,
            })
        // A successful policy mutation advances the principal revision. Authenticate the read
        // independently; reusing the pre-mutation witness must not bypass its revision fence.
        const currentWitness = yield* LocalTaskAuthority.authenticatePassword(db, runtime, config.username, password)
        const observed = yield* OfflineNativeRouteApproval.history(query).pipe(
          Effect.provideService(LocalOperator.Mutation, currentWitness),
        )
        return {
          commandReceipt: receipt,
          currentRecord: observed?.currentRecord ?? null,
          authorization: "not_checked" as const,
        }
      }).pipe(Effect.provide(capture)),
    )
  }
  if (input.action === "revoke")
    return yield* LocalTaskAuthority.provide(
      { runtime, witness },
      LocalOperator.revoke(db, { operationID: input.operationID, expectedRevision: input.expectedRevision! }),
    )
  const resolved = policy ? yield* resolvePolicy(policy, current.operator_id) : undefined
  const verifier = yield* credential(() => AuthRuntime.hash(password))
  return yield* LocalTaskAuthority.provide(
    { runtime, witness },
    LocalOperator.rotate(db, {
      operationID: input.operationID,
      expectedRevision: input.expectedRevision!,
      username: config.username,
      credentialVerifier: verifier,
      policy: resolved,
    }),
  )
})

const credential = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () =>
      new LocalOperatorSchema.Error({
        code: "LOCAL_OPERATOR_UNAVAILABLE",
        message: "Local credential verification is unavailable or exceeds its supported resource profile",
      }),
  })

const privateCredential = (filename: string | undefined) =>
  Effect.tryPromise({
    try: async () => {
      if (!filename) throw new Error("missing")
      const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 8192 || stat.nlink !== 1)
          throw new Error("private credential required")
        const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
          .decode(await file.readFile())
          .replace(/\r?\n$/, "")
        if (!value) throw new Error("empty")
        return value
      } finally {
        await file.close()
      }
    },
    catch: () =>
      new LocalOperatorSchema.Error({
        code: "LOCAL_OPERATOR_AUTH_REQUIRED",
        message: "A private prior-credential file is required",
      }),
  })

const resolvePolicy = Effect.fn("Cli.operator.resolvePolicy")(function* (policy: unknown, operatorID: string) {
  const { LocalOperatorPolicy } = yield* Effect.promise(() => import("@/im/local-operator-policy"))
  return yield* LocalOperatorPolicy.resolve(policy, operatorID)
})
