import fs from "node:fs/promises"
import { Effect, Schema } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { linuxWorkWriteProfile } from "../../../desktop/resources/linux-work-provisioning/write-policy.mjs"

const Identity = Schema.Struct({ kind: Schema.Literal("posix"), device: Schema.String, inode: Schema.String })
export const Description = Schema.Struct({ profile: Schema.String, profile_sha256: WorkAuthoritySchema.Digest,
  helper_sha256: WorkAuthoritySchema.Digest, project_identity: Identity, data_identity: Identity,
  enforced: Schema.Literal(true) })

/** Metadata from an already-confined original Native helper is checked against the
 * shared administrator generator. It grants no Work authority or stage reservation. */
export const check = Effect.fn("LinuxWorkWritePolicy.check")(function* (input: {
  helper: string
  helperSHA256: string
  project: string
  data: string
  projectIdentity: typeof Identity.Type
}, observed: typeof Description.Type) {
  return yield* Effect.tryPromise({ try: async () => {
    const uid = process.getuid?.()
    if (process.platform !== "linux" || uid === undefined || uid === 0 || uid !== process.geteuid?.() ||
      process.getgid?.() !== process.getegid?.() || await fs.realpath(input.data) !== input.data)
      throw new Error("LINUX_WRITE_POLICY_UNAVAILABLE")
    const data = await fs.lstat(input.data, { bigint: true })
    const expected = linuxWorkWriteProfile({ helper: input.helper, helperSHA256: input.helperSHA256,
      uid, project: input.project, data: input.data })
    if (!data.isDirectory() || data.uid !== BigInt(uid) || (data.mode & 0o077n) !== 0n ||
      observed.profile !== expected.profile || observed.profile_sha256 !== expected.profileSHA256 ||
      observed.helper_sha256 !== input.helperSHA256 || !observed.enforced ||
      CanonicalJson.stringify(observed.project_identity) !== CanonicalJson.stringify(input.projectIdentity) ||
      observed.data_identity.device !== data.dev.toString() || observed.data_identity.inode !== data.ino.toString())
      throw new Error("LINUX_WRITE_POLICY_UNAVAILABLE")
  }, catch: () => new Error("LINUX_WRITE_POLICY_UNAVAILABLE") })
})
export * as LinuxWorkWritePolicy from "./linux-work-write-policy"
