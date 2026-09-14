export * as DeepAgentWorkspace from "./workspace-context"

import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import type { ValidationCommand } from "@deepagent-code/core/deepagent/validation"

export type WorkspaceInfo = {
  validationCommands: string[]
  validationPlan: ValidationCommand[]
  hasTypeScript: boolean
  hasPython: boolean
  hasGo: boolean
  packageJson: { scripts?: Record<string, string>; packageManager?: string } | null
  agentsMdContent: string | null
  gitBranch: string | null
  gitRoot: string | null
}

const CACHE_TTL_MS = 30_000
const MAX_CACHE_ENTRIES = 128
const cache = new Map<string, { value: WorkspaceInfo; expiresAt: number }>()
const pending = new Map<string, Promise<WorkspaceInfo>>()

export function getCached(cwd: string): WorkspaceInfo | null {
  const key = path.resolve(cwd)
  const cached = cache.get(key)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  cache.delete(key)
  cache.set(key, cached)
  return cached.value
}

export async function detect(cwd: string): Promise<WorkspaceInfo> {
  const key = path.resolve(cwd)
  const cached = getCached(key)
  if (cached) return cached

  const inflight = pending.get(key)
  if (inflight) return inflight

  const task = detectImpl(key).then((value) => {
    if (pending.get(key) !== task) return value
    cache.delete(key)
    while (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    return value
  })
  pending.set(key, task)
  return task.finally(() => {
    if (pending.get(key) === task) pending.delete(key)
  })
}

export function invalidate(cwd: string): void {
  const key = path.resolve(cwd)
  cache.delete(key)
  pending.delete(key)
}

async function detectImpl(cwd: string): Promise<WorkspaceInfo> {
  const info: WorkspaceInfo = {
    validationCommands: [],
    validationPlan: [],
    hasTypeScript: false,
    hasPython: false,
    hasGo: false,
    packageJson: null,
    agentsMdContent: null,
    gitBranch: null,
    gitRoot: null,
  }

  const pkgContent = await readFileSafe(path.join(cwd, "package.json"))
  if (pkgContent) {
    try {
      info.packageJson = JSON.parse(pkgContent)
    } catch {}
  }

  info.hasTypeScript = (await exists(path.join(cwd, "tsconfig.json"))) || Boolean(info.packageJson?.scripts?.typecheck)
  info.hasPython = await Promise.all(
    ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile"].map((file) =>
      exists(path.join(cwd, file)),
    ),
  ).then((results) => results.some(Boolean))
  info.hasGo = await exists(path.join(cwd, "go.mod"))
  info.agentsMdContent = await readFileSafe(path.join(cwd, "AGENTS.md"))
  const git = await gitInfo(cwd)
  info.gitBranch = git.branch
  info.gitRoot = git.root
  info.validationPlan = inferCommands(info)
  info.validationCommands = info.validationPlan.map((command) => command.display)

  return info
}

async function gitInfo(cwd: string) {
  const run = async (args: string[]) => {
    const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" })
    if ((await process.exited) !== 0) return null
    const value = (await new Response(process.stdout).text()).trim()
    return value || null
  }
  return {
    branch: await run(["branch", "--show-current"]).catch(() => null),
    root: await run(["rev-parse", "--show-toplevel"]).catch(() => null),
  }
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8")
  } catch {
    return null
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function inferCommands(info: WorkspaceInfo): ValidationCommand[] {
  // P2-7 / P1-3: single source of validation-command inference lives in core's validation.ts
  // (includes test/build/python + the AGENTS.md extractor). This bun-based workspace passes the
  // "bun run" runner so emitted commands use the workspace package manager. The validation
  // executor runs them through the host's accepted shell (PowerShell/cmd on Windows, POSIX elsewhere).
  return AgentGateway.DeepAgentValidation.inferValidationPlan(
    AgentGateway.DeepAgentValidation.withPackageScriptRunner(
      {
        packageJson: info.packageJson ?? undefined,
        agentsMd: info.agentsMdContent ?? undefined,
        hasTypeScript: info.hasTypeScript,
        hasPython: info.hasPython,
        hasGo: info.hasGo,
      },
      "bun run",
    ),
  )
}
