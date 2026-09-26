import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/context/server"
import { offlineGateState } from "./bootstrap-gate"

const key4096 = ServerConnection.Key.make("http://localhost:4096")
const key40210 = ServerConnection.Key.make("http://127.0.0.1:40210")

// The dead-server gate decision: a cold boot against an unreachable server takes the offline
// screen; a server that already served the app this session keeps the app mounted behind the
// reconnect banner. Keyed per server — ready on one server never whitelists another.
describe("offlineGateState", () => {
  test("a cold boot (never ready) takes the offline screen", () => {
    expect(offlineGateState(undefined, key4096)).toBe("offline")
  })

  test("the server that reached ready keeps the app (reconnect banner)", () => {
    expect(offlineGateState(key40210, key40210)).toBe("offline_after_ready")
  })

  test("ready on a different server does not whitelist the dead one", () => {
    expect(offlineGateState(key40210, key4096)).toBe("offline")
  })
})
