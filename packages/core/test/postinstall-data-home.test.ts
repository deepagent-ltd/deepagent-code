import { expect, test } from "bun:test"
import os from "node:os"
import { platformDataHome } from "../src/global-path"
import { installDataHome } from "../../deepagent-code/script/install-data-home.mjs"

test("published Node postinstall storage root matches Core on each platform", () => {
  const home = os.homedir()
  const cases: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform }[] = [
    { env: {}, platform: "linux" },
    { env: {}, platform: "darwin" },
    { env: {}, platform: "win32" },
    { env: { LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" }, platform: "win32" },
    { env: { DEEPAGENT_CODE_HOME: "/ignored" }, platform: "linux" },
    { env: { DEEPAGENT_CODE_TEST_HOME: "/isolated" }, platform: "win32" },
    { env: { DEEPAGENT_CODE_TEST_HOME: "/isolated", DEEPAGENT_CODE_HOME: "/exact" }, platform: "linux" },
  ]
  for (const item of cases)
    expect(installDataHome(item.env, item.platform, home)).toBe(
      platformDataHome(item.env, item.platform),
    )
})
