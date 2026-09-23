import { describe, expect, test } from "bun:test"

import {
  expandRegValue,
  loadWindowsEnv,
  mergeRegistryEnv,
  parseRegQueryOutput,
  SYSTEM_ENV_KEY,
  USER_ENV_KEY,
} from "./win-env"

const hive = (key: string, body: string) => ({
  status: 0,
  stdout: `\r\n${key}\r\n${body}`,
})

describe("parseRegQueryOutput", () => {
  test("parses REG_SZ and REG_EXPAND_SZ values with spaced data", () => {
    const values = parseRegQueryOutput(
      hive(
        USER_ENV_KEY,
        "    JAVA_HOME    REG_SZ    C:\\Program Files\\Java\\jdk-17\r\n" +
          "    PATH    REG_EXPAND_SZ    %USERPROFILE%\\bin;%SystemRoot%\\system32\r\n" +
          "    TRAILING    REG_SZ    keeps  inner   spacing \r\n",
      ).stdout,
    )
    expect(values).toEqual([
      { name: "JAVA_HOME", type: "REG_SZ", data: "C:\\Program Files\\Java\\jdk-17" },
      { name: "PATH", type: "REG_EXPAND_SZ", data: "%USERPROFILE%\\bin;%SystemRoot%\\system32" },
      { name: "TRAILING", type: "REG_SZ", data: "keeps  inner   spacing " },
    ])
  })

  test("skips non-string types, the key default, headers and continuation lines", () => {
    const values = parseRegQueryOutput(
      hive(
        USER_ENV_KEY,
        "    (Default)    REG_SZ    (value not set)\r\n" +
          "    ENABLE    REG_DWORD    0x1\r\n" +
          "    BLOB    REG_BINARY    0a0b0c\r\n" +
          "    MULTI    REG_MULTI_SZ    a\\0b\r\n" +
          "        0d0e0f\r\n" +
          "    EMPTY    REG_SZ    \r\n",
      ).stdout,
    )
    expect(values).toEqual([{ name: "EMPTY", type: "REG_SZ", data: "" }])
  })

  test("returns nothing for unparseable output", () => {
    expect(parseRegQueryOutput("")).toEqual([])
    expect(parseRegQueryOutput("ERROR: The system was unable to find the specified registry key or value.")).toEqual([])
    expect(parseRegQueryOutput("    no type column here")).toEqual([])
  })

  test("accepts a value name containing spaces", () => {
    const values = parseRegQueryOutput(`${USER_ENV_KEY}\r\n    MY VAR    REG_SZ    data\r\n`)
    expect(values).toEqual([{ name: "MY VAR", type: "REG_SZ", data: "data" }])
  })
})

describe("expandRegValue", () => {
  const table = {
    USERPROFILE: "C:\\Users\\me",
    SystemRoot: "C:\\Windows",
    NESTED: "%SystemRoot%\\SysWOW64",
  }
  const resolve = (name: string) => table[name as keyof typeof table]

  test("expands known references and leaves unknown ones literal", () => {
    expect(expandRegValue("%USERPROFILE%\\bin", resolve)).toBe("C:\\Users\\me\\bin")
    expect(expandRegValue("%Unknown%\\bin", resolve)).toBe("%Unknown%\\bin")
  })

  test("resolves chained references iteratively", () => {
    expect(expandRegValue("%NESTED%\\cmd.exe", resolve)).toBe("C:\\Windows\\SysWOW64\\cmd.exe")
  })

  test("stops self-referential cycles instead of hanging", () => {
    expect(expandRegValue("%LOOP%", (name) => (name === "LOOP" ? "%LOOP%" : undefined), 4)).toBe("%LOOP%")
  })
})

describe("mergeRegistryEnv", () => {
  test("process env wins over user env, user env wins over system env", () => {
    const merged = mergeRegistryEnv(
      { PATH: "C:\\live", FROM_PROCESS: "1" },
      { FROM_PROCESS: "2", FROM_USER: "user", SHARED: "user" },
      { FROM_USER: "system", FROM_SYSTEM: "system", SHARED: "system" },
    )
    expect(merged.FROM_PROCESS).toBeUndefined()
    expect(merged.FROM_USER).toBe("user")
    expect(merged.FROM_SYSTEM).toBe("system")
    expect(merged.SHARED).toBe("user")
    expect(merged.PATH).toBeUndefined()
  })

  test("presence check is case-insensitive (Path vs PATH)", () => {
    const merged = mergeRegistryEnv({ Path: "C:\\live" }, { PATH: "C:\\user" }, { PATH: "C:\\system" })
    expect(merged.PATH).toBeUndefined()
    expect(merged.Path).toBeUndefined()
  })

  test("missing PATH composes system entries before user entries", () => {
    const merged = mergeRegistryEnv({}, { PATH: "C:\\user" }, { PATH: "C:\\system" })
    expect(merged.PATH).toBe("C:\\system;C:\\user")
  })

  test("missing PATH with only one hive present does not emit an empty segment", () => {
    expect(mergeRegistryEnv({}, { PATH: "C:\\user" }, {}).PATH).toBe("C:\\user")
    expect(mergeRegistryEnv({}, {}, { PATH: "C:\\system" }).PATH).toBe("C:\\system")
    expect(mergeRegistryEnv({}, {}, {}).PATH).toBeUndefined()
  })
})

