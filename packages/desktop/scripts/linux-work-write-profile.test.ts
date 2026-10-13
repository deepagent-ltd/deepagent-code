import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { linuxWorkWriteProfile } from "./linux-work-write-profile"

const input = { helper: "/opt/DeepAgent Code/resources/app.asar.unpacked/out/main/chunks/deepagent-work-file-helper",
  helperSHA256: "a".repeat(64), uid: 501, project: "/home/user/项目 代码", data: "/home/user/.local/share/deepagent-code" }

describe("Linux installation-owned project write policy", () => {
  test("has bounded current-path scope and no execution authority", () => {
    const result = linuxWorkWriteProfile(input)
    expect(result.nativeAuthority).toBe(false)
    expect(result.scope).toEqual({ domain: "dac.linux-work-write-policy.v1", ...input })
    expect(result.profile).toMatch(/^dac_write_[a-f0-9]{48}$/)
    expect(result.profileText).toContain('"/home/user/项目 代码/**" rw,')
    expect(result.profileText).toContain('"/home/user/.local/share/deepagent-code/work-write-stage/**" rw,')
    expect(result.profileText.split("\n").filter((line) => line.includes("k,"))).toEqual([
      '  "/home/user/.local/share/deepagent-code/work-write-stage/.cleanup-lock" rwk,',
    ])
    expect(result.profileText.split("\n").filter((line) => line.includes("signal "))).toEqual([
      "  signal (receive) set=(term,kill) peer=unconfined,",
    ])
    expect(result.profileText).not.toMatch(/flags=|\b(userns|capability|network|mount|change_profile|file)\s*,|\b[rw]*[xilm][rw]*,/)
    expect(result.profileSHA256).toBe(createHash("sha256").update(result.profileText).digest("hex"))
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.scope)).toBe(true)
  })

  test("a different scope or installation cannot adopt the original policy", () => {
    const result = linuxWorkWriteProfile(input)
    for (const changed of [{ uid: 502 }, { project: "/home/user/other" }, { data: "/home/user/other-data" },
      { helperSHA256: "b".repeat(64) }, { helper: input.helper.replace("DeepAgent Code", "DeepAgent Code QA") }]) {
      expect(linuxWorkWriteProfile({ ...input, ...changed }).profile).not.toBe(result.profile)
      expect(linuxWorkWriteProfile({ ...input, ...changed }).profileSHA256).not.toBe(result.profileSHA256)
    }
  })

  test("parser metacharacters, controls and noncanonical paths cannot expand scope", () => {
    for (const value of ["/", "relative", "/home//user", "/home/user/", "/home/./user", "/home/../user",
      '/home/user/"', "/home/user/\\", "/home/user/*", "/home/user/?", "/home/user/[a]", "/home/user/{a,b}",
      "/home/user/^", "/home/user/@{HOME}", "/home/user/,", "/home/user/\n", "/home/user/\0", "/" + "a".repeat(2048)]) {
      expect(() => linuxWorkWriteProfile({ ...input, project: value })).toThrow("DAC_LINUX_WRITE_SCOPE_INVALID")
      expect(() => linuxWorkWriteProfile({ ...input, data: value })).toThrow("DAC_LINUX_WRITE_SCOPE_INVALID")
    }
  })

  test("project and stage ownership scopes cannot overlap", () => {
    for (const data of [input.project, `${input.project}/data`])
      expect(() => linuxWorkWriteProfile({ ...input, data })).toThrow("DAC_LINUX_WRITE_SCOPE_INVALID")
    expect(() => linuxWorkWriteProfile({ ...input, project: `${input.data}/project` })).toThrow("DAC_LINUX_WRITE_SCOPE_INVALID")
  })

  test("unknown images, malformed hashes and root or invalid user IDs fail closed", () => {
    for (const helper of ["/usr/bin/bun", input.helper + ".bak", input.helper.replace("/opt/", "/tmp/"), input.helper.replace("chunks/", "chunks/../")])
      expect(() => linuxWorkWriteProfile({ ...input, helper })).toThrow("DAC_LINUX_WRITE_INSTALLATION_INVALID")
    for (const uid of [0, -1, 1.5, 4_294_967_295, Number.NaN])
      expect(() => linuxWorkWriteProfile({ ...input, uid })).toThrow("DAC_LINUX_WRITE_INSTALLATION_INVALID")
    for (const helperSHA256 of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64)])
      expect(() => linuxWorkWriteProfile({ ...input, helperSHA256 })).toThrow("DAC_LINUX_WRITE_INSTALLATION_INVALID")
  })
})
