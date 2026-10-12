import fs from "node:fs/promises"
import path from "node:path"
import { constants } from "node:fs"
import { fileURLToPath } from "node:url"
import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"

const unitPattern = /^dac-work-[a-f0-9]{24}\.scope$/
const directory = path.dirname(fileURLToPath(import.meta.url))
const controllers = ["cpu", "memory", "pids"]
const fail = (code) => { throw Object.assign(new Error(code), { code }) }
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const stamp = (stat) => [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.gid, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(":")

async function readOwned(filename, limit = 1_048_576, root = true, content = true) {
  if (!path.isAbsolute(filename) || await fs.realpath(filename) !== filename) fail("DAC_INSTALL_PATH_CHANGED")
  for (const parent of ancestors(path.dirname(filename))) {
    const stat = await fs.lstat(parent, { bigint: true })
    if (!stat.isDirectory() || root && stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) fail("DAC_INSTALL_PATH_UNTRUSTED")
  }
  const before = await fs.lstat(filename, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n || root && before.uid !== 0n ||
    (before.mode & 0o022n) !== 0n || before.size > BigInt(limit)) fail("DAC_INSTALL_FILE_UNTRUSTED")
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const held = await file.stat({ bigint: true })
    if (stamp(held) !== stamp(before)) fail("DAC_INSTALL_FILE_CHANGED")
    const chunks = []
    const buffer = Buffer.alloc(65_536)
    const state = { bytes: 0 }
    while (true) {
      const observed = await file.read(buffer, 0, buffer.length, null)
      if (!observed.bytesRead) break
      state.bytes += observed.bytesRead
      if (state.bytes > limit) fail("DAC_INSTALL_FILE_CAPACITY")
      if (content) chunks.push(Buffer.from(buffer.subarray(0, observed.bytesRead)))
    }
    const after = await file.stat({ bigint: true })
    if (state.bytes !== Number(held.size) || stamp(held) !== stamp(after) || stamp(after) !== stamp(await fs.lstat(filename, { bigint: true })))
      fail("DAC_INSTALL_FILE_CHANGED")
    return content ? Buffer.concat(chunks) : undefined
  } finally { await file.close() }
}

function ancestors(filename) {
  const parts = filename.split("/").filter(Boolean)
  return ["/", ...parts.map((_, index) => `/${parts.slice(0, index + 1).join("/")}`)]
}

async function contract() {
  if (process.platform !== "linux") fail("DAC_LINUX_REQUIRED")
  const value = JSON.parse(await readOwned(path.join(directory, "install.json")))
  const keys = ["domain", "target", "prefix", "executable", "helper", "helperBytes", "helperSHA256", "profile", "profileSHA256"].sort()
  if (Object.keys(value).sort().join() !== keys.join() || value.domain !== "dac.linux-work-install.v1" ||
    value.target !== `linux-${process.arch}` || !/^\/opt\/[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(value.prefix) ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(value.executable) ||
    value.helper !== "resources/app.asar.unpacked/out/main/chunks/deepagent-work-process-supervisor" ||
    !Number.isSafeInteger(value.helperBytes) || value.helperBytes < 1 || value.helperBytes > 16_777_216 ||
    ![value.helperSHA256, value.profileSHA256].every((item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)) ||
    value.profile !== `dac_work_${hash(`${value.prefix}/${value.helper}`).slice(0, 32)}` ||
    directory !== `${value.prefix}/resources/linux-work-provisioning`) fail("DAC_INSTALL_CONTRACT_INVALID")
  const bytes = await readOwned(`${value.prefix}/${value.helper}`, 16_777_216)
  if (bytes.length !== value.helperBytes || hash(bytes) !== value.helperSHA256 || bytes.readUInt32LE(0) !== 0x464c457f ||
    bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== (process.arch === "x64" ? 62 : 183)) fail("DAC_HELPER_CHANGED")
  if (hash(await readOwned(path.join(directory, "apparmor.profile"))) !== value.profileSHA256 ||
    (await readOwned(path.join(directory, "executable.name"))).toString() !== `${value.executable}\n`) fail("DAC_INSTALL_CONTRACT_CHANGED")
  await readOwned(`${value.prefix}/${value.executable}`, 536_870_912, true, false)
  return value
}

async function command(filename, args, timeout = 10_000, env = process.env) {
  await readOwned(await fs.realpath(filename), 536_870_912, true, false)
  return await new Promise((resolve, reject) => {
    const child = spawn(filename, args, { env, stdio: ["ignore", "pipe", "pipe"] })
    const state = { bytes: 0, stdout: [], stderr: [], timedOut: false }
    const timer = setTimeout(() => { state.timedOut = true; child.kill("SIGKILL") }, timeout)
    const capture = (kind) => (chunk) => {
      state.bytes += chunk.length
      if (state.bytes > 65_536) { state.timedOut = true; child.kill("SIGKILL"); return }
      state[kind].push(chunk)
    }
    child.stdout.on("data", capture("stdout")); child.stderr.on("data", capture("stderr"))
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("close", (code) => {
      clearTimeout(timer)
      resolve({ code: state.timedOut ? null : code, stdout: Buffer.concat(state.stdout).toString("utf8"), stderr: Buffer.concat(state.stderr).toString("utf8") })
    })
  })
}

async function optional(filename) {
  return await fs.readFile(filename, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error })
}

