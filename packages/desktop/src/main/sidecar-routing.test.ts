import { describe, expect, test } from "bun:test"
import type { WslServerItem, WslServerRuntime, WslServersState } from "../preload/types"
import {
  firstReadyWslServer,
  isSidecarSpawnFailure,
  resolveWslSidecarMode,
  sidecarSpawnFailure,
  startPrimarySidecar,
  waitForWslServerReady,
  WSL_SIDECAR_MODE_ENV,
  type SidecarReady,
  type SpawnLocalServer,
  type WslSidecarMode,
} from "./sidecar-routing"
import { createWslServersController, type WslServerConfig } from "./wsl/servers"

const server = (id: string, runtime: WslServerRuntime): WslServerItem => ({
  config: { id, distro: "Ubuntu" },
  runtime,
})

const wslResult: SidecarReady = {
  listener: null,
  ready: { url: "http://127.0.0.1:4001", username: "deepagent-code", password: "pw" },
  wslFallback: true,
}

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
    expect(isSidecarSpawnFailure(sidecarSpawnFailure("boom", undefined, "health"))).toBe(true)
    expect(isSidecarSpawnFailure(new Error("boom"))).toBe(false)
    expect(isSidecarSpawnFailure(undefined)).toBe(false)
  })

  test("fallback picks the first ready WSL server in persisted order, not the earliest ready", () => {
    const items = [
      server("wsl:Debian", { kind: "starting" }),
      server("wsl:Ubuntu", {
        kind: "ready",
        url: "http://127.0.0.1:4001",
        username: "deepagent-code",
        password: "pw",
      }),
      // Also ready, but later in persisted order, so never selected while `wsl:Ubuntu` is ready:
      // the rule is persisted array order, not readiness recency.
      server("wsl:Ubuntu-24.04", {
        kind: "ready",
        url: "http://127.0.0.1:4002",
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

  describe("startPrimarySidecar dispatch", () => {
    const route = (overrides: {
      platform?: NodeJS.Platform
      mode?: WslSidecarMode
      spawnLocalServer?: SpawnLocalServer
      startWslPrimary?: (mode: WslSidecarMode) => Promise<SidecarReady>
      healthTimeoutMs?: number
    } = {}) => {
      const calls: string[] = []
      const promise = startPrimarySidecar({
        platform: overrides.platform ?? "win32",
        mode: overrides.mode ?? "auto",
        hostname: "127.0.0.1",
        port: 3188,
        password: "secret",
        healthTimeoutMs: overrides.healthTimeoutMs,
        spawnLocalServer:
          overrides.spawnLocalServer ??
          (async () => {
            calls.push("local")
            return { listener: { stop: async () => undefined }, health: { wait: Promise.resolve() } }
          }),
        startWslPrimary:
          overrides.startWslPrimary ??
          (async (mode) => {
            calls.push(`wsl:${mode}`)
            return wslResult
          }),
        onStdout: () => undefined,
        onStderr: () => undefined,
        onExit: () => undefined,
        onPlatformFallback: (reason) => calls.push(`fallback:${reason}`),
      })
      return { calls, promise }
    }

    test("force on win32 goes straight to the WSL primary, never local", async () => {
      const { calls, promise } = route({ platform: "win32", mode: "force" })
      await expect(promise).resolves.toBe(wslResult)
      expect(calls).toEqual(["wsl:force"])
    })

    test("force propagates WSL startup failures without any fallback", async () => {
      const failure = new Error("no WSL server is configured")
      const { calls, promise } = route({ platform: "win32", mode: "force", startWslPrimary: async () => { throw failure } })
      await expect(promise).rejects.toBe(failure)
      expect(calls).toEqual([])
    })

    test("native on win32 uses the local sidecar and passes local failures through", async () => {
      const boom = sidecarSpawnFailure("boom")
      const spawnLocalServer: SpawnLocalServer = () => {
        throw boom
      }
      const { calls, promise } = route({ platform: "win32", mode: "native", spawnLocalServer })
      await expect(promise).rejects.toBe(boom)
      expect(calls).toEqual([])
    })

    test("non-win32 never falls back, even for spawn failures", async () => {
      const spawnLocalServer: SpawnLocalServer = () => {
        throw sidecarSpawnFailure("boom")
      }
      const { calls, promise } = route({ platform: "darwin", mode: "native", spawnLocalServer })
      await expect(promise).rejects.toMatchObject({ code: "SIDECAR_SPAWN_FAILED", message: "boom" })
      expect(calls).toEqual([])
    })

    test("auto falls back to WSL when the local spawn fails", async () => {
      const spawnLocalServer: SpawnLocalServer = () => {
        throw sidecarSpawnFailure("boom")
      }
      const { calls, promise } = route({ spawnLocalServer })
      await expect(promise).resolves.toBe(wslResult)
      expect(calls).toEqual(["fallback:boom", "wsl:auto"])
    })

    test("auto does not fall back on non-spawn failures", async () => {
      const spawnLocalServer: SpawnLocalServer = () => {
        throw new Error("environment misconfigured")
      }
      const { calls, promise } = route({ spawnLocalServer })
      await expect(promise).rejects.toThrow("environment misconfigured")
      expect(calls).toEqual([])
    })

    test("auto wraps a failing WSL fallback into a spawn failure with both reasons", async () => {
      const spawnLocalServer: SpawnLocalServer = () => {
        throw sidecarSpawnFailure("boom")
      }
      const startWslPrimary = async () => {
        throw new Error("no WSL sidecar server is configured for fallback")
      }
      const { calls, promise } = route({ spawnLocalServer, startWslPrimary })
      const error = await promise.catch((value: unknown) => value)
      expect(error).toMatchObject({ code: "SIDECAR_SPAWN_FAILED" })
      expect((error as Error).message).toContain("local sidecar spawn failed (boom)")
      expect((error as Error).message).toContain("WSL fallback failed (no WSL sidecar server is configured for fallback)")
      expect(calls).toEqual(["fallback:boom"])
    })

    test("auto falls back when the local sidecar fails its API health check and kills it", async () => {
      let stops = 0
      const spawnLocalServer: SpawnLocalServer = async () => ({
        listener: {
          stop: async () => {
            stops++
          },
        },
        health: { wait: Promise.reject(new Error("Sidecar exited before health check passed with code 1")) },
      })
      const { calls, promise } = route({ spawnLocalServer })
      await expect(promise).resolves.toBe(wslResult)
      expect(stops).toBe(1)
      expect(calls).toEqual([
        "fallback:local sidecar health check failed: Sidecar exited before health check passed with code 1",
        "wsl:auto",
      ])
    })

    test("auto falls back when the local sidecar health check times out and kills it", async () => {
      let stops = 0
      const spawnLocalServer: SpawnLocalServer = async () => ({
        listener: {
          stop: async () => {
            stops++
          },
        },
        health: { wait: new Promise<void>(() => undefined) },
      })
      const { calls, promise } = route({ spawnLocalServer, healthTimeoutMs: 20 })
      await expect(promise).resolves.toBe(wslResult)
      expect(stops).toBe(1)
      expect(calls).toEqual([
        "fallback:local sidecar health check failed: health check timed out after 20ms",
        "wsl:auto",
      ])
    })

    test("health failures never deliver an unverified ready and never fall back outside auto", async () => {
      let stops = 0
      const spawnLocalServer: SpawnLocalServer = async () => ({
        listener: {
          stop: async () => {
            stops++
          },
        },
        health: { wait: Promise.reject(new Error("unhealthy")) },
      })
      const { calls, promise } = route({ platform: "darwin", mode: "native", spawnLocalServer })
      await expect(promise).rejects.toMatchObject({
        code: "SIDECAR_SPAWN_FAILED",
        phase: "health",
        message: expect.stringContaining("local sidecar health check failed: unhealthy"),
      })
      expect(stops).toBe(1)
      expect(calls).toEqual([])
    })

    test("a verified local sidecar is returned with computed credentials", async () => {
      const { calls, promise } = route({ platform: "darwin", mode: "native" })
      await expect(promise).resolves.toEqual({
        listener: expect.objectContaining({ stop: expect.any(Function) }),
        ready: { url: "http://127.0.0.1:3188", username: "deepagent-code", password: "secret" },
        wslFallback: false,
      })
      expect(calls).toEqual(["local"])
    })
  })

  describe("waitForWslServerReady", () => {
    test("fails fast when the store is empty and nothing can be started", async () => {
      persistedServers = []
      const controller = createWslServersController(
        "1.16.2",
        async () => {
          throw new Error("must not spawn")
        },
        controllerOptions(),
      )
      const started = Date.now()
      await expect(waitForWslServerReady(controller)).rejects.toThrow(
        "no WSL sidecar server is configured for fallback",
      )
      expect(Date.now() - started).toBeLessThan(5_000)
    })

    test("reports per-mode wording when the store is empty", async () => {
      persistedServers = []
      const controller = createWslServersController(
        "1.16.2",
        async () => {
          throw new Error("must not spawn")
        },
        controllerOptions(),
      )
      // force = always WSL, so nothing is a "fallback": the message names the
      // missing capability; auto keeps the fallback framing for the console.
      await expect(waitForWslServerReady(controller, { mode: "force" })).rejects.toThrow("no WSL server is configured")
      await expect(waitForWslServerReady(controller, { mode: "auto" })).rejects.toThrow(
        "no WSL sidecar server is configured for fallback",
      )
    })

    test("rejects when every configured server failed to start", async () => {
      persistedServers = [
        { id: "wsl:Debian", distro: "Debian" },
        { id: "wsl:Ubuntu", distro: "Ubuntu" },
      ]
      const controller = createWslServersController(
        "1.16.2",
        async (distro) => {
          throw new Error(`${distro} is broken`)
        },
        controllerOptions(),
      )
      await expect(waitForWslServerReady(controller)).rejects.toThrow(
        "every configured WSL sidecar failed to start",
      )
    })

    test("resolves with the first server that becomes ready, in persisted order", async () => {
      persistedServers = [
        { id: "wsl:Debian", distro: "Debian" },
        { id: "wsl:Ubuntu", distro: "Ubuntu" },
      ]
      const spawns = new Map<string, () => void>()
      const controller = createWslServersController(
        "1.16.2",
        (distro) =>
          new Promise((resolve) => {
            spawns.set(distro, () =>
              resolve({
                listener: { stop: () => undefined, onExit: () => undefined },
                url: "http://127.0.0.1:4001",
                username: "deepagent-code",
                password: "pv",
              }),
            )
          }),
        controllerOptions(),
      )
      const waiting = waitForWslServerReady(controller)
      await waitFor(() => spawns.size === 2)
      // Ubuntu is second in the persisted array but becomes ready first: the
      // wait resolves on the earliest ready transition, where Ubuntu is the
      // first READY entry in the persisted order (see firstReadyWslServer).
      spawns.get("Ubuntu")?.()
      await expect(waiting).resolves.toEqual({
        id: "wsl:Ubuntu",
        url: "http://127.0.0.1:4001",
        username: "deepagent-code",
        password: "pv",
      })
    })

    test("rejects when no server becomes ready within the timeout", async () => {
      persistedServers = [{ id: "wsl:Debian", distro: "Debian" }]
      const controller = createWslServersController(
        "1.16.2",
        () => new Promise<never>(() => undefined),
        controllerOptions(),
      )
      await expect(waitForWslServerReady(controller, { timeoutMs: 25 })).rejects.toThrow(
        "WSL fallback timed out after 25ms",
      )
    })

    test("subscribes to the controller before initialize so no transition is missed", async () => {
      persistedServers = [{ id: "wsl:Debian", distro: "Debian" }]
      const controller = createWslServersController(
        "1.16.2",
        () => new Promise<never>(() => undefined),
        controllerOptions(),
      )
      const calls: string[] = []
      const states: WslServersState[] = []
      const subscribe = controller.subscribe
      controller.subscribe = (listener) => {
        calls.push("subscribe")
        return subscribe((event) => {
          states.push(event.state)
          listener(event)
        })
      }
      const initialize = controller.initialize
      controller.initialize = () => {
        calls.push("initialize")
        return initialize()
      }
      const waiting = waitForWslServerReady(controller, { timeoutMs: 25 })
      await expect(waiting).rejects.toThrow("WSL fallback timed out after 25ms")
      expect(calls).toEqual(["subscribe", "initialize"])
      // The subscription predates initialize's refreshFromStore emission, so
      // the persisted servers configure the state the wait inspects.
      expect(states.length).toBeGreaterThan(0)
      expect(states[0]?.servers[0]?.config.id).toBe("wsl:Debian")
    })
  })
})

let persistedServers: WslServerConfig[] = []

function controllerOptions() {
  return {
    readServers: () => persistedServers,
    writeServers: (servers: WslServerConfig[]) => {
      persistedServers = servers
    },
    readCommandVersion: async () => "1.16.2",
    listInstalledDistros: async () => [
      { name: "Debian", version: 2, isDefault: true },
      { name: "Ubuntu", version: 2, isDefault: false },
    ],
    resolveDeepagentCode: async () => "/home/me/.deepagent/code/bin/deepagent-code",
  }
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for condition")
}
