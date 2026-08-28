import * as path from "node:path"
import * as fs from "node:fs"
import * as net from "node:net"
import { dispersionVerdict } from "../stats"
import { tempRoot, type ScenarioOutcome, summarizeGroups, Recorder } from "../lib"

export const repoRoot = path.resolve(import.meta.dir, "../../../../..")
const cliEntrypoint = path.join(repoRoot, "packages/deepagent-code/src/index.ts")

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Reserve an OS ephemeral port and release it so the child does not collide with other listeners. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (address === null || typeof address === "string") {
        probe.close()
        reject(new Error("failed to reserve a port"))
        return
      }
      const port = address.port
      probe.close(() => resolve(port))
    })
  })

/**
 * TCP listen probe against the spawned server's port. Readiness is defined by the
 * kernel accepting connections on the composition-root server — semantically equal
 * to its own "server listening" line but immune to stdout pipe buffering stalls.
 */
const waitUntilListening = async (port: number, timeoutMs: number): Promise<boolean> => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" })
      socket.once("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
    })
    if (open) return true
    await sleep(40)
  }
  return false
}

/** Reap the child without ever hanging the harness: immediate SIGKILL + bounded wait. */
const terminateChild = async (child: Bun.Subprocess<"ignore", "ignore", number>) => {
  try {
    child.kill(9)
  } catch {}
  const reaped = await Promise.race([child.exited.then(() => true), sleep(5000).then(() => false)])
  if (!reaped) console.error("[perf-baseline][startup] child did not die within 5s of SIGKILL")
}

interface LaunchResult {
  readonly ready_ms: number | undefined
  readonly stderr_tail: string
}

/**
 * One cold start sample: spawn the real CLI composition root (packages/deepagent-code
 * src/index.ts `serve`) with the data root redirected to a fresh empty temp home via
 * DEEPAGENT_CODE_TEST_HOME, and stop the wall clock when the server first accepts a
 * TCP connection (shell/listen readiness).
 */
const launchOnce = async (home: string): Promise<LaunchResult> => {
  const port = await freePort()
  const stderrPath = path.join(home, "serve-stderr.log")
  const stderrFd = fs.openSync(stderrPath, "w")
  let child: Bun.Subprocess<"ignore", "ignore", number>
  try {
    child = Bun.spawn([process.execPath, cliEntrypoint, "serve", "--port", String(port)], {
      cwd: home,
      env: { ...process.env, DEEPAGENT_CODE_TEST_HOME: home },
      stdout: "ignore",
      stderr: stderrFd,
      stdin: "ignore",
    })
  } finally {
    fs.closeSync(stderrFd)
  }
  const started = performance.now()

  try {
    const listening = await waitUntilListening(port, 45_000)
    if (!listening) {
      await terminateChild(child)
      return { ready_ms: undefined, stderr_tail: readTail(stderrPath) }
    }
    // Grace period so we sample a boot that stayed up past accept(), then tear down.
    await sleep(150)
    return { ready_ms: performance.now() - started, stderr_tail: readTail(stderrPath) }
  } catch (error) {
    return { ready_ms: undefined, stderr_tail: `${readTail(stderrPath)} [probe error: ${String(error)}]` }
  } finally {
    await terminateChild(child)
  }
}

const readTail = (stderrPath: string) => {
  try {
    return fs.readFileSync(stderrPath, "utf8").slice(-600)
  } catch {
    return "(stderr unavailable)"
  }
}

export interface StartupOptions {
  readonly warmup: number
  readonly measured: number
}

export const runStartup = async (options: StartupOptions): Promise<ScenarioOutcome> => {
  const recorder = new Recorder()
  const failures: string[] = []
  const startedAt = performance.now()

  const sweep = async (group: string, count: number) => {
    for (let index = 0; index < count; index++) {
      const home = tempRoot("startup")
      try {
        const result = await launchOnce(home)
        if (result.ready_ms !== undefined) recorder.add(group, result.ready_ms)
        else recorder.fail(group)
        if (result.ready_ms === undefined) failures.push(`${group} sample ${index}: ${result.stderr_tail.slice(-400)}`)
      } catch (error) {
        recorder.fail(group)
        failures.push(`${group} sample ${index}: ${String(error)}`)
      } finally {
        fs.rmSync(home, { recursive: true, force: true })
      }
    }
  }

  await sweep("warmup", options.warmup)
  await sweep("measured", options.measured)

  // Dispersion guard: cold-start wall clock is the scenario most exposed to host noise
  // (Spotlight indexing, debugger attach, thermal state). When the first measured sweep
  // is heavy-tailed we run ONE additional full sweep as a separate series; nothing from
  // either pass is ever discarded and both stay in the raw CSV.
  let dispersion = { ratio_p99_over_p50: 0, rerun_required: false }
  const firstMeasured = recorder.results().find((group) => group.group === "measured")
  if (firstMeasured && firstMeasured.values.length >= 2) {
    dispersion = dispersionVerdict(firstMeasured.values)
    if (dispersion.rerun_required) await sweep("measured_rerun", options.measured)
  }

  return summarizeGroups(
    {
      name: "cold-start-to-shell-ready",
      owner_note:
        "headless composition-root boot: bun -> packages/deepagent-code/src/index.ts (yargs ServeCommand -> Server.listen); readiness = server first accepting a TCP connection on its own port (equivalent timing to its printed listen line, measured without stdout-pipe coupling). Fresh empty temp data root per sample.",
      status: "ok",
      evidence_refs: ["packages/deepagent-code/src/index.ts", "packages/deepagent-code/src/cli/cmd/serve.ts"],
      groups: recorder.results(),
      extras: {
        unit: "ms",
        sample_basis:
          "25 measured spawns after 5 warmup spawns; each spawn is a fresh cold process with an empty temp data root; N keeps total startup wall time under ~2min while resolving p95",
        warmup_policy: `${options.warmup} warmup spawns then ${options.measured} measured spawns; both groups reported`,
        dispersion_guard: `one extra ${options.measured}-spawn rerun sweep is appended under measured_rerun when p99/p50 >= 3 on the first measured pass (neither pass is trimmed or dropped)`,
        dispersion_first_pass: dispersion,
        rerun_executed: dispersion.rerun_required,
        failure_notes: failures.join(" | ") || "none",
      },
    },
    performance.now() - startedAt,
  )
}
