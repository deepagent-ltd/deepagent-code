import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { SessionID, MessageID } from "./schema"
import { Config } from "@/config/config"

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

export const emptyManifest = (): Snapshot.DiffManifest => ({
  files: [],
  additions: 0,
  deletions: 0,
  totalFiles: 0,
  totalFilesExact: true,
  statisticsExact: true,
  includedFiles: 0,
  truncatedFiles: 0,
  manifestHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  completeness: "complete",
  truncationReasons: [],
})

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: SessionV1.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeManifest: (input: { messages: SessionV1.WithParts[] }) => Effect.Effect<Snapshot.DiffManifest>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service

    const snapshots = (messages: SessionV1.WithParts[]) => {
      let from: string | undefined
      let to: string | undefined
      for (const item of messages) {
        if (!from) {
          for (const part of item.parts) {
            if (part.type === "step-start" && part.snapshot) {
              from = part.snapshot
              break
            }
          }
        }
        for (const part of item.parts) {
          if (part.type === "step-finish" && part.snapshot) to = part.snapshot
        }
      }
      return { from, to }
    }

    const descriptor = (manifest: Snapshot.DiffManifest) => ({
      completeness: manifest.completeness,
      truncationReasons: [...manifest.truncationReasons],
      manifestHash: manifest.manifestHash,
      totalFiles: manifest.totalFiles,
      totalFilesExact: manifest.totalFilesExact,
      statisticsExact: manifest.statisticsExact,
      includedFiles: manifest.includedFiles,
      truncatedFiles: manifest.truncatedFiles,
    })

    const computeManifest = Effect.fn("SessionSummary.computeManifest")(function* (input: {
      messages: SessionV1.WithParts[]
    }) {
      const range = snapshots(input.messages)
      if (range.from && range.to) return yield* snapshot.diffManifest(range.from, range.to)
      return emptyManifest()
    })

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: SessionV1.WithParts[] }) {
      return (yield* computeManifest(input)).files.map((item) => {
        if (item.patch !== "") return item
        const { patch, ...metadata } = item
        return metadata
      })
    })

    const turnManifest = Effect.fn("SessionSummary.turnManifest")(function* (input: {
      sessionID: SessionID
      parentID: MessageID
    }) {
      const range = yield* sessions.turnSnapshotRange(input)
      if (range.from && range.to) return yield* snapshot.diffManifest(range.from, range.to)
      return emptyManifest()
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const empty = emptyManifest()
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: 0,
          deletions: 0,
          files: 0,
          diffManifest: descriptor(empty),
        },
      })
      yield* events.publish(Session.Event.Diff, {
        sessionID: input.sessionID,
        diff: [],
        manifest: descriptor(empty),
      })
      if ((yield* config.get()).snapshot === false) return
      const target = yield* sessions
        .getClientMessage({ sessionID: input.sessionID, messageID: input.messageID })
        .pipe(Effect.orDie)
      if (!target || target.info.role !== "user") return
      const manifest = yield* turnManifest({ sessionID: input.sessionID, parentID: target.info.id })
      const diffs = manifest.files.map((item) => {
        if (item.patch !== "") return item
        const { patch, ...metadata } = item
        return metadata
      })
      target.info.summary = { ...target.info.summary, diffs, diffManifest: descriptor(manifest) }
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: manifest.additions,
          deletions: manifest.deletions,
          files: manifest.totalFiles,
          diffManifest: descriptor(manifest),
        },
      })
      yield* events.publish(Session.Event.Diff, {
        sessionID: input.sessionID,
        diff: diffs,
        manifest: descriptor(manifest),
      })
      yield* sessions.updateMessage(target.info)
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      if (!input.messageID) return []
      const message = yield* sessions.getClientMessage({ sessionID: input.sessionID, messageID: input.messageID }).pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
        Effect.orDie,
      )
      if (!message || message.info.role !== "user") return []
      const diffs = message.info.summary?.diffs ?? []
      return diffs.map((item) => {
        const metadata = {
          ...(item.file === undefined ? {} : { file: item.file }),
          additions: item.additions,
          deletions: item.deletions,
          ...(item.status === undefined ? {} : { status: item.status }),
        } satisfies Snapshot.FileDiff
        if (item.file === undefined) return metadata
        const file = unquoteGitPath(item.file)
        if (file === item.file) return metadata
        return { ...metadata, file }
      })
    })

    return Service.of({ summarize, diff, computeDiff, computeManifest })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Config.defaultLayer),
  ),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export * as SessionSummary from "./summary"
