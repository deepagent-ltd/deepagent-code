import type { Argv } from "yargs"
import path from "path"
import { DateTime, Effect } from "effect"
import { SessionV2 } from "@deepagent-code/core/session"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ProjectDocs } from "@deepagent-code/core/system-context/project-docs"
import { ProjectDocsSync } from "@deepagent-code/core/deepagent/project-docs-sync"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { Filesystem } from "@/util/filesystem"

// `deepagent docs sync` — explicit, unstaged W10 write path: reads sessions of the project
// directory, runs the SAME generation logic as the session settle hook, and atomically writes
// docs/deepagent/{HANDOFF,DESIGN,PLAN,LOG}.md. Explicit invocation always writes; the automatic
// settle hook additionally needs DEEPAGENT_CODE_PROJECT_DOCS_SYNC=true or `docs_sync: true`.

export const DocsCommand = effectCmd({
  command: "docs",
  describe: "project documentation suite (docs/deepagent)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(
        effectCmd({
          command: "sync",
          describe: "generate or update docs/deepagent {HANDOFF,DESIGN,PLAN,LOG}.md from session history",
          instance: false,
          builder: (yargs: Argv) =>
            yargs
              .option("dir", {
                type: "string",
                describe:
                  "project directory whose sessions to sync — exact directory match, NOT recursive (default: current directory)",
              })
              .option("root", {
                type: "string",
                describe:
                  "project root to write docs/deepagent under; an explicit root is always written (default: --dir)",
              })
              .option("session", {
                type: "string",
                describe: "only sync the given session id (must belong to --dir)",
              })
              .option("json", {
                type: "boolean",
                default: false,
                describe: "print the generated document paths as JSON",
              }),
          handler: Effect.fn("Cli.docs.sync")(function* (rawArgs) {
            const args = rawArgs as {
              dir?: string
              root?: string
              session?: string
              json: boolean
            }
            const run = Effect.fn("Cli.docs.sync.run")(function* () {
              // Normalize exactly like `run --dir` does (Filesystem.resolve realpaths the
              // directory), so the session store lookup matches the recorded location.
              const directory = Filesystem.resolve(path.resolve(args.dir ?? process.cwd()))
              const root = Filesystem.resolve(path.resolve(args.root ?? directory))
              // High-2: the write root is an explicit user target, but the filesystem root is
              // never acceptable — refuse instead of creating /docs/deepagent.
              if (path.parse(root).root === root)
                return yield* fail(
                  `refusing to write project docs to the filesystem root ${root} (pass --root/--dir naming a real project directory)`,
                )
              const sessions = yield* SessionV2.Service
              const scoped = yield* sessions.list({ directory: AbsolutePath.make(directory) })
              // High-1: ASCENDING by updated time — the LOG writer inserts each session's entry at
              // its newest-first position (and typically prepends), so old→new traversal finishes
              // with the newest session on top instead of inverted.
              const parents = scoped.filter((session) => session.parentID === undefined).toSorted(
                (a, b) => DateTime.toEpochMillis(a.time.updated) - DateTime.toEpochMillis(b.time.updated),
              )
              const targets = args.session
                ? parents.filter((session) => session.id === args.session)
                : parents
              if (args.session && targets.length === 0)
                return yield* fail(`Session ${args.session} not found in ${directory}`)

              const written: string[] = []
              for (const session of targets) {
                if (session.location.directory !== AbsolutePath.make(directory)) continue
                const messages = yield* sessions.messages({ sessionID: session.id, order: "asc" })
                const docs = yield* ProjectDocsSync.syncSessionData({ root, session, messages })
                const dir = path.join(root, ProjectDocs.DOCS_DIRECTORY)
                written.push(...Object.keys(docs).sort().map((name) => path.join(dir, `${name}.md`)))
                if (!args.json) {
                  UI.println(
                    UI.Style.TEXT_SUCCESS_BOLD +
                      `sync` +
                      UI.Style.TEXT_NORMAL +
                      `  ${session.title} (${session.id}) → ${dir}`,
                  )
                }
              }
              if (targets.length === 0 && !args.json) UI.println("no sessions found in " + directory)
              if (args.json) process.stdout.write(JSON.stringify({ written }) + "\n")
            })
            return yield* run().pipe(Effect.catch((error) => fail(String(error))))
          }),
        }),
      )
      .demandCommand(),
  handler: Effect.fn("Cli.docs")(function* () {}),
})
