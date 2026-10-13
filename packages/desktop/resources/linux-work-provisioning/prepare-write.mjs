import fs from "node:fs/promises"
import path from "node:path"
import { constants } from "node:fs"
import { createHash } from "node:crypto"
import { linuxWorkWriteProfile } from "./write-policy.mjs"

const fail = (code) => { throw Object.assign(new Error(code), { code }) }
const hash = (value) => createHash("sha256").update(value).digest("hex")
const identity = (stat) => ({ kind: "posix", device: stat.dev.toString(), inode: stat.ino.toString() })
const same = (left, right) => left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode

/** Scope metadata is descriptive. It never authorizes a Work or opens a stage. */
export async function inspectProjectWriteScope(input) {
  // Use the actual generator for all path and UID validation before filesystem access.
  linuxWorkWriteProfile(input)
  const project = await inspectDirectory(input.project, input.uid, false)
  const data = await inspectDirectory(input.data, input.uid, true)
  if (project.dev !== data.dev) fail("DAC_WRITE_SAME_VOLUME_REQUIRED")
  return Object.freeze({ projectIdentity: identity(project), dataIdentity: identity(data) })
}

async function inspectDirectory(filename, uid, privateData) {
  // Hold the final no-follow directory and reconcile the whole canonical path.
  // The helper repeats this observation at admission and publication.
  if (await fs.realpath(filename) !== filename) fail("DAC_WRITE_SCOPE_CHANGED")
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const held = await file.stat({ bigint: true })
    if (!held.isDirectory() || held.uid !== BigInt(uid) || privateData && (held.mode & 0o077n) !== 0n ||
      !same(held, await fs.lstat(filename, { bigint: true })) || await fs.realpath(filename) !== filename)
      fail("DAC_WRITE_SCOPE_UNTRUSTED")
    return held
  } finally { await file.close() }
}

async function ownedDirectory(filename) {
  // Installation management runs as root. Each ancestor must remain root-owned
  // and not group/world writable; supplied project paths never select this tree.
  const parts = filename.split("/").filter(Boolean)
  for (const current of parts.map((_, index) => `/${parts.slice(0, index + 1).join("/")}`)) {
    await fs.mkdir(current, { mode: 0o755 }).catch((error) => { if (error.code !== "EEXIST") throw error })
    const stat = await fs.lstat(current, { bigint: true })
    if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n || await fs.realpath(current) !== current)
      fail("DAC_WRITE_POLICY_DIRECTORY_UNTRUSTED")
  }
}

