export * as IMReaderProductDescriptor from "./im-reader-product-descriptor"

import { Schema } from "effect"
import { IMMediaProductDescriptor } from "./im-media-product-descriptor"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512),
  Schema.makeFilter((value: string) => value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(value) <= 512))
const Absolute = Text.check(Schema.makeFilter((value: string) => value.startsWith("/")))
const Marker = Text.check(Schema.isMaxLength(48))
const Group = Schema.Struct({ id: Text, name: Marker })
const Scope = Schema.Struct({
  directory: Absolute,
  workspaceID: Text,
  ordinary: Schema.Array(Group).check(Schema.isMinLength(33), Schema.isMaxLength(64)),
  protected: Schema.Array(Group).check(Schema.isMinLength(3), Schema.isMaxLength(32)),
  selectedGroupID: Text,
  messages: Schema.Struct({
    ids: Schema.Array(Text).check(Schema.isLengthBetween(125, 125)),
    markers: Schema.Array(Marker).check(Schema.isLengthBetween(125, 125)),
    oldestMarker: Marker,
    newestMarker: Marker,
  }),
})
export const Input = Schema.Struct({
  version: Schema.Literal(1),
  window: Schema.Literal("ordinary-reader-registry-product"),
  createdAt: Schema.Int.check(Schema.isGreaterThan(0)),
  deadlineAt: Schema.Int.check(Schema.isGreaterThan(0)),
  root: Schema.Struct({ url: Text, authorizationFile: Absolute }),
  scopes: Schema.Struct({ A: Scope, B: Scope }),
  faults: Schema.Struct({
    state: Schema.Literal("unavailable"),
    reason: Text,
  }),
})
export type Input = typeof Input.Type

/** Observation inputs are supplied by the original backend fixture. They are
 * expected public facts, never an actor, permission, or a reader epoch. */
export function decode(value: unknown) {
  const input = Schema.decodeUnknownSync(Input)(value, { onExcessProperty: "error" })
  const url = new URL(input.root.url)
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.port || url.pathname !== "/" || url.username || url.password || url.search || url.hash)
    throw new Error("An original private loopback Root is required")
  if (input.deadlineAt <= input.createdAt || input.deadlineAt - input.createdAt > 900_000 ||
      input.scopes.A.directory === input.scopes.B.directory ||
      input.scopes.A.workspaceID === input.scopes.B.workspaceID)
    throw new Error("Two actual directory placements and a bounded window are required")
  const groupIDs = Object.values(input.scopes).flatMap((scope) => [...scope.ordinary, ...scope.protected].map((group) => group.id))
  if (new Set(groupIDs).size !== groupIDs.length) throw new Error("Directory group identities overlap")
  for (const scope of Object.values(input.scopes)) {
    const groups = [...scope.ordinary, ...scope.protected]
    if (new Set(groups.map((group) => group.name)).size !== groups.length ||
        !scope.protected.slice(2).some((group) => group.id === scope.selectedGroupID) ||
        new Set(scope.messages.ids).size !== 125 || new Set(scope.messages.markers).size !== 125 ||
        scope.messages.oldestMarker === scope.messages.newestMarker ||
        !scope.messages.markers.includes(scope.messages.oldestMarker) ||
        !scope.messages.markers.includes(scope.messages.newestMarker))
      throw new Error("Distinct off-page groups and 125 exact original messages are required")
  }
  return input
}

export async function prepare(filename: string, live = false) {
  const input = decode(await Bun.file(filename).json())
  const authorization = await IMMediaProductDescriptor.authorization(input.root.authorizationFile)
  if (live && (Date.now() < input.createdAt || Date.now() >= input.deadlineAt))
    throw new Error("The original backend window is not current")
  return { input, authorization }
}

export function safe(input: Input) {
  return { version: input.version, window: input.window, rootCount: 1, directoryCount: 2,
    ordinaryCounts: [input.scopes.A.ordinary.length, input.scopes.B.ordinary.length],
    protectedCounts: [input.scopes.A.protected.length, input.scopes.B.protected.length],
    messagesPerDirectory: 125, faultActions: input.faults.state,
    faultCoverage: "OPEN: original backend held-page, epoch replacement and cold-ready signals required" }
}
