import { Effect, Layer, Context, Option, Schema } from "effect"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { Log } from "@deepagent-code/core/util/log"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"
import { KeyedMutex } from "@deepagent-code/core/effect/keyed-mutex"

const log = Log.create({ service: "session.revert" })
const mutationLocks = KeyedMutex.makeUnsafe<SessionID>()
const pageSize = 50

export class LimitError extends Schema.TaggedErrorClass<LimitError>()("SessionRevertLimitError", {
  sessionID: SessionID,
  maxFiles: Schema.Number,
}) {}

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
  /**
   * C2 notice gate (default on). Autonomous rollbacks (goal-loop liveRollback, oversight rollback)
   * pass false: the "user reverted" notice is only truthful for genuine user-initiated reverts, and
   * those paths publish their own actor-accurate notice (or none). Omitted from the HTTP payload.
   */
  notice: Schema.optional(Schema.Boolean),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError | LimitError>
  readonly unrevert: (input: {
    sessionID: SessionID
    notice?: boolean
  }) => Effect.Effect<Session.Info, Session.BusyError>
  readonly cleanup: (session: Session.Info, mutationEpoch?: number) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const state = yield* SessionRunState.Service

    const revertUnlocked = Effect.fn("SessionRevert.revertUnlocked")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const target = Option.getOrUndefined(
        yield* sessions
          .getClientMessage({ sessionID: input.sessionID, messageID: input.messageID })
          .pipe(Effect.option),
      )
      if (!target) return session
      const legacyUser =
        target.info.canonicalSeq === undefined
          ? (Option.getOrUndefined(
              yield* sessions
                .findMessage(
                  input.sessionID,
                  (message) =>
                    message.info.role === "user" &&
                    message.info.id <= input.messageID &&
                    // Revert itself publishes a user-shaped Synthetic notice. It is not a turn anchor.
                    (message.parts.length === 0 ||
                      message.parts.some((part) => part.type !== "text" || !part.synthetic)),
                )
                .pipe(Effect.orDie),
            )?.info as SessionV1.User | undefined)
          : undefined
      let lastUser = legacyUser
      if (target.info.canonicalSeq !== undefined) {
        let before: string | undefined
        while (true) {
          const page = yield* sessions
            .messagesPage({ sessionID: input.sessionID, limit: pageSize, before })
            .pipe(Effect.orDie)
          for (const message of page.items) {
            if (
              message.info.role !== "user" ||
              message.info.canonicalSeq === undefined ||
              message.info.canonicalSeq > target.info.canonicalSeq ||
              (lastUser?.canonicalSeq !== undefined && message.info.canonicalSeq <= lastUser.canonicalSeq) ||
              (message.parts.length > 0 && message.parts.every((part) => part.type === "text" && part.synthetic))
            )
              continue
            lastUser = message.info
          }
          if (!page.more || !page.cursor) break
          before = page.cursor
        }
        if (!lastUser) return session
      }
      const remaining = [] as SessionV1.Part[]
      let rev: Session.Info["revert"] | undefined
      const patches: Snapshot.Patch[] = []
      const files = new Set<string>()
      const collect = (part: SessionV1.Part) => {
        if (part.type !== "patch") return Effect.void
        const novel = part.files.filter((file) => !files.has(file))
        if (files.size + novel.length > Snapshot.DiffLimits.captureCandidateFiles)
          return Effect.fail(
            new LimitError({ sessionID: input.sessionID, maxFiles: Snapshot.DiffLimits.captureCandidateFiles }),
          )
        novel.forEach((file) => files.add(file))
        if (novel.length > 0) patches.push({ ...part, files: novel })
        return Effect.void
      }
      for (const part of target.parts) {
        if (rev) {
          yield* collect(part)
          continue
        }
        if (!input.partID || part.id === input.partID) {
          const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
          rev = {
            messageID: !partID && lastUser?.role === "user" ? lastUser.id : target.info.id,
            partID,
          }
        }
        remaining.push(part)
      }
      if (!rev) return session

      // A queued input keeps its admission time but joins history at promotion. Time cursors
      // still page the wire rows; only durable sequence decides which patches are later.
      let after =
        target.info.canonicalSeq === undefined
          ? MessageV2.cursor.encode({ id: target.info.id, time: target.info.time.created })
          : undefined
      const canonicalPatches = new Map<string, { seq: number; patch: Snapshot.Patch }>()
      while (true) {
        const page = yield* target.info.canonicalSeq === undefined
          ? sessions.messagesForwardPage({ sessionID: input.sessionID, limit: pageSize, after: after! })
          : sessions.messagesPage({ sessionID: input.sessionID, limit: pageSize, before: after }).pipe(Effect.orDie)
        for (const message of page.items) {
          if (
            target.info.canonicalSeq !== undefined &&
            (message.info.canonicalSeq === undefined || message.info.canonicalSeq <= target.info.canonicalSeq)
          )
            continue
          for (const part of message.parts) {
            if (target.info.canonicalSeq === undefined) {
              yield* collect(part)
              continue
            }
            if (part.type !== "patch") continue
            const novel = part.files.filter((file) => !files.has(file))
            const added = novel.filter((file) => !canonicalPatches.has(file))
            if (files.size + canonicalPatches.size + added.length > Snapshot.DiffLimits.captureCandidateFiles)
              return yield* new LimitError({
                sessionID: input.sessionID,
                maxFiles: Snapshot.DiffLimits.captureCandidateFiles,
              })
            for (const file of novel) {
              const previous = canonicalPatches.get(file)
              if (previous && previous.seq <= message.info.canonicalSeq!) continue
              canonicalPatches.set(file, { seq: message.info.canonicalSeq!, patch: { hash: part.hash, files: [file] } })
            }
          }
        }
        if (!page.more || !page.cursor) break
        after = page.cursor
      }
      patches.push(
        ...Array.from(canonicalPatches.values())
          .sort((a, b) => a.seq - b.seq)
          .map((item) => item.patch),
      )

      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* snap.revert(patches)
      const range = yield* sessions
        .snapshotRangeFromMessage({
          sessionID: input.sessionID,
          messageID: rev.messageID,
        })
        .pipe(Effect.orDie)
      const manifest =
        range.from && range.to ? yield* snap.diffManifest(range.from, range.to) : SessionSummary.emptyManifest()
      const descriptor = {
        completeness: manifest.completeness,
        truncationReasons: [...manifest.truncationReasons],
        manifestHash: manifest.manifestHash,
        totalFiles: manifest.totalFiles,
        totalFilesExact: manifest.totalFilesExact,
        statisticsExact: manifest.statisticsExact,
        includedFiles: manifest.includedFiles,
        truncatedFiles: manifest.truncatedFiles,
      }
      const diffs = manifest.files.map(
        (item) =>
          ({
            ...(item.file === undefined ? {} : { file: item.file }),
            additions: item.additions,
            deletions: item.deletions,
            ...(item.status === undefined ? {} : { status: item.status }),
          }) satisfies Snapshot.FileDiff,
      )
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* sessions.commitRevert({
        sessionID: input.sessionID,
        revert: rev,
        summary: {
          additions: manifest.additions,
          deletions: manifest.deletions,
          files: manifest.totalFiles,
          diffManifest: descriptor,
        },
        ...(input.notice === undefined ? {} : { notice: input.notice }),
      })
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: manifest.additions,
          deletions: manifest.deletions,
          files: manifest.totalFiles,
          diffManifest: descriptor,
        },
        diff: diffs,
      })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const unrevertUnlocked = Effect.fn("SessionRevert.unrevertUnlocked")(function* (input: {
      sessionID: SessionID
      notice?: boolean
    }) {
      log.info("unreverting", input)
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* sessions.commitUnrevert(input)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const cleanupUnlocked = Effect.fn("SessionRevert.cleanupUnlocked")(function* (
      session: Session.Info,
      mutationEpoch?: number,
    ) {
      if (!session.revert) return
      if (
        mutationEpoch !== undefined &&
        (yield* sessions.mutationEpoch(session.id).pipe(Effect.orDie)) !== mutationEpoch
      )
        return
      const current = yield* sessions.get(session.id).pipe(Effect.orDie)
      if (JSON.stringify(current.revert) !== JSON.stringify(session.revert)) return
      const sessionID = session.id
      const messageID = session.revert.messageID
      const boundary = Option.getOrUndefined(
        yield* sessions.getClientMessage({ sessionID, messageID }).pipe(Effect.option),
      )
      if (!boundary) return
      let target: SessionV1.WithParts | undefined
      let before: string | undefined
      while (true) {
        const page = yield* sessions.messagesPage({ sessionID, limit: pageSize, before }).pipe(Effect.orDie)
        const reachedTarget =
          boundary.info.canonicalSeq === undefined && page.items.some((message) => message.info.id <= messageID)
        for (const message of page.items) {
          if (
            boundary.info.canonicalSeq === undefined
              ? message.info.id < messageID
              : message.info.canonicalSeq === undefined || message.info.canonicalSeq < boundary.info.canonicalSeq
          )
            continue
          if (message.info.id === messageID && session.revert.partID) {
            target = message
            continue
          }
          yield* sessions.removeMessage({ sessionID, messageID: message.info.id })
        }
        if (reachedTarget || !page.more || !page.cursor) break
        before = page.cursor
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sessions.removePart({ sessionID, messageID: target.info.id, partID: part.id })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    const revert: Interface["revert"] = (input) => mutationLocks.withLock(input.sessionID)(revertUnlocked(input))
    const unrevert: Interface["unrevert"] = (input) => mutationLocks.withLock(input.sessionID)(unrevertUnlocked(input))
    const cleanup: Interface["cleanup"] = (session, mutationEpoch) =>
      mutationLocks.withLock(session.id)(cleanupUnlocked(session, mutationEpoch))

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

export * as SessionRevert from "./revert"
