import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { resolveDataPath } from "../global-path"

export const DEEPAGENT_CODE_HOME_ENV = "DEEPAGENT_CODE_HOME"
export const PROJECT_SCHEMA_VERSION = "deepagent-code.project.v1"
export const SESSION_SCHEMA_VERSION = "deepagent-code.session.v1"
export const RUN_SCHEMA_VERSION = "deepagent-code.run.v1"
export const PROJECT_INDEX_SCHEMA_VERSION = "deepagent-code.project_index_manifest.v1"

export type ProjectPaths = {
  readonly root: string
  readonly publicDir: string
  readonly publicLink: string
  readonly docsDir: string
  readonly projectMemoryDir: string
  readonly projectRulesDir: string
  readonly projectKnowledgeDir: string
  readonly handoffDir: string
  readonly questDir: string
  readonly indexesDir: string
  readonly sessionsDir: string
  readonly projectJson: string
}

export type SessionPaths = {
  readonly root: string
  readonly sessionJson: string
  readonly promptDir: string
  readonly rawInputs: string
  readonly draftsDir: string
  readonly confirmedDir: string
  readonly suggestionsDir: string
  readonly runsDir: string
}

export type RunPaths = {
  readonly root: string
  readonly runJson: string
  readonly graphDir: string
  readonly artifactsDir: string
  readonly logsDir: string
  readonly runContext: string
  readonly runState: string
}

export type ProjectManifest = {
  readonly schema_version: typeof PROJECT_SCHEMA_VERSION
  readonly project_id: string
  readonly worktree: string | null
  readonly created_at: string
}

export type SessionManifest = {
  readonly schema_version: typeof SESSION_SCHEMA_VERSION
  readonly project_id: string
  readonly session_id: string
  readonly created_at: string
}

export type RunManifest = {
  readonly schema_version: typeof RUN_SCHEMA_VERSION
  readonly project_id: string
  readonly session_id: string
  readonly run_id: string
  readonly created_at: string
}

export const DEEPAGENT_CODE_TEST_HOME_ENV = "DEEPAGENT_CODE_TEST_HOME"

// Single storage-root contract (P2-F): delegate to the shared pure resolver (core/global-path.ts),
// the SAME computation Global.Path.data uses. DEEPAGENT_CODE_HOME wins; otherwise
// <DEEPAGENT_CODE_TEST_HOME ?? os.homedir()>/.deepagent/code. There is no longer a second
// independent resolver — both this and Global.Path call resolveDataPath, so they cannot diverge for
// any env combination ([storage-root-dual-resolver]).
export const resolveDeepAgentCodeHome = (env: NodeJS.ProcessEnv = process.env): string => resolveDataPath(env)

