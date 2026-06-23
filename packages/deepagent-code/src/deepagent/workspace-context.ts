export * as DeepAgentWorkspace from "./workspace-context"

import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"

export type WorkspaceInfo = {
  validationCommands: string[]
  hasTypeScript: boolean
  hasPython: boolean
  packageJson: { scripts?: Record<string, string> } | null
  agentsMdContent: string | null
  gitBranch: string | null
  gitRoot: string | null
}

const cache = new Map<string, WorkspaceInfo>()
const pending = new Map<string, Promise<WorkspaceInfo>>()

export function getCached(cwd: string): WorkspaceInfo | null {
  return cache.get(cwd) ?? null
}

export async function detect(cwd: string): Promise<WorkspaceInfo> {
  const cached = cache.get(cwd)
  if (cached) return cached

  const inflight = pending.get(cwd)
  if (inflight) return inflight

  const p = detectImpl(cwd)
  pending.set(cwd, p)
  const result = await p
  cache.set(cwd, result)
  pending.delete(cwd)
  return result
}

async function detectImpl(cwd: string): Promise<WorkspaceInfo> {
  const info: WorkspaceInfo = {
    validationCommands: [],
    hasTypeScript: false,
    hasPython: false,
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
  info.hasPython = await exists(path.join(cwd, "requirements.txt"))
  info.agentsMdContent = await readFileSafe(path.join(cwd, "AGENTS.md"))
  info.validationCommands = inferCommands(info)

  return info
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

function inferCommands(info: WorkspaceInfo): string[] {
  // P2-7 / P1-3: single source of validation-command inference lives in core's validation.ts
  // (includes test/build/python + the AGENTS.md extractor). This bun-based workspace passes the
  // "bun run" runner so emitted commands are runnable via `sh -c` in validation-exec.
  return AgentGateway.DeepAgentValidation.inferValidationCommands({
    cwd: "",
    packageJson: info.packageJson ?? undefined,
    agentsMd: info.agentsMdContent ?? undefined,
    hasTypeScript: info.hasTypeScript,
    hasPython: info.hasPython,
    runner: "bun run",
  })
}
