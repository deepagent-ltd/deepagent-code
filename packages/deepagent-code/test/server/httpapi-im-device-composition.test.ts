import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Global } from "@deepagent-code/core/global"
import { Flag } from "@deepagent-code/core/flag/flag"
import { IMDeviceProof } from "../../src/im/device-proof"
import { IMDeviceStore } from "../../src/im/device-store"
import { SecretStore } from "../../src/mcp/secret-store"
import { Server } from "../../src/server/server"
import { IMPaths } from "../../src/server/routes/instance/httpapi/groups/im"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

test("trusted listener composition shares one original device store across Facade and Activation without changing defaults", async () => {
  await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
  const previous = {
    username: Flag.DEEPAGENT_CODE_SERVER_USERNAME,
    password: Flag.DEEPAGENT_CODE_SERVER_PASSWORD,
    envUsername: process.env.DEEPAGENT_CODE_SERVER_USERNAME,
    envPassword: process.env.DEEPAGENT_CODE_SERVER_PASSWORD,
  }
  const file = path.join(Global.Path.config, "deepagent-code.json")
  const original = await Bun.file(file)
    .text()
    .catch(() => undefined)
  const realm = "https://constructor-only.invalid/platform"
  const directory = path.join(tmp.path, "device")
  const marker = path.join(directory, "identity.json")
  const backend = SecretStore.fileBackend(path.join(tmp.path, "custody.json"))
  const reads: string[] = []
  const construction = { count: 0 }
  const store = IMDeviceStore.make({
    directory,
    backend: {
      ...backend,
      get: async (account) => {
        reads.push(account)
        return backend.get(account)
      },
    },
  })
  const device = Layer.sync(IMDeviceStore.Service, () => {
    construction.count++
    return store
  })
  let listener: Awaited<ReturnType<typeof Server.listen>> | undefined
  try {
    Flag.DEEPAGENT_CODE_SERVER_USERNAME = "composition-test"
    Flag.DEEPAGENT_CODE_SERVER_PASSWORD = "private-local-test"
    process.env.DEEPAGENT_CODE_SERVER_USERNAME = Flag.DEEPAGENT_CODE_SERVER_USERNAME
    process.env.DEEPAGENT_CODE_SERVER_PASSWORD = Flag.DEEPAGENT_CODE_SERVER_PASSWORD
    await Bun.write(file, JSON.stringify({ im: { url: realm } }))
    const current = await Server.listen({ hostname: "127.0.0.1", port: 0, imDeviceStore: device })
    listener = current
    const request = (route: string, authenticated = true) =>
      fetch(new URL(route, current.url), {
        headers: {
          "x-deepagent-code-directory": tmp.path,
          ...(authenticated ? { authorization: `Basic ${btoa("composition-test:private-local-test")}` } : {}),
        },
      })

    expect(construction.count).toBe(1)
    expect(reads).toContain(`${IMDeviceProof.sha256(realm)}:login`)
    expect(await Bun.file(marker).exists()).toBe(false)
    const before = reads.length
    expect((await request(IMPaths.deviceInfo, false)).status).toBe(401)
    expect(reads).toHaveLength(before)
    expect(await Bun.file(marker).exists()).toBe(false)
    const status = await request(IMPaths.status)
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      facade: "blocked",
      blocked: { code: "im_activation_required" },
      service: { url: realm, source: "config" },
    })
    const info = await request(IMPaths.deviceInfo)
    expect(info.status).toBe(200)
    const publicIdentity = await Bun.file(marker).json()
    expect(await info.json()).toMatchObject({ storeAvailable: true, deviceJkt: publicIdentity.jkt })
    expect((await Effect.runPromise(store.identity)).jkt).toBe(publicIdentity.jkt)
    expect(reads).toContain("installation-p256-v1")
    expect(construction.count).toBe(1)
    expect(await Bun.file(path.join(Global.Path.data, "im-device", "identity.json")).exists()).toBe(false)
    expect(JSON.stringify(await Server.openapi())).not.toContain("imDeviceStore")
  } finally {
    await listener?.stop(true)
    await resetDatabase()
    if (original === undefined && (await Bun.file(file).exists())) await Bun.file(file).delete()
    if (original !== undefined) await Bun.write(file, original)
    Flag.DEEPAGENT_CODE_SERVER_USERNAME = previous.username
    Flag.DEEPAGENT_CODE_SERVER_PASSWORD = previous.password
    if (previous.envUsername === undefined) delete process.env.DEEPAGENT_CODE_SERVER_USERNAME
    if (previous.envUsername !== undefined) process.env.DEEPAGENT_CODE_SERVER_USERNAME = previous.envUsername
    if (previous.envPassword === undefined) delete process.env.DEEPAGENT_CODE_SERVER_PASSWORD
    if (previous.envPassword !== undefined) process.env.DEEPAGENT_CODE_SERVER_PASSWORD = previous.envPassword
  }
})
