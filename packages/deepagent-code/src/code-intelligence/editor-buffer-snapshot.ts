export * as LiveEditorBufferSnapshot from "./editor-buffer-snapshot"

import { EditorBufferSnapshot } from "@deepagent-code/core/code-intelligence/editor-buffer"
import { LocationKey } from "@deepagent-code/core/context-federation/reference"
import { Hash } from "@deepagent-code/core/util/hash"
import { Context, Effect, Layer, Schema } from "effect"

const MaxBufferBytes = 2 * 1024 * 1024

export class InvalidSnapshotError extends Schema.TaggedErrorClass<InvalidSnapshotError>()(
  "EditorBufferSnapshot.InvalidSnapshotError",
  { reason: Schema.String },
) {}

export interface ControllerInterface {
  readonly publish: (input: {
    readonly locationKey: LocationKey
    readonly path: string
    readonly content: string
    readonly contentSha: string
    readonly documentVersion: number
    readonly observedAt?: number
    readonly visibility: "session" | "workspace"
    readonly sessionId?: string
  }) => Effect.Effect<EditorBufferSnapshot.Snapshot, InvalidSnapshotError>
  readonly remove: (input: {
    readonly locationKey: LocationKey
    readonly path: string
    readonly visibility: "session" | "workspace"
    readonly sessionId?: string
  }) => Effect.Effect<void>
  readonly markSaved: (input: {
    readonly locationKey: LocationKey
    readonly path: string
    readonly contentSha: string
  }) => Effect.Effect<void>
}

export class Controller extends Context.Service<Controller, ControllerInterface>()(
  "@deepagent-code/EditorBufferSnapshotController",
) {}

export function layer() {
  const snapshots = new Map<string, EditorBufferSnapshot.Snapshot>()
  const get: EditorBufferSnapshot.Interface["get"] = (input) =>
    Effect.sync(
      () =>
        snapshots.get(key(input.locationKey, input.path, "session", input.sessionId)) ??
        snapshots.get(key(input.locationKey, input.path, "workspace")),
    )
  const publish: ControllerInterface["publish"] = (input) =>
    Effect.gen(function* () {
      if (!validPath(input.path)) return yield* new InvalidSnapshotError({ reason: "path" })
      if (
        !Number.isSafeInteger(input.documentVersion) ||
        input.documentVersion < 0 ||
        Buffer.byteLength(input.content) > MaxBufferBytes ||
        Hash.sha256(input.content) !== input.contentSha ||
        (input.visibility === "session") !== Boolean(input.sessionId)
      ) {
        return yield* new InvalidSnapshotError({ reason: "contract" })
      }
      const identity = key(input.locationKey, input.path, input.visibility, input.sessionId)
      const current = snapshots.get(identity)
      if (current && input.documentVersion < current.documentVersion) {
        return yield* new InvalidSnapshotError({ reason: "stale_version" })
      }
      if (
        current &&
        input.documentVersion === current.documentVersion &&
        (current.contentSha !== input.contentSha || current.content !== input.content)
      ) {
        return yield* new InvalidSnapshotError({ reason: "version_conflict" })
      }
      const snapshot = Schema.decodeUnknownSync(EditorBufferSnapshot.Snapshot, { onExcessProperty: "error" })({
        ...input,
        observedAt: input.observedAt ?? Date.now(),
      })
      snapshots.set(identity, snapshot)
      return snapshot
    })
  const remove: ControllerInterface["remove"] = (input) =>
    Effect.sync(() => {
      snapshots.delete(key(input.locationKey, input.path, input.visibility, input.sessionId))
    })
  const markSaved: ControllerInterface["markSaved"] = (input) =>
    Effect.sync(() => {
      for (const [identity, snapshot] of snapshots) {
        if (snapshot.locationKey === input.locationKey && snapshot.path === input.path && snapshot.contentSha === input.contentSha) {
          snapshots.delete(identity)
        }
      }
    })
  return Layer.merge(
    Layer.succeed(EditorBufferSnapshot.Service, EditorBufferSnapshot.Service.of({ get })),
    Layer.succeed(Controller, Controller.of({ publish, remove, markSaved })),
  )
}

function key(locationKey: LocationKey, filePath: string, visibility: "session" | "workspace", sessionId?: string) {
  return `${locationKey}\u0000${filePath}\u0000${visibility}\u0000${sessionId ?? ""}`
}

function validPath(filePath: string) {
  return Boolean(filePath && !filePath.startsWith("/") && !filePath.includes("\\") && !filePath.split("/").includes(".."))
}
