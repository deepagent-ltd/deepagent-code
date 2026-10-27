import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mkdtempSync } from "node:fs"
import { DeepAgentCodeHome, PROJECT_SCHEMA_VERSION, SESSION_SCHEMA_VERSION } from "../../src/deepagent/workspace"
import { tmpRoot } from "../fixture/tmpdir"

let root: string
let home: DeepAgentCodeHome

beforeEach(() => {
  root = mkdtempSync(tmpRoot())
  home = new DeepAgentCodeHome(root)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("V3.1 DeepAgent Code workspace", () => {
  test("initializes project under fixed DeepAgent Code home", () => {
    const paths = home.ensureProject("projA", "/repo/worktree")
    expect(paths.root).toBe(path.join(root, "project", "projA"))
    expect(existsSync(paths.projectMemoryDir)).toBe(true)
    expect(existsSync(paths.projectRulesDir)).toBe(true)
    expect(existsSync(paths.projectKnowledgeDir)).toBe(true)
    expect(existsSync(paths.handoffDir)).toBe(true)
    expect(existsSync(paths.questDir)).toBe(true)
    expect(existsSync(paths.indexesDir)).toBe(true)
    expect(existsSync(paths.sessionsDir)).toBe(true)
    expect(JSON.parse(readFileSync(path.join(paths.indexesDir, "manifest.json"), "utf8")).schema_version).toBe(
      "deepagent-code.project_index_manifest.v1",
    )

    const manifest = JSON.parse(readFileSync(paths.projectJson, "utf8"))
    expect(manifest.schema_version).toBe(PROJECT_SCHEMA_VERSION)
    expect(manifest.project_id).toBe("projA")
    expect(JSON.stringify(manifest)).not.toContain("deepcode")
  })

  test("public pointer is symlink or readonly manifest and ensureProject is idempotent", () => {
    const first = home.ensureProject("projA")
    const second = home.ensureProject("projA")
    expect(second.root).toBe(first.root)
    expect(existsSync(first.publicLink) || existsSync(`${first.publicLink}.link.json`)).toBe(true)
    if (existsSync(first.publicLink)) expect(lstatSync(first.publicLink).isSymbolicLink()).toBe(true)
  })

  test("accepts the strict relative public symlink with host-native separators", () => {
    const paths = home.ensureProject("projA")
    if (!existsSync(paths.publicLink)) return
    unlinkSync(paths.publicLink)
    symlinkSync(["..", "..", "public"].join(path.sep), paths.publicLink, "dir")
    expect(home.ensureProject("projA").publicLink).toBe(paths.publicLink)
  })

  test("rejects a dot-rewritten public target under the host's actual symlink resolution", () => {
    const paths = home.ensureProject("projA")
    if (!existsSync(paths.publicLink)) return
    const outside = path.join(root, "outside")
    mkdirSync(path.join(outside, "deeper"), { recursive: true })
    mkdirSync(path.join(outside, "public"))
    symlinkSync(path.join(outside, "deeper"), path.join(root, "x"), "dir")
    unlinkSync(paths.publicLink)
    symlinkSync(["..", "..", "x", "..", "public"].join(path.sep), paths.publicLink, "dir")
    // Windows resolves the dot segments before traversing x; POSIX traverses x first.
    // Both must reject the same stored non-exact target instead of normalizing it into authority.
    expect(realpathSync(paths.publicLink)).toBe(realpathSync(path.join(process.platform === "win32" ? root : outside, "public")))
    expect(() => home.ensureProject("projA")).toThrow("ProjectStore.InvalidPublicLink")
  })

  test("rejects absolute public symlinks and ordinary replacement directories", () => {
    const paths = home.ensureProject("projA")
    if (!existsSync(paths.publicLink)) return
    unlinkSync(paths.publicLink)
    symlinkSync(paths.publicDir, paths.publicLink, "dir")
    expect(() => home.ensureProject("projA")).toThrow("ProjectStore.InvalidPublicLink")
    unlinkSync(paths.publicLink)
    mkdirSync(paths.publicLink)
    expect(() => home.ensureProject("projA")).toThrow("ProjectStore.InvalidPublicLink")
  })

  test("repairs project root that exists without manifest", () => {
    const paths = home.projectPaths("projA")
    mkdirSync(paths.root, { recursive: true })

    home.ensureProject("projA", "/repo/worktree")

    const manifest = JSON.parse(readFileSync(paths.projectJson, "utf8"))
    expect(manifest.schema_version).toBe(PROJECT_SCHEMA_VERSION)
    expect(manifest.project_id).toBe("projA")
    expect(existsSync(paths.sessionsDir)).toBe(true)
  })

  test("creates session and run prompt templates", () => {
    const session = home.ensureSession("projA", "sess1")
    expect(existsSync(session.rawInputs)).toBe(true)
    expect(existsSync(session.draftsDir)).toBe(true)
    expect(existsSync(session.confirmedDir)).toBe(true)
    const sessionManifest = JSON.parse(readFileSync(session.sessionJson, "utf8"))
    expect(sessionManifest.schema_version).toBe(SESSION_SCHEMA_VERSION)

    const run = home.ensureRun("projA", "sess1", "run1")
    expect(existsSync(run.graphDir)).toBe(true)
    expect(existsSync(run.artifactsDir)).toBe(true)
    expect(existsSync(run.logsDir)).toBe(true)
    expect(readFileSync(run.runContext, "utf8")).toContain("run_id: run1")
    expect(JSON.parse(readFileSync(run.runState, "utf8")).schema_version).toBe("deepagent-code.run_state.v1")
  })

  test("rejects unsafe ids before touching filesystem", () => {
    expect(() => home.ensureProject("../escape")).toThrow("unsafe")
    expect(() => home.ensureSession("projA", "../sess")).toThrow("unsafe")
    expect(() => home.ensureRun("projA", "sess1", "../run")).toThrow("unsafe")
  })

  test("rejects public symlink that points outside the managed public area", () => {
    const paths = home.ensureProject("projA")
    if (!existsSync(paths.publicLink)) return
    unlinkSync(paths.publicLink)
    symlinkSync(tmpdir(), paths.publicLink, "dir")
    expect(() => home.ensureProject("projA")).toThrow("ProjectStore.InvalidPublicLink")
  })
})
