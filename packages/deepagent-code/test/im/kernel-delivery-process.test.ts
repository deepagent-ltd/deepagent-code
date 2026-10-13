import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

test("actual SDK + sync + repository keep ACK-loss and ACK-SQL-failure unknown across same-inode cold restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "im-kernel-delivery-cold-"))
  const run = (directory: string, stage: string, scenario: string) =>
    Bun.spawn(
      [process.execPath, "run", path.join(import.meta.dir, "kernel-delivery-process.fixture.ts"), stage, scenario],
      {
        cwd: path.join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          IM_DELIVERY_ORACLE_ROOT: directory,
          HOME: `${directory}/home`,
          TMPDIR: `${directory}/tmp`,
          DEEPAGENT_CODE_TEST_HOME: `${directory}/home`,
          XDG_CONFIG_HOME: `${directory}/config`,
          XDG_DATA_HOME: `${directory}/data`,
          XDG_CACHE_HOME: `${directory}/cache`,
          XDG_STATE_HOME: `${directory}/state`,
          DEEPAGENT_IM_AGENT_RESPONDER: "off",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
  const finish = async (child: ReturnType<typeof run>, directory: string, phase: string) => {
    const output = await new Response(child.stdout).text()
    const errors = await new Response(child.stderr).text()
    const code = await child.exited
    await Bun.write(`${directory}/${phase}.stdout.log`, output)
    await Bun.write(`${directory}/${phase}.stderr.log`, errors)
    expect(code, `${output}\n${errors}`).toBe(0)
    return JSON.parse(
      output
        .split("\n")
        .find((line) => line.startsWith("KERNEL_DELIVERY_RESULT "))!
        .slice(23),
    )
  }
  for (const scenario of ["lost", "ack-write", "success", "identity", "denied", "missing-identity"]) {
    const directory = path.join(root, scenario)
    await fs.mkdir(`${directory}/home`, { recursive: true })
    await fs.mkdir(`${directory}/tmp`)
    const first = run(directory, "p1", scenario)
    const p1 =
      scenario === "lost"
        ? await (async () => {
            for (let n = 0; n < 400; n++) {
              if (await Bun.file(`${directory}/ready.json`).exists()) break
              if (first.exitCode !== null) break
              await Bun.sleep(25)
            }
            const ready = await Bun.file(`${directory}/ready.json`)
              .json()
              .catch(async () => {
                throw new Error(await new Response(first.stderr).text())
              })
            first.kill("SIGKILL")
            await first.exited
            await Bun.write(`${directory}/p1.stdout.log`, await new Response(first.stdout).text())
            await Bun.write(`${directory}/p1.stderr.log`, await new Response(first.stderr).text())
            return ready
          })()
        : await finish(first, directory, "p1")
    const second = run(directory, "p2", scenario)
    const p2 = await finish(second, directory, "p2")
    expect(p2.pid).not.toBe(p1.pid)
    expect(p2.file).toEqual(p1.file)
    expect(p2.wire).toEqual([])
    expect(p2.before).toEqual(p2.after)
    expect(p2.status.state).toBe(
      scenario === "success"
        ? "acknowledged"
        : ["denied", "missing-identity"].includes(scenario)
          ? "prepared"
          : "unknown",
    )
    expect(p2.messages).toHaveLength(1)
    expect(p2.networks).toBe(0)
    expect(p2.sessionInputs).toEqual({ n: 0 })
    expect(p2.providerAttempts).toEqual({ n: 0 })
    expect(p1.wire).toHaveLength(["identity", "denied", "missing-identity"].includes(scenario) ? 0 : 1)
    expect(p2.clockAdvanceMS).toBe(["lost", "ack-write"].includes(scenario) ? 660_000 : 0)
    if (p1.wire[0]) expect(p1.wire[0].tid).toBe(p2.messages[0].id)
    await Bun.write(`${directory}/oracle.json`, JSON.stringify({ p1, p2 }, null, 2))
  }
  console.log(`KERNEL_DELIVERY_ARTIFACT ${root}`)
}, 60000)
