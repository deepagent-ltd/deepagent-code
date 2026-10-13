import { createHash } from "node:crypto"

const fail = (code) => { throw Object.assign(new Error(code), { code }) }

/** Offline installation data. A profile name never grants Work authority; the
 * original installed helper and current Work still select and validate scope. */
/** @param {{ helper: string, helperSHA256: string, uid: number, project: string, data: string }} input */
export function linuxWorkWriteProfile(input) {
  if (!Number.isSafeInteger(input.uid) || input.uid < 1 || input.uid > 4_294_967_294 ||
    !/^[a-f0-9]{64}$/.test(input.helperSHA256) ||
    !/^\/opt\/[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}\/resources\/app\.asar\.unpacked\/out\/main\/chunks\/deepagent-work-file-helper$/.test(input.helper))
    fail("DAC_LINUX_WRITE_INSTALLATION_INVALID")
  if (![input.project, input.data].every(policyPath) || input.project === input.data ||
    input.project.startsWith(`${input.data}/`) || input.data.startsWith(`${input.project}/`))
    fail("DAC_LINUX_WRITE_SCOPE_INVALID")
  const scope = Object.freeze({ domain: "dac.linux-work-write-policy.v1",
    helper: input.helper, helperSHA256: input.helperSHA256, uid: input.uid,
    project: input.project, data: input.data })
  const profile = `dac_write_${createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 48)}`
  // No attachment wildcard, exec, capability, mount, link, or network rule.
  // Publication revalidates current paths in the host mount namespace. Binding
  // a directory inode into a private mount would change this guarantee.
  const profileText = `# DAC project write policy v1; installation data only.\n` +
    `# helper_sha256=${scope.helperSHA256} uid=${scope.uid}\n` +
    `abi <abi/4.0>,\nprofile ${profile} {\n` +
    `  "${scope.project}/" r,\n  "${scope.project}/**" rw,\n` +
    `  "${scope.data}/" r,\n  "${scope.data}/work-write-stage/" rw,\n` +
    `  "${scope.data}/work-write-stage/**" rw,\n` +
    `  "${scope.data}/work-write-stage/.cleanup-lock" rwk,\n` +
    // The original unconfined Host owns cancellation of its exact helper/collector.
    // Receive only the two signals used by their bounded termination paths.
    `  signal (receive) set=(term,kill) peer=unconfined,\n` +
    `  owner /proc/[0-9]*/attr/current r,\n  owner /proc/[0-9]*/attr/apparmor/current r,\n}\n`
  return Object.freeze({ scope, profile, profileText,
    profileSHA256: createHash("sha256").update(profileText).digest("hex"), nativeAuthority: false })
}

/** @param {string} value */
function policyPath(value) {
  // Unsupported parser metacharacters fail explicitly. Quoting alone would
  // still interpret globs and variables inside an AppArmor path expression.
  return value.startsWith("/") && value !== "/" && Buffer.byteLength(value) <= 2048 &&
    !/[\x00-\x1f\x7f"\\*?\[\]{}^@,]/.test(value) &&
    value.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== "..")
}
