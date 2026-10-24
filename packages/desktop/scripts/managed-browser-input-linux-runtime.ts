import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"

const directory = fileURLToPath(new URL("../native/managed-browser-input/linux-runtime", import.meta.url))
const digest = (body: Uint8Array) => createHash("sha256").update(body).digest("hex")

/** Source preparation in an explicitly owned checkout; never runtime qualification. */
export async function prepareLinuxRuntimeBridge(input: { checkout: string }) {
  if (!path.isAbsolute(input.checkout) || (await realpath(input.checkout)) !== input.checkout)
    throw new Error("LINUX_RUNTIME_CHECKOUT_PATH")
  // This marker prevents accidental application to a developer checkout. It is
  // a build-stage ownership declaration, never an input-source authorization.
  const marker = await Bun.file(path.join(input.checkout, ".dac-managed-input-owned-stage.json")).json()
  if (
    marker.schemaVersion !== "dac.runtime-build.owned.v1" ||
    marker.purpose !== "linux-native-input" ||
    marker.electronCommit !== "832e70a551348f2b6b2e004b4f09b9eb6ca038c0" ||
    marker.chromiumCommit !== "ff9214069a282850ff7ebbef6615bb009cf45c57"
  )
    throw new Error("LINUX_RUNTIME_CHECKOUT_OWNER")
  const source = (await Bun.file(path.join(directory, "UPSTREAM.json")).json()) as {
    schemaVersion: string
    upstreamFiles: { path: string; sha256: string; patchedSha256: string }[]
    patch: { file: string; sha256: string }
    copy: { source: string; destination: string; sha256: string }[]
  }
  const expected = [
    "electron/BUILD.gn",
    "ui/aura/window_tree_host_observer.h",
    "ui/aura/window_tree_host_platform.cc",
    "ui/base/ime/input_method.h",
    "ui/base/ime/input_method_base.cc",
    "ui/base/ime/input_method_base.h",
    "ui/base/ime/input_method_observer.h",
    "ui/base/ime/linux/input_method_auralinux.cc",
    "ui/base/ime/linux/input_method_auralinux.h",
    "ui/base/ime/linux/linux_input_method_context.h",
    "ui/gtk/input_method_context_impl_gtk.cc",
    "ui/gtk/input_method_context_impl_gtk.h",
  ]
  if (
    source.schemaVersion !== "dac.managed-input-linux-runtime-source.v1" ||
    source.patch.file !== "0001-dac-linux-original-input-observer.patch" ||
    source.upstreamFiles
      .map((file) => file.path)
      .toSorted()
      .join(",") !== expected.join(",") ||
    source.copy.map((file) => file.source + ":" + file.destination).join(",") !==
      "bridge.cc:electron/shell/browser/dac_managed_input_bridge.cc,../linux-bridge.h:electron/shell/browser/dac_managed_input_bridge.h"
  )
    throw new Error("LINUX_RUNTIME_SOURCE_MANIFEST")
  const patchFile = path.join(directory, source.patch.file)
  if (digest(await readFile(patchFile)) !== source.patch.sha256) throw new Error("LINUX_RUNTIME_PATCH_HASH")
  const observed = await Promise.all(
    source.upstreamFiles.map(async (file) => {
      const filename = path.join(input.checkout, file.path)
      if ((await realpath(filename)) !== filename || !(await lstat(filename)).isFile())
        throw new Error("LINUX_RUNTIME_UPSTREAM_PATH:" + file.path)
      return { ...file, observedSha256: digest(await readFile(filename)) }
    }),
  )
  const original = observed.every((file) => file.observedSha256 === file.sha256)
  const prepared = observed.every((file) => file.observedSha256 === file.patchedSha256)
  if (!original && !prepared) throw new Error("LINUX_RUNTIME_UPSTREAM_HASH")
  // Copy bytes before any mutation. Caller/source edits cannot silently join the
  // prepared source cohort, and an existing target is never overwritten.
  const copies = await Promise.all(
    source.copy.map(async (file) => {
      const body = await readFile(path.join(directory, file.source))
      if (digest(body) !== file.sha256) throw new Error("LINUX_RUNTIME_COPY_HASH")
      const target = path.join(input.checkout, file.destination)
      const exists = await lstat(target).then(
        () => true,
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
          throw error
        },
      )
      if (
        exists &&
        ((await realpath(target)) !== target ||
          !(await lstat(target)).isFile() ||
          digest(await readFile(target)) !== file.sha256)
      )
        throw new Error("LINUX_RUNTIME_COPY_EXISTS")
      return { target, body, sha256: file.sha256, exists }
    }),
  )
  if (prepared) {
    if (copies.some((copy) => !copy.exists)) throw new Error("LINUX_RUNTIME_PREPARED_COPY_MISSING")
    return Object.freeze({
      status: "source_prepared" as const,
      runtimeQualification: "unverified" as const,
      patchSha256: source.patch.sha256,
      changedFiles: 0,
    })
  }
  await apply(["--check", patchFile], input.checkout)
  for (const copy of copies) {
    if (copy.exists) continue
    await mkdir(path.dirname(copy.target), { recursive: true })
    if ((await realpath(path.dirname(copy.target))) !== path.dirname(copy.target))
      throw new Error("LINUX_RUNTIME_COPY_PATH")
    await writeFile(copy.target, copy.body, { flag: "wx", mode: 0o600 })
  }
  await apply([patchFile], input.checkout)
  for (const file of source.upstreamFiles)
    if (digest(await readFile(path.join(input.checkout, file.path))) !== file.patchedSha256)
      throw new Error("LINUX_RUNTIME_PREPARED_HASH:" + file.path)
  for (const copy of copies)
    if (digest(await readFile(copy.target)) !== copy.sha256) throw new Error("LINUX_RUNTIME_PREPARED_COPY_HASH")
  return Object.freeze({
    status: "source_prepared" as const,
    runtimeQualification: "unverified" as const,
    patchSha256: source.patch.sha256,
    changedFiles: source.upstreamFiles.length + copies.length,
  })
}

async function apply(arguments_: string[], checkout: string) {
  const child = Bun.spawn(["/usr/bin/git", "apply", ...arguments_], {
    cwd: checkout,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  const chunks: Uint8Array[] = []
  const reader = child.stderr.getReader()
  const state = { bytes: 0, timedOut: false, overflow: false }
  const timer = setTimeout(() => {
    state.timedOut = true
    child.kill("SIGKILL")
    void reader.cancel()
  }, 30_000)
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      state.bytes += next.value.byteLength
      if (state.bytes > 65_536) {
        state.overflow = true
        child.kill("SIGKILL")
        await reader.cancel()
        break
      }
      chunks.push(next.value)
    }
    const exit = await child.exited
    if (state.timedOut || state.overflow || exit !== 0)
      throw new Error(
        "LINUX_RUNTIME_PATCH_FAILED:" +
          (state.timedOut ? "timeout" : state.overflow ? "output_limit" : Buffer.concat(chunks).toString("utf8")),
      )
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await child.exited
  }
}
