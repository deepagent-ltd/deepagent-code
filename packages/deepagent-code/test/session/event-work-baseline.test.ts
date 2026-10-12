import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { Effect } from "effect"
import { EventWorkGit } from "../../src/session/event-work-git"
import { EventWorkArtifacts } from "../../src/session/event-work-artifacts"

test("dirty ordinary output becomes one immutable baseline through a private index without parent writes", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-event-baseline-")))
  const prepare = (args: string[]) => {
    const value = spawnSync("git", args, { cwd: directory, encoding: "utf8", timeout: 10_000 })
    if (value.status !== 0) throw new Error("BASELINE_FIXTURE_FAILED")
    return value.stdout.trim()
  }
  try {
    prepare(["init", "--quiet"])
    await fs.mkdir(path.join(directory, "src")); await fs.writeFile(path.join(directory, "src/work.txt"), "original\n")
    await fs.writeFile(path.join(directory, "outside.txt"), "outside approved scope\n")
    prepare(["add", "src/work.txt", "outside.txt"])
    prepare(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "original"])
    const parent = prepare(["rev-parse", "HEAD"])
    const originalIndex = await fs.readFile(path.join(directory, ".git/index"))
    await fs.writeFile(path.join(directory, "src/work.txt"), "ordinary latest output\0🌟\n")
    await fs.writeFile(path.join(directory, "src/new.txt"), "untracked allowed\n")
    const scope = { read: [{ kind: "tree" as const, path: "src" }], write: [{ kind: "tree" as const, path: "src" }], deny: [],
      maxReadBytes: 16_777_216, maxHashBytes: 16_777_216, maxPageBytes: 51_200, maxWriteBytes: 51_200, symlinks: "deny" as const }
    const frozen = await Effect.runPromise(Effect.gen(function* () {
      const runtime = yield* EventWorkGit.pinRepository(directory, yield* EventWorkGit.capture)
      return yield* Effect.gen(function* () {
        const leaves = yield* Effect.promise(() => Promise.all(["src/work.txt", "src/new.txt"].map(async (relative) => ({ relative,
          bytes: await fs.readFile(path.join(directory, relative)) }))))
        const objects = yield* Effect.forEach(leaves, (leaf) => EventWorkGit.run({ directory, args: ["hash-object", "-w", "--stdin"], stdin: leaf.bytes })
          .pipe(Effect.map((result) => ({ ...leaf, object: result.stdout.toString().trim() }))))
        const commit = yield* EventWorkGit.withPrivateIndex(Effect.gen(function* () {
          expect((yield* EventWorkGit.run({ directory, args: ["read-tree", "--empty"] })).exitCode).toBe(0)
          const records = objects.map((leaf) => `100644 ${leaf.object}\t${leaf.relative}\0`).join("")
          expect((yield* EventWorkGit.run({ directory, args: ["update-index", "-z", "--index-info"], stdin: Buffer.from(records) })).exitCode).toBe(0)
          const tree = yield* EventWorkGit.run({ directory, args: ["write-tree"] })
          const committed = yield* EventWorkGit.run({ directory, args: ["commit-tree", tree.stdout.toString().trim(), "-p", parent,
            "-m", "DeepAgent Code event node artifact"], commitTime: 1_700_000_000_000 })
          expect(committed.exitCode).toBe(0)
          expect(yield* EventWorkGit.indexAllocation).toBeGreaterThan(0)
          return committed.stdout.toString().trim()
        }))
        const entries = yield* EventWorkArtifacts.read({ directory, commit, scope, maxBytes: 67_108_864 })
        const names = yield* EventWorkGit.run({ directory, args: ["ls-tree", "-rz", "--full-tree", commit] })
        expect(names.stdout.toString()).not.toContain("outside.txt")
        const retained = yield* EventWorkGit.run({ directory, args: ["rev-list", "--objects", "--no-object-names", `${parent}..${commit}`] })
        expect(retained.exitCode).toBe(0)
        expect(retained.stdout.toString().trim().split("\n").every((object) => /^[a-f0-9]{40,64}$/.test(object))).toBe(true)
        return { commit, entries, manifest: EventWorkArtifacts.manifest(entries) }
      }).pipe(Effect.provideService(EventWorkGit.Current, runtime))
    }).pipe(Effect.scoped))
    expect(prepare(["rev-parse", "HEAD"])).toBe(parent)
    expect(await fs.readFile(path.join(directory, ".git/index"))).toEqual(originalIndex)
    expect(frozen.entries.find((entry) => entry.relative === "src/work.txt")!.bytes.toString()).toBe("ordinary latest output\0🌟\n")
    expect(frozen.entries.find((entry) => entry.relative === "src/new.txt")!.bytes.toString()).toBe("untracked allowed\n")
    await fs.writeFile(path.join(directory, "src/work.txt"), "later unrelated parent change\n")
    const same = await Effect.runPromise(EventWorkArtifacts.read({ directory, commit: frozen.commit, scope, maxBytes: 67_108_864 }))
    expect(EventWorkArtifacts.manifest(same)).toBe(frozen.manifest)
    expect(same.map((entry) => entry.sha256)).toEqual(frozen.entries.map((entry) => entry.sha256))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}, 30_000)
