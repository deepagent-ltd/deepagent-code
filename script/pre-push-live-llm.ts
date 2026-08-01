#!/usr/bin/env bun

import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  blockingDirtyPaths,
  parsePushedRefs,
  readDirtyPaths,
  resolvePushedRefs,
} from "../packages/deepagent-code/script/live-llm/git"
import { modelRunKey, selectRoutes } from "../packages/deepagent-code/script/live-llm/routes"
import {
  commandForModelRun,
  commandsForChecks,
  unqualifiedRuns,
} from "../packages/deepagent-code/script/live-llm/dispatcher"
import {
  canReuseSuccess,
  readSuccessCache,
  successCacheKey,
  writeSuccessCache,
  type SuccessCacheKeyInput,
} from "../packages/deepagent-code/script/live-llm/cache"
import { loadLiveLLMConfig, modelFingerprint, type LiveLLMConfig } from "../packages/llm/script/live-llm/config"

export async function createPrePushPlan(input: { repository: string; remote: string; stdin: string }) {
  const plan = await resolvePushedRefs({
    repository: input.repository,
    remote: input.remote,
    refs: parsePushedRefs(input.stdin),
  })
  if (plan.selection.invalid.length) {
    throw new Error(`Invalid changed paths: ${plan.selection.invalid.join(", ")}`)
  }
  if (plan.selection.unclassified.length) {
    throw new Error(`Unclassified live LLM owning paths: ${plan.selection.unclassified.join(", ")}`)
  }
  if (!plan.paths.length) return plan

  const dirty = blockingDirtyPaths(plan.selection, await readDirtyPaths(input.repository))
  if (dirty.length) throw new Error(`Dirty files can affect the selected live LLM plan: ${dirty.join(", ")}`)
  return plan
}

