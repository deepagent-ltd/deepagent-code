import { expect, test } from "bun:test"
import path from "node:path"

const source = (relative: string) => Bun.file(path.resolve(import.meta.dirname, "../../src", relative)).text()

test("production roots use the shared V2 runner frame without standalone test layers", async () => {
  const [app, root, routes, frame] = await Promise.all([
    source("effect/app-runtime.ts"),
    source("effect/root.ts"),
    source("server/routes/instance/httpapi/server.ts"),
    source("session/v2-runner-frame.ts"),
  ])
  expect(app).toContain("Root.layer")
  expect(routes).toContain("Root.layer")
  expect(routes).toContain("SessionPromptV2.productionLayer")
  expect(app).not.toContain("SessionPromptV2.productionLayer")
  for (const production of [app, root, routes, frame]) {
    expect(production).not.toContain("SessionV2.liveLayer")
    expect(production).not.toMatch(/\b\w+\.testLayer\b/)
  }
})

test("standalone V2 compositions are named testLayer only", async () => {
  const modules = ["session/prompt-v2.ts", "session/command-v2.ts", "session/goal-manager.ts", "tool/registry.ts"]
  for (const module of modules) {
    const value = await source(module)
    expect(value).toContain("export const testLayer = productionLayer.pipe(Layer.provide(SessionV2.liveLayer))")
    expect(value).not.toContain("export const defaultLayer = productionLayer.pipe(Layer.provide(SessionV2.liveLayer))")
  }
})
