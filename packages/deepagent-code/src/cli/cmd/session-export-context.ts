import { Effect } from "effect"
import { EOL } from "os"
import { effectCmd, fail } from "../effect-cmd"
import { attachOptions, createInstanceSDK, type QueryFormatArgs } from "./instance-sdk"
import { renderSdkError } from "../sdk-error"
import { exportSessionContext } from "../session-context"

// C6-08: "复制上下文" — copy/export a session's recovery context in read-only recovery. Reuses the
// generated recovery evidence-export surface (client.recovery.*) which remains available when the
// store is in read_only_recovery mode. Output is JSON (scriptable); failures are rendered through
// the stable C0-03 typed-error path (branch on code/httpStatus, never parse message).

export const SessionExportContextCommand = effectCmd({
  command: "export-context <sessionID>",
  describe: "copy/export a session's recovery context (works when the store is in read-only recovery)",
  builder: (yargs) =>
    attachOptions(
      yargs
        .positional("sessionID", {
          describe: "session ID to export context for",
          type: "string",
          demandOption: true,
        })
        .option("export-id", {
          describe: "read a previously-created evidence export by id (instead of creating one)",
          type: "string",
        }),
    ),
  handler: Effect.fn("Cli.session.exportContext")(function* (rawArgs) {
    const args = rawArgs as unknown as QueryFormatArgs & { sessionID: string; exportId?: string }
    const sdk = yield* Effect.promise(() => createInstanceSDK(args, process.cwd()))
    const manifest = yield* Effect.tryPromise(() =>
      exportSessionContext(sdk, { sessionID: args.sessionID, exportID: args.exportId }),
    ).pipe(Effect.catchAll((error: unknown) => fail(renderSdkError(error))))
    process.stdout.write(JSON.stringify(manifest))
    process.stdout.write(EOL)
  }),
})