if (import.meta.main) {
  const remote = Bun.argv[2]
  if (!remote) throw new Error("Usage: pre-push-live-llm.ts <remote-name> <remote-url>")
  const repository = (await git(process.cwd(), ["rev-parse", "--show-toplevel"])).trim()
  const stdin = await Bun.stdin.text()
  const plan = await createPrePushPlan({ repository, remote, stdin })

  if (!plan.refs.length) process.exit(0)
  const liveRuns = plan.selection.runs.filter((run) => run.mode === "live")
  console.log(
    JSON.stringify(
      {
        refs: plan.refs.map((ref) => ({
          localRef: ref.localRef,
          remoteRef: ref.remoteRef,
          objectOID: ref.localOID,
          commitOID: ref.commitOID,
          remoteObjectOID: ref.remoteOID,
          remoteCommitOID: ref.remoteCommitOID,
          kind: ref.kind,
        })),
        paths: plan.paths,
        deterministicChecks: plan.selection.checks,
        liveRuns: liveRuns.map((run) => modelRunKey(run)),
        extendedRuns: plan.selection.runs.filter((run) => run.mode === "ext").map((run) => modelRunKey(run)),
      },
      undefined,
      2,
    ),
  )

  if (!plan.paths.length) process.exit(0)
  const required = process.env.DEEPAGENT_CODE_LIVE_LLM_REQUIRED === "1"
  const skipping = required && process.env.DEEPAGENT_CODE_SKIP_LIVE_LLM === "1" && liveRuns.length > 0
  if (skipping) {
    const reason = process.env.DEEPAGENT_CODE_SKIP_LIVE_LLM_REASON?.trim()
    if (!reason) throw new Error("DEEPAGENT_CODE_SKIP_LIVE_LLM_REASON is required when skipping live LLM suites")
    const directory = path.join((await git(repository, ["rev-parse", "--git-common-dir"])).trim(), "deepagent-code")
    await mkdir(path.resolve(repository, directory), { recursive: true })
    await appendFile(
      path.resolve(repository, directory, "live-llm-skip.log"),
      `${plan.refs
        .filter((ref) => ref.kind === "commit")
        .flatMap((ref) =>
          selectRoutes(ref.paths)
            .runs.filter((run) => run.mode === "live")
            .map((run) =>
              JSON.stringify({
                timestamp: new Date().toISOString(),
                pushedRef: ref.remoteRef,
                objectOID: ref.localOID,
                commitOID: ref.commitOID,
                stack: run.stack,
                suite: run.suite,
                reason,
              }),
            ),
        )
        .join("\n")}\n`,
    )
  }

  const deadline = Date.now() + 15 * 60_000
  const commitPlans = new Map<string, Set<string>>()
  for (const ref of plan.refs) {
    if (ref.kind !== "commit" || !ref.commitOID) continue
    const existing = commitPlans.get(ref.commitOID) ?? new Set<string>()
    ref.paths.forEach((item) => existing.add(item))
    commitPlans.set(ref.commitOID, existing)
  }
  const commonDirectory = path.resolve(repository, (await git(repository, ["rev-parse", "--git-common-dir"])).trim())
  const cacheFile = path.join(commonDirectory, "deepagent-code/live-llm-cache.json")
  const cache = await readSuccessCache(cacheFile)
  const processIdentity = `${process.pid}:${crypto.randomUUID()}`

  for (const [commitOID, paths] of commitPlans) {
    const selection = selectRoutes(paths)
    await withDetachedWorktree(repository, commitOID, async (worktree) => {
      await runPrePushCommand(["bun", "install", "--frozen-lockfile"], worktree, deadline)
      for (const item of commandsForChecks(selection.checks)) {
        await runPrePushCommand(item.args, path.join(worktree, item.cwd), deadline)
      }
      if (!required || skipping) return

      const selectedLiveRuns = selection.runs.filter((run) => run.mode === "live")
      const unqualified = unqualifiedRuns(selectedLiveRuns)
      if (unqualified.length) {
        throw new Error(
          `Live LLM execution is required, but these suites have not completed 30/30 qualification: ` +
            unqualified.map(modelRunKey).join(", "),
        )
      }
      const config = await loadLiveLLMConfig()
      const fingerprint = modelFingerprint(config)
      const refs = plan.refs.filter((ref) => ref.kind === "commit" && ref.commitOID === commitOID)
      const harnessHash = await hashPatterns(worktree, [
        "packages/llm/script/live-llm/**",
        "packages/core/script/live-llm/**",
        "packages/deepagent-code/script/live-llm/**",
        "script/pre-push-live-llm.ts",
      ])
      const routeManifestHash = await hashPaths(worktree, [
        "packages/deepagent-code/script/live-llm/routes.ts",
        "packages/deepagent-code/script/live-llm/dispatcher.ts",
      ])
      const relevantSourceHash = await hashPaths(worktree, paths)
      const sandboxProfileHash = await hashPatterns(worktree, [
        "packages/core/script/live-llm/sandbox*.ts",
        "packages/core/script/live-llm/*repair.ts",
      ])
      for (const run of selectedLiveRuns) {
        const item = commandForModelRun(run)
        if (!item) throw new Error(`No command is registered for ${modelRunKey(run)}`)
        const identities = refs.map(
          (ref): SuccessCacheKeyInput => ({
            pushedRef: ref.remoteRef,
            objectOID: ref.localOID,
            commitOID,
            suite: run.suite,
            suiteVersion: "1",
            stack: run.stack,
            providerID: fingerprint.providerID,
            modelID: fingerprint.modelID,
            modelRevision: fingerprint.modelRevision,
            processIdentity,
            generationParametersHash: hashText(`${modelRunKey(run)}:generation-v1`),
            harnessHash,
            routeManifestHash,
            relevantSourceHash,
            sandboxProfileHash,
            oracleHash: sandboxProfileHash,
          }),
        )
        if (identities.every((identity) => cache.entries.some((entry) => canReuseSuccess(entry, identity)))) {
          console.log(`Reused live LLM success cache for ${modelRunKey(run)} at ${commitOID}`)
          continue
        }
        await runPrePushCommand(
          item.args,
          path.join(worktree, item.cwd),
          deadline,
          prePushEnvironment(process.env, config),
        )
        const completedAt = Date.now()
        for (const identity of identities) {
          const key = successCacheKey(identity)
          cache.entries.splice(0, cache.entries.length, ...cache.entries.filter((entry) => entry.key !== key), {
            key,
            completedAt,
            identity,
          })
        }
        await writeSuccessCache(cacheFile, cache)
      }
    })
  }

  if (skipping) console.log(`Skipped ${liveRuns.length} live LLM suite(s); audit record appended.`)
  if (!required && liveRuns.length) {
    console.log("Live LLM suites are not enabled on this machine; selected suites were not executed.")
  }
}

