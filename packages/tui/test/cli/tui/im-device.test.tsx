/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { DialogIMDevice } from "../../../src/component/dialog-im-device"
import { useSDK } from "../../../src/context/sdk"
import { IMDeviceClient } from "@deepagent-code/core/im/device-client"
import { mountIM, until } from "../../fixture/im-environment"
import { tmpdir } from "../../fixture/fixture"

function fixture(mode: "fresh" | "pending" | "unknown" | "unavailable" | "service-unavailable" | "observation-unavailable") {
  const state = {
    posts: [] as { migrationID: string; voucher: string; retryOriginal?: boolean }[],
    calls: [] as string[],
  }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url).pathname.replace(/^\/w/, "")
      state.calls.push(url)
      if (mode === "unavailable")
        return Response.json({ name: "IMError", data: { code: "im_device_store_unavailable" } }, { status: 503 })
      if (url === "/api/v1/im/device/info")
        return Response.json({
          profile: "dac-im-device-v1",
          storeAvailable: true,
          deviceJkt: "a".repeat(43),
          publicJwk: { kty: "EC", crv: "P-256", x: "b".repeat(43), y: "c".repeat(43) },
        })
      if (url === "/api/v1/im/device/migrations" && (mode === "service-unavailable" || mode === "observation-unavailable"))
        return Response.json({ name: "IM_FACADE_UNAVAILABLE", data: { code: mode === "service-unavailable" ? "im_activation_unavailable" : "im_device_unavailable" } }, { status: 502 })
      if (url === "/api/v1/im/device/migrations")
        return Response.json({
          migration:
            mode === "pending" || mode === "unknown"
              ? { migrationID: "migration_original_123", state: mode, chargedCredits: 0, credentialStored: false }
              : null,
        })
      if (request.method === "POST") {
        const body = (await request.json()) as { migrationID: string; voucher: string; retryOriginal?: boolean }
        state.posts.push(body)
        return Response.json({
          migrationID: body.migrationID,
          state: "succeeded",
          chargedCredits: 0,
          credentialStored: true,
        })
      }
      return Response.json({
        migrationID: "migration_original_123",
        state: mode === "unknown" ? "unknown" : "succeeded",
        chargedCredits: 0,
        credentialStored: mode !== "unknown",
      })
    },
  })
  return {
    server,
    state,
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}
function View() {
  const sdk = useSDK()
  return (
    <DialogIMDevice
      client={sdk.client as unknown as IMDeviceClient.Transport}
      current={() => true}
      back={() => undefined}
    />
  )
}

test("TUI device binding hides the voucher, requires explicit consent and uses only a zero-cost migration", async () => {
  await using tmp = await tmpdir()
  using f = fixture("fresh")
  using ui = await mountIM(tmp.path, f.server.url.origin, View, 140)
  await ui.frame("Root-reviewed first-binding voucher")
  await ui.type("fixture-voucher")
  expect(f.state.posts).toHaveLength(0)
  const frame = await ui.frame("***************")
  expect(frame).not.toContain("fixture-voucher")
  ui.app.mockInput.pressKey("c", { meta: true })
  await ui.app.renderOnce()
  ui.app.mockInput.pressEnter()
  await until(() => f.state.posts.length === 1, "explicit migration")
  await ui.frame("Binding confirmed and credentials stored")
  expect(f.state.posts[0].voucher).toBe("fixture-voucher")
  expect(Object.keys(f.state.posts[0])).toEqual(["migrationID", "voucher"])
})

test("TUI cold unknown migration uses Enter only to query and Alt+S to explicitly resend the same original request", async () => {
  await using tmp = await tmpdir()
  using f = fixture("unknown")
  using ui = await mountIM(tmp.path, f.server.url.origin, View, 160)
  await ui.frame("migration_original_123")
  ui.app.mockInput.pressEnter()
  await until(() => f.state.calls.includes("/api/v1/im/device/migrations/migration_original_123"), "original GET observation")
  expect(f.state.posts).toHaveLength(0)
  await ui.frame("Root-reviewed first-binding voucher")
  await ui.type("fixture-original-voucher")
  ui.app.mockInput.pressKey("s", { meta: true })
  await ui.app.renderOnce()
  expect(f.state.posts).toHaveLength(0)
  ui.app.mockInput.pressKey("c", { meta: true })
  await ui.app.renderOnce()
  ui.app.mockInput.pressKey("s", { meta: true })
  await until(() => f.state.posts.length === 1, "explicit original migration")
  await ui.frame("Binding confirmed and credentials stored")
  expect(f.state.posts[0]).toEqual({
    migrationID: "migration_original_123",
    voucher: "fixture-original-voucher",
    retryOriginal: true,
  })
  expect(ui.app.captureCharFrame()).not.toContain("fixture-original-voucher")
})

test("TUI resumes the original pending migration without a new POST", async () => {
  await using tmp = await tmpdir()
  using f = fixture("pending")
  using ui = await mountIM(tmp.path, f.server.url.origin, View, 140)
  await ui.frame("migration_original_123")
  ui.app.mockInput.pressKey("r", { ctrl: true })
  await ui.frame("Binding confirmed and credentials stored")
  expect(f.state.posts).toHaveLength(0)
  expect(f.state.calls.at(-1)).toBe("/api/v1/im/device/migrations/migration_original_123")
})

test("TUI clearly reports unavailable OS storage and does not migrate", async () => {
  await using tmp = await tmpdir()
  using f = fixture("unavailable")
  using ui = await mountIM(tmp.path, f.server.url.origin, View, 140)
  await ui.frame("binding and sign-in are disabled")
  ui.app.mockInput.pressEnter()
  await ui.app.renderOnce()
  expect(f.state.posts).toHaveLength(0)
})

for (const mode of ["service-unavailable", "observation-unavailable"] as const)
  test(`TUI fresh read refusal cannot invent an unknown migration: ${mode}`, async () => {
    await using tmp = await tmpdir()
    using f = fixture(mode)
    using ui = await mountIM(tmp.path, f.server.url.origin, View, 180)
    const message = mode === "service-unavailable" ? "The IM service is unavailable" : "Device status could not be read"
    const frame = await ui.frame(message)
    expect(frame).not.toContain("This device operation could not be confirmed")
    expect(frame).not.toContain("An unresolved migration exists")
    expect(frame).toContain("a".repeat(43))
    await ui.app.mockInput.typeText("disabled-voucher")
    ui.app.mockInput.pressKey("c", { meta: true })
    ui.app.mockInput.pressEnter()
    await ui.app.renderOnce()
    expect(f.state.posts).toHaveLength(0)
    ui.app.mockInput.pressKey("r", { ctrl: true })
    await until(() => f.state.calls.length === 4, "fresh read-only refresh")
    expect(f.state.calls).toEqual([
      "/api/v1/im/device/info", "/api/v1/im/device/migrations",
      "/api/v1/im/device/info", "/api/v1/im/device/migrations",
    ])
  })
