import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { linuxWorkInstallContract, prepareLinuxWorkProvisioning } from "./linux-work-provisioning"
import type { LinuxNativeDevManifest } from "../../deepagent-code/script/build-linux-native-assets"

const manifest: LinuxNativeDevManifest = {
  schemaVersion: "dac.linux-native-dev-assets.v1", target: "linux-x64", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40),
  source: [{ path: "packages/work-file-helper/src/command_supervisor/main.rs", bytes: 1, sha256: "c".repeat(64) }],
  tools: [{ name: "cargo", bytes: 1, sha256: "d".repeat(64), version: "fixture, not executed" }],
  runtimeVersion: "fixture, not executed",
  assets: ["deepagent-work-file-helper", "deepagent-work-storage-cleanup", "deepagent-work-process-supervisor", "bun-command-runtime"]
    .map((name) => ({ path: `packages/work-file-helper/bin/linux-x64/${name}`, bytes: 128, sha256: "e".repeat(64) })),
  licenses: ["NOTICE", "work-file-helper.LICENSE", "work-file-helper.NOTICE", "work-file-helper.UPSTREAM.json"]
    .map((name) => ({ path: `linux-native-licenses/${name}`, bytes: 1, sha256: "f".repeat(64) })),
}

test("one exact installed supervisor attachment, never arbitrary interpreters or globs", () => {
  const value = linuxWorkInstallContract({ productName: "DeepAgent Code Dev", executable: "deepagent-code-dev", manifest })
  expect(value.prefix).toBe("/opt/DeepAgent Code Dev")
  expect(value.helperSHA256).toBe("e".repeat(64))
  expect(value.profileText).toContain('"/opt/DeepAgent Code Dev/resources/app.asar.unpacked/out/main/chunks/deepagent-work-process-supervisor"')
  expect(value.profileText).not.toMatch(/\*|\?|\/usr\/bin\/(node|bun)|sysctl/)
  expect(value.profileSHA256).toBe(createHash("sha256").update(value.profileText).digest("hex"))
  // Package upgrades retain the exact path's stable profile and independently
  // require the new helper hash; a stale binary never adopts the new contract.
  const newer = linuxWorkInstallContract({ productName: "DeepAgent Code Dev", executable: "deepagent-code-dev",
    manifest: { ...manifest, assets: manifest.assets.map((entry) => ({ ...entry, sha256: "1".repeat(64) })) } })
  expect(newer.profile).toBe(value.profile)
  expect(newer.profileText).toBe(value.profileText)
  expect(newer.helperSHA256).not.toBe(value.helperSHA256)
})

test("unsafe package names, traversal, unsupported or missing exact assets refuse before generating permissions", () => {
  for (const productName of ["../DAC", "DAC*", "DAC\" {}", "DAC\nuserns,", "DAC;touch x", "DAC/child"]) {
    expect(() => linuxWorkInstallContract({ productName, executable: "deepagent-code-dev", manifest })).toThrow()
  }
  expect(() => linuxWorkInstallContract({ productName: "DAC", executable: "../../node", manifest })).toThrow()
  expect(() => linuxWorkInstallContract({ productName: "DAC", executable: "dac",
    manifest: { ...manifest, assets: manifest.assets.filter((entry) => !entry.path.endsWith("/deepagent-work-process-supervisor")) } })).toThrow()
})

test("physical package resources preserve exact helper contract and create-only stage custody", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-linux-work-provision-"))
  try {
    await fs.mkdir(path.join(directory, "resources"))
    const value = await prepareLinuxWorkProvisioning({ appOutDir: directory, productName: "DeepAgent Code Dev",
      executable: "deepagent-code-dev", manifest, resources: path.resolve("resources/linux-work-provisioning") })
    const installed = path.join(directory, "resources/linux-work-provisioning")
    const metadata = await Bun.file(path.join(installed, "install.json")).json()
    expect(metadata.helperSHA256).toBe(value.helperSHA256)
    expect(metadata.profileSHA256).toBe(value.profileSHA256)
    expect(metadata).not.toHaveProperty("profileText")
    expect(await fs.readFile(path.join(installed, "executable.name"), "utf8")).toBe("deepagent-code-dev\n")
    expect(await fs.readFile(path.join(installed, "manage.mjs"))).toEqual(await fs.readFile("resources/linux-work-provisioning/manage.mjs"))
    for (const name of ["write-policy.mjs", "prepare-write.mjs"])
      expect(await fs.readFile(path.join(installed, name))).toEqual(await fs.readFile(path.join("resources/linux-work-provisioning", name)))
    expect(await Bun.file(path.join(installed, "write-install.json")).json()).toEqual({
      domain: "dac.linux-work-write-install.v1", target: "linux-x64", prefix: value.prefix,
      helper: `${value.prefix}/resources/app.asar.unpacked/out/main/chunks/deepagent-work-file-helper`, helperBytes: 128, helperSHA256: "e".repeat(64),
    })
    expect(await fs.readFile(path.join(installed, "apparmor.profile"), "utf8")).toBe(value.profileText)
    await expect(prepareLinuxWorkProvisioning({ appOutDir: directory, productName: "DeepAgent Code Dev", executable: "deepagent-code-dev",
      manifest, resources: path.resolve("resources/linux-work-provisioning") })).rejects.toThrow()
    expect(await fs.readFile(path.join(installed, "apparmor.profile"), "utf8")).toBe(value.profileText)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test("production delegation refuses a copied or arbitrary unit before touching the filesystem", async () => {
  const runtime = await import(path.resolve("resources/linux-work-provisioning/manage.mjs"))
  for (const unit of ["user@501.service", "arbitrary.scope", "dac-work-../scope", "dac-work-" + "a".repeat(24) + ".service"]) {
    await expect(runtime.prepareDelegatedCgroup(unit)).rejects.toMatchObject({ code: "DAC_USER_SCOPE_REQUIRED" })
  }
})
