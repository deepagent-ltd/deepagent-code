import { describe, expect, test } from "bun:test"
import type { WslServerItem, WslServerRuntime } from "../preload/types"
import {
  firstReadyWslServer,
  isSidecarSpawnFailure,
  resolveWslSidecarMode,
  sidecarSpawnFailure,
  WSL_SIDECAR_MODE_ENV,
} from "./sidecar-routing"

const server = (id: string, runtime: WslServerRuntime): WslServerItem => ({
  config: { id, distro: "Ubuntu" },
  runtime,
})

describe("desktop sidecar routing", () => {
  test("resolves the WSL sidecar mode flag with an auto default", () => {
    expect(resolveWslSidecarMode({})).toBe("auto")
    expect(resolveWslSidecarMode({ [WSL_SIDECAR_MODE_ENV]: "force" })).toBe("force")
    expect(resolveWslSidecarMode({ [WSL_SIDECAR_MODE_ENV]: "native" })).toBe("native")
    expect(resolveWslSidecarMode({ [WSL_SIDECAR_MODE_ENV]: "auto" })).toBe("auto")
    expect(resolveWslSidecarMode({ [WSL_SIDECAR_MODE_ENV]: "whatever" })).toBe("auto")
  })

  test("classifies local spawn failures by error code", () => {
    expect(isSidecarSpawnFailure(sidecarSpawnFailure("sidecar did not become ready"))).toBe(true)
    expect(isSidecarSpawnFailure(sidecarSpawnFailure("boom", new Error("cause")))).toBe(true)
    expect(isSidecarSpawnFailure(new Error("boom"))).toBe(false)
    expect(isSidecarSpawnFailure(undefined)).toBe(false)
  })

  test("fallback picks the first ready WSL server in state order", () => {
    const items = [
      server("wsl:Debian", { kind: "starting" }),
      server("wsl:Ubuntu", {
        kind: "ready",
        url: "http://127.0.0.1:4001",
        username: "deepagent-code",
        password: "pw",
      }),
      server("wsl:Kali", { kind: "failed", message: "no" }),
    ]
    expect(firstReadyWslServer(items)).toEqual({
      id: "wsl:Ubuntu",
      url: "http://127.0.0.1:4001",
      username: "deepagent-code",
      password: "pw",
    })
  })

  test("fallback finds nothing when no server is ready", () => {
    expect(firstReadyWslServer([server("wsl:Debian", { kind: "failed", message: "no" })])).toBeNull()
    expect(firstReadyWslServer([server("wsl:Debian", { kind: "stopped" })])).toBeNull()
    expect(firstReadyWslServer([])).toBeNull()
  })
})