describe("loadWindowsEnv", () => {
  test("fills missing vars with expanded registry values and expands PATH chains through hives", () => {
    const runRegQuery = (key: string) => {
      if (key === USER_ENV_KEY) {
        return hive(
          USER_ENV_KEY,
          "    TEMP_USER    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp\r\n" +
            "    PATH    REG_EXPAND_SZ    %USERPROFILE%\\bin\r\n",
        )
      }
      if (key === SYSTEM_ENV_KEY) {
        return hive(
          SYSTEM_ENV_KEY,
          "    USERPROFILE    REG_EXPAND_SZ    %SystemDrive%\\Users\\me\r\n" +
            "    PATH    REG_EXPAND_SZ    %SystemRoot%\\system32\r\n" +
            "    SystemDrive    REG_SZ    C:\r\n" +
            "    SystemRoot    REG_SZ    C:\\Windows\r\n",
        )
      }
      return { status: 1, stdout: "" }
    }

    const merged = loadWindowsEnv({
      env: { USERNAME: "me" },
      runRegQuery,
    })

    // USERPROFILE is expanded through the system hive chain
    // (%SystemDrive%\Users\me), PATH composes system-then-user.
    expect(merged.TEMP_USER).toBe("C:\\Users\\me\\AppData\\Local\\Temp")
    expect(merged.PATH).toBe("C:\\Windows\\system32;C:\\Users\\me\\bin")
    expect(merged.USERPROFILE).toBe("C:\\Users\\me")
    expect(merged.SystemDrive).toBe("C:")
    expect(merged.USERNAME).toBeUndefined()
  })

  test("live process values are preferred for expansion over registry values", () => {
    const runRegQuery = (key: string) => {
      if (key === USER_ENV_KEY) {
        return hive(USER_ENV_KEY, "    GOPATH    REG_EXPAND_SZ    %USERPROFILE%\\go\r\n")
      }
      return hive(SYSTEM_ENV_KEY, "    USERPROFILE    REG_SZ    C:\\Users\\registry\r\n")
    }

    const merged = loadWindowsEnv({ env: { USERPROFILE: "C:\\Users\\live" }, runRegQuery })
    expect(merged.GOPATH).toBe("C:\\Users\\live\\go")
  })

  test("expansion and fill matching are case-insensitive across casing styles", () => {
    const runRegQuery = (key: string) => {
      if (key === USER_ENV_KEY) {
        // Referenced as %userprofile% even though the system hive spells it USERPROFILE.
        return hive(USER_ENV_KEY, "    GOPATH    REG_EXPAND_SZ    %userprofile%\\go\r\n")
      }
      return hive(SYSTEM_ENV_KEY, "    USERPROFILE    REG_SZ    C:\\Users\\me\r\n")
    }

    const merged = loadWindowsEnv({ env: { other: "1" }, runRegQuery })
    expect(merged.GOPATH).toBe("C:\\Users\\me\\go")
  })

  test("fail-open: spawn errors and non-zero statuses yield an empty fill", () => {
    const failing = { status: null, stdout: "", error: new Error("ENOENT") }
    expect(loadWindowsEnv({ env: {}, runRegQuery: () => failing })).toEqual({})
    expect(loadWindowsEnv({ env: {}, runRegQuery: () => ({ status: 1, stdout: "" }) })).toEqual({})
  })

  test("system hive failure alone still applies the user hive", () => {
    const runRegQuery = (key: string) =>
      key === USER_ENV_KEY
        ? hive(USER_ENV_KEY, "    API_KEY    REG_SZ    secret\r\n")
        : { status: 5, stdout: "Access is denied." }
    expect(loadWindowsEnv({ env: {}, runRegQuery })).toEqual({ API_KEY: "secret" })
  })

  test("a throwing query never propagates", () => {
    expect(loadWindowsEnv({ env: {}, runRegQuery: () => { throw new Error("boom") } })).toEqual({})
  })

  // Real-wiring regression (cross-review P1): circular REG_EXPAND_SZ references (A=%A%,
  // B/C mutual) must resolve as unknown — like Windows itself — instead of recursing until
  // the stack overflows and crashing every startup.
  test("circular registry references resolve as unknown, never recurse to death", () => {
    const runRegQuery = (key: string) =>
      key === USER_ENV_KEY
        ? hive(
            USER_ENV_KEY,
            "    SELF    REG_EXPAND_SZ    %SELF%\\bin\r\n" +
              "    B    REG_EXPAND_SZ    %C%\\b\r\n" +
              "    C    REG_EXPAND_SZ    %B%\\c\r\n" +
              "    GOOD    REG_EXPAND_SZ    %SystemRoot%\\good\r\n",
          )
        : hive(SYSTEM_ENV_KEY, "    SystemRoot    REG_SZ    C:\\Windows\r\n")

    const merged = loadWindowsEnv({ env: {}, runRegQuery })
    expect(merged.SELF).toBe("%SELF%\\bin")
    expect(merged.B).toBe("%B%\\c\\b")
    expect(merged.GOOD).toBe("C:\\Windows\\good")
  })
})
