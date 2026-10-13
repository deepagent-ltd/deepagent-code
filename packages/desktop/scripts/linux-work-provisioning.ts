import fs from "node:fs/promises"
import path from "node:path"
import { constants } from "node:fs"
import { createHash } from "node:crypto"
import type { LinuxNativeDevManifest } from "../../deepagent-code/script/build-linux-native-assets"

const helper = "resources/app.asar.unpacked/out/main/chunks/deepagent-work-process-supervisor"
const scripts = ["manage.mjs", "manage.sh", "write-policy.mjs", "prepare-write.mjs"] as const

/** Installation data only. AppArmor grants userns to one packaged supervisor,
 * while the original signed Native/Work factory remains the execution authority. */
export function linuxWorkInstallContract(input: { productName: string; executable: string; manifest: LinuxNativeDevManifest }) {
  if (![input.productName, input.executable].every((name) => /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(name)) ||
    !["linux-x64", "linux-arm64"].includes(input.manifest.target)) throw new Error("Invalid Linux installation layout")
  const asset = input.manifest.assets.find((entry) => entry.path === `packages/work-file-helper/bin/${input.manifest.target}/deepagent-work-process-supervisor`)
  if (!asset || asset.bytes < 1 || asset.bytes > 16_777_216 || !/^[a-f0-9]{64}$/.test(asset.sha256))
    throw new Error("Missing exact Linux supervisor asset")
  const prefix = `/opt/${input.productName}`
  const filename = `${prefix}/${helper}`
  const profile = `dac_work_${createHash("sha256").update(filename).digest("hex").slice(0, 32)}`
  // The path, rather than a wildcard, is stable across package upgrades. The
  // new package's exact hash remains mandatory in manage.mjs and NativeInstallation.
  const text = `# DAC managed command namespace: exact packaged supervisor only.\nabi <abi/4.0>,\nprofile ${profile} "${filename}" flags=(unconfined) {\n  userns,\n}\n`
  return { domain: "dac.linux-work-install.v1", target: input.manifest.target, prefix,
    executable: input.executable, helper, helperBytes: asset.bytes, helperSHA256: asset.sha256,
    profile, profileSHA256: createHash("sha256").update(text).digest("hex"), profileText: text }
}

/** Called after the original unpacked asset cohort is verified, before sealing
 * the package. Never writes desktop/out, host AppArmor, cgroups or user config. */
export async function prepareLinuxWorkProvisioning(input: {
  appOutDir: string; productName: string; executable: string; manifest: LinuxNativeDevManifest; resources: string
}) {
  const contract = linuxWorkInstallContract(input)
  const writeHelper = input.manifest.assets.find((entry) => entry.path === `packages/work-file-helper/bin/${input.manifest.target}/deepagent-work-file-helper`)
  if (!writeHelper || writeHelper.bytes < 64 || writeHelper.bytes > 16_777_216 || !/^[a-f0-9]{64}$/.test(writeHelper.sha256))
    throw new Error("Missing exact Linux file helper asset")
  const directory = path.join(input.appOutDir, "resources/linux-work-provisioning")
  await fs.mkdir(directory, { mode: 0o755 })
  await Promise.all(scripts.map(async (name) => {
    const source = await fs.readFile(path.join(input.resources, name))
    await fs.writeFile(path.join(directory, name), source, { flag: "wx", mode: name.endsWith(".sh") ? 0o755 : 0o644 })
  }))
  await fs.writeFile(path.join(directory, "apparmor.profile"), contract.profileText, { flag: "wx", mode: 0o644 })
  await fs.writeFile(path.join(directory, "executable.name"), `${contract.executable}\n`, { flag: "wx", mode: 0o644 })
  const { profileText, ...metadata } = contract
  await fs.writeFile(path.join(directory, "install.json"), `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o644 })
  await fs.writeFile(path.join(directory, "write-install.json"), `${JSON.stringify({ domain: "dac.linux-work-write-install.v1",
    target: input.manifest.target, prefix: contract.prefix,
    helper: `${contract.prefix}/resources/app.asar.unpacked/out/main/chunks/deepagent-work-file-helper`,
    helperBytes: writeHelper.bytes, helperSHA256: writeHelper.sha256 })}\n`, { flag: "wx", mode: 0o644 })
  const readme = `DAC Linux managed execution setup\n\nThis package grants user namespaces only to ${contract.prefix}/${contract.helper}.\nNative installation, route, current Work and tool authorization remain mandatory.\n\nOne-time installation or diagnosis:\n  sudo -- '${contract.prefix}/resources/linux-work-provisioning/manage.sh' install\n  '${contract.prefix}/resources/linux-work-provisioning/manage.sh' diagnose\n\nClose any existing DAC Desktop, then launch as the current ordinary user in one delegated scope:\n  '${contract.prefix}/resources/linux-work-provisioning/manage.sh' start\n\nThe helper checks exact bytes before namespace diagnosis. The launcher moves only itself\nto keeper in its own random scope and enables cpu/memory/pids only in that delegated unit.\nIt never changes global sysctl, AppArmor mode, arbitrary Node/Bun permissions, user services\nor unknown Work custody. Stop the Desktop normally; systemd collects the empty scope.\nAn unconfirmed remaining scope stays unknown and is never automatically removed or replayed.\n\nWithout a working user systemd manager, start is unavailable. Containers require explicitly\nprovisioned cgroup-v2/namespace support and the original DEEPAGENT_CODE_WORK_CGROUP contract.\nRoot/container results do not qualify ordinary-user installation. Namespace probe and\ninstallation metadata are diagnostics, never execution permits or Native provenance.\n`
  await fs.writeFile(path.join(directory, "README.txt"), readme, { flag: "wx", mode: 0o644 })
  await fs.writeFile(path.join(directory, "WRITE-SETUP.txt"),
    `DAC Linux project file-write isolation\n\n` +
    `The administrator prepares one exact project and ordinary-user data directory:\n` +
    `  sudo -- '${contract.prefix}/resources/linux-work-provisioning/manage.sh' prepare-write USER_UID PROJECT_ROOT PRIVATE_DATA_ROOT\n\n` +
    `Use canonical absolute paths. The project and private data must belong to USER_UID,\n` +
    `be on the same volume, and must not overlap. The data directory must be private (0700).\n` +
    `This installs a create-only enforcing AppArmor profile; it does not start an agent,\n` +
    `reserve storage, approve tools, create Work, or enable an unavailable runtime.\n` +
    `Native installation, current project/route, Work and tool permissions still apply.\n\n` +
    `There are at most 32 retained project policies per installation and UID. Exact\n` +
    `retry checks the original policy and scope. Edited or partial preparations remain\n` +
    `unavailable for explicit diagnosis; setup never replaces or removes an unknown\n` +
    `policy to make room. Keep original policy records while any Work custody remains.\n` +
    `Setup changes no global sysctl, other profile, registry, user service or privilege.\n`,
    { flag: "wx", mode: 0o644 })
  await fs.copyFile(path.join(input.resources, "LICENSE.electron-builder"), path.join(directory, "LICENSE.electron-builder"), constants.COPYFILE_EXCL)
  await fs.access(path.join(directory, "manage.sh"), constants.R_OK)
  return contract
}
