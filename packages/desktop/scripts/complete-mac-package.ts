#!/usr/bin/env bun
import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createPrivateKey, createPublicKey } from "node:crypto"
import { fileURLToPath } from "node:url"
import { packageEnvironment } from "./package"

/** One publisher environment must reach both compilation and final package sealing. */
export async function completeMacPackageEnvironment(input: {
  environment: NodeJS.ProcessEnv
  args: string[]
  platform: NodeJS.Platform
  arch: string
  signingFile: string
}): Promise<NodeJS.ProcessEnv> {
  if (input.platform !== "darwin" || !["arm64", "x64"].includes(input.arch) ||
    input.args.some((arg) => ["--win", "--linux", "--universal", "--ia32", "--armv7l"].includes(arg)) ||
    input.args.includes(input.arch === "arm64" ? "--x64" : "--arm64"))
    throw new Error("Complete macOS packaging requires the native ARM or Intel host for the selected target")
  const environment = await packageEnvironment(input)
  const missing = ["DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY", "DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY",
    "DEEPAGENT_CODE_RELEASE_ID"].filter((key) => !environment[key]?.trim())
  if (missing.length) throw new Error(`Complete Native packaging requires: ${missing.join(", ")}`)
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(environment.DEEPAGENT_CODE_RELEASE_ID!.trim()))
    throw new Error("Complete Native packaging requires a bounded release identity")
  const unsigned = ["1", "true"].includes(environment.DEEPAGENT_CODE_ALLOW_UNSIGNED ?? "")
  const identity = environment.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY?.trim()
  if (unsigned ? identity !== "-" : !/^[0-9a-f]{40}$/i.test(identity ?? ""))
    throw new Error("Complete Native packaging requires an explicit asset certificate fingerprint; unsigned candidates require '-'")
  const raw = environment.DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY!.trim()
  const pin = raw.includes("-----BEGIN") ? raw : (await publisherKey(raw, false)).toString("utf8")
  if (pin.includes("PRIVATE KEY") || !pin.includes("-----BEGIN PUBLIC KEY-----"))
    throw new Error("Complete Native packaging requires a public release pin")
  const publicKey = createPublicKey(pin)
  const privateKey = createPrivateKey(await publisherKey(environment.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY!.trim(), true))
  if (publicKey.asymmetricKeyType !== "ed25519" || privateKey.asymmetricKeyType !== "ed25519" ||
    !publicKey.export({ type: "spki", format: "der" }).equals(createPublicKey(privateKey).export({ type: "spki", format: "der" })))
    throw new Error("Complete Native packaging requires the matching Ed25519 publisher key and public pin")
  return { ...environment, DEEPAGENT_CODE_RELEASE_NATIVE_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY: path.resolve(environment.DEEPAGENT_CODE_RELEASE_NATIVE_PRIVATE_KEY!.trim()),
    DEEPAGENT_CODE_RELEASE_ID: environment.DEEPAGENT_CODE_RELEASE_ID!.trim(),
    DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY: identity }
}

async function publisherKey(filename: string, privateKey: boolean) {
  const canonical = path.resolve(filename)
  if (await fs.realpath(canonical) !== canonical) throw new Error("Publisher keys require physical files")
  const opened = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await opened.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 16_384n ||
      (before.mode & (privateKey ? 0o077n : 0o022n)) !== 0n)
      throw new Error("Publisher keys require bounded files with private key permissions")
    const body = Buffer.alloc(Number(before.size))
    const read = await opened.read(body, 0, body.length, 0)
    const stamp = (stat: typeof before) => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
    if (read.bytesRead !== body.length || stamp(before) !== stamp(await opened.stat({ bigint: true })) ||
      stamp(before) !== stamp(await fs.lstat(canonical, { bigint: true })) || await fs.realpath(canonical) !== canonical)
      throw new Error("Publisher key changed during preparation")
    return body
  } finally {
    await opened.close()
  }
}

if (import.meta.main) {
  const directory = fileURLToPath(new URL("..", import.meta.url))
  process.chdir(directory)
  const args = ["--mac", ...Bun.argv.slice(2)]
  const environment = await completeMacPackageEnvironment({ environment: Bun.env, args,
    platform: process.platform, arch: process.arch, signingFile: path.join(directory, "signing.env") })
  // Fail configuration before replacing build output. Child processes inherit exactly
  // this pin/key/certificate selection, including an explicit unsigned candidate mode.
  for (const command of [["./scripts/prebuild.ts"], ["./scripts/build.ts"], ["./scripts/package.ts", ...args]]) {
    const exitCode = await Bun.spawn([process.execPath, ...command], { cwd: directory, env: environment,
      stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited
    if (exitCode !== 0) process.exit(exitCode)
  }
}
