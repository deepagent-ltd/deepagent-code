import { describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import {
  containsDataPath,
  legacyDataHome,
  platformConfigHome,
  platformDataHome,
  resolveConfigPath,
  resolveDataPath,
} from "../src/global-path"

// Pure home-selection matrix (D-W1). win32 branches are exercised here with an injected platform
// so the split is pinned on every host; the win32 CI runner additionally executes the live branch.
describe("platform home selection", () => {
  test("POSIX keeps the unified ~/.deepagent/code root for both homes", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(platformDataHome({}, platform)).toBe(path.join(os.homedir(), ".deepagent", "code"))
      expect(platformConfigHome({}, platform)).toBe(platformDataHome({}, platform))
    }
  })

  test("win32 splits roaming config from machine-local data", () => {
    const env = {
      APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
    }
    expect(platformDataHome(env, "win32")).toBe("C:\\Users\\ada\\AppData\\Local\\deepagent-code")
    expect(platformConfigHome(env, "win32")).toBe("C:\\Users\\ada\\AppData\\Roaming\\deepagent-code")
  })

  test("win32 falls back to the profile AppData layout when the env vars are absent", () => {
    // resolveHomeBase falls back to os.homedir(); compute the expectation the same way.
    const home = os.homedir()
    expect(platformDataHome({}, "win32")).toBe(path.win32.join(home, "AppData", "Local", "deepagent-code"))
    expect(platformConfigHome({}, "win32")).toBe(path.win32.join(home, "AppData", "Roaming", "deepagent-code"))
  })

  test("an isolated test home stays unified even on win32", () => {
    const env = {
      DEEPAGENT_CODE_TEST_HOME: "/tmp/deepagent-test-home",
      APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
    }
    expect(platformDataHome(env, "win32")).toBe(path.join("/tmp/deepagent-test-home", ".deepagent", "code"))
    expect(platformConfigHome(env, "win32")).toBe(platformDataHome(env, "win32"))
  })

  test("an exact data-root override wins only with the test boundary, on every platform", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const env = {
        DEEPAGENT_CODE_TEST_HOME: "/tmp/deepagent-test-home",
        DEEPAGENT_CODE_HOME: "/private/root",
        APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
      }
      expect(platformDataHome(env, platform)).toBe(path.resolve("/private/root"))
      expect(platformConfigHome(env, platform)).toBe(path.resolve("/private/root"))
      // Without the boundary the override is inert.
      expect(platformDataHome({ DEEPAGENT_CODE_HOME: "/private/root" }, platform)).not.toBe(path.resolve("/private/root"))
    }
  })

  test("legacyDataHome is the pre-split unified root", () => {
    expect(legacyDataHome({ DEEPAGENT_CODE_TEST_HOME: "/tmp/x" })).toBe(path.join("/tmp/x", ".deepagent", "code"))
  })

  test("resolveDataPath/resolveConfigPath track the live platform", () => {
    const split = process.platform === "win32" && !process.env.DEEPAGENT_CODE_TEST_HOME
    expect(resolveConfigPath() === resolveDataPath()).toBe(!split)
  })

  test("containsDataPath still guards the data root", () => {
    const env = { DEEPAGENT_CODE_TEST_HOME: "/test-home", DEEPAGENT_CODE_HOME: "/private/root" }
    expect(containsDataPath("/private/root/state/file", env)).toBe(true)
    expect(containsDataPath("/private/root-other/file", env)).toBe(false)
  })
})
