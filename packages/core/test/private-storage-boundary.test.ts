import { describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { Database } from "../src/database/database"
import { Flag } from "../src/flag/flag"
import { containsDataPath, resolveDataPath } from "../src/global-path"

describe("private storage boundary", () => {
  test("production ignores an arbitrary DEEPAGENT_CODE_HOME", () => {
    const root = resolveDataPath({ DEEPAGENT_CODE_HOME: "/outside" })
    expect(root).toBe(path.join(os.homedir(), ".deepagent", "code"))
  })

  test("containsDataPath rejects traversal and sibling prefixes", () => {
    const env = { DEEPAGENT_CODE_TEST_HOME: "/test-home", DEEPAGENT_CODE_HOME: "/private/root" }
    expect(containsDataPath("/private/root/state/file", env)).toBe(true)
    expect(containsDataPath("/private/root-other/file", env)).toBe(false)
    expect(containsDataPath("/private/root/../outside", env)).toBe(false)
  })

  test("production rejects an external database path", () => {
    const previous = Flag.DEEPAGENT_CODE_DB
    const testHome = process.env.DEEPAGENT_CODE_TEST_HOME
    try {
      delete process.env.DEEPAGENT_CODE_TEST_HOME
      Flag.DEEPAGENT_CODE_DB = "/tmp/deepagent-outside.db"
      expect(() => Database.path()).toThrow("DEEPAGENT_CODE_DB must stay under")
    } finally {
      Flag.DEEPAGENT_CODE_DB = previous
      if (testHome === undefined) delete process.env.DEEPAGENT_CODE_TEST_HOME
      else process.env.DEEPAGENT_CODE_TEST_HOME = testHome
    }
  })

  test("shipped production sources contain no private writes to legacy or system-temp roots", async () => {
    const repo = path.resolve(import.meta.dir, "../../..")
    const files = [
      ...new Bun.Glob("packages/*/src/**/*.{ts,tsx,js,mjs}").scanSync({ cwd: repo, onlyFiles: true }),
      "packages/deepagent-code/script/postinstall.mjs",
      "install",
      "github/action.yml",
      "patches/install-korean-ime-fix.sh",
    ].filter(
      (file) =>
        !file.includes("/__tests__/") &&
        !file.endsWith(".test.ts") &&
        !file.endsWith(".test.tsx") &&
        file !== "packages/desktop/src/main/index.ts",
    )
    const forbidden = [
      { name: "system tmp API", pattern: /\b(?:os\.)?tmpdir\(\)/ },
      { name: "hard-coded system tmp", pattern: /[\"'`]\/tmp(?:\/|[\"'`])/ },
      { name: "legacy install root", pattern: /\.deepagent-code\/bin/ },
      { name: "legacy WSL state", pattern: /\$HOME\/\.local\/state/ },
      { name: "legacy XDG package", pattern: /from [\"']xdg-basedir[\"']/ },
      { name: "legacy data root", pattern: /[\"']\.local[\"']\s*,\s*[\"']share[\"']\s*,\s*[\"']deepagent-code[\"']/ },
      { name: "legacy config root", pattern: /[\"']\.config[\"']\s*,\s*[\"']deepagent-code[\"']/ },
    ]
    const violations = (
      await Promise.all(
        files.map(async (file) => {
          const content = await Bun.file(path.join(repo, file)).text()
          return forbidden.filter((rule) => rule.pattern.test(content)).map((rule) => `${file}: ${rule.name}`)
        }),
      )
    ).flat()
    expect(violations).toEqual([])
  })
})
