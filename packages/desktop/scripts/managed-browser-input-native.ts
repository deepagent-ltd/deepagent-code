import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { realpath, chmod } from "node:fs/promises"
import { managedBrowserInputRuntime } from "./managed-browser-input-runtime"

/** Independent publisher step; the shared build decides whether to include this asset. */
export async function compileManagedBrowserInputNative(input: {
  target: "darwin-arm64" | "darwin-x64"
  headers: string
  directory: string
}) {
  if (process.platform !== "darwin") throw new Error("Managed browser input build requires Darwin")
  if (!["darwin-arm64", "darwin-x64"].includes(input.target))
    throw new Error("Managed browser input build requires an explicit Darwin target")
  const source = fileURLToPath(new URL("../native/managed-browser-input/darwin.mm", import.meta.url))
  const filename = path.join(await realpath(input.directory), "managed-browser-input-darwin.node")
  const child = Bun.spawn(["/usr/bin/xcrun", "clang++", "-std=c++17", "-bundle", "-undefined", "dynamic_lookup",
    "-fobjc-arc", "-DNAPI_VERSION=8",
    `-DDAC_MANAGED_BROWSER_INPUT_ELECTRON_VERSION=${JSON.stringify(managedBrowserInputRuntime.electronVersion)}`,
    `-DDAC_MANAGED_BROWSER_INPUT_NODE_VERSION=${JSON.stringify(managedBrowserInputRuntime.nodeVersion)}`,
    "-mmacosx-version-min=12.0", "-arch",
    input.target === "darwin-arm64" ? "arm64" : "x86_64", "-framework", "AppKit", "-I", input.headers,
    source, "-o", filename], { stdout: "pipe", stderr: "pipe" })
  const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (result[0] !== 0) throw new Error(`Managed browser input compile failed: ${result[2]}`)
  await chmod(filename, 0o755)
  return Object.freeze({ schemaVersion: "dac.managed-browser-input.darwin.v1" as const, target: input.target,
    napiVersion: 8 as const, ...managedBrowserInputRuntime, path: filename,
    bytes: (await Bun.file(filename).arrayBuffer()).byteLength,
    sha256: createHash("sha256").update(new Uint8Array(await Bun.file(filename).arrayBuffer())).digest("hex"),
    sourceSha256: createHash("sha256").update(new Uint8Array(await Bun.file(source).arrayBuffer())).digest("hex"),
  })
}
