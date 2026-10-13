export * as IMMediaProductDescriptor from "./im-media-product-descriptor"

import { Schema } from "effect"
import fs from "node:fs/promises"

const Text = Schema.String.check(
  Schema.isMinLength(1), Schema.isMaxLength(8192), Schema.makeFilter((value: string) => value.isWellFormed()),
)
const Integer = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Reader = Schema.Struct({ mode: Text, state: Text, liveUnread: Schema.NullOr(Text), peerID: Text })
export const Peer = Schema.Struct({
  pid: Integer,
  url: Text,
  directory: Text,
  authorizationFile: Text,
  database: Text,
})
export const Group = Schema.Struct({
  reader: Reader,
  id: Text,
  workspaceID: Text,
  projectID: Schema.NullOr(Text),
  type: Text,
  name: Text,
  createdBy: Text,
  kernelConvID: Text,
  createdAt: Integer,
  updatedAt: Integer,
})
export const File = Schema.Struct({
  path: Text,
  filename: Text,
  mime: Text,
  bytes: Integer.check(Schema.isLessThanOrEqualTo(50 * 1024 * 1024)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
const State = Schema.Struct({
  media: Schema.Struct({
    version: Integer,
    enabled: Schema.Boolean,
    multipleAttachments: Schema.Boolean,
    maxAttachments: Integer,
    maxAttachmentBytes: Integer,
    ttlMs: Integer,
  }),
  reader: Schema.Struct({ state: Text, displayEpoch: Text, legacyMirrorUnavailable: Schema.Boolean }),
  facade: Text,
  identity: Schema.Struct({ uuid: Text, name: Text, orgID: Integer, orgAllGroupID: Text }),
  blocked: Schema.Null,
  kernel: Text,
  keyOrigin: Text,
  viewer: Schema.Struct({ memberID: Text }),
  recovery: Schema.Struct({ status: Text }),
})
export const Descriptor = Schema.Struct({
  version: Schema.Literal(1),
  window: Text,
  createdAt: Integer,
  deadlineAt: Integer,
  peers: Schema.Struct({ A: Peer, B: Peer }),
  groups: Schema.Struct({ A: Group, B: Group }),
  kernel: Schema.Struct({ api: Text, navigator: Text, ws: Text, realm: Text }),
  platform: Text,
  controls: Schema.Struct({ base: Text, authorizationFile: Text, header: Text, allowed: Schema.Array(Text) }),
  facadeKeysFile: Text,
  files: Schema.Array(File).check(Schema.isMinLength(4), Schema.isMaxLength(4)),
  task: Schema.Struct({ state: Schema.Literal("unavailable"), reason: Text }),
  state: Schema.Struct({ A: State, B: State }),
  stopFile: Text,
  resourceSafe: Text,
})
export type Descriptor = typeof Descriptor.Type

/** Coordinates describe the original peers. They never create a Core grant or a
 * Source witness. Task facts remain unavailable in this ordinary media window. */
export function decode(input: unknown) {
  const value = Schema.decodeUnknownSync(Descriptor)(input)
  for (const peer of [value.peers.A, value.peers.B]) {
    const url = new URL(peer.url)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error("Fixture endpoint must be a plain original server URL")
    if (![peer.directory, peer.authorizationFile, peer.database].every((file) => file.startsWith("/")))
      throw new Error("Fixture paths must refer to explicit private resources")
  }
  if (new URL(value.peers.A.url).origin === new URL(value.peers.B.url).origin)
    throw new Error("The cross-Origin product fixture requires distinct original origins")
  if (value.deadlineAt <= value.createdAt) throw new Error("Fixture deadline must follow creation")
  if (value.files.some((file) => !file.path.startsWith("/")))
    throw new Error("Media fixture inputs must use explicit private file paths")
  return value
}

export function requireCurrent(value: Descriptor) {
  if (Date.now() >= value.deadlineAt) throw new Error("Fixture window has ended")
  if (![value.state.A, value.state.B].every((state) => state.media.enabled && state.media.multipleAttachments))
    throw new Error("The original media profile is not ready")
  return value
}

export async function authorization(filename: string) {
  const info = await fs.lstat(filename)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 8192)
    throw new Error("Private authorization file unavailable")
  const value = await fs.readFile(filename, "utf8")
  if (!/^Basic [a-zA-Z0-9+/]+={0,2}$/.test(value)) throw new Error("Original Basic authorization required")
  return value
}
