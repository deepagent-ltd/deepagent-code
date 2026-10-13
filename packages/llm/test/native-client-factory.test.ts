import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Fetch service references and Bun proxy state live for the whole process. These
// real bootstrap mutation cases must not change another test's transport state.
const cases = [
  "builtin factory crosses a real pre-existing global wrapper and binds final auth/body to exact client/request",
  "request capacity is bounded and scope close releases capacity without making an old request ordinary",
  "real late environment drift and RequestInit override produce zero physical requests",
  "builtin TLS verification rejects a real untrusted certificate with an insecure environment at factory construction",
]
for (const name of cases)
  test(
    name,
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-native-factory-case-"))
      const child = Bun.spawn(
        [process.execPath, path.join(import.meta.dir, "fixture/native-client-factory.ts"), name],
        {
          env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
      try {
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        await fs.writeFile(path.join(directory, "child.log"), stdout + stderr)
        console.info("NATIVE_FACTORY_EVIDENCE", directory)
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
        expect(stdout).toContain("NATIVE_FACTORY_ISOLATED_OK")
      } finally {
        clearTimeout(timer)
        child.kill()
      }
    },
    20_000,
  )
