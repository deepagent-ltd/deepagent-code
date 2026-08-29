import { EOL } from "os"
import { Effect } from "effect"
import { FileSystem } from "@deepagent-code/core/filesystem"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { Search } from "@deepagent-code/core/filesystem/search"
import { AbsolutePath, RelativePath } from "@deepagent-code/core/schema"
import { CliError, effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"

const filesystem = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(LocationServiceMap.get({ directory: AbsolutePath.make(process.cwd()) })),
    Effect.provide(LocationServiceMap.layer),
  )

const FileSearchCommand = effectCmd({
  command: "search <query>",
  describe: "search files by query",
  builder: (yargs) =>
    yargs.positional("query", {
      type: "string",
      demandOption: true,
      description: "Search query",
    }),
  handler: (args) =>
    Effect.fn("Cli.debug.file.search")(function* () {
    const results = yield* filesystem(FileSystem.Service.use((svc) => svc.find({ query: args.query })))
    process.stdout.write(results.map((item) => item.path).join(EOL) + EOL)
  })().pipe(
    Effect.mapError((e) => (e instanceof CliError ? e : new CliError({ message: String((e as { message?: string })?.message ?? e), exitCode: 1 }))),
  ),
})

const FileReadCommand = effectCmd({
  command: "read <path>",
  describe: "read file contents as JSON",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      demandOption: true,
      description: "File path to read",
    }),
  handler: (args) =>
    Effect.fn("Cli.debug.file.read")(function* () {
    const content = yield* filesystem(FileSystem.Service.use((svc) => svc.read({ path: RelativePath.make(args.path) })))
    process.stdout.write(JSON.stringify(content, null, 2) + EOL)
  })().pipe(
    Effect.mapError((e) => (e instanceof CliError ? e : new CliError({ message: String((e as { message?: string })?.message ?? e), exitCode: 1 }))),
  ),
})

const FileListCommand = effectCmd({
  command: "list <path>",
  describe: "list files in a directory",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      demandOption: true,
      description: "File path to list",
    }),
  handler: (args) =>
    Effect.fn("Cli.debug.file.list")(function* () {
    const files = yield* filesystem(FileSystem.Service.use((svc) => svc.list({ path: RelativePath.make(args.path) })))
    process.stdout.write(JSON.stringify(files, null, 2) + EOL)
  })().pipe(
    Effect.mapError((e) => (e instanceof CliError ? e : new CliError({ message: String((e as { message?: string })?.message ?? e), exitCode: 1 }))),
  ),
})

const FileTreeCommand = effectCmd({
  command: "tree [dir]",
  describe: "show directory tree",
  builder: (yargs) =>
    yargs.positional("dir", {
      type: "string",
      description: "Directory to tree",
      default: process.cwd(),
    }),
  handler: Effect.fn("Cli.debug.file.tree")(function* (args) {
    const tree = yield* Effect.orDie(Search.Service.use((svc) => svc.tree({ cwd: args.dir, limit: 200 })))
    console.log(JSON.stringify(tree, null, 2))
  }),
})

export const FileCommand = cmd({
  command: "file",
  describe: "file system debugging utilities",
  builder: (yargs) =>
    yargs
      .command(FileReadCommand)
      .command(FileListCommand)
      .command(FileSearchCommand)
      .command(FileTreeCommand)
      .demandCommand(),
  async handler() {},
})
