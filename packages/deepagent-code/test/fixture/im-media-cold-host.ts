import { createServer } from "node:net"
import { createInterface } from "node:readline"
import path from "node:path"

const root = process.argv[2]!
const mode = process.argv[3]!
if (mode === "host") {
  const { Database } = await import("@deepagent-code/core/database/database")
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { Server } = await import("@/server/server")
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const address = probe.address()
  if (!address || typeof address === "string") throw new Error("Missing private port")
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  await AppRuntime.runPromise(Database.Service)
  const listener = await Server.listen({ hostname: "127.0.0.1", port: address.port })
  await Bun.write(path.join(root, "host-ready.json"), JSON.stringify({ url: listener.url.href, pid: process.pid }))
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve)
    process.once("SIGINT", resolve)
  })
  await listener.stop(true)
  await Server.disposeDefault()
  await AppRuntime.dispose()
  process.exit(0)
}

const { createComponent } = await import("solid-js")
const { createOpencodeClient } = await import("@deepagent-code/sdk")
const { createIMClient } = await import("../../../tui/src/component/im-client")
const { DialogIMMedia } = await import("../../../tui/src/component/dialog-im-media")
const { mountIM } = await import("../../../tui/test/fixture/im-environment")
const input = await Bun.file(path.join(root, `${mode}-input.json`)).json()
const client = createIMClient({
  client: createOpencodeClient({ baseUrl: input.url, headers: input.headers }),
  url: input.url,
  directory: input.directory,
})
const ui = await mountIM(
  input.clientRoot,
  input.url,
  () =>
    createComponent(DialogIMMedia, {
      client,
      group: input.group,
      identity: "server",
      attachmentID: input.attachmentID,
      back() {},
      onSent(message) {
        void Bun.write(path.join(root, `${mode}-sent.json`), JSON.stringify(message))
      },
    }),
  input.width ?? 80,
  undefined,
  input.appearance ?? {},
)
const lines = createInterface({ input: process.stdin })
try {
  await ui.frame(input.appearance?.locale === "zh" ? "上传本机文件" : "Upload a local file")
  for (let count = 0; count < 100; count++) {
    await ui.app.renderOnce()
    if (!ui.app.captureCharFrame().includes("Loading")) break
    await Bun.sleep(10)
  }
  if (input.snapshotOnly) {
    await ui.app.renderOnce()
    await Bun.write(path.join(root, `${mode}-menu.txt`), ui.app.captureCharFrame())
    await Bun.write(path.join(root, `${mode}-menu.json`), JSON.stringify(ui.app.captureSpans()))
    await ui.select(input.appearance?.locale === "zh" ? "上传本机文件" : "Upload a local file")
    await ui.frame(input.appearance?.locale === "zh" ? "这台电脑上的文件路径" : "Path on this computer")
    await Bun.write(path.join(root, `${mode}-form.txt`), ui.app.captureCharFrame())
    await Bun.write(path.join(root, `${mode}-form.json`), JSON.stringify(ui.app.captureSpans()))
    ui.app.mockInput.pressTab()
    await ui.app.renderOnce()
    await Bun.write(
      path.join(root, `${mode}-keyboard.json`),
      JSON.stringify({
        focused: ui.app.renderer.currentFocusedEditor?.id,
        width: input.width,
        mode: input.appearance.mode,
        locale: input.appearance.locale,
      }),
    )
    ui[Symbol.dispose]()
    process.exit(0)
  }
  if (input.start) {
    await ui.select("Upload a local file")
    await ui.frame("Path on this computer")
    await ui.type(input.source)
    ui.app.mockInput.pressEnter()
    await ui.frame(`Remove from draft · ${path.basename(input.source)}`)
    await ui.select("Upload selected files")
    await ui.frame("Send attachments together")
    await ui.select("Send attachments together")
  }
  await Bun.write(path.join(root, `${mode}-ready.json`), JSON.stringify({ pid: process.pid }))
  for await (const line of lines) {
    const command = JSON.parse(line) as {
      action: "retry" | "send" | "snapshot" | "stop" | "download" | "preview"
      id: string
      target?: string
    }
    if (command.action === "stop") break
    if (command.action === "retry") await ui.select("Retry same message")
    if (command.action === "send") await ui.select("Send attachments together")
    if (command.action === "download") {
      await ui.select("Save file")
      await ui.frame("Save to a new path")
      await ui.type(command.target!)
      ui.app.mockInput.pressEnter()
      await ui.frame("File saved and verified")
    }
    if (command.action === "preview") {
      await ui.select("Create temporary image link")
      await ui.frame("Open image link")
    }
    await ui.app.renderOnce()
    await Bun.write(path.join(root, `${mode}-${command.id}.txt`), ui.app.captureCharFrame())
  }
} finally {
  lines.close()
  ui[Symbol.dispose]()
}
process.exit(0)
