import { expect, test } from "bun:test"
import { runWindowsInputCompiler, WindowsInputCompilerError } from "../../scripts/managed-browser-input-windows-native"

const child = (source: string, timeoutMs?: number) => runWindowsInputCompiler({
  command: [process.execPath, "-e", source], cwd: process.cwd(), timeoutMs,
})
function gone(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow()
}
async function rejected(source: string, code: string, timeoutMs?: number) {
  const result = await child(source, timeoutMs).then(() => undefined, (error: unknown) => error)
  expect(result).toBeInstanceOf(WindowsInputCompilerError)
  if (!(result instanceof WindowsInputCompilerError)) throw new Error("COMPILER_EXPECTED_TYPED_ERROR")
  expect(result.code).toBe(code)
  expect(result.process.exited).toBe(true)
  gone(result.process.pid)
  return result.process
}

test("owned CLI natural success drains bounded original stdout/stderr then joins the exact child", async () => {
  const result = await child('await Bun.stdout.write("abc"); await Bun.stderr.write("defg")')
  expect(result).toMatchObject({ exitCode: 0, stdout: "abc", stderr: "defg", stdoutBytes: 3, stderrBytes: 4, exited: true })
  expect(Object.isFrozen(result)).toBe(true)
  gone(result.pid)
})

test("compiler nonzero exit remains exact after both streams and real child exit", async () => {
  const result = await child('await Bun.stderr.write("original-failure"); process.exit(7)')
  expect(result.exitCode).toBe(7)
  expect(result.stderr).toBe("original-failure")
  expect(result.stderrBytes).toBe(16)
  gone(result.pid)
})

test("each stream accepts its exact one-MiB bound independently", async () => {
  const result = await child('await Promise.all([Bun.stdout.write(Buffer.alloc(1048576,97)),Bun.stderr.write(Buffer.alloc(1048576,98))])')
  expect(result.exitCode).toBe(0)
  expect(result.stdoutBytes).toBe(1_048_576)
  expect(result.stderrBytes).toBe(1_048_576)
  expect(result.stdout.length).toBe(1_048_576)
  expect(result.stderr.length).toBe(1_048_576)
  gone(result.pid)
})

test("stdout overflow rejects without retaining/printing the large stream and joins the original child", async () => {
  const result = await rejected('await Bun.stdout.write(Buffer.alloc(2097152,97)); setInterval(()=>{},1000)', "WINDOWS_INPUT_COMPILER_STDOUT_LIMIT")
  expect(result.stdoutBytes).toBeGreaterThan(1_048_576)
  expect(result.stderrBytes).toBeLessThanOrEqual(1_048_576)
})

test("stderr overflow is independently bounded and cannot stall the other reader", async () => {
  const result = await rejected('await Bun.stderr.write(Buffer.alloc(2097152,98)); setInterval(()=>{},1000)', "WINDOWS_INPUT_COMPILER_STDERR_LIMIT")
  expect(result.stderrBytes).toBeGreaterThan(1_048_576)
  expect(result.stdoutBytes).toBeLessThanOrEqual(1_048_576)
})

test("a real held CLI is stopped at its shortened module deadline and is reaped before rejection", async () => {
  const start = performance.now()
  const result = await rejected('setInterval(()=>{},1000)', "WINDOWS_INPUT_COMPILER_TIMEOUT", 100)
  expect(performance.now() - start).toBeLessThan(5_000)
  expect(result.exitCode).not.toBe(0)
  if (process.platform !== "win32") expect(result.signalCode).toBe("SIGKILL")
})

test("invalid or extended deadlines are rejected before creating any subprocess", async () => {
  for (const timeoutMs of [0, -1, 180_001, Number.POSITIVE_INFINITY, 1.5])
    await expect(child('throw new Error("must not start")', timeoutMs)).rejects.toThrow("WINDOWS_INPUT_COMPILER_OPTIONS")
})
