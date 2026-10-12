import { Cause, Effect, Exit, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Global } from "@deepagent-code/core/global"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { EventValidationNative } from "../../../src/installation/event-validation-native"
import { WorkFileHelper } from "../../../src/installation/work-file-helper"
import { NativeInstallation } from "../../../src/installation/native-installation"
import { WorkCommandRuntime } from "../../../src/installation/work-command-runtime"

// Primitive oracle only: no operator grant/Rule is forged. The following separate store
// and HTTP fixtures exercise authorization; this checks the actual installed leaf.
const directory = process.argv[2]!
const port = Number(process.argv[3])
const program = Effect.gen(function* () {
  const root = path.join(directory, "project")
  const native = yield* EventValidation.Native
  const installed = yield* NativeInstallation.current()
  const executable = yield* Effect.promise(() => WorkCommandRuntime.verifiedRuntime(installed))
  const actual = yield* WorkFileHelper.inspectRoot(root)
  const configuration = Schema.decodeUnknownSync(EventValidationSchema.Configuration)({
    profile: "project_validation_v1", scope: { instanceID: "native-fixture", workspaceID: null,
      securityNamespaceID: "namespace", namespaceBindingHash: "a".repeat(64), locationKey: root,
      projectScopeKey: "project", projectID: "project", canonicalRoot: root, rootIdentity: actual.rootIdentity },
    helperHash: actual.helperHash, kind: "test", watch: ["guard.test.ts", "binary.dat", "empty.dat", "missing.dat"], parameters: [], recipient: "local_status",
    maxRuns: 10, expiresAt: Date.now() + (process.argv[4] === "store-prepare" ? 240000 : 120000), investigation: "disabled", autoFix: false,
    recipe: { schemaVersion: "work-command-recipe.v1", logicalID: "test", revision: 1, executable: executable.executable,
      argv: ["test", "guard.test.ts", "--timeout", "5000"].map((value) => ({ kind: "literal", value })),
      parameters: [], cwd: null, inputs: ["guard.test.ts", "binary.dat", "empty.dat"], outputs: ["result.txt"], environment: [{ name: "CI", value: "1" }],
      workspace: "private_explicit_files.v1", sandbox: { id: "darwin-single-process-workspace-v1", revision: 1,
        network: "deny", processes: 1, openFiles: 64, maxInputFiles: 256, maxInputFileBytes: 16777216,
        maxInputBytes: 67108864, maxDepth: 16, maxOutputFiles: 32, maxOutputFileBytes: 1048576, maxOutputBytes: 33554432 },
      timeoutMs: 15000, stdoutBytes: 1048576, stderrBytes: 1048576 },
  })
  if (process.argv[4]?.startsWith("store")) {
    const { run } = yield* Effect.promise(() => import("./event-validation-store"))
    return yield* run(configuration, directory, process.argv[4])
  }
  const first = yield* native.observe(configuration)
  const approval = yield* native.approve(configuration)
  if (!native.approved(approval, configuration)) throw new Error("actual approval missing")
  const handle = yield* native.prepare(configuration, first, `cmd_${randomUUID().replaceAll("-", "")}`, Date.now() + 15000)
  const started: number[] = []
  yield* native.execute(handle, { beforeDispatch: Effect.void, started: (pid) => Effect.sync(() => { started.push(pid) }) })
  const result = native.result(handle)
  yield* native.cleanup(handle)
  yield* Effect.promise(() => fs.appendFile(path.join(root, "guard.test.ts"), "\n// content revision two\n"))
  const second = yield* native.observe(configuration)
  return { result, started: started.length, cleaned: native.cleaned(handle),
    changed: native.content(first, configuration)?.contentHash !== native.content(second, configuration)?.contentHash,
    sourceBytes: yield* Effect.promise(() => fs.readFile(path.join(root, "guard.test.ts"), "utf8")), port }
})
const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(EventValidationNative.layer), Effect.provide(Global.layer), Effect.scoped))
process.stdout.write(`${JSON.stringify(Exit.isSuccess(exit) ? { ok: true, value: exit.value } : { ok: false, error: Cause.pretty(exit.cause) })}\n`)
process.exitCode = Exit.isSuccess(exit) ? 0 : 1