async function profileLoaded(name) {
  const text = await optional("/sys/kernel/security/apparmor/profiles")
  return text?.split("\n").some((line) => line === `${name} (unconfined)`) ?? false
}

async function install(value) {
  if (process.getuid() !== 0) fail("DAC_INSTALL_ROOT_REQUIRED")
  const restricted = await optional("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
  if (restricted?.trim() !== "1") return { status: "not_required", nativeAuthority: false }
  const parser = "/usr/sbin/apparmor_parser"
  const profile = path.join(directory, "apparmor.profile")
  if ((await command(parser, ["--skip-kernel-load", "--skip-cache", profile])).code !== 0) fail("DAC_APPARMOR_ABI_UNAVAILABLE")
  const target = `/etc/apparmor.d/${value.profile}`
  const bytes = await readOwned(profile)
  const parent = await fs.lstat("/etc/apparmor.d", { bigint: true })
  if (await fs.realpath("/etc/apparmor.d") !== "/etc/apparmor.d" || !parent.isDirectory() || parent.uid !== 0n || (parent.mode & 0o022n) !== 0n)
    fail("DAC_APPARMOR_DIRECTORY_UNTRUSTED")
  const staged = `/etc/apparmor.d/.${value.profile}.${randomBytes(12).toString("hex")}.stage`
  const file = await fs.open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
  // Publish without replacing an independently edited system profile.
  await fs.link(staged, target).catch(async (error) => {
    if (error.code !== "EEXIST" || hash(await readOwned(target)) !== value.profileSHA256) fail("DAC_APPARMOR_FOREIGN_PROFILE")
  })
  await fs.unlink(staged)
  const heldDirectory = await fs.open("/etc/apparmor.d", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await heldDirectory.sync() } finally { await heldDirectory.close() }
  if (hash(await readOwned(target)) !== value.profileSHA256) fail("DAC_APPARMOR_PROFILE_CHANGED")
  if ((await command(parser, ["--replace", "--write-cache", "--skip-read-cache", target])).code !== 0 || !await profileLoaded(value.profile))
    fail("DAC_APPARMOR_LOAD_UNKNOWN")
  return { status: "profile_loaded", profile: value.profile, nativeAuthority: false }
}

/** This function owns only the original caller process in its exact delegated
 * unit. Kernel/Native checks repeat at actual command admission and dispatch. */
export async function prepareDelegatedCgroup(unit) {
  if (process.platform !== "linux" || process.getuid() === 0 || !unitPattern.test(unit)) fail("DAC_USER_SCOPE_REQUIRED")
  const lines = (await fs.readFile("/proc/self/cgroup", "utf8")).trim().split("\n")
  if (lines.length !== 1 || !lines[0].startsWith("0::/") || lines[0].includes("..")) fail("DAC_CGROUP_V2_REQUIRED")
  const relative = lines[0].slice(3)
  if (!relative.endsWith(`/${unit}`) && !relative.endsWith(`/${unit}/keeper`)) fail("DAC_SCOPE_IDENTITY_CHANGED")
  const delegated = path.join("/sys/fs/cgroup", relative.endsWith("/keeper") ? path.dirname(relative) : relative)
  const owner = BigInt(process.getuid())
  const before = await fs.lstat(delegated, { bigint: true })
  if (await fs.realpath(delegated) !== delegated || !before.isDirectory() || before.uid !== owner ||
    (before.mode & 0o022n) !== 0n || (await fs.statfs(delegated)).type !== 0x63677270) fail("DAC_CGROUP_NOT_DELEGATED")
  const available = (await fs.readFile(path.join(delegated, "cgroup.controllers"), "utf8")).split(/\s+/)
  if (!controllers.every((name) => available.includes(name))) fail("DAC_CGROUP_CONTROLLERS_UNAVAILABLE")
  if (!relative.endsWith("/keeper")) {
    if ((await fs.readFile(path.join(delegated, "cgroup.procs"), "utf8")).trim() !== String(process.pid)) fail("DAC_SCOPE_PROCESS_CHANGED")
    const keeper = path.join(delegated, "keeper")
    await fs.mkdir(keeper, { mode: 0o700 })
    const stat = await fs.lstat(keeper, { bigint: true })
    if (await fs.realpath(keeper) !== keeper || stat.uid !== owner || !stat.isDirectory()) fail("DAC_SCOPE_KEEPER_CHANGED")
    await fs.writeFile(path.join(keeper, "cgroup.procs"), String(process.pid))
  }
  if ((await fs.readFile(path.join(delegated, "cgroup.procs"), "utf8")).trim()) fail("DAC_SCOPE_NOT_EMPTY")
  await fs.writeFile(path.join(delegated, "cgroup.subtree_control"), "+cpu +memory +pids")
  const enabled = (await fs.readFile(path.join(delegated, "cgroup.subtree_control"), "utf8")).split(/\s+/)
  const after = await fs.lstat(delegated, { bigint: true })
  if (before.dev !== after.dev || before.ino !== after.ino || !controllers.every((name) => enabled.includes(name))) fail("DAC_CGROUP_PROVISION_UNKNOWN")
  return delegated
}

async function diagnose(value) {
  const probe = await command(`${value.prefix}/${value.helper}`, ["--probe-linux-namespaces"], 5_000, {})
  const observed = probe.code === 0 ? JSON.parse(probe.stdout) : null
  const namespaceSetup = observed?.version === 1 && observed.namespace_setup === true && observed.payloads === 0 && observed.native_authority === false
  const manager = await command("/usr/bin/systemctl", ["--user", "is-system-running"])
  return { status: namespaceSetup && ["running", "degraded"].includes(manager.stdout.trim()) ? "setup_candidate" : "unavailable",
    uid: process.getuid(), namespaceSetup, userSystemd: manager.stdout.trim(), nativeAuthority: false,
    next: "start creates and verifies one delegated current-user scope; actual Work requires original Native authority" }
}

async function main() {
  const value = await contract()
  const action = process.argv[2] ?? "diagnose"
  if (action === "prepare-write" && process.argv.length === 6 && /^[1-9][0-9]{0,9}$/.test(process.argv[3])) {
    const { prepareProjectWrite } = await import("./prepare-write.mjs")
    return prepareProjectWrite(value, { uid: Number(process.argv[3]), project: process.argv[4], data: process.argv[5] }, { readOwned, command })
  }
  if (action === "install" && process.argv.length === 3) return install(value)
  if (action === "diagnose" && process.argv.length === 3) return diagnose(value)
  if (action === "start" && process.argv.length === 3) {
    if (process.getuid() === 0) fail("DAC_ORDINARY_USER_REQUIRED")
    const checked = await diagnose(value)
    if (checked.status !== "setup_candidate") fail("DAC_NAMESPACE_OR_MANAGER_UNAVAILABLE")
    const unit = `dac-work-${randomBytes(12).toString("hex")}.scope`
    const child = spawn("/usr/bin/systemd-run", ["--user", "--scope", "--collect", `--unit=${unit}`,
      "--property=Delegate=cpu memory pids", process.execPath, path.join(directory, "manage.mjs"), "run", unit],
      { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } })
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
    if (code !== 0) fail("DAC_SCOPE_START_UNKNOWN")
    const closed = await command("/usr/bin/systemctl", ["--user", "show", unit, "--property=ActiveState", "--property=ControlGroup"])
    const facts = new Map(closed.stdout.trim().split("\n").map((line) => line.split("=")))
    if (closed.code !== 0 || facts.get("ActiveState") !== "inactive" || facts.get("ControlGroup") !== "")
      fail("DAC_SCOPE_EXIT_UNCONFIRMED")
    return { status: "scope_closed", nativeAuthority: false }
  }
  if (action === "run" && process.argv.length === 4) {
    const cgroup = await prepareDelegatedCgroup(process.argv[3])
    const env = { ...process.env, DEEPAGENT_CODE_WORK_CGROUP: cgroup }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(`${value.prefix}/${value.executable}`, [], { env, stdio: "inherit" })
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
    if (code !== 0) fail("DAC_DESKTOP_EXIT_UNKNOWN")
    return { status: "desktop_closed", nativeAuthority: false }
  }
  fail("DAC_PROVISIONING_ACTION_INVALID")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => console.log(JSON.stringify(result)), (error) => {
    console.error(JSON.stringify({ status: "unavailable", code: /^DAC_[A-Z_]+$/.test(error.code) ? error.code : "DAC_PROVISIONING_UNKNOWN", nativeAuthority: false }))
    process.exitCode = 2
  })
}