async function withDetachedWorktree(repository: string, commitOID: string, run: (worktree: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepagent-code-pre-push-"))
  const worktree = path.join(directory, "repository")
  await git(repository, ["worktree", "add", "--detach", worktree, commitOID])
  try {
    await run(worktree)
  } finally {
    await git(repository, ["worktree", "remove", "--force", worktree])
    await rm(directory, { recursive: true, force: true })
  }
}

export function prePushEnvironment(
  hostEnvironment: Readonly<Record<string, string | undefined>> = process.env,
  config?: LiveLLMConfig,
): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(
      [
        "PATH",
        "TMPDIR",
        "SHELL",
        "LANG",
        "LC_ALL",
        "TERM",
        "COLORTERM",
        "NO_COLOR",
        "FORCE_COLOR",
        "CI",
        "BUN_INSTALL",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "PATHEXT",
      ].flatMap((key) => (hostEnvironment[key] === undefined ? [] : ([[key, hostEnvironment[key]]] as const))),
    ),
    ...(config
      ? {
          DEEPAGENT_CODE_LIVE_LLM_API_KEY_FILE: config.apiKeyFile,
          DEEPAGENT_CODE_LIVE_LLM_BASE_URL: config.baseURL,
          DEEPAGENT_CODE_LIVE_LLM_MODEL: config.modelID,
          DEEPAGENT_CODE_LIVE_LLM_TIMEOUT_MS: String(config.timeoutMs),
          ...(config.modelRevision ? { DEEPAGENT_CODE_LIVE_LLM_REVISION: config.modelRevision } : {}),
        }
      : {}),
  }
}

export async function runPrePushCommand(
  args: string[],
  cwd: string,
  deadline = Number.POSITIVE_INFINITY,
  environment = prePushEnvironment(),
) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error("Pre-push live LLM budget exhausted before starting the next command")
  const subprocess = Bun.spawn(args, {
    cwd,
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
    detached: Number.isFinite(remaining) && process.platform !== "win32",
  })
  const timeout = Number.isFinite(remaining)
    ? setTimeout(() => {
        terminateProcessTree(subprocess.pid)
        setTimeout(() => {
          if (subprocess.exitCode === null) terminateProcessTree(subprocess.pid, "SIGKILL")
        }, 1_000)
      }, remaining)
    : undefined
  const exitCode = await subprocess.exited
  if (timeout) clearTimeout(timeout)
  if (Date.now() >= deadline) throw new Error(`Pre-push command exceeded the 15 minute budget: ${args.join(" ")}`)
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed with exit code ${exitCode}`)
}

function terminateProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  if (process.platform === "win32") {
    Bun.spawn(["taskkill", "/pid", String(pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      return
    }
  }
}

async function hashPatterns(repository: string, patterns: string[]) {
  return hashPaths(
    repository,
    (
      await Promise.all(
        patterns.map((pattern) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: repository, onlyFiles: true }))),
      )
    ).flat(),
  )
}

async function hashPaths(repository: string, paths: Iterable<string>) {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const file of [...new Set(paths)].sort()) {
    hasher.update(`${file}\0`)
    const source = Bun.file(path.join(repository, file))
    hasher.update((await source.exists()) ? new Uint8Array(await source.arrayBuffer()) : "<missing>")
    hasher.update("\0")
  }
  return hasher.digest("hex")
}

function hashText(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

async function git(repository: string, args: string[]) {
  const process = Bun.spawn(["git", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed (${exitCode}): ${stderr.trim() || "no stderr"}`)
  return stdout
}
