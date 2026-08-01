export * as LocationIndexCoordinator from "./coordinator"

import { CodeGraph } from "@deepagent-code/core/code-intelligence/code-graph"
import { LocationIndexCoordination } from "@deepagent-code/core/context-federation/coordination"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import type { ProjectionKind, ProjectionSnapshotRevision } from "@deepagent-code/core/context-federation/reference"
import { RepoDocument } from "@deepagent-code/core/document-intelligence/repo-document"
import { LocationChangeJournal } from "@deepagent-code/core/location-index/change-journal"
import { LocationCommitLock } from "@deepagent-code/core/location-index/commit-lock"
import { Hash } from "@deepagent-code/core/util/hash"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { make as makeCodeStore } from "../code-intelligence/live-code-graph-store"
import { fileEntityId, fileProjection, indexWorkspace } from "../code-intelligence/typescript-workspace-adapter"
import { indexMarkdown } from "../document-intelligence/markdown-adapter"
import { make as makeDocumentStore } from "../document-intelligence/live-repo-document-store"
import { isRepoDocument, normalizeRelative, scan } from "./manifest"

const AdapterSet = { code: "ts-js-v1", repo_documents: "markdown-v1" } as const
const LeaseMs = 30_000

export class IndexError extends Schema.TaggedErrorClass<IndexError>()("LocationIndexCoordinator.IndexError", {
  projectionKind: Schema.Literals(["code", "repo_documents"]),
  reason: Schema.Literals(["build", "unstable", "not_initialized", "path"]),
}) {}

export interface Interface {
  readonly initialize: () => Effect.Effect<void, Error>
  readonly observe: (input: {
    readonly file: string
    readonly event: "add" | "change" | "unlink"
    readonly source?: "watcher" | "tool" | "editor" | "fresh_query"
    readonly observedAt?: number
  }) => Effect.Effect<void, Error>
  readonly observeRename: (input: {
    readonly previousFile: string
    readonly file: string
    readonly correlationId: string
    readonly source: "git" | "tool" | "reconciliation"
    readonly observedAt?: number
  }) => Effect.Effect<void, Error>
  readonly requestReconciliation: (input: {
    readonly reason: "checkout" | "overflow" | "reconcile"
    readonly source: "git" | "watcher" | "reconciliation" | "fresh_query"
    readonly observedAt?: number
  }) => Effect.Effect<void, Error>
  readonly drain: (projectionKind: ProjectionKind) => Effect.Effect<void, Error>
  readonly codeStatus: () => Effect.Effect<CodeGraph.IndexStatus, Error>
  readonly searchCode: (input: { readonly query: string; readonly limit: number }) => Effect.Effect<ReturnType<CodeGraph.Store["search"]>, Error>
  readonly codeNeighbors: (input: Parameters<CodeGraph.Store["neighbors"]>[0]) => Effect.Effect<ReturnType<CodeGraph.Store["neighbors"]>, Error>
  readonly searchDocuments: (input: { readonly query: string; readonly limit: number }) => Effect.Effect<ReturnType<RepoDocument.Store["search"]>, Error>
  readonly lookupDocuments: (input: Parameters<RepoDocument.Store["lookup"]>[0]) => Effect.Effect<ReturnType<RepoDocument.Store["lookup"]>, Error>
  readonly mutationEpoch?: () => Effect.Effect<number, Error>
  readonly pause: (projectionKind: ProjectionKind) => Effect.Effect<void, Error>
  readonly retire: (projectionKind: ProjectionKind) => Effect.Effect<void, Error>
}

export type Error =
  | IndexError
  | LocationIndexCoordination.Error
  | LocationChangeJournal.Error
  | LocationCommitLock.Error

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/LocationIndexCoordinator") {}

