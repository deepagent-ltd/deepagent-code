import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { cliIt, testModelID } from "../lib/cli-process"

// PARITY-004 long-tail: `session rename` / `session archive` mirror the GUI
// session context menu (httpapi session update → setTitle / setArchived). The
// CLI drives the same Session.Service through the local instance.
describe("deepagentCode session rename/archive (non-interactive subprocess)", () => {
  cliIt.live(
    "renames, archives, and restores a session",
    ({ deepagentCode, home }) =>
      Effect.gen(function* () {
        // test/preload.ts pins DEEPAGENT_CODE_DB=:memory:, which gives every
        // spawned process its own DB. Point the whole flow at a shared file DB
        // so the session created by `run` is visible to the session commands.
        const dbEnv = { DEEPAGENT_CODE_DB: path.join(home, "cli.db") }

        // Create one session through the normal run path so the list is non-empty.
        const run = yield* deepagentCode.run("hello", { model: testModelID, env: dbEnv })
        deepagentCode.expectExit(run, 0, "run")

        const listOnce = yield* deepagentCode.spawn(["session", "list", "--format", "json"], { env: dbEnv })
        deepagentCode.expectExit(listOnce, 0, "session list")
        const sessions = JSON.parse(listOnce.stdout) as Array<{ id: string; title: string; archived: number | null }>
        expect(sessions.length).toBeGreaterThan(0)
        const sessionID = sessions[0].id

        // rename (UI.println writes to stderr)
        const rename = yield* deepagentCode.spawn(["session", "rename", sessionID, "CLI parity title"], { env: dbEnv })
        deepagentCode.expectExit(rename, 0, "session rename")
        expect(rename.stderr + rename.stdout).toContain(`Session ${sessionID} renamed to "CLI parity title"`)

        const listAfterRename = yield* deepagentCode.spawn(["session", "list", "--format", "json"], { env: dbEnv })
        const afterRename = JSON.parse(listAfterRename.stdout) as Array<{ id: string; title: string }>
        expect(afterRename.find((s) => s.id === sessionID)?.title).toBe("CLI parity title")

        // archive
        const archive = yield* deepagentCode.spawn(["session", "archive", sessionID], { env: dbEnv })
        deepagentCode.expectExit(archive, 0, "session archive")
        expect(archive.stderr + archive.stdout).toContain(`Session ${sessionID} archived`)

        const listAfterArchive = yield* deepagentCode.spawn(["session", "list", "--format", "json"], { env: dbEnv })
        const afterArchive = JSON.parse(listAfterArchive.stdout) as Array<{ id: string; archived: number | null }>
        const archivedEntry = afterArchive.find((s) => s.id === sessionID)
        expect(archivedEntry?.archived).toBeNumber()

        // restore
        const undo = yield* deepagentCode.spawn(["session", "archive", sessionID, "--undo"], { env: dbEnv })
        deepagentCode.expectExit(undo, 0, "session archive --undo")
        expect(undo.stderr + undo.stdout).toContain(`Session ${sessionID} restored`)

        const listAfterUndo = yield* deepagentCode.spawn(["session", "list", "--format", "json"], { env: dbEnv })
        const afterUndo = JSON.parse(listAfterUndo.stdout) as Array<{ id: string; archived: number | null }>
        expect(afterUndo.find((s) => s.id === sessionID)?.archived).toBeNull()
      }),
    120_000,
  )

  cliIt.concurrent(
    "fails with a clear error when the session does not exist",
    ({ deepagentCode }) =>
      Effect.gen(function* () {
        const rename = yield* deepagentCode.spawn(["session", "rename", "ses_missing000000", "nope"])
        expect(rename.exitCode).not.toBe(0)
        expect(rename.stderr + rename.stdout).toContain("Session not found: ses_missing000000")

        const archive = yield* deepagentCode.spawn(["session", "archive", "ses_missing000000"])
        expect(archive.exitCode).not.toBe(0)
        expect(archive.stderr + archive.stdout).toContain("Session not found: ses_missing000000")
      }),
    60_000,
  )
})
