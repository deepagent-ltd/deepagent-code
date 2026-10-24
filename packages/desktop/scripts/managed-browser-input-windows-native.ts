import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises"
import { publishWindowsInputCandidate, requireWindowsInputPE, windowsInputSourceCensus } from "./managed-browser-input-windows-assets"
import { managedBrowserInputRuntime } from "./managed-browser-input-runtime"

/** Native publisher build only. The caller is a trusted build coordinator, not Main/HTTP. */
export async function compileWindowsInputNative(input: {
  directory: string
  compiler: { path: string; sha256: string }
  electronImportLibrary: { path: string; sha256: string }
}) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("WINDOWS_INPUT_NATIVE_BUILD_REQUIRED")
  const directory = await realpath(input.directory)
  if (!path.isAbsolute(input.directory) || directory !== input.directory) throw new Error("WINDOWS_INPUT_BUILD_PATH")
  for (const tool of [input.compiler, input.electronImportLibrary]) {
    if (!path.isAbsolute(tool.path) || await realpath(tool.path) !== tool.path || !/^[a-f0-9]{64}$/.test(tool.sha256) ||
      createHash("sha256").update(await readFile(tool.path)).digest("hex") !== tool.sha256)
      throw new Error("WINDOWS_INPUT_BUILD_TOOL")
  }
  const before = windowsInputSourceCensus()
  // All compiler outputs, including .exp/.lib and partial .obj, are owned by a
  // fresh stage. Never give cl a destination that could overwrite an old asset.
  const stage = await mkdtemp(path.join(directory, ".windows-input-build-"))
  try {
    const filename = path.join(stage, "managed-browser-input-windows.node")
    const include = path.join(stage, "include")
    await mkdir(include)
    // Compile a checked private copy, not live workspace bytes that a concurrent
    // writer could swap while cl is reading. The original anchor is checked again
    // before publication, so an edit cannot silently become a new source cohort.
    const source = await readFile(before.source)
    if (createHash("sha256").update(source).digest("hex") !== before.sourceSha256)
      throw new Error("WINDOWS_INPUT_BUILD_SOURCE_CHANGED")
    const entry = path.join(stage, "windows.cc")
    await writeFile(entry, source, { flag: "wx" })
    for (const header of before.headers) {
      const body = await readFile(header.path)
      if (createHash("sha256").update(body).digest("hex") !== header.sha256)
        throw new Error("WINDOWS_INPUT_BUILD_SOURCE_CHANGED")
      await writeFile(path.join(include, path.basename(header.path)), body, { flag: "wx" })
    }
    // The native MSVC/SDK INCLUDE/LIB closure must also be held and inventoried
    // by the release coordinator. This helper is not an SDK/toolchain installer.
    const result = await runWindowsInputCompiler({ command: [input.compiler.path, "/nologo", "/std:c++17", "/O2", "/MT", "/GR-", "/LD",
      "/DNAPI_VERSION=8", "/DBUILDING_NODE_EXTENSION", "/D_WIN32_WINNT=0x0A00",
      `/DDAC_MANAGED_BROWSER_INPUT_ELECTRON_VERSION=${JSON.stringify(managedBrowserInputRuntime.electronVersion)}`,
      `/DDAC_MANAGED_BROWSER_INPUT_NODE_VERSION=${JSON.stringify(managedBrowserInputRuntime.nodeVersion)}`,
      `/I${include}`,
      `/Fo${path.join(stage, "managed-browser-input-windows.obj")}`, entry, "/link", `/OUT:${filename}`,
      "/DELAYLOAD:node.exe", input.electronImportLibrary.path, "delayimp.lib",
      "user32.lib", "msctf.lib", "ole32.lib", "uuid.lib"], cwd: stage })
    if (result.exitCode !== 0) throw new Error(`WINDOWS_INPUT_BUILD_FAILED:${result.stderr}`)
    const body = await readFile(filename)
    requireWindowsInputPE(body)
    const after = windowsInputSourceCensus()
    if (after.sourceSha256 !== before.sourceSha256 || after.headerInventorySha256 !== before.headerInventorySha256 ||
      after.headers.some((header, index) => header.sha256 !== before.headers[index].sha256))
      throw new Error("WINDOWS_INPUT_BUILD_SOURCE_CHANGED")
    for (const tool of [input.compiler, input.electronImportLibrary])
      if (createHash("sha256").update(await readFile(tool.path)).digest("hex") !== tool.sha256)
        throw new Error("WINDOWS_INPUT_BUILD_TOOL_CHANGED")
    return await publishWindowsInputCandidate({ directory, body, source: before })
  } finally { await rm(stage, { recursive: true, force: true }) }
}


export class WindowsInputCompilerError extends Error {
  constructor(readonly code: string, readonly process: {
    pid: number
    exitCode: number
    signalCode: string | null
    stdoutBytes: number
    stderrBytes: number
    exited: true
  }) {
    super(code)
  }
}

/** Direct owned compiler only; the native build coordinator also owns its SDK/linker job tree. */
export async function runWindowsInputCompiler(input: { command: string[]; cwd: string; timeoutMs?: number }) {
  const timeout = input.timeoutMs ?? 180_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 180_000 || !input.command.length)
    throw new Error("WINDOWS_INPUT_COMPILER_OPTIONS")
  const child = Bun.spawn(input.command, { cwd: input.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const readers = [child.stdout.getReader(), child.stderr.getReader()]
  const counts = [0, 0]
  const state = { failure: "", exited: false, cancellations: Promise.resolve<PromiseSettledResult<void>[]>([]) }
  const abort = (code: string) => {
    if (state.failure) return
    state.failure = code
    // The original process is joined before cleanup; a reaped PID must never be
    // treated as a new kill target while an inherited output pipe is still open.
    if (!state.exited && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    state.cancellations = Promise.allSettled(readers.map((reader) => reader.cancel()))
  }
  const timer = setTimeout(() => abort("WINDOWS_INPUT_COMPILER_TIMEOUT"), timeout)
  const collect = async (index: number) => {
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const next = await readers[index].read()
        if (next.done) return Buffer.concat(chunks).toString("utf8")
        counts[index] += next.value.byteLength
        if (counts[index] > 1_048_576) {
          abort(index === 0 ? "WINDOWS_INPUT_COMPILER_STDOUT_LIMIT" : "WINDOWS_INPUT_COMPILER_STDERR_LIMIT")
          return ""
        }
        // Copy only accepted bounded chunks. Never read an unbounded Response.text().
        chunks.push(Buffer.from(next.value))
      }
    } catch {
      abort("WINDOWS_INPUT_COMPILER_IO")
      return ""
    } finally { readers[index].releaseLock() }
  }
  try {
    const result = await Promise.all([
      child.exited.then((code) => { state.exited = true; return code }),
      collect(0), collect(1),
    ])
    await state.cancellations
    if (state.failure) throw new WindowsInputCompilerError(state.failure, {
      pid: child.pid, exitCode: result[0], signalCode: child.signalCode,
      stdoutBytes: counts[0], stderrBytes: counts[1], exited: true,
    })
    return Object.freeze({ pid: child.pid, exitCode: result[0], stdout: result[1], stderr: result[2],
      stdoutBytes: counts[0], stderrBytes: counts[1], exited: true as const })
  } finally { clearTimeout(timer) }
}