export function layer(config: {
  readonly identity: Identity
  readonly ownerId: string
  readonly indexDirectory: string
  readonly hooks?: {
    readonly afterCommit?: (projectionKind: ProjectionKind) => Effect.Effect<void, never, never>
  }
}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const coordination = yield* LocationIndexCoordination.Service
      const journal = yield* LocationChangeJournal.Service
      const lock = yield* LocationCommitLock.Service
      const state: {
        code?: CodeGraph.Store
        repo_documents?: RepoDocument.Store
        leases: Partial<Record<ProjectionKind, LocationIndexCoordination.Lease>>
        locators: Partial<Record<ProjectionKind, string>>
      } = { leases: {}, locators: {} }

      const commitKey = (projectionKind: ProjectionKind) => `${config.identity.indexSpaceId}:${projectionKind}`

      const indexLocator = (projectionKind: ProjectionKind, incarnation: number, suffix?: string) =>
        path.join(
          config.indexDirectory,
          `${Hash.sha256(`${config.identity.locationKey}:${projectionKind}`)}-v${incarnation}${suffix ? `-${suffix}` : ""}.sqlite`,
        )

      const openStore = (projectionKind: ProjectionKind, record: LocationIndexCoordination.Record) => {
        if (projectionKind === "code") {
          const store = makeCodeStore({
            filename: record.dbLocator,
            indexSpaceId: config.identity.indexSpaceId,
            indexIncarnation: record.indexIncarnation,
            canonicalRoot: config.identity.canonicalRoot,
            adapterSetVersion: AdapterSet.code,
          })
          state.code?.close()
          state.code = store
        } else {
          const store = makeDocumentStore({
            filename: record.dbLocator,
            indexSpaceId: config.identity.indexSpaceId,
            indexIncarnation: record.indexIncarnation,
            adapterSetVersion: AdapterSet.repo_documents,
          })
          state.repo_documents?.close()
          state.repo_documents = store
        }
        state.locators[projectionKind] = record.dbLocator
      }

      const acquire = Effect.fn("LocationIndexCoordinator.acquire")(function* (projectionKind: ProjectionKind) {
        yield* coordination.ensure({ identity: config.identity, projectionKind, dbLocator: indexLocator(projectionKind, 1) })
        const lease = yield* coordination
          .acquire({
            identity: config.identity,
            projectionKind,
            ownerId: config.ownerId,
            leaseMs: LeaseMs,
          })
          .pipe(lock.withExclusive(commitKey(projectionKind)))
        state.leases[projectionKind] = lease
        const registration = yield* journal.register({ indexSpaceId: config.identity.indexSpaceId, projectionKind })
        const opened = yield* Effect.try({
          try: () => openStore(projectionKind, lease),
          catch: () => new IndexError({ projectionKind, reason: "build" }),
        }).pipe(Effect.exit)
        if (Exit.isSuccess(opened)) return registration
        return yield* replaceDatabase(projectionKind, lease, registration)
      })

      const capture = (projectionKind: ProjectionKind, reconciliation: boolean) =>
        reconciliation
          ? journal.captureReconciliation({ indexSpaceId: config.identity.indexSpaceId, projectionKind })
          : journal.capture({ indexSpaceId: config.identity.indexSpaceId, projectionKind })

      const buildProjection = Effect.fn("LocationIndexCoordinator.buildProjection")(function* (projectionKind: ProjectionKind) {
        const manifest = yield* Effect.tryPromise({
          try: () => scan({ root: config.identity.canonicalRoot }),
          catch: () => new IndexError({ projectionKind, reason: "build" }),
        })
        return yield* Effect.try({
          try: () => projectionKind === "code"
            ? { projectionKind, build: indexWorkspace({ root: config.identity.canonicalRoot, files: manifest.files }) } as const
            : {
                projectionKind,
                documents: manifest.files.filter((file) => isRepoDocument(file.path)).flatMap(indexMarkdown),
              } as const,
          catch: () => new IndexError({ projectionKind, reason: "build" }),
        })
      })

      const replaceDatabase: (
        projectionKind: ProjectionKind,
        lease: LocationIndexCoordination.Lease,
        registration: LocationChangeJournal.Registration,
        attempt?: number,
      ) => Effect.Effect<LocationChangeJournal.Registration, Error> = Effect.fn("LocationIndexCoordinator.replaceDatabase")(
        function* (projectionKind, lease, registration, attempt = 0) {
          if (attempt >= 3) return yield* new IndexError({ projectionKind, reason: "unstable" })
          if (!registration.reconcileRequired) {
            yield* journal.append({
              indexSpaceId: config.identity.indexSpaceId,
              changeKind: "reconcile",
              source: "reconciliation",
            })
          }
          const reconciliation = registration.reconcileRequired
          const before = yield* capture(projectionKind, reconciliation)
          const projection = yield* buildProjection(projectionKind)
          const after = yield* capture(projectionKind, reconciliation)
          if (before.capturedEventSeq !== after.capturedEventSeq) {
            return yield* replaceDatabase(projectionKind, lease, after.registration, attempt + 1)
          }
          const nextIncarnation = lease.indexIncarnation + 1
          const locator = indexLocator(
            projectionKind,
            nextIncarnation,
            Hash.sha256(`${config.ownerId}:${Date.now()}:${attempt}`).slice(0, 12),
          )
          if (projection.projectionKind === "code") {
            const store = yield* Effect.try({
              try: () => makeCodeStore({
                filename: locator,
                indexSpaceId: config.identity.indexSpaceId,
                indexIncarnation: nextIncarnation,
                canonicalRoot: config.identity.canonicalRoot,
                adapterSetVersion: AdapterSet.code,
              }),
              catch: () => new IndexError({ projectionKind, reason: "build" }),
            })
            const nextLease = yield* Effect.gen(function* () {
              yield* coordination.validate({ lease })
              const current = yield* capture(projectionKind, reconciliation)
              if (current.capturedEventSeq !== after.capturedEventSeq) {
                return yield* new IndexError({ projectionKind, reason: "unstable" })
              }
              yield* Effect.try({
                try: () => store.fullCommit({
                  indexIncarnation: nextIncarnation,
                  fencingToken: lease.fencingToken + 1,
                  expectedGeneration: store.snapshot()?.generation ?? 0,
                  indexedAt: Date.now(),
                  build: { ...projection.build, aliases: aliases(after.events) },
                }),
                catch: () => new IndexError({ projectionKind, reason: "build" }),
              })
              return yield* coordination.replaceDatabase({ lease, dbLocator: locator })
            }).pipe(
              lock.withExclusive(commitKey(projectionKind)),
              Effect.onError(() => Effect.sync(() => store.close())),
            )
            state.code?.close()
            state.code = store
            state.leases.code = nextLease
            state.locators.code = locator
          } else {
            const store = yield* Effect.try({
              try: () => makeDocumentStore({
                filename: locator,
                indexSpaceId: config.identity.indexSpaceId,
                indexIncarnation: nextIncarnation,
                adapterSetVersion: AdapterSet.repo_documents,
              }),
              catch: () => new IndexError({ projectionKind, reason: "build" }),
            })
            const nextLease = yield* Effect.gen(function* () {
              yield* coordination.validate({ lease })
              const current = yield* capture(projectionKind, reconciliation)
              if (current.capturedEventSeq !== after.capturedEventSeq) {
                return yield* new IndexError({ projectionKind, reason: "unstable" })
              }
              yield* Effect.try({
                try: () => store.fullCommit({
                  indexIncarnation: nextIncarnation,
                  fencingToken: lease.fencingToken + 1,
                  expectedGeneration: store.snapshot()?.generation ?? 0,
                  indexedAt: Date.now(),
                  documents: projection.documents,
                }),
                catch: () => new IndexError({ projectionKind, reason: "build" }),
              })
              return yield* coordination.replaceDatabase({ lease, dbLocator: locator })
            }).pipe(
              lock.withExclusive(commitKey(projectionKind)),
              Effect.onError(() => Effect.sync(() => store.close())),
            )
            state.repo_documents?.close()
            state.repo_documents = store
            state.leases.repo_documents = nextLease
            state.locators.repo_documents = locator
          }
          yield* config.hooks?.afterCommit?.(projectionKind) ?? Effect.void
          if (reconciliation) {
            return yield* journal.markReconciled({
              indexSpaceId: config.identity.indexSpaceId,
              projectionKind,
              capturedEventSeq: after.capturedEventSeq,
            })
          }
          return yield* journal.acknowledge({
            indexSpaceId: config.identity.indexSpaceId,
            projectionKind,
            capturedEventSeq: after.capturedEventSeq,
          })
        },
      )

      const commitFull: (
        projectionKind: ProjectionKind,
        reconciliation: boolean,
        attempt?: number,
      ) => Effect.Effect<ProjectionSnapshotRevision, Error> = Effect.fn("LocationIndexCoordinator.commitFull")(function* (
        projectionKind: ProjectionKind,
        reconciliation: boolean,
        attempt = 0,
      ) {
        if (attempt >= 3) return yield* new IndexError({ projectionKind, reason: "unstable" })
        const before = yield* capture(projectionKind, reconciliation)
        const build = yield* buildProjection(projectionKind)
        const after = yield* capture(projectionKind, reconciliation)
        if (before.capturedEventSeq !== after.capturedEventSeq) {
          return yield* commitFull(projectionKind, reconciliation, attempt + 1)
        }
        const lease = state.leases[projectionKind]
        if (!lease) return yield* new IndexError({ projectionKind, reason: "not_initialized" })
        const committed = yield* Effect.gen(function* () {
          yield* coordination.validate({ lease })
          const current = yield* capture(projectionKind, reconciliation)
          if (current.capturedEventSeq !== after.capturedEventSeq) {
            return yield* new IndexError({ projectionKind, reason: "unstable" })
          }
          return yield* Effect.try({
            try: () => {
              if (build.projectionKind === "code") {
                const store = state.code
                if (!store) throw new Error("missing Code store")
                return store.fullCommit({
                  indexIncarnation: lease.indexIncarnation,
                  fencingToken: lease.fencingToken,
                  expectedGeneration: store.snapshot()?.generation ?? 0,
                  indexedAt: Date.now(),
                  build: { ...build.build, aliases: aliases(after.events) },
                })
              }
              const store = state.repo_documents
              if (!store) throw new Error("missing Repo Document store")
              return store.fullCommit({
                indexIncarnation: lease.indexIncarnation,
                fencingToken: lease.fencingToken,
                expectedGeneration: store.snapshot()?.generation ?? 0,
                indexedAt: Date.now(),
                documents: build.documents,
              })
            },
            catch: () => new IndexError({ projectionKind, reason: "build" }),
          })
        }).pipe(lock.withExclusive(commitKey(projectionKind)))
        yield* config.hooks?.afterCommit?.(projectionKind) ?? Effect.void
        if (reconciliation) {
          yield* journal.markReconciled({
            indexSpaceId: config.identity.indexSpaceId,
            projectionKind,
            capturedEventSeq: after.capturedEventSeq,
          })
        } else {
          yield* journal.acknowledge({
            indexSpaceId: config.identity.indexSpaceId,
            projectionKind,
            capturedEventSeq: after.capturedEventSeq,
          })
        }
        return committed
      })

      const commitDocumentsIncremental = Effect.fn("LocationIndexCoordinator.commitDocumentsIncremental")(function* (
        work: LocationChangeJournal.Work,
      ) {
        const lease = state.leases.repo_documents
        const store = state.repo_documents
        if (!lease || !store) return yield* new IndexError({ projectionKind: "repo_documents", reason: "not_initialized" })
        const files = yield* Effect.tryPromise({
          try: () => scan({ root: config.identity.canonicalRoot }),
          catch: () => new IndexError({ projectionKind: "repo_documents", reason: "build" }),
        })
        const changed = new Set(work.dirty.flatMap((item) => [item.path, ...(item.previousPath ? [item.previousPath] : [])]))
        const documents = files.files
          .filter((file) => changed.has(file.path) && isRepoDocument(file.path))
          .flatMap(indexMarkdown)
        yield* Effect.gen(function* () {
          yield* coordination.validate({ lease })
          const current = yield* journal.capture({ indexSpaceId: config.identity.indexSpaceId, projectionKind: "repo_documents" })
          if (current.capturedEventSeq !== work.capturedEventSeq) {
            return yield* new IndexError({ projectionKind: "repo_documents", reason: "unstable" })
          }
          yield* Effect.try({
            try: () => store.incrementalCommit({
              indexIncarnation: lease.indexIncarnation,
              fencingToken: lease.fencingToken,
              expectedGeneration: store.snapshot()?.generation ?? 0,
              indexedAt: Date.now(),
              documents,
              deletedPaths: [...changed],
            }),
            catch: () => new IndexError({ projectionKind: "repo_documents", reason: "build" }),
          })
        }).pipe(lock.withExclusive(commitKey("repo_documents")))
        yield* config.hooks?.afterCommit?.("repo_documents") ?? Effect.void
        yield* journal.acknowledge({
          indexSpaceId: config.identity.indexSpaceId,
          projectionKind: "repo_documents",
          capturedEventSeq: work.capturedEventSeq,
        })
      })

      const commitCodeIncremental = Effect.fn("LocationIndexCoordinator.commitCodeIncremental")(function* (
        work: LocationChangeJournal.Work,
      ) {
        const lease = state.leases.code
        const store = state.code
        if (!lease || !store) return yield* new IndexError({ projectionKind: "code", reason: "not_initialized" })
        const manifest = yield* Effect.tryPromise({
          try: () => scan({ root: config.identity.canonicalRoot }),
          catch: () => new IndexError({ projectionKind: "code", reason: "build" }),
        })
        const changed = new Set(work.dirty.flatMap((item) => [item.path, ...(item.previousPath ? [item.previousPath] : [])]))
        const semanticChange = [...changed].some((filePath) => /\.(?:[cm]?[jt]sx?)$/i.test(filePath))
        const build = yield* Effect.try({
          try: () => semanticChange
            ? indexWorkspace({ root: config.identity.canonicalRoot, files: manifest.files })
            : {
                files: manifest.files.filter((file) => changed.has(file.path)).map((file) => fileProjection(file)),
                externalEntities: [],
                edges: [],
                aliases: [],
              },
          catch: () => new IndexError({ projectionKind: "code", reason: "build" }),
        })
        yield* Effect.gen(function* () {
          yield* coordination.validate({ lease })
          const current = yield* journal.capture({ indexSpaceId: config.identity.indexSpaceId, projectionKind: "code" })
          if (current.capturedEventSeq !== work.capturedEventSeq) {
            return yield* new IndexError({ projectionKind: "code", reason: "unstable" })
          }
          yield* Effect.try({
            try: () => store.incrementalCommit({
              indexIncarnation: lease.indexIncarnation,
              fencingToken: lease.fencingToken,
              expectedGeneration: store.snapshot()?.generation ?? 0,
              indexedAt: Date.now(),
              files: build.files,
              deletedPaths: [...changed],
              externalEntities: build.externalEntities,
              edges: build.edges,
              aliases: aliases(work.events),
            }),
            catch: () => new IndexError({ projectionKind: "code", reason: "build" }),
          })
        }).pipe(lock.withExclusive(commitKey("code")))
        yield* config.hooks?.afterCommit?.("code") ?? Effect.void
        yield* journal.acknowledge({
          indexSpaceId: config.identity.indexSpaceId,
          projectionKind: "code",
          capturedEventSeq: work.capturedEventSeq,
        })
      })

      const initialize = Effect.fn("LocationIndexCoordinator.initialize")(function* () {
        yield* Effect.tryPromise(() => mkdir(config.indexDirectory, { recursive: true, mode: 0o700 })).pipe(Effect.orDie)
        const code = yield* acquire("code")
        const documents = yield* acquire("repo_documents")
        if (code.reconcileRequired || !state.code?.snapshot()) yield* commitFull("code", true)
        if (documents.reconcileRequired || !state.repo_documents?.snapshot()) yield* commitFull("repo_documents", true)
        if (!code.reconcileRequired) yield* drain("code")
        if (!documents.reconcileRequired) yield* drain("repo_documents")
      })

      const observe: Interface["observe"] = (input) =>
        Effect.gen(function* () {
          const relative = normalizeRelative(config.identity.canonicalRoot, input.file)
          if (!relative) return yield* new IndexError({ projectionKind: "code", reason: "path" })
          if (relative === ".git/HEAD") {
            yield* journal.append({
              indexSpaceId: config.identity.indexSpaceId,
              changeKind: "checkout",
              source: "git",
              observedAt: input.observedAt,
            })
            return
          }
          yield* journal.append({
            indexSpaceId: config.identity.indexSpaceId,
            path: relative,
            changeKind: input.event === "add" ? "create" : input.event === "unlink" ? "delete" : configPath(relative) ? "config" : "update",
            source: input.source ?? "watcher",
            observedAt: input.observedAt,
          })
        })

      const observeRename: Interface["observeRename"] = (input) =>
        Effect.gen(function* () {
          const previousPath = normalizeRelative(config.identity.canonicalRoot, input.previousFile)
          const filePath = normalizeRelative(config.identity.canonicalRoot, input.file)
          if (!previousPath || !filePath) return yield* new IndexError({ projectionKind: "code", reason: "path" })
          yield* journal.append({
            indexSpaceId: config.identity.indexSpaceId,
            path: filePath,
            previousPath,
            renameCorrelationId: input.correlationId,
            changeKind: "rename",
            source: input.source,
            observedAt: input.observedAt,
          })
        })

      const requestReconciliation: Interface["requestReconciliation"] = (input) =>
        journal.append({
          indexSpaceId: config.identity.indexSpaceId,
          changeKind: input.reason,
          source: input.source,
          observedAt: input.observedAt,
        }).pipe(Effect.asVoid)

      const drain: Interface["drain"] = (projectionKind) =>
        Effect.gen(function* () {
          const work = yield* journal.capture({ indexSpaceId: config.identity.indexSpaceId, projectionKind })
          if (work.dirty.length === 0) return
          const global = work.events.some((event) => ["checkout", "overflow", "reconcile", "config"].includes(event.changeKind))
          if (global) {
            yield* commitFull(projectionKind, false)
            return
          }
          if (projectionKind === "code") {
            yield* commitCodeIncremental(work).pipe(
              Effect.catchTag("LocationIndexCoordinator.IndexError", (error) =>
                error.reason === "unstable" ? drain(projectionKind) : Effect.fail(error),
              ),
            )
            return
          }
          yield* commitDocumentsIncremental(work).pipe(
            Effect.catchTag("LocationIndexCoordinator.IndexError", (error) =>
              error.reason === "unstable" ? drain(projectionKind) : Effect.fail(error),
            ),
          )
        })

      const refresh = Effect.fn("LocationIndexCoordinator.refresh")(function* (projectionKind: ProjectionKind) {
        const record = yield* coordination.get({ identity: config.identity, projectionKind })
        if (state.locators[projectionKind] !== record.dbLocator || state.leases[projectionKind]?.indexIncarnation !== record.indexIncarnation) {
          yield* Effect.try({
            try: () => openStore(projectionKind, record),
            catch: () => new IndexError({ projectionKind, reason: "build" }),
          })
        }
      })

      const codeStatus = () =>
        Effect.gen(function* () {
          yield* refresh("code")
          if (!state.code) return yield* new IndexError({ projectionKind: "code", reason: "not_initialized" })
          const work = yield* journal.capture({ indexSpaceId: config.identity.indexSpaceId, projectionKind: "code" })
          return state.code.status(work.dirty.length)
        }).pipe(lock.withShared(commitKey("code")))

      const searchCode: Interface["searchCode"] = (input) =>
        Effect.gen(function* () {
          yield* refresh("code")
          if (!state.code) return yield* new IndexError({ projectionKind: "code", reason: "not_initialized" })
          return state.code.search(input)
        }).pipe(lock.withShared(commitKey("code")))

      const codeNeighbors: Interface["codeNeighbors"] = (input) =>
        Effect.gen(function* () {
          yield* refresh("code")
          if (!state.code) return yield* new IndexError({ projectionKind: "code", reason: "not_initialized" })
          return state.code.neighbors(input)
        }).pipe(lock.withShared(commitKey("code")))

      const searchDocuments: Interface["searchDocuments"] = (input) =>
        Effect.gen(function* () {
          yield* refresh("repo_documents")
          if (!state.repo_documents) {
            return yield* new IndexError({ projectionKind: "repo_documents", reason: "not_initialized" })
          }
          return state.repo_documents.search(input)
        }).pipe(lock.withShared(commitKey("repo_documents")))

      const lookupDocuments: Interface["lookupDocuments"] = (input) =>
        Effect.gen(function* () {
          yield* refresh("repo_documents")
          if (!state.repo_documents) {
            return yield* new IndexError({ projectionKind: "repo_documents", reason: "not_initialized" })
          }
          return state.repo_documents.lookup(input)
        }).pipe(lock.withShared(commitKey("repo_documents")))

      const mutationEpoch = () =>
        Effect.all([
          journal.capture({ indexSpaceId: config.identity.indexSpaceId, projectionKind: "code" }),
          journal.capture({ indexSpaceId: config.identity.indexSpaceId, projectionKind: "repo_documents" }),
        ]).pipe(Effect.map((work) => Math.max(...work.map((item) => item.capturedEventSeq), 0)))

      const pause = (projectionKind: ProjectionKind) =>
        journal
          .setState({ indexSpaceId: config.identity.indexSpaceId, projectionKind, state: "paused" })
          .pipe(Effect.asVoid)
      const retire = (projectionKind: ProjectionKind) =>
        journal
          .setState({ indexSpaceId: config.identity.indexSpaceId, projectionKind, state: "retired" })
          .pipe(Effect.asVoid)

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.code?.close()
          state.repo_documents?.close()
        }),
      )
      return Service.of({
        initialize,
        observe,
        observeRename,
        requestReconciliation,
        drain,
        codeStatus,
        searchCode,
        codeNeighbors,
        searchDocuments,
        lookupDocuments,
        mutationEpoch,
        pause,
        retire,
      })
    }),
  )
}

function aliases(events: readonly LocationChangeJournal.Event[]): readonly CodeGraph.Alias[] {
  return events.flatMap((event) =>
    event.changeKind === "rename" && event.previousPath && event.renameCorrelationId
      ? [{
          fromEntityId: fileEntityId(event.previousPath),
          toEntityId: fileEntityId(event.path),
          reason: event.source === "git" ? "git_rename" as const : "trusted_rename" as const,
          evidence: event.renameCorrelationId,
        }]
      : [],
  )
}

function configPath(filePath: string) {
  return /(^|\/)(?:tsconfig|jsconfig)(?:\.[^/]*)?\.json$/.test(filePath) ||
    /(^|\/)(?:package|bun|deno)\.json$/.test(filePath)
}
