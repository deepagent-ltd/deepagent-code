import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readGoalPlanFile } from "../../src/session/goal-manager"

const roots: string[] = []
const markdown = "## Goal\nVerify the bounded source\n## Plan\n- [ ] Verify\n"
function fixture(contents: string | Buffer = markdown) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dac-goal-plan-reader-")))
  roots.push(root)
  const directory = path.join(root, ".deepagent-code", "plans")
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, "goal+plan.md")
  fs.writeFileSync(file, contents)
  return { root, directory, file }
}
afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

test("Goal file reader preserves valid bounded plans and rejects invalid UTF8", () => {
  const files = fixture()
  expect(readGoalPlanFile(files.root, "parent")?.plan.steps).toHaveLength(1)
  fs.writeFileSync(files.file, Buffer.concat([Buffer.from(markdown), Buffer.from([0xff])]))
  expect(readGoalPlanFile(files.root, "parent")).toBeNull()
})
test("Goal file reader refuses an oversized source before decoding", () => {
  const files = fixture(markdown + "x".repeat(262144))
  expect(readGoalPlanFile(files.root, "parent")).toBeNull()
})
test("Goal file reader refuses final and parent symlink escape", () => {
  const outside = fixture()
  const files = fixture()
  fs.unlinkSync(files.file)
  fs.symlinkSync(outside.file, files.file)
  expect(readGoalPlanFile(files.root, "parent")).toBeNull()
  fs.rmSync(files.directory, { recursive: true })
  fs.symlinkSync(outside.directory, files.directory)
  expect(readGoalPlanFile(files.root, "parent")).toBeNull()
})
for (const change of ["file", "parent", "content"] as const) {
  test(`Goal file reader refuses actual ${change} mutation after its bytes are read`, () => {
    const files = fixture()
    let changed = false
    const mutate = () => {
      if (changed) return
      changed = true
      if (change === "file") {
        fs.renameSync(files.file, `${files.file}.previous`)
        fs.writeFileSync(files.file, markdown)
      } else if (change === "parent") {
        fs.renameSync(files.directory, `${files.directory}.previous`)
        fs.mkdirSync(files.directory)
        fs.writeFileSync(files.file, markdown)
      } else fs.writeFileSync(files.file, markdown.replace("bounded", "changed"))
    }
    // Scheduling seams only: both old/new readers perform real native file reads, then a real
    // competing writer changes disk before the reader can validate its completed observation.
    const beforeRead = fs.readSync
    const beforeFile = fs.readFileSync
    const read = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const result = Reflect.apply(beforeRead, fs, args) as number
      mutate()
      return result
    }) as typeof fs.readSync)
    const file = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const result = Reflect.apply(beforeFile, fs, args) as ReturnType<typeof fs.readFileSync>
      if (args[0] === files.file) mutate()
      return result
    }) as typeof fs.readFileSync)
    try {
      expect(readGoalPlanFile(files.root, "parent")).toBeNull()
      expect(changed).toBeTrue()
    } finally {
      read.mockRestore()
      file.mockRestore()
    }
  })
}
