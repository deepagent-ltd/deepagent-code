import { describe, expect, test } from "bun:test"
import {
  isSidecarSpawnFailure,
  sidecarSpawnFailure,
  startPrimarySidecar,
  type SpawnLocalServer,
} from "./sidecar-routing"

describe("desktop sidecar routing", () => {
  test("classifies local spawn failures by error code", () => {
    expect(isSidecarSpawnFailure(sidecarSpawnFailure("sidecar did not become ready"))).toBe(true)
    expect(isSidecarSpawnFailure(sidecarSpawnFailure("boom", new Error("cause")))).toBe(true)
    expect(isSidecarSpawnFailure(sidecarSpawnFailure("boom", undefined, "health"))).toBe(true)
    expect(isSidecarSpawnFailure(new Error("boom"))).toBe(false)
    expect(isSidecarSpawnFailure(undefined)).toBe(false)
  })

  describe("startPrimarySidecar dispatch", () => {
    const route = (overrides: {
      spawnLocalServer?: SpawnLocalServer
      healthTimeoutMs?: number
    } = {}) => {
      const calls: string[] = []
      const promise = startPrimarySidecar({
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
        onStdout: () => undefined,
        onStderr: () => undefined,
        onExit: () => undefined,
      })
      return { calls, promise }
    }

    test("passes local spawn failures through without any fallback", async () => {
      const boom = sidecarSpawnFailure("boom")
      const spawnLocalServer: SpawnLocalServer = () => {
        throw boom
      }
      const { calls, promise } = route({ spawnLocalServer })
      await expect(promise).rejects.toBe(boom)
      expect(calls).toEqual([])
    })

    test("passes non-spawn failures through unchanged", async () => {
      const spawnLocalServer: SpawnLocalServer = () => {
        throw new Error("environment misconfigured")
      }
      const { calls, promise } = route({ spawnLocalServer })
      await expect(promise).rejects.toThrow("environment misconfigured")
      expect(calls).toEqual([])
    })

    test("kills the sidecar and fails when its API health check rejects", async () => {
      let stops = 0
      const spawnLocalServer: SpawnLocalServer = async () => ({
        listener: {
          stop: async () => {
            stops++
          },
        },
        health: { wait: Promise.reject(new Error("unhealthy")) },
      })
      const { calls, promise } = route({ spawnLocalServer })
      await expect(promise).rejects.toMatchObject({
        code: "SIDECAR_SPAWN_FAILED",
        phase: "health",
        message: expect.stringContaining("local sidecar health check failed: unhealthy"),
      })
      expect(stops).toBe(1)
      expect(calls).toEqual([])
    })

    test("kills the sidecar and fails when the health check times out", async () => {
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
      await expect(promise).rejects.toMatchObject({
        code: "SIDECAR_SPAWN_FAILED",
        phase: "health",
        message: expect.stringContaining("health check timed out after 20ms"),
      })
      expect(stops).toBe(1)
      expect(calls).toEqual([])
    })

    test("a verified local sidecar is returned with computed credentials", async () => {
      const { calls, promise } = route()
      await expect(promise).resolves.toEqual({
        listener: expect.objectContaining({ stop: expect.any(Function) }),
        ready: { url: "http://127.0.0.1:3188", username: "deepagent-code", password: "secret" },
      })
      expect(calls).toEqual(["local"])
    })
  })
})