async function createOwned(filename, bytes) {
  const file = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
  const directory = await fs.open(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
}

async function loaded(profile) {
  const file = await fs.open("/sys/kernel/security/apparmor/profiles", constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.alloc(1_048_577)
    const result = await file.read(buffer, 0, buffer.length, 0)
    if (result.bytesRead > 1_048_576) fail("DAC_WRITE_POLICY_INVENTORY_CAPACITY")
    return buffer.subarray(0, result.bytesRead).toString("utf8").split("\n").filter((line) => line.startsWith(`${profile} (`))
  } finally { await file.close() }
}

/** Explicit offline administrator operation, called by the package-owned
 * setup entry. There is no daemon, privilege escalation or runtime fallback. */
export async function prepareProjectWrite(installation, input, tools) {
  if (process.platform !== "linux" || process.getuid() !== 0) fail("DAC_WRITE_SETUP_ROOT_REQUIRED")
  const metadata = JSON.parse(await tools.readOwned(`${installation.prefix}/resources/linux-work-provisioning/write-install.json`, 4096))
  const keys = ["domain", "target", "prefix", "helper", "helperBytes", "helperSHA256"].sort()
  if (Object.keys(metadata).sort().join() !== keys.join() || metadata.domain !== "dac.linux-work-write-install.v1" ||
    metadata.target !== `linux-${process.arch}` || metadata.prefix !== installation.prefix ||
    metadata.helper !== `${metadata.prefix}/resources/app.asar.unpacked/out/main/chunks/deepagent-work-file-helper` ||
    !Number.isSafeInteger(metadata.helperBytes) || metadata.helperBytes < 64 || metadata.helperBytes > 16_777_216 ||
    !/^[a-f0-9]{64}$/.test(metadata.helperSHA256)) fail("DAC_WRITE_INSTALL_CONTRACT_INVALID")
  const bytes = await tools.readOwned(metadata.helper, 16_777_216)
  if (bytes.length !== metadata.helperBytes || hash(bytes) !== metadata.helperSHA256 || bytes.readUInt32LE(0) !== 0x464c457f ||
    bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== (process.arch === "x64" ? 62 : 183))
    fail("DAC_WRITE_HELPER_CHANGED")
  const profile = linuxWorkWriteProfile({ helper: metadata.helper, helperSHA256: metadata.helperSHA256,
    uid: input.uid, project: input.project, data: input.data })
  const observed = await inspectProjectWriteScope(profile.scope)
  const directory = `/var/lib/deepagent-code/work-write-policy/${input.uid}/${hash(installation.prefix).slice(0, 32)}`
  await ownedDirectory(directory)
  const lock = `${directory}/prepare.lock`
  const guard = await fs.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const lockIdentity = await guard.stat({ bigint: true })
  try {
    const record = { domain: "dac.linux-work-write-installation-record.v1", target: metadata.target,
      scope: profile.scope, profile: profile.profile, profileSHA256: profile.profileSHA256, ...observed, nativeAuthority: false }
    const body = `${JSON.stringify(record)}\n`
    const target = `/etc/apparmor.d/${profile.profile}`
    const ready = `${directory}/${profile.profile}.json`
    const present = await fs.lstat(ready).catch((error) => { if (error.code === "ENOENT") return undefined; throw error })
    if (present) {
      if ((await tools.readOwned(ready, 16_384)).toString() !== body || hash(await tools.readOwned(target, 16_384)) !== profile.profileSHA256 ||
        (await loaded(profile.profile)).join() !== `${profile.profile} (enforce)`) fail("DAC_WRITE_POLICY_CURRENT_MISMATCH")
      return { status: "write_policy_current", profile: profile.profile, nativeAuthority: false }
    }
    const names = await fs.readdir(directory)
    if (names.length > 66 || names.some((name) => name !== "prepare.lock" && !/^dac_write_[a-f0-9]{48}\.(prepared\.)?json$/.test(name)))
      fail("DAC_WRITE_POLICY_INVENTORY_UNTRUSTED")
    // A partial prepare remains an explicit obligation. Never retry a load or
    // delete an unknown profile simply because no final record was committed.
    if (new Set(names.filter((name) => name !== "prepare.lock").map((name) => name.split(".")[0])).size >= 32)
      fail("DAC_WRITE_POLICY_CAPACITY")
    if (names.includes(`${profile.profile}.prepared.json`) || (await loaded(profile.profile)).length)
      fail("DAC_WRITE_POLICY_PREPARATION_UNKNOWN")
    await ownedDirectory("/etc/apparmor.d")
    await createOwned(`${directory}/${profile.profile}.prepared.json`, body)
    await createOwned(target, profile.profileText)
    if (hash(await tools.readOwned(target, 16_384)) !== profile.profileSHA256 ||
      JSON.stringify(await inspectProjectWriteScope(profile.scope)) !== JSON.stringify(observed)) fail("DAC_WRITE_POLICY_SCOPE_CHANGED")
    const parser = "/usr/sbin/apparmor_parser"
    if ((await tools.command(parser, ["--skip-kernel-load", "--skip-cache", "--skip-read-cache", target])).code !== 0)
      fail("DAC_WRITE_POLICY_ABI_UNAVAILABLE")
    // Create-only kernel publication preserves independently loaded policies.
    if ((await tools.command(parser, ["--add", "--skip-cache", "--skip-read-cache", target])).code !== 0 ||
      (await loaded(profile.profile)).join() !== `${profile.profile} (enforce)` ||
      JSON.stringify(await inspectProjectWriteScope(profile.scope)) !== JSON.stringify(observed) ||
      hash(await tools.readOwned(target, 16_384)) !== profile.profileSHA256) fail("DAC_WRITE_POLICY_LOAD_UNKNOWN")
    await createOwned(ready, body)
    return { status: "write_policy_prepared", profile: profile.profile, nativeAuthority: false }
  } finally {
    // Only our still-held guard may be removed; a substituted lock is foreign.
    const current = await fs.lstat(lock, { bigint: true }).catch(() => undefined)
    if (current && same(current, lockIdentity)) await fs.unlink(lock)
    await guard.close()
  }
}
