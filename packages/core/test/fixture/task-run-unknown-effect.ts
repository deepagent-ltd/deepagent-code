import path from "node:path"

// A separate real-clock owner prevents this timed interruption from sharing the global
// controlled LLM script or TestClock with unrelated dispatcher fixtures. All data is private.
const root = process.argv[2]
if (!root || !path.isAbsolute(root)) throw new Error("A private absolute fixture root is required")
const started = performance.now()
await Promise.all(["home", "tmp", "config", "data", "cache", "state"].map((name) => Bun.$`mkdir -p ${path.join(root, name)}`.quiet()))
console.error(JSON.stringify({ test: "task-unknown-custody-process", phase: "child-spawn",
  elapsedMs: Math.round(performance.now() - started) }))
const child = Bun.spawn({
  cmd: [process.execPath, "test", "test/task-run-dispatcher.test.ts", "--test-name-pattern", "timed-out real mutation", "--timeout", "10000"],
  cwd: path.resolve(import.meta.dirname, "../.."),
  env: { PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    DEEPAGENT_CODE_HOME: path.join(root, "data"), DAC_TASK_UNKNOWN_ACTUAL: "1", DAC_TASK_UNKNOWN_DB: path.join(root, "authority.sqlite") },
  stdout: "pipe", stderr: "pipe",
})
const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
console.error(JSON.stringify({ test: "task-unknown-custody-process", phase: "child-exited", status,
  elapsedMs: Math.round(performance.now() - started) }))
if (status !== 0) throw new Error(`Private unknown custody fixture failed (${status}): ${stdout}${stderr}`)
process.stdout.write(stdout)
process.stderr.write(stderr)
process.stdout.write("UNKNOWN_CUSTODY_ACTUAL_OK\n")
