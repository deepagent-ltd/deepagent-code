import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { GlobalMigrate } from "../src/global-migrate"
import { tmpdir } from "./fixture/tmpdir"

// D-W1 one-time legacy migration. The logic is path-parameterized so the whole flow runs on any
// host; the win32 gate itself (migrateLegacyHomeIfNeeded) is a thin platform/env check.
describe("legacy home migration", () => {
  const seedLegacy = async (root: string) => {
    const legacy = path.join(root, "home", ".deepagent", "code")
    await fs.mkdir(path.join(legacy, "cache"), { recursive: true })
    await fs.writeFile(path.join(legacy, "config.jsonc"), "{ /* user config */ }")
    await fs.writeFile(path.join(legacy, "auth.json"), "{}")
    await fs.writeFile(path.join(legacy, "settings.json"), "{}")
    await fs.mkdir(path.join(legacy, "themes"), { recursive: true })
    await fs.writeFile(path.join(legacy, "themes", "mine.json"), "{}")
    await fs.writeFile(path.join(legacy, "deepagent-code-local.db"), "db-bytes")
    await fs.writeFile(path.join(legacy, "cache", "blob"), "cached")
    return {
      legacy,
      data: path.join(root, "local", "deepagent-code"),
      config: path.join(root, "roaming", "deepagent-code"),
    }
  }

  test("moves the tree to the data home, config-class entries to the config home, and leaves a note", async () => {
    await using tmp = await tmpdir()
    const { legacy, data, config } = await seedLegacy(tmp.path)

    const report = await GlobalMigrate.migrateLegacyHome({ legacy, data, config })

    expect(report).toMatchObject({ migrated: true })
    expect(report.movedToConfig).toEqual(["config.jsonc", "auth.json", "settings.json", "themes"])

    // Config-class entries landed in the roaming home with content intact.
    expect(await fs.readFile(path.join(config, "config.jsonc"), "utf8")).toBe("{ /* user config */ }")
    expect(await fs.readFile(path.join(config, "auth.json"), "utf8")).toBe("{}")
    expect(await fs.readFile(path.join(config, "settings.json"), "utf8")).toBe("{}")
    expect(await fs.readFile(path.join(config, "themes", "mine.json"), "utf8")).toBe("{}")

    // Everything else lives under the machine-local data home.
    expect(await fs.readFile(path.join(data, "deepagent-code-local.db"), "utf8")).toBe("db-bytes")
    expect(await fs.readFile(path.join(data, "cache", "blob"), "utf8")).toBe("cached")
    expect(await fs.stat(path.join(data, "auth.json")).catch(() => undefined)).toBeUndefined()

    // The legacy root holds only the pointer note.
    expect(await fs.readdir(legacy)).toEqual([GlobalMigrate.NOTE])
    const text = await fs.readFile(path.join(legacy, GlobalMigrate.NOTE), "utf8")
    expect(text).toContain(data)
    expect(text).toContain(config)
  })

  test("is idempotent: a second run reports already-migrated and changes nothing", async () => {
    await using tmp = await tmpdir()
    const { legacy, data, config } = await seedLegacy(tmp.path)
    await GlobalMigrate.migrateLegacyHome({ legacy, data, config })

    const second = await GlobalMigrate.migrateLegacyHome({ legacy, data, config })
    expect(second).toMatchObject({ migrated: false, skipped: "already-migrated" })
    expect(await fs.readdir(legacy)).toEqual([GlobalMigrate.NOTE])
    expect(await fs.readFile(path.join(config, "auth.json"), "utf8")).toBe("{}")
  })

  test("never clobbers an existing data home; legacy content stays put", async () => {
    await using tmp = await tmpdir()
    const { legacy, data, config } = await seedLegacy(tmp.path)
    await fs.mkdir(data, { recursive: true })
    await fs.writeFile(path.join(data, "deepagent-code-local.db"), "current")

    const report = await GlobalMigrate.migrateLegacyHome({ legacy, data, config })
    expect(report).toMatchObject({ migrated: false, skipped: "data-home-exists" })
    expect(await fs.readFile(path.join(data, "deepagent-code-local.db"), "utf8")).toBe("current")
    expect(await fs.readFile(path.join(legacy, "auth.json"), "utf8")).toBe("{}")
    expect(await fs.stat(config).catch(() => undefined)).toBeUndefined()
  })

  test("no legacy home is a clean no-op", async () => {
    await using tmp = await tmpdir()
    const report = await GlobalMigrate.migrateLegacyHome({
      legacy: path.join(tmp.path, "missing", ".deepagent", "code"),
      data: path.join(tmp.path, "local", "deepagent-code"),
      config: path.join(tmp.path, "roaming", "deepagent-code"),
    })
    expect(report).toMatchObject({ migrated: false, skipped: "no-legacy-home" })
  })

  test("the win32 gate only fires for native Windows production processes", async () => {
    await using tmp = await tmpdir()
    const { legacy } = await seedLegacy(tmp.path)
    const env = {
      DEEPAGENT_CODE_TEST_HOME: path.join(tmp.path, "home"),
      LOCALAPPDATA: path.join(tmp.path, "local"),
      APPDATA: path.join(tmp.path, "roaming"),
    }

    // Non-win32 platforms never migrate.
    expect(await GlobalMigrate.migrateLegacyHomeIfNeeded(env, "darwin")).toBeUndefined()
    // The test/desktop boundary (DEEPAGENT_CODE_TEST_HOME present) never migrates, even on win32.
    expect(await GlobalMigrate.migrateLegacyHomeIfNeeded(env, "win32")).toBeUndefined()
    // The seeded legacy tree is untouched by both gates. (The positive production path resolves
    // the real os.homedir(), so it is only exercised by the win32 CI runner, never here.)
    expect((await fs.readdir(legacy)).sort()).toContain("auth.json")
  })
})