const safeSegment = (name: string, value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${name} contains unsafe characters: ${value}`)
  return value
}

const writeJsonIfMissing = (file: string, value: unknown): void => {
  if (existsSync(file)) return
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8")
}

const ensureFile = (file: string, content = ""): void => {
  if (existsSync(file)) return
  writeFileSync(file, content, "utf8")
}

export class DeepAgentCodeHome {
  readonly root: string

  constructor(root = resolveDeepAgentCodeHome()) {
    this.root = path.resolve(root)
    this.ensurePublic()
  }

  ensurePublic(): string {
    const publicDir = path.join(this.root, "public")
    for (const dir of ["docs", "skills", "templates", "global-memory", "indexes"]) {
      mkdirSync(path.join(publicDir, dir), { recursive: true })
    }
    return publicDir
  }

  projectPaths(projectID: string): ProjectPaths {
    const project = safeSegment("projectID", projectID)
    const root = path.join(this.root, "project", project)
    const docsDir = path.join(root, "docs")
    return {
      root,
      publicDir: path.join(this.root, "public"),
      publicLink: path.join(root, "public"),
      docsDir,
      projectMemoryDir: path.join(docsDir, "project-memory"),
      projectRulesDir: path.join(docsDir, "project-rules"),
      projectKnowledgeDir: path.join(docsDir, "project-knowledge"),
      handoffDir: path.join(docsDir, "handoff"),
      questDir: path.join(docsDir, "quest"),
      indexesDir: path.join(root, "indexes"),
      sessionsDir: path.join(root, "sessions"),
      projectJson: path.join(root, "project.json"),
    }
  }

  ensureProject(projectID: string, worktree: string | null = null): ProjectPaths {
    const paths = this.projectPaths(projectID)
    if (!existsSync(paths.root)) this.createProjectAtomically(paths, projectID, worktree)
    this.validateProject(paths, projectID)
    return paths
  }

  ensureSession(projectID: string, sessionID: string): SessionPaths {
    const session = safeSegment("sessionID", sessionID)
    const project = this.ensureProject(projectID)
    const root = path.join(project.sessionsDir, session)
    const paths: SessionPaths = {
      root,
      sessionJson: path.join(root, "session.json"),
      promptDir: path.join(root, "prompt"),
      rawInputs: path.join(root, "prompt", "raw-inputs.jsonl"),
      draftsDir: path.join(root, "prompt", "drafts"),
      confirmedDir: path.join(root, "prompt", "confirmed"),
      suggestionsDir: path.join(root, "prompt", "suggestions"),
      runsDir: path.join(root, "runs"),
    }
    mkdirSync(paths.draftsDir, { recursive: true })
    mkdirSync(paths.confirmedDir, { recursive: true })
    mkdirSync(paths.suggestionsDir, { recursive: true })
    mkdirSync(paths.runsDir, { recursive: true })
    ensureFile(paths.rawInputs)
    writeJsonIfMissing(paths.sessionJson, {
      schema_version: SESSION_SCHEMA_VERSION,
      project_id: projectID,
      session_id: sessionID,
      created_at: new Date().toISOString(),
    } satisfies SessionManifest)
    return paths
  }

  ensureRun(projectID: string, sessionID: string, runID: string): RunPaths {
    const run = safeSegment("runID", runID)
    const session = this.ensureSession(projectID, sessionID)
    const root = path.join(session.runsDir, run)
    const paths: RunPaths = {
      root,
      runJson: path.join(root, "run.json"),
      graphDir: path.join(root, "graph"),
      artifactsDir: path.join(root, "artifacts"),
      logsDir: path.join(root, "logs"),
      runContext: path.join(root, "run_context.md"),
      runState: path.join(root, "run_state.json"),
    }
    mkdirSync(paths.graphDir, { recursive: true })
    mkdirSync(paths.artifactsDir, { recursive: true })
    mkdirSync(paths.logsDir, { recursive: true })
    ensureFile(paths.runContext, `# Run Context\n\nrun_id: ${runID}\n`)
    writeJsonIfMissing(paths.runJson, {
      schema_version: RUN_SCHEMA_VERSION,
      project_id: projectID,
      session_id: sessionID,
      run_id: runID,
      created_at: new Date().toISOString(),
    } satisfies RunManifest)
    writeJsonIfMissing(paths.runState, { schema_version: "deepagent-code.run_state.v1", run_id: runID, phase: "created" })
    return paths
  }

  private createProjectAtomically(paths: ProjectPaths, projectID: string, worktree: string | null): void {
    mkdirSync(path.dirname(paths.root), { recursive: true })
    const tempRoot = `${paths.root}.tmp-${process.pid}-${randomUUID()}`
    const tempDocsDir = path.join(tempRoot, "docs")
    const tempPaths = {
      ...paths,
      root: tempRoot,
      publicLink: path.join(tempRoot, "public"),
      docsDir: tempDocsDir,
      projectMemoryDir: path.join(tempDocsDir, "project-memory"),
      projectRulesDir: path.join(tempDocsDir, "project-rules"),
      projectKnowledgeDir: path.join(tempDocsDir, "project-knowledge"),
      handoffDir: path.join(tempDocsDir, "handoff"),
      questDir: path.join(tempDocsDir, "quest"),
      indexesDir: path.join(tempRoot, "indexes"),
      sessionsDir: path.join(tempRoot, "sessions"),
      projectJson: path.join(tempRoot, "project.json"),
    } satisfies ProjectPaths
    try {
      for (const dir of [
        tempPaths.projectMemoryDir,
        tempPaths.projectRulesDir,
        tempPaths.projectKnowledgeDir,
        tempPaths.handoffDir,
        tempPaths.questDir,
        tempPaths.indexesDir,
        tempPaths.sessionsDir,
      ]) mkdirSync(dir, { recursive: true })
      writeJsonIfMissing(tempPaths.projectJson, {
        schema_version: PROJECT_SCHEMA_VERSION,
        project_id: projectID,
        worktree,
        created_at: new Date().toISOString(),
      } satisfies ProjectManifest)
      writeJsonIfMissing(path.join(tempPaths.indexesDir, "manifest.json"), {
        schema_version: PROJECT_INDEX_SCHEMA_VERSION,
        project_id: projectID,
        rebuildable: true,
        indexes: ["project-memory", "project-rules", "project-knowledge", "handoff", "quest"],
      })
      this.createPublicPointer(tempPaths.publicLink)
      ensureFile(path.join(tempRoot, ".initialized"), new Date().toISOString() + "\n")
      renameSync(tempRoot, paths.root)
    } catch (error) {
      rmSync(tempRoot, { recursive: true, force: true })
      throw error
    }
  }

  private createPublicPointer(publicPath: string): void {
    try {
      symlinkSync("../../public", publicPath, "dir")
    } catch {
      writeFileSync(`${publicPath}.link.json`, JSON.stringify({ target: "../../public", readonly: true }, null, 2), "utf8")
    }
  }

  private validateProject(paths: ProjectPaths, projectID: string): void {
    const manifest = JSON.parse(readFileSync(paths.projectJson, "utf8")) as ProjectManifest
    if (manifest.schema_version !== PROJECT_SCHEMA_VERSION) throw new Error(`invalid project schema for ${projectID}`)
    if (manifest.project_id !== projectID) throw new Error(`project id mismatch: ${manifest.project_id} !== ${projectID}`)
    for (const dir of [paths.projectMemoryDir, paths.projectRulesDir, paths.projectKnowledgeDir, paths.handoffDir, paths.questDir, paths.indexesDir, paths.sessionsDir]) {
      mkdirSync(dir, { recursive: true })
    }
    if (existsSync(paths.publicLink)) {
      const stat = lstatSync(paths.publicLink)
      if (!stat.isSymbolicLink()) throw new Error(`ProjectStore.InvalidPublicLink: ${paths.publicLink}`)
      if (readlinkSync(paths.publicLink) !== "../../public") throw new Error(`ProjectStore.InvalidPublicLink: ${paths.publicLink}`)
    } else if (!existsSync(`${paths.publicLink}.link.json`)) {
      this.createPublicPointer(paths.publicLink)
    }
    writeJsonIfMissing(path.join(paths.indexesDir, "manifest.json"), {
      schema_version: PROJECT_INDEX_SCHEMA_VERSION,
      project_id: projectID,
      rebuildable: true,
      indexes: ["project-memory", "project-rules", "project-knowledge", "handoff", "quest"],
    })
  }
}
