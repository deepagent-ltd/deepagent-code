import { afterEach, expect, test } from "bun:test"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { IMDeviceClient } from "@deepagent-code/core/im/device-client"

const info = {
  profile: "dac-im-device-v1",
  deviceJkt: "a".repeat(43),
  storeAvailable: true,
  publicJwk: { kty: "EC", crv: "P-256", x: "b".repeat(43), y: "c".repeat(43) },
} as const
const receipt = {
  migrationID: "migration_original_123",
  state: "succeeded",
  chargedCredits: 0,
  credentialStored: true,
} as const
const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => servers.splice(0).forEach((server) => server.stop(true)))
function fixture() {
  const state = {
    current: true,
    code: "",
    status: 503,
    charged: 0,
    wrongID: false,
    requests: [] as { url: string; method: string; body?: unknown }[],
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url).pathname
      state.requests.push({
        url,
        method: request.method,
        ...(request.method === "POST" ? { body: await request.json() } : {}),
      })
      if (state.code)
        return Response.json({ name: "IMDeviceError", data: { code: state.code } }, { status: state.status })
      if (url === "/api/v1/im/device/info") return Response.json(info)
      if (url === "/api/v1/im/device/migrations") return Response.json({ migration: null })
      return Response.json({
        ...receipt,
        chargedCredits: state.charged,
        migrationID: state.wrongID ? "migration_wrong_12345" : receipt.migrationID,
      })
    },
  })
  servers.push(server)
  const sdk = createOpencodeClient({ baseUrl: server.url.href }) as unknown as IMDeviceClient.Transport
  return { state, client: IMDeviceClient.create({ client: sdk, current: () => state.current }) }
}

test("device client uses only public DTOs and the original zero-cost migration ID", async () => {
  const f = fixture()
  expect(await f.client.info()).toEqual(info)
  expect(await f.client.pending()).toBeNull()
  expect(await f.client.migrate({ migrationID: receipt.migrationID, voucher: "private-test-voucher" })).toEqual(receipt)
  expect(await f.client.status(receipt.migrationID)).toEqual(receipt)
  expect(f.state.requests.map((request) => [request.method, request.url])).toEqual([
    ["GET", "/api/v1/im/device/info"],
    ["GET", "/api/v1/im/device/migrations"],
    ["POST", "/api/v1/im/device/migrate"],
    ["GET", `/api/v1/im/device/migrations/${receipt.migrationID}`],
  ])
  expect(f.state.requests[2].body).toEqual({ migrationID: receipt.migrationID, voucher: "private-test-voucher" })
})
for (const code of ["im_device_store_unavailable", "im_activation_pending", "im_device_migration_pending"])
  test(`structured Host refusal preserves safe code: ${code}`, async () => {
    const f = fixture()
    f.state.code = code
    f.state.status = code === "im_device_store_unavailable" ? 503 : 409
    await expect(f.client.info()).rejects.toMatchObject({ code, status: f.state.status })
  })

test("retired scope cannot send a device operation", async () => {
  const f = fixture()
  f.state.current = false
  await expect(
    f.client.migrate({ migrationID: receipt.migrationID, voucher: "private-test-voucher" }),
  ).rejects.toMatchObject({ code: "im_device_scope_changed" })
  expect(f.state.requests).toHaveLength(0)
})

test("a nonzero migration charge or a changed ID cannot become success", async () => {
  const f = fixture()
  f.state.charged = 1
  await expect(f.client.status(receipt.migrationID)).rejects.toMatchObject({ code: "im_device_invalid_response" })
  f.state.charged = 0
  f.state.wrongID = true
  await expect(f.client.status(receipt.migrationID)).rejects.toMatchObject({ code: "im_device_target_changed" })
})
