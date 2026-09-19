import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import * as Log from "@deepagent-code/core/util/log"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import { NamedError } from "@deepagent-code/core/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { ImportHistoryCommand } from "./cli/cmd/import-history"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import path from "path"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { GoalCommand } from "./cli/cmd/goal"
import { WorktreeCommand } from "./cli/cmd/worktree"
import { OversightCommand } from "./cli/cmd/oversight"
import { PanelCommand } from "./cli/cmd/panel"
import { ReviewCommand } from "./cli/cmd/review"
import { WikiCommand } from "./cli/cmd/wiki"
import { PacksCommand } from "./cli/cmd/packs"
import { DocsCommand } from "./cli/cmd/docs"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"
import { ensureProcessMetadata } from "@deepagent-code/core/util/deepagent-code-process"
import { isRecord } from "@/util/record"
import { applyRuntimeDefaults, RUNTIME_DEFAULTS_SNAPSHOT_ENV, runtimeDefaultsEnvSnapshot } from "./runtime-defaults"
import { ProcessLifecycle } from "./effect/process-lifecycle"
import * as mechanismBeacon from "@deepagent-code/core/deepagent/mechanism-beacon"

// Bun's fetch treats a set-but-empty HTTP(S)_PROXY value as a proxy with an empty URL and
// fails every request ("proxy.url must be a non-empty string"), killing the first provider
// turn and background installs. Drop empties so an unset-in-spirit variable cannot do that.
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
  if (process.env[key] === "") delete process.env[key]
}

// Normalize the environment inherited by subprocesses and compatibility readers. Core V2 feature
// registries capture their own immutable value at construction; their canonical unset defaults are
// identical to this table, so static ESM evaluation order cannot change feature authority.
applyRuntimeDefaults()

// Info-printing invocations (--help/--version/completion) run no mechanism, so the ablation
// ledger has nothing to record — and yargs writes --help to stderr, where beacon lines would
// corrupt both the user's terminal and the CLI help-text snapshots.
const infoInvocation = process.argv.some(
  (arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v" || arg === "completion",
)

if (process.env[RUNTIME_DEFAULTS_SNAPSHOT_ENV] === "1") {
  // Test-only backdoor (W0.1 verification case 4): print the canonical defaults vector and exit
  // without starting the CLI — test/runtime-defaults.test.ts compares both entries' vectors. Any
  // process (or inherited child env) carrying this key exits here, so never set it in production
  // shells, packaging, or service managers.
  console.log(JSON.stringify(runtimeDefaultsEnvSnapshot(process.env)))
  process.exit(0)
}

// Mechanism beacon: emit the resolved on/off state of every ablable mechanism once, before any
// turn runs, plus an engagement summary at exit. This is the ablation-correctness ledger — it
// distinguishes "flag set" from "mechanism actually ran" for every arm of the matrix.
if (!infoInvocation) {
  mechanismBeacon.emitStartupBeacon()
  process.once("exit", () => mechanismBeacon.emitSummaryBeacon())
}

const processMetadata = ensureProcessMetadata("main")

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

const args = hideBin(process.argv)
const entryName = path.basename(process.argv[1] ?? "deepagent-code")
const scriptName = entryName === "deepagent" ? "deepagent" : "deepagent-code"
const isDeepAgentEntry = scriptName === "deepagent"

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith(`${scriptName} `)) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName(scriptName)
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.pure) {
      process.env.DEEPAGENT_CODE_PURE = "1"
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    if (isDeepAgentEntry) {
      process.env.DEEPAGENT = "1"
      process.env.DEEPAGENT_PID = String(process.pid)
    }
    process.env.DEEPAGENT_CODE = "1"
    process.env.DEEPAGENT_CODE_PID = String(process.pid)
    // C7-05/W0.1: the V2 event-admission defaults live in src/runtime-defaults.ts (applied at the top
    // of this module). The former DEEPAGENT_CODE_V4_EVENT_DRIVEN_IM pairing default is removed with
    // the V2 IM durable-only migration: @mentions are admitted directly as durable SessionV2 work by
    // the IM handler (src/im/im-agent-execution.ts) and replies return through the im_reply_outbox
    // daemon — there is no bus-mediated IM path left to pair with, and the v4EventDrivenIm flag itself
    // is deleted from runtime-flags.ts.

    Log.Default.info(scriptName, {
      version: InstallationVersion,
      args: process.argv.slice(2),
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
    })
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(ImportHistoryCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(DbCommand)
  .command(GoalCommand)
  .command(WorktreeCommand)
  .command(OversightCommand)
  .command(PanelCommand)
  .command(ReviewCommand)
  .command(WikiCommand)
  .command(PacksCommand)
  .command(DocsCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exitCode = 1
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof NamedError) {
    const obj = e.toObject()
    if (isRecord(obj.data)) {
      for (const [key, value] of Object.entries(obj.data)) {
        if (key === "name" || key === "stack" || key === "cause") continue
        data[key] = value
      }
    }
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  const { AppRuntime } = await import("./effect/app-runtime")
  const cleanup = await Promise.race([
    Promise.allSettled([AppRuntime.dispose(), ProcessLifecycle.disposeAll()]),
    Bun.sleep(2_000).then(() => undefined),
  ])
  if (cleanup) {
    cleanup
      .flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      .forEach((error) => Log.Default.error("process resource cleanup failed", { error: errorMessage(error) }))
  } else {
    Log.Default.warn("process resource cleanup exceeded shutdown budget", { budgetMs: 2_000 })
  }
  Heap.stop()
  // Some external subprocesses do not react to scope interruption. Exit only after the application
  // runtime has had a bounded opportunity to run every registered finalizer.
  process.exit()
}
