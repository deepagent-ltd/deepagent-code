export * as EventWorkPlacementHost from "./event-work-placement"

import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { constants, watch } from "node:fs"
import { Cause, Context, Effect, Exit, Option, Schema, Scope } from "effect"
import { and, eq, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { KeyedMutex } from "@deepagent-code/core/effect/keyed-mutex"
import { EventWorkPlacement } from "@deepagent-code/core/deepagent/event-work-placement"
import { EventWorkNodeAuthority } from "@deepagent-code/core/deepagent/event-work-node-authority"
import { EventWorkDagPolicy } from "@deepagent-code/core/deepagent/event-work-dag.policy"
import { EventWorkController } from "@deepagent-code/core/deepagent/event-work-controller"
import { EventWorkResult } from "@deepagent-code/core/deepagent/event-work-result"
import { EventWorkDagSchema } from "@deepagent-code/core/deepagent/event-work-dag.schema"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { WorkWriteStage } from "@deepagent-code/core/session/work-write-stage"
import { WorkWriteStageTable } from "@deepagent-code/core/session/work-write-stage.sql"
import { WorkToolPolicy } from "@deepagent-code/core/session/work-tool-policy"
import { TaskWorkspace } from "@deepagent-code/core/session/task-workspace"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable, EventTaskWorkspaceTable } from "@deepagent-code/core/session/sql"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { fromRow } from "@deepagent-code/core/session/info"
import { Location } from "@deepagent-code/core/location"
import { Config } from "@deepagent-code/core/config"
import type { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { LocationIdentityTable, ProjectScopeIdentityTable, SecurityNamespaceTable } from "@deepagent-code/core/context-federation/sql"
import { WorkRouteApproval } from "@deepagent-code/core/session/work-route-approval"
import type { WorkRouteApprovalSchema } from "@deepagent-code/core/session/work-route-approval.schema"
import { EventWorkGit } from "@/session/event-work-git"
import { EventWorkArtifacts } from "@/session/event-work-artifacts"
import { NativeRuntime } from "./native-runtime"
import { WorkFileHelper } from "./work-file-helper"
import { EventWorkTree } from "./event-work-tree"

const failure = (unknown = false) => new WorkAuthoritySchema.Error({ code: unknown ? "WORK_RECOVERY_REQUIRED" : "PROFILE_UNAVAILABLE",
  message: "Original event worktree custody, native configuration or immutable artifact is unavailable or changed" })
const map = (error: unknown) => error instanceof WorkAuthoritySchema.Error ? error : failure(error instanceof EventWorkDagSchema.Error && error.code === "EVENT_DAG_UNKNOWN")
const hash = EventWorkDagPolicy.hash
const wire = (identity: WorkAuthoritySchema.ProjectBinding["projectScope"]["rootIdentity"]) => identity.kind === "posix"
  ? identity : { kind: "windows" as const, volume_serial: identity.volumeSerial, file_id: identity.fileID }
type DirectoryLease = { readonly current: Effect.Effect<void, WorkAuthoritySchema.Error>;
  readonly isCurrent: () => boolean; readonly close: Effect.Effect<void, WorkAuthoritySchema.Error> }
type Entry = { readonly description: EventWorkPlacement.Description; readonly root: WorkAuthoritySchema.ProjectBinding;
  readonly parent: DirectoryLease; readonly child: DirectoryLease; readonly purpose: NativeRuntime.PurposeReadiness;
  readonly tree: Effect.Success<ReturnType<typeof EventWorkTree.make>>; readonly git: Effect.Success<typeof EventWorkGit.capture>;
  readonly accountingOnly: boolean; artifact?: EventWorkDagSchema.ArtifactCustody; active: boolean; changed: boolean }

/** One original Root owns this registry and captures its existing Location map once after
 * SessionExecution construction. Locations cannot acquire a second Root through this port. */
export const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const native = yield* NativeRuntime.Service
  const lifetimeScope = yield* Scope.Scope
  const lifetime = { active: true, locations: undefined as Context.Service.Shape<typeof LocationServiceMap> | undefined }
  const entries = new WeakMap<EventWorkPlacement.Witness, Entry>()
  const byWork = new Map<string, EventWorkPlacement.Witness>()
  const configurations = new Map<string, { readonly service: Config.Interface; readonly witness: SessionRunnerModel.ConfigurationWitness;
    readonly parent: DirectoryLease; readonly child: DirectoryLease;
    readonly expiresAt: number; readonly purpose: NativeRuntime.PurposeReadiness }>()
  const readinessGit = yield* Effect.cached(EventWorkGit.capture.pipe(Effect.provideService(Scope.Scope, lifetimeScope)))
  const readiness = new Map<string, { readonly purpose: NativeRuntime.PurposeReadiness;
    readonly git?: Effect.Success<typeof EventWorkGit.capture> }>()
  const custody = yield* KeyedMutex.make<string>()
  const scopeOf = (root: WorkAuthoritySchema.ProjectBinding) => Effect.gen(function* () {
    const record = yield* WorkRouteApproval.get(database.db, root.provider.evidenceID).pipe(Effect.mapError(map))
    if (!record || record.evidenceHash !== root.provider.evidenceHash || record.evidence.configurationStamp !== root.provider.configurationHash ||
      record.evidence.canonicalRoot !== root.location.directory || record.evidence.locationKey !== root.projectScope.locationKey ||
      record.evidence.namespaceBindingHash !== root.projectScope.namespaceBindingHash) return yield* failure()
    const value = record.evidence
    return { instanceID: value.instanceID, operatorID: value.operatorID, targetID: value.targetID,
      securityNamespaceID: value.securityNamespaceID, projectScopeKey: value.projectScopeKey,
      locationKey: value.locationKey, canonicalRoot: value.canonicalRoot, namespaceBindingHash: value.namespaceBindingHash }
  })
  const current = (value: EventWorkPlacement.Witness) => Effect.suspend(() => {
    const entry = entries.get(value)
    return !lifetime.active || !entry?.active || entry.accountingOnly || entry.changed || !entry.parent.isCurrent() || !entry.child.isCurrent() ||
      entry.description.expiresAt <= Date.now() || !native.purposeCurrent(entry.purpose)
      ? Effect.fail(failure()) : Effect.void
  })
  const accountingCurrent = (value: EventWorkPlacement.Witness) => Effect.suspend(() => {
    const entry = entries.get(value)
    return !lifetime.active || !entry?.active || entry.changed || !entry.parent.isCurrent() || !entry.child.isCurrent() || !native.purposeCurrent(entry.purpose)
      ? Effect.fail(failure()) : Effect.void
  })
  const gitAllocation = (directory: string, baseCommit: string, commit: string, tree: Entry["tree"], git: Entry["git"], maxBytes: number) => Effect.gen(function* () {
    const common = yield* EventWorkGit.run({ directory, args: ["rev-parse", "--path-format=absolute", "--git-common-dir"] })
      .pipe(Effect.provideService(EventWorkGit.Current, git))
    const named = common.stdout.toString().trim()
    if (common.exitCode !== 0 || !path.isAbsolute(named) || /[\u0000-\u001f\u007f]/.test(named)) return yield* failure()
    const objects = yield* WorkFileHelper.inspectRoot(path.join(named, "objects")).pipe(Effect.mapError(map))
    const selected = yield* EventWorkGit.run({ directory, args: ["rev-list", "--objects", "--no-object-names", `${baseCommit}..${commit}`] })
      .pipe(Effect.provideService(EventWorkGit.Current, git))
    if (selected.exitCode !== 0) return yield* failure()
    return yield* tree.objectAllocation({ directory: path.join(named, "objects"), identity: wire(objects.rootIdentity),
      objects: selected.stdout.toString().trim().split("\n").filter(Boolean), maxBytes }).pipe(Effect.mapError(map))
  })
  const administrationAllocation = (directory: string, tree: Entry["tree"], git: Entry["git"]) => Effect.gen(function* () {
    if (!git.repository) return yield* failure()
    yield* git.repository.current.pipe(Effect.mapError(map))
    const pointer = yield* Effect.acquireRelease(Effect.tryPromise({ try: () => fs.open(path.join(directory, ".git"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
      catch: map }), (file) => Effect.promise(() => file.close()))
    const named = yield* Effect.tryPromise({ try: async () => {
      const before = await pointer.stat({ bigint: true })
      if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 8192n) throw failure()
      const bytes = Buffer.alloc(Number(before.size)); const count = await pointer.read(bytes, 0, bytes.length, 0)
      const parsed = /^gitdir: ([^\r\n\0]+)\n$/.exec(bytes.toString("utf8"))?.[1]
      const value = parsed && path.isAbsolute(parsed) ? process.platform === "win32" ? path.resolve(parsed) : parsed : undefined
      const after = await pointer.stat({ bigint: true }); const current = await fs.lstat(path.join(directory, ".git"), { bigint: true })
      const stamp = (metadata: typeof before) => [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs, metadata.nlink].join(":")
      if (!value || count.bytesRead !== bytes.length || stamp(before) !== stamp(after) || stamp(after) !== stamp(current) ||
        path.dirname(value) !== path.join(git.repository!.gitDirectory, "worktrees") || !path.basename(value).startsWith(path.basename(directory))) throw failure()
      return value
    }, catch: map })
    const actual = yield* WorkFileHelper.inspectRoot(named).pipe(Effect.mapError(map))
    yield* git.repository.current.pipe(Effect.mapError(map))
    return yield* tree.administrationAllocation({ directory: named, identity: wire(actual.rootIdentity) }).pipe(Effect.mapError(map))
  }).pipe(Effect.scoped)
  const captureLocations = (locations: Context.Service.Shape<typeof LocationServiceMap>) => Effect.suspend(() => {
    if (!lifetime.active || lifetime.locations && lifetime.locations !== locations) return Effect.fail(failure())
    lifetime.locations = locations
    return Effect.void
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    lifetime.active = false; readiness.clear(); configurations.clear()
    byWork.forEach((value) => { const entry = entries.get(value); if (entry) entry.active = false })
    byWork.clear()
  }))
  const context = (directory: string) => Effect.gen(function* () {
    if (!lifetime.active || !lifetime.locations) return yield* failure()
    return yield* lifetime.locations.contextEffect({ directory: AbsolutePath.make(directory) }).pipe(Effect.mapError(map))
  })
  const configured = (work: WorkAuthority.Work, scope: WorkRouteApprovalSchema.Scope, directory = work.binding.location.directory) => Effect.gen(function* () {
    const row = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make(work.session_id))).get()
    if (!row || work.binding.schemaVersion !== "work-execution.v2") return yield* failure()
    const location = yield* context(directory).pipe(Effect.tapCause((cause) => configuredDiagnostic("location", cause)))
    const actualLocation = Context.get(location, Location.Service)
    if (actualLocation.directory !== directory || actualLocation.workspaceID !== undefined || actualLocation.project.id !== work.binding.projectScope.projectID)
      return yield* failure()
    const resolved = yield* Context.get(location, SessionRunnerModel.Service).resolve(fromRow(row)).pipe(
      Effect.tapCause((cause) => configuredDiagnostic("model", cause)), Effect.mapError(map))
    const handle = yield* native.approve(resolved).pipe(Effect.provide(location),
      Effect.tapCause((cause) => configuredDiagnostic("native_approval", cause)), Effect.mapError(map))
    const configuration = yield* native.configuration(handle, scope).pipe(Effect.provide(location),
      Effect.tapCause((cause) => configuredDiagnostic("native_configuration", cause)), Effect.mapError(map))
    return { location, resolved, handle, configuration }
  })
  const inheritConfiguration = (parentRuntime: Effect.Success<ReturnType<typeof configured>>, root: WorkAuthoritySchema.ProjectBinding,
    directory: string, parentIdentity: EventWorkPlacement.Description["parentRootIdentity"], childIdentity: EventWorkPlacement.Description["childRootIdentity"],
    purpose: NativeRuntime.PurposeReadiness) => Effect.gen(function* () {
    const service = Context.get(parentRuntime.location, Config.Service)
    const documents = yield* service.entries()
    const witness = SessionRunnerModel.configuration(parentRuntime.resolved, service, documents)
    if (!witness || !SessionRunnerModel.configurationCurrent(witness) || !native.purposeCurrent(purpose) ||
      parentRuntime.configuration.configurationStamp !== root.provider.configurationHash || root.deadline <= Date.now()) return yield* failure()
    const existing = configurations.get(directory)
    if (existing && (existing.service !== service || !SessionRunnerModel.configurationCurrent(existing.witness))) return yield* failure()
    if (existing) return
    const parent = yield* retainDirectory(root.location.directory, parentIdentity)
    const child = yield* retainDirectory(directory, childIdentity)
    const entry = { service, witness, parent, child, expiresAt: root.deadline, purpose }
    configurations.set(directory, entry)
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      if (configurations.get(directory) === entry) configurations.delete(directory)
    }))
  })
  const configuration = (ref: Location.Ref) => Effect.gen(function* () {
    const entry = configurations.get(ref.directory)
    if (!entry) return undefined
    if (!lifetime.active || ref.workspaceID !== undefined || entry.expiresAt <= Date.now() || !entry.parent.isCurrent() || !entry.child.isCurrent() ||
      !SessionRunnerModel.configurationCurrent(entry.witness) || !native.purposeCurrent(entry.purpose)) return yield* failure()
    yield* entry.parent.current
    yield* entry.child.current
    return entry.service
  })
  const registered = (root: WorkAuthoritySchema.ProjectBinding, directory: string, locationKey: string) => database.db.transaction((tx) => Effect.gen(function* () {
    const namespace = yield* tx.select().from(SecurityNamespaceTable).where(eq(SecurityNamespaceTable.id, root.scope.securityNamespaceID)).get()
    const project = yield* tx.select().from(ProjectScopeIdentityTable).where(and(
      eq(ProjectScopeIdentityTable.security_namespace_id, root.scope.securityNamespaceID), eq(ProjectScopeIdentityTable.project_scope_key, root.scope.projectScopeKey))).get()
    if (!namespace || namespace.kind !== "implicit_local" || namespace.retired_at !== null || namespace.binding_hash !== root.projectScope.namespaceBindingHash ||
      !project || project.retired_at !== null || project.observed_project_id !== root.projectScope.projectID) return yield* failure()
    const existing = yield* tx.select().from(LocationIdentityTable).where(and(
      eq(LocationIdentityTable.security_namespace_id, root.scope.securityNamespaceID), eq(LocationIdentityTable.canonical_root, directory))).get()
    if (existing && (existing.location_key !== locationKey || existing.project_scope_key !== root.scope.projectScopeKey || existing.retired_at !== null ||
      existing.workspace_binding !== null || existing.observed_project_id !== root.projectScope.projectID)) return yield* failure()
    if (!existing) yield* tx.insert(LocationIdentityTable).values({ security_namespace_id: root.scope.securityNamespaceID, location_key: locationKey,
      project_scope_key: root.scope.projectScopeKey, canonical_root: directory, observed_project_id: root.projectScope.projectID, created_at: Date.now() }).run()
    return locationKey
  }), { behavior: "immediate" })
  const install = (description: EventWorkPlacement.Description, root: WorkAuthoritySchema.ProjectBinding,
    purpose: NativeRuntime.PurposeReadiness, tree: Entry["tree"], git: Entry["git"], accountingOnly = false) => Effect.gen(function* () {
    const parent = yield* retainDirectory(description.workspace.repositoryRoot, description.parentRootIdentity)
    const child = yield* retainDirectory(description.workspace.directory, description.childRootIdentity)
    const value = Object.freeze(Object.create(null)) as EventWorkPlacement.Witness
    const entry: Entry = { description, root, purpose, tree, git, parent, child, accountingOnly, active: true, changed: false }
    const observers = yield* Effect.acquireRelease(Effect.try({ try: () => [description.workspace.repositoryRoot, description.workspace.directory]
      .flatMap((directory) => [watch(directory, { persistent: false }, (event, name) => {
        if (event === "rename" && (name === null || name.toString() === ".git")) entry.changed = true
      }), watch(path.dirname(directory), { persistent: false }, (event, name) => {
        if (event === "rename" && (name === null || name.toString() === path.basename(directory))) entry.changed = true
      })]), catch: map }), (observers) => Effect.sync(() => observers.forEach((observer) => observer.close())))
    observers.forEach((observer) => observer.on("error", () => { entry.changed = true }))
    const prior = byWork.get(description.childWorkID)
    if (prior) {
      const original = entries.get(prior)
      if (!original || hash(original.description) !== hash(description) || hash(original.root) !== hash(root) ||
        original.git.hash !== git.hash || !native.purposeCurrent(purpose) || !accountingOnly && original.accountingOnly) return yield* failure()
      // Boot collection and a known-result reader may finish restoring the same Work
      // concurrently. Reuse only its original held witness, without upgrading a cold
      // accounting lease to execution authority or replacing its immutable custody.
      yield* accountingOnly ? accountingCurrent(prior) : current(prior)
      return { value: prior, installed: false, duplicateClosed: () => !parent.isCurrent() && !child.isCurrent() }
    }
    entries.set(value, entry); byWork.set(description.childWorkID, value)
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      entry.active = false; entries.delete(value)
      if (byWork.get(description.childWorkID) === value) byWork.delete(description.childWorkID)
    }))
    if (!accountingOnly) yield* current(value)
    return { value, installed: true, duplicateClosed: undefined }
  })
  const prepare = (input: { controllerID: string; nodeID: string; expectedRevision: number }) => {
    const diagnostic = { stage: "read_preparation" }
    return Effect.gen(function* () {
    const prepared = yield* EventWorkNodeAuthority.readPreparation(database.db, input)
    const root = prepared.rootWork.binding
    if (root.schemaVersion !== "work-execution.v2" || !EventWorkDagPolicy.requiresPlacement(prepared.controller.plan, prepared.node)) return yield* failure()
    const bound = yield* EventWorkNodeAuthority.get(database.db, prepared.identities.workID!)
    if (bound?.placement) {
      const prior = byWork.get(bound.childWorkID)
      if (prior) {
        yield* current(prior)
        if (hash(placement.describe(prior)) !== hash(bound.placement)) return yield* failure()
        return prior
      }
      return yield* restore(bound.placement)
    }
    diagnostic.stage = "native_purpose"
    const purpose = yield* native.requirePurpose("event_dag_write_v1").pipe(Effect.mapError(map))
    diagnostic.stage = "parent_native_identity"
    const original = yield* WorkFileHelper.inspectRoot(root.location.directory).pipe(Effect.mapError(map))
    if (original.helperHash !== root.projectScope.helperHash || hash(original.rootIdentity) !== hash(root.projectScope.rootIdentity)) return yield* failure()
    diagnostic.stage = "parent_git_custody"
    const git = yield* EventWorkGit.pinRepository(root.location.directory, yield* EventWorkGit.capture).pipe(Effect.mapError(map))
    const gitRoot = yield* WorkFileHelper.inspectRoot(git.repository.gitDirectory).pipe(Effect.mapError(map))
    if (gitRoot.helperHash !== original.helperHash) return yield* failure()
    const run = (directory: string, args: readonly string[], stdin?: Buffer) => EventWorkGit.run({ directory, args, stdin }).pipe(Effect.provideService(EventWorkGit.Current, git))
    const tree = yield* EventWorkTree.make(root.projectScope.helperHash).pipe(Effect.mapError(map))
    diagnostic.stage = "baseline_capture"
    const controller = yield* Effect.gen(function* () {
      const prior = prepared.controller.baseline
      if (prior?.state === "sealed") return prepared.controller
      if (prior) {
        if (prior.state === "preparing") yield* EventWorkController.markBaselineUnknown(database.db, {
          controllerID: prepared.controller.controllerID, preparingHash: hash(prior) }).pipe(Effect.mapError(map))
        return yield* failure(true)
      }
      const head = yield* run(root.location.directory, ["rev-parse", "--verify", "HEAD^{commit}"])
      if (head.exitCode !== 0) return yield* failure()
      const started = yield* EventWorkController.beginBaseline(database.db, { controllerID: prepared.controller.controllerID,
        nodeID: prepared.node.id, expectedRevision: prepared.controller.revision,
        originalCommit: head.stdout.toString().trim(), rootIdentity: original.rootIdentity,
        gitDirectory: git.repository.gitDirectory, gitRootIdentity: gitRoot.rootIdentity }).pipe(Effect.mapError(map))
      const baseline = started.controller.baseline
      if (!baseline || baseline.state !== "preparing") return yield* failure(true)
      return yield* Effect.gen(function* () {
        yield* tree.headroom({ directory: root.location.directory, identity: wire(original.rootIdentity),
          reservationBytes: EventWorkPlacement.BASELINE_CUSTODY_RESERVATION_BYTES }).pipe(Effect.mapError(map))
        const captured = yield* tree.observe({ directory: root.location.directory, identity: wire(original.rootIdentity),
          paths: [], baselineScope: root.toolPolicy.fileScope, expiresAt: root.deadline }).pipe(Effect.scoped, Effect.mapError(map))
        yield* tree.headroom({ directory: root.location.directory, identity: wire(original.rootIdentity),
          reservationBytes: EventWorkPlacement.BASELINE_CUSTODY_RESERVATION_BYTES, git: gitPlan(captured.leaves, 0) }).pipe(Effect.mapError(map))
        const base = yield* EventWorkArtifacts.read({ directory: root.location.directory, commit: baseline.originalCommit,
          scope: root.toolPolicy.fileScope, maxBytes: EventWorkPlacement.CLONE_RESERVATION_BYTES }).pipe(Effect.provideService(EventWorkGit.Current, git), Effect.mapError(map))
        const entries = yield* Effect.forEach(captured.leaves, (leaf) => run(root.location.directory, ["hash-object", "-w", "--stdin"], leaf.bytes).pipe(
          Effect.flatMap((result) => result.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(result.stdout.toString().trim())
            ? Effect.fail(failure(true)) : Effect.succeed({ relative: leaf.relative, bytes: leaf.bytes, mode: leaf.executable ? "100755" as const : "100644" as const,
                object: result.stdout.toString().trim(), sha256: createHash("sha256").update(leaf.bytes).digest("hex") }))))
        const built = yield* EventWorkGit.withPrivateIndex(Effect.gen(function* () {
          if (yield* indexTree(run, root.location.directory, baseline.originalCommit, base, entries)) return yield* failure(true)
          const index = yield* run(root.location.directory, ["write-tree"])
          if (index.exitCode !== 0) return yield* failure(true)
          const committed = yield* EventWorkGit.run({ directory: root.location.directory, args: ["commit-tree", index.stdout.toString().trim(),
            "-p", baseline.originalCommit, "-m", "DeepAgent Code event node artifact"], commitTime: baseline.startedAt }).pipe(Effect.provideService(EventWorkGit.Current, git))
          if (committed.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(committed.stdout.toString().trim())) return yield* failure(true)
          return { commit: committed.stdout.toString().trim(), indexBytes: yield* EventWorkGit.indexAllocation }
        })).pipe(Effect.provideService(EventWorkGit.Current, git))
        const commit = built.commit
        const gitBytes = yield* gitAllocation(root.location.directory, baseline.originalCommit, commit, tree, git,
          EventWorkPlacement.BASELINE_CUSTODY_RESERVATION_BYTES)
        if (gitBytes + built.indexBytes > EventWorkPlacement.BASELINE_CUSTODY_RESERVATION_BYTES) return yield* failure(true)
        const frozen = yield* EventWorkArtifacts.read({ directory: root.location.directory, commit, scope: root.toolPolicy.fileScope,
          maxBytes: EventWorkPlacement.CLONE_RESERVATION_BYTES }).pipe(Effect.provideService(EventWorkGit.Current, git), Effect.mapError(map))
        if (frozen.length !== captured.leaves.length || EventWorkArtifacts.manifest(frozen) !== captured.manifestSha256 ||
          frozen.reduce((bytes, item) => bytes + item.bytes.byteLength, 0) !== captured.bytes) return yield* failure(true)
        return (yield* EventWorkController.sealBaseline(database.db, { controllerID: started.controller.controllerID,
          nodeID: prepared.node.id, expectedRevision: started.controller.revision, preparingHash: hash(baseline), commit,
          manifestSha256: captured.manifestSha256, files: frozen.length, bytes: captured.bytes,
          allocatedBytes: gitBytes + built.indexBytes }).pipe(Effect.mapError(map))).controller
      }).pipe(Effect.tapError(() => EventWorkController.markBaselineUnknown(database.db, { controllerID: started.controller.controllerID,
        preparingHash: hash(baseline) }).pipe(Effect.catchCause(() => Effect.void))))
    })
    diagnostic.stage = "baseline_identity"
    const value = { ...prepared, controller }
    if (!controller.baseline || controller.baseline.state !== "sealed" || controller.baseline.scopeHash !== hash(root.toolPolicy.fileScope) ||
      controller.baseline.sourceHash !== prepared.receipt.authorityHash || hash(controller.baseline.rootIdentity) !== hash(original.rootIdentity) ||
      controller.baseline.gitDirectory !== git.repository.gitDirectory || hash(controller.baseline.gitRootIdentity) !== hash(gitRoot.rootIdentity)) return yield* failure(true)
    const baseCommit = controller.baseline.commit
    diagnostic.stage = "baseline_manifest"
    const base = yield* EventWorkArtifacts.read({ directory: root.location.directory, commit: baseCommit,
      scope: root.toolPolicy.fileScope, maxBytes: EventWorkPlacement.CLONE_RESERVATION_BYTES }).pipe(Effect.provideService(EventWorkGit.Current, git))
    if (EventWorkArtifacts.manifest(base) !== controller.baseline.manifestSha256 || base.length !== controller.baseline.files ||
      base.reduce((bytes, item) => bytes + item.bytes.byteLength, 0) !== controller.baseline.bytes) return yield* failure(true)
    diagnostic.stage = "predecessor_manifest"
    const selected = EventWorkDagPolicy.artifactPredecessors(value.controller.plan, value.node)
    const branches = yield* Effect.forEach(value.predecessors.filter((item) => selected.includes(item.terminal.nodeID) && item.terminal.workspaceCommit), (item) =>
      EventWorkArtifacts.read({ directory: root.location.directory, commit: item.terminal.workspaceCommit!, scope: root.toolPolicy.fileScope,
        maxBytes: EventWorkPlacement.CLONE_RESERVATION_BYTES }).pipe(Effect.provideService(EventWorkGit.Current, git)))
    const merged = EventWorkArtifacts.merge(base, branches)
    if (!merged.ok) return yield* failure()
    const materialized: { value?: Effect.Success<ReturnType<Entry["tree"]["materialize"]>> } = {}
    const eventGit: Context.Service.Shape<typeof TaskWorkspace.EventGit> = {
      ...(process.platform === "win32" ? { prepareParent: (repositoryRoot: string, parent: string) =>
        EventWorkGit.prepareParent(repositoryRoot, parent).pipe(Effect.provideService(EventWorkGit.Current, git),
          Effect.map((directory) => ({ outcome: "known" as const, directory })),
          Effect.catch(() => Effect.succeed({ outcome: "unknown" as const, directory: "" }))) } : {}),
      run: (directory, args) => run(directory, args).pipe(Effect.map((value) => ({ ...value, stdout: value.stdout.toString(), stderr: value.stderr.toString(), outcome: "known" as const })),
        Effect.catch((error) => Effect.succeed({ outcome: error.code === "EVENT_DAG_UNKNOWN" ? "unknown" as const : "known" as const,
          exitCode: 1, stdout: "", stderr: "" }))),
      materialize: (workspace) => Effect.gen(function* () {
        const actual = yield* WorkFileHelper.inspectRoot(workspace.directory)
        if (actual.helperHash !== original.helperHash) return { outcome: "known" as const, exitCode: 1, stdout: "", stderr: "" }
        materialized.value = yield* tree.materialize({ directory: workspace.directory, identity: wire(actual.rootIdentity),
          leaves: merged.entries.map((entry) => ({ relative: entry.relative, bytes: entry.bytes, executable: entry.mode === "100755" })), expiresAt: root.deadline }).pipe(Effect.scoped)
        return { outcome: "known" as const, exitCode: 0, stdout: "", stderr: "" }
      }).pipe(Effect.catch((error) => Effect.succeed({ outcome: error instanceof EventWorkDagSchema.Error && error.code === "EVENT_DAG_UNKNOWN" ? "unknown" as const : "known" as const,
        exitCode: 1, stdout: "", stderr: "" }))),
      settle: () => Effect.succeed({ outcome: "known" as const, exitCode: 1, stdout: "", stderr: "" }),
    }
    yield* tree.headroom({ directory: root.location.directory, identity: wire(original.rootIdentity),
      reservationBytes: EventWorkPlacement.WORKSPACE_CUSTODY_RESERVATION_BYTES }).pipe(Effect.mapError(map))
    diagnostic.stage = "workspace_materialize"
    const workspace = yield* TaskWorkspace.prepareEvent(database.db, { eventID: value.receipt.eventID, taskID: value.node.id,
      generation: 0, parentDirectory: root.location.directory, baseRef: baseCommit }).pipe(Effect.provideService(TaskWorkspace.EventGit, eventGit), Effect.mapError(map))
    diagnostic.stage = "workspace_row"
    const row = yield* database.db.select().from(EventTaskWorkspaceTable).where(and(eq(EventTaskWorkspaceTable.event_id, workspace.eventID),
      eq(EventTaskWorkspaceTable.task_id, workspace.taskID), eq(EventTaskWorkspaceTable.generation, 0))).get()
    if (!row || row.error !== null || row.state !== "ready" || row.base_commit !== baseCommit) return yield* failure()
    diagnostic.stage = "child_native_identity"
    const child = yield* WorkFileHelper.inspectRoot(workspace.directory).pipe(Effect.mapError(map))
    diagnostic.stage = "workspace_manifest"
    const observed = materialized.value ?? (yield* tree.observe({ directory: workspace.directory, identity: wire(child.rootIdentity),
      paths: merged.entries.map((item) => item.relative), expiresAt: root.deadline }).pipe(Effect.scoped, Effect.map((value) => ({
        files: value.leaves.length, bytes: value.bytes, manifestSha256: value.manifestSha256, allocatedBytes: value.allocatedBytes })), Effect.mapError(map)))
    if (observed.files !== merged.entries.length || observed.manifestSha256 !== EventWorkArtifacts.manifest(merged.entries) ||
      observed.bytes !== merged.entries.reduce((bytes, item) => bytes + item.bytes.byteLength, 0)) return yield* failure(true)
    diagnostic.stage = "workspace_administration"
    const administrationBytes = yield* administrationAllocation(workspace.directory, tree, git)
    const locationKey = `loc_evn_${hash([value.controller.receiptID, value.node.id, workspace.directory])}`
    diagnostic.stage = "location_registration"
    yield* registered(root, workspace.directory, locationKey)
    diagnostic.stage = "route_scope"
    const scope = yield* scopeOf(root)
    diagnostic.stage = "parent_configuration"
    const parentRuntime = yield* configured(value.rootWork, scope)
    yield* inheritConfiguration(parentRuntime, root, workspace.directory, original.rootIdentity, child.rootIdentity, purpose.readiness)
    diagnostic.stage = "child_configuration"
    const childRuntime = yield* configured(value.rootWork, { ...scope, canonicalRoot: workspace.directory, locationKey }, workspace.directory)
    diagnostic.stage = "configuration_inheritance"
    if (parentRuntime.configuration.configurationStamp !== root.provider.configurationHash ||
      parentRuntime.configuration.configuredTargetStamp !== childRuntime.configuration.configuredTargetStamp) return yield* failure()
    diagnostic.stage = "placement_description"
    const description = yield* Schema.decodeUnknownEffect(EventWorkPlacement.Description)({ version: 1, kind: "event_task_worktree_v1",
      controllerID: value.controller.controllerID, receiptID: value.controller.receiptID, eventID: value.receipt.eventID, nodeID: value.node.id,
      rootWorkID: root.workID, childWorkID: value.identities.workID!, childSessionID: value.identities.sessionID!, childInputID: value.identities.inputID!,
      rootBindingHash: value.rootWork.binding_hash, planHash: value.controller.planHash, rootRevision: value.rootWork.control_revision,
      controllerRevision: value.controller.revision, workspace: { ...workspace, immutableRowHash: EventWorkNodeAuthority.workspaceIdentityHash(row),
        files: observed.files, bytes: observed.bytes, manifestSha256: observed.manifestSha256, allocatedBytes: observed.allocatedBytes + administrationBytes },
      parentRootIdentity: original.rootIdentity, childRootIdentity: child.rootIdentity, projectID: root.projectScope.projectID,
      locationKey, namespaceBindingHash: root.projectScope.namespaceBindingHash, helperHash: original.helperHash, gitRuntimeHash: git.hash,
      configurationStamp: parentRuntime.configuration.configurationStamp, configuredTargetStamp: parentRuntime.configuration.configuredTargetStamp,
      childConfigurationStamp: childRuntime.configuration.configurationStamp, childConfiguredTargetStamp: childRuntime.configuration.configuredTargetStamp,
      observedAt: Date.now(), expiresAt: root.deadline }).pipe(Effect.mapError(map))
    diagnostic.stage = "placement_custody"
    return (yield* install(description, root, purpose.readiness, tree, git)).value
  }).pipe(Effect.provideService(Scope.Scope, lifetimeScope), Effect.catchCause((cause) => {
      const error = Option.getOrUndefined(Cause.findErrorOption(cause))
      return Effect.logWarning(`event_work_placement_preparation_refused ${JSON.stringify({ stage: diagnostic.stage,
        code: error instanceof WorkAuthoritySchema.Error || error instanceof EventWorkDagSchema.Error ? error.code : "UNCLASSIFIED" })}`)
        .pipe(Effect.andThen(Effect.failCause(cause)))
    }), Effect.mapError(map))
  }
  const restore = (description: EventWorkPlacement.Description, accountingOnly = false) => {
    const diagnostic = { stage: "authority" }
    return Effect.gen(function* () {
    const resources = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
    return yield* Effect.gen(function* () {
    const original = yield* EventWorkNodeAuthority.get(database.db, description.childWorkID)
    if (!original?.placement || hash(original.placement) !== hash(description)) return yield* failure()
    const controller = yield* database.db.transaction((tx) => EventWorkController.get(tx, description.controllerID)).pipe(Effect.mapError(map))
    const baseline = controller?.controller.baseline
    if (!baseline || baseline.state !== "sealed" || baseline.commit !== description.workspace.baseCommit ||
      baseline.sourceHash !== controller.receipt.authorityHash || baseline.scopeHash !== hash(original.rootBinding.toolPolicy.fileScope)) return yield* failure(true)
    diagnostic.stage = "native_purpose"
    const purpose = yield* native.requirePurpose("event_dag_write_v1").pipe(Effect.mapError(map))
    diagnostic.stage = "root_identity"
    const parent = yield* WorkFileHelper.inspectRoot(description.workspace.repositoryRoot).pipe(Effect.mapError(map))
    const child = yield* WorkFileHelper.inspectRoot(description.workspace.directory).pipe(Effect.mapError(map))
    if (parent.helperHash !== description.helperHash || child.helperHash !== description.helperHash || hash(parent.rootIdentity) !== hash(description.parentRootIdentity) ||
      hash(child.rootIdentity) !== hash(description.childRootIdentity)) return yield* failure()
    diagnostic.stage = "git_capture"
    const git = yield* EventWorkGit.pinRepository(description.workspace.repositoryRoot, yield* EventWorkGit.capture).pipe(Effect.mapError(map))
    const gitRoot = yield* WorkFileHelper.inspectRoot(git.repository.gitDirectory).pipe(Effect.mapError(map))
    if (gitRoot.helperHash !== description.helperHash) return yield* failure()
    if (baseline.gitDirectory !== git.repository.gitDirectory || hash(baseline.gitRootIdentity) !== hash(gitRoot.rootIdentity)) return yield* failure(true)
    if (git.hash !== description.gitRuntimeHash) return yield* failure()
    diagnostic.stage = "signed_tree"
    const tree = yield* EventWorkTree.make(description.helperHash).pipe(Effect.mapError(map))
    diagnostic.stage = "baseline_manifest"
    const frozen = yield* EventWorkArtifacts.read({ directory: description.workspace.repositoryRoot, commit: baseline.commit,
      scope: original.rootBinding.toolPolicy.fileScope, maxBytes: EventWorkPlacement.CLONE_RESERVATION_BYTES })
      .pipe(Effect.provideService(EventWorkGit.Current, git), Effect.mapError(map))
    if (frozen.length !== baseline.files || EventWorkArtifacts.manifest(frozen) !== baseline.manifestSha256 ||
      frozen.reduce((bytes, item) => bytes + item.bytes.byteLength, 0) !== baseline.bytes) return yield* failure(true)
    diagnostic.stage = "worktree_listing"
    const listed = yield* EventWorkGit.run({ directory: description.workspace.repositoryRoot, args: ["worktree", "list", "--porcelain"] })
      .pipe(Effect.provideService(EventWorkGit.Current, git), Effect.mapError(map))
    const block = listed.stdout.toString().split("\n\n").find((value) => {
      if (process.platform !== "win32") return value.startsWith(`worktree ${description.workspace.directory}\n`)
      const directory = value.split("\n")[0]?.slice("worktree ".length)
      return value.startsWith("worktree ") && !!directory && path.isAbsolute(directory) && path.resolve(directory) === description.workspace.directory
    })
    if (listed.exitCode !== 0 || !block?.split("\n").includes(`branch refs/heads/${description.workspace.branch}`)) return yield* failure()
    const row = yield* database.db.select().from(EventTaskWorkspaceTable).where(and(eq(EventTaskWorkspaceTable.event_id, description.eventID),
      eq(EventTaskWorkspaceTable.task_id, description.nodeID), eq(EventTaskWorkspaceTable.generation, 0))).get()
    if (!row || row.error !== null && !(accountingOnly && original.artifactCustody && row.error === "formal_physical_unknown") || row.state !== "ready" && row.state !== "retained" &&
      !(accountingOnly && row.state === "reclaimed" && original.artifactCustody?.cleanup?.state === "collected") ||
      EventWorkNodeAuthority.workspaceIdentityHash(row) !== description.workspace.immutableRowHash ||
      !block.includes(`\nHEAD ${row.state !== "ready" ? row.continuation_ref : accountingOnly && original.artifactCustody ? original.artifactCustody.commit : row.base_commit}\n`)) return yield* failure(true)
    diagnostic.stage = "configuration"
    if (!accountingOnly) {
      const parentWork = yield* WorkAuthority.get(database.db, description.rootWorkID)
      if (!parentWork || parentWork.binding_hash !== description.rootBindingHash) return yield* failure()
      const parentRuntime = yield* configured(parentWork, yield* scopeOf(original.rootBinding))
      if (parentRuntime.configuration.configurationStamp !== description.configurationStamp ||
        parentRuntime.configuration.configuredTargetStamp !== description.configuredTargetStamp) return yield* failure()
      yield* inheritConfiguration(parentRuntime, original.rootBinding, description.workspace.directory,
        description.parentRootIdentity, description.childRootIdentity, purpose.readiness)
    }
    diagnostic.stage = "held_install"
    return yield* install(description, original.rootBinding, purpose.readiness, tree, git, accountingOnly)
    }).pipe(Effect.provideService(Scope.Scope, resources), Effect.onExit((exit) => {
      if (Exit.isFailure(exit)) return Scope.close(resources, exit)
      if (exit.value.installed) return Effect.void
      return Scope.close(resources, exit).pipe(Effect.andThen(Effect.gen(function* () {
        if (!exit.value.duplicateClosed?.()) return yield* failure()
        yield* accountingOnly ? accountingCurrent(exit.value.value) : current(exit.value.value)
        yield* Effect.logInfo(`event_work_placement_restore_reused ${JSON.stringify({ nodeID: description.nodeID,
          originalWitnessReused: true, duplicateResourcesClosed: true, accountingOnly })}`)
      })))
    }), Effect.map((result) => result.value))
    }).pipe(Effect.tapCause((cause) => {
      const error = Cause.squash(cause)
      return Effect.logWarning(`event_work_placement_restore_refused ${JSON.stringify({ stage: diagnostic.stage,
        code: error instanceof WorkAuthoritySchema.Error || error instanceof EventWorkDagSchema.Error || error instanceof NativeRuntime.Error ? error.code : "UNCLASSIFIED" })}`)
    }))
  }
  const approve = (work: WorkAuthority.Work, resolved: SessionRunnerModel.ResolvedModel) => Effect.gen(function* () {
    const value = byWork.get(work.work_id)
    const entry = value ? entries.get(value) : undefined
    if (!entry || !value) return yield* failure()
    yield* current(value)
    yield* entry.parent.current
    yield* entry.child.current
    const parent = yield* WorkAuthority.get(database.db, entry.description.rootWorkID)
    if (!parent || parent.binding_hash !== entry.description.rootBindingHash) return yield* failure()
    const scope = yield* scopeOf(entry.root)
    const original = yield* configured(parent, scope)
    return yield* native.approveDerived({ parent: original.handle, parentConfiguration: original.configuration,
      resolved, placement: value, scope }).pipe(Effect.provideService(EventWorkPlacement.Service, placement), Effect.mapError(map))
  })
  const settleHeld = (value: EventWorkPlacement.Witness) => Effect.gen(function* () {
    const entry = entries.get(value)
    if (!lifetime.active || !entry?.active || entry.changed || !entry.parent.isCurrent() || !entry.child.isCurrent()) return yield* failure()
    yield* entry.parent.current
    yield* entry.child.current
    const description = entry.description
    const work = yield* WorkAuthority.get(database.db, description.childWorkID)
    const authority = yield* EventWorkNodeAuthority.get(database.db, description.childWorkID)
    if (!work || !authority?.placement || hash(authority.placement) !== hash(description) || work.binding_hash !== authority.childBindingHash ||
      work.binding.schemaVersion !== "work-execution.v2" || work.outcome !== "succeeded" && work.outcome !== "failed") return yield* failure()
    yield* EventWorkResult.prepareTerminal(database.db, work.work_id).pipe(Effect.mapError(map))
    yield* database.db.transaction((tx) => EventWorkResult.requireKnownExecution(tx, work.work_id)).pipe(Effect.mapError(map))
    const run = (directory: string, args: readonly string[], stdin?: Buffer) => EventWorkGit.run({ directory, args, stdin }).pipe(Effect.provideService(EventWorkGit.Current, entry.git))
    const row = yield* database.db.select().from(EventTaskWorkspaceTable).where(and(eq(EventTaskWorkspaceTable.event_id, description.eventID),
      eq(EventTaskWorkspaceTable.task_id, description.nodeID), eq(EventTaskWorkspaceTable.generation, 0))).get()
    if (!row || row.error !== null && !(authority.artifactCustody && row.error === "formal_physical_unknown") ||
      EventWorkNodeAuthority.workspaceIdentityHash(row) !== description.workspace.immutableRowHash) return yield* failure()
    if (authority.artifactCustody) {
      const artifact = authority.artifactCustody
      const head = yield* run(row.repository_root, ["rev-parse", `refs/heads/${row.branch}`])
      if (head.exitCode !== 0 || head.stdout.toString().trim() !== artifact.commit) return yield* failure(true)
      const frozen = yield* EventWorkArtifacts.read({ directory: row.repository_root, commit: artifact.commit,
        scope: entry.root.toolPolicy.fileScope, maxBytes: EventWorkPlacement.CLONE_RESERVATION_BYTES }).pipe(Effect.provideService(EventWorkGit.Current, entry.git))
      const allocation = yield* gitAllocation(row.repository_root, row.base_commit, artifact.commit, entry.tree, entry.git,
        EventWorkPlacement.WORKSPACE_CUSTODY_RESERVATION_BYTES)
      if (EventWorkArtifacts.manifest(frozen) !== artifact.manifestSha256 || frozen.length !== artifact.files ||
        frozen.reduce((bytes, item) => bytes + item.bytes.byteLength, 0) !== artifact.bytes || allocation > artifact.gitAllocatedBytes) return yield* failure(true)
      entry.artifact = artifact
      yield* database.db.transaction((tx) => EventWorkNodeAuthority.reconcileArtifact(tx, { workID: work.work_id, witness: value }), { behavior: "immediate" })
        .pipe(Effect.provideService(EventWorkPlacement.Service, placement), Effect.mapError(map))
      return { commit: artifact.commit, continuationRef: artifact.commit }
    }
    if (row.state !== "ready") return yield* failure()
    const base = yield* EventWorkArtifacts.read({ directory: row.repository_root, commit: row.base_commit,
      scope: entry.root.toolPolicy.fileScope, maxBytes: EventWorkPlacement.CLONE_RESERVATION_BYTES }).pipe(Effect.provideService(EventWorkGit.Current, entry.git))
    const stages = yield* database.db.select({ admissionID: WorkWriteStageTable.admission_id }).from(WorkWriteStageTable)
      .where(eq(WorkWriteStageTable.work_id, work.work_id)).all()
    const published = yield* Effect.forEach(stages, (stage) => WorkWriteStage.get(database.db, stage.admissionID).pipe(Effect.mapError(map)))
    if (published.some((stage) => !stage || stage.bindingHash !== work.binding_hash || stage.workID !== work.work_id ||
      stage.state !== "published" && stage.state !== "refused" || hash(stage.rootIdentity) !== hash(description.childRootIdentity))) return yield* failure()
    // A complete namespace must be composed solely of the committed approved view and
    // original known publications. Foreign/untracked command outputs cannot become refs.
    const paths = [...new Set([...base.map((item) => item.relative), ...published.filter((stage) => stage?.state === "published")
      .map((stage) => stage!.relative)])].sort()
    const controller = yield* database.db.transaction((tx) => EventWorkController.get(tx, description.controllerID)).pipe(Effect.mapError(map))
    const node = controller?.controller.plan.nodes.find((item) => item.id === description.nodeID)
    if (!controller || !node) return yield* failure()
    const selected = EventWorkDagPolicy.artifactPredecessors(controller.controller.plan, node)
    const priorTrees = yield* Effect.forEach(authority.predecessorRefs.filter((item) => selected.includes(item.nodeID) && item.workspaceCommit), (item) =>
      EventWorkArtifacts.read({ directory: row.repository_root, commit: item.workspaceCommit!, scope: entry.root.toolPolicy.fileScope,
        maxBytes: EventWorkPlacement.CLONE_RESERVATION_BYTES }).pipe(Effect.provideService(EventWorkGit.Current, entry.git)))
    const initial = EventWorkArtifacts.merge(base, priorTrees)
    if (!initial.ok || EventWorkArtifacts.manifest(initial.entries) !== description.workspace.manifestSha256) return yield* failure(true)
    const expectedPaths = [...new Set([...paths, ...priorTrees.flatMap((tree) => tree.map((item) => item.relative))])].sort()
    const observed = yield* entry.tree.observe({ directory: row.directory, identity: wire(description.childRootIdentity), paths: expectedPaths,
      expiresAt: Date.now() + 180_000 }).pipe(Effect.scoped, Effect.mapError(map))
    const administrationBytes = yield* administrationAllocation(row.directory, entry.tree, entry.git)
    const writes = yield* database.db.transaction((tx) => Effect.gen(function* () {
      const effects = yield* tx.all<{ effect_id: string }>(sql`SELECT e.effect_id FROM session_v2_tool_effect e
        JOIN session_v2_tool_effect_admission a ON a.session_id=e.session_id AND a.receipt_id=e.receipt_id
          AND a.provider_attempt_id=e.provider_attempt_id AND a.tool_call_id=e.tool_call_id AND a.owner_token=e.owner_token
        JOIN work_write_stage s ON s.admission_id=a.admission_id WHERE s.work_id=${work.work_id} AND s.state='published'
          AND e.tool_name='write' AND e.state='settled' AND e.error_code IS NULL LIMIT 129`)
      const proof = yield* Effect.serviceOption(WorkToolPolicy.LeafProof)
      if (effects.length > 128 || effects.length && (Option.isNone(proof) || !proof.value.requireEventTerminal)) return yield* failure()
      if (Option.isNone(proof)) return []
      return yield* Effect.forEach(effects, (item) => proof.value.requireEventTerminal!(item.effect_id).pipe(Effect.flatMap((known) =>
        known.toolID === "write" && known.outcome === "published" && known.fileIdentity !== null && known.workID === work.work_id &&
          known.bindingHash === work.binding_hash ? Effect.succeed(known) : Effect.fail(failure()))))
    }))
    if (writes.length !== published.filter((stage) => stage?.state === "published").length) return yield* failure()
    for (const leaf of observed.leaves) {
      const modifications = writes.filter((write) => write.relative === leaf.relative)
      const last = modifications.filter((write) => !modifications.some((next) => next.admissionID !== write.admissionID &&
        next.expected.kind === "observed" && hash(next.expected.identity) === hash(write.fileIdentity)))
      const before = initial.entries.find((item) => item.relative === leaf.relative)
      const bodyHash = createHash("sha256").update(leaf.bytes).digest("hex")
      if (modifications.length ? last.length !== 1 || hash(wire(last[0]!.fileIdentity!)) !== hash(leaf.identity) ||
        last[0]!.nextHash !== bodyHash || last[0]!.nextBytes !== leaf.bytes.byteLength || leaf.executable
        : !before || before.sha256 !== bodyHash || (before.mode === "100755") !== leaf.executable) return yield* failure(true)
    }
    yield* entry.tree.headroom({ directory: row.repository_root, identity: wire(description.parentRootIdentity),
      reservationBytes: EventWorkPlacement.WORKSPACE_CUSTODY_RESERVATION_BYTES,
      git: gitPlan(observed.leaves, observed.allocatedBytes + administrationBytes) }).pipe(Effect.mapError(map))
    const objects = yield* Effect.forEach(observed.leaves, (leaf) => EventWorkGit.run({ directory: row.repository_root,
      args: ["hash-object", "-w", "--stdin"], stdin: leaf.bytes }).pipe(Effect.provideService(EventWorkGit.Current, entry.git),
      Effect.flatMap((result) => result.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(result.stdout.toString().trim())
        ? Effect.fail(failure(true)) : Effect.succeed({ relative: leaf.relative, mode: leaf.executable ? "100755" as const : "100644" as const,
            object: result.stdout.toString().trim(), bytes: leaf.bytes, sha256: createHash("sha256").update(leaf.bytes).digest("hex") }))))
    const port: Context.Service.Shape<typeof TaskWorkspace.EventGit> = {
      run: (directory, args) => run(directory, args).pipe(Effect.map((result) => ({ outcome: "known" as const, exitCode: result.exitCode,
        stdout: result.stdout.toString(), stderr: result.stderr.toString() })), Effect.catch((error) => Effect.succeed({
          outcome: error.code === "EVENT_DAG_UNKNOWN" ? "unknown" as const : "known" as const, exitCode: 1, stdout: "", stderr: "" }))),
      materialize: () => Effect.succeed({ outcome: "known" as const, exitCode: 1, stdout: "", stderr: "" }),
      settle: (workspace) => Effect.gen(function* () {
        const head = yield* run(workspace.repositoryRoot, ["rev-parse", `refs/heads/${workspace.branch}`])
        if (head.exitCode !== 0 || head.stdout.toString().trim() !== workspace.baseCommit) return yield* failure()
        const built = yield* EventWorkGit.withPrivateIndex(Effect.gen(function* () {
          if (yield* indexTree(run, workspace.repositoryRoot, workspace.baseCommit, base, objects)) return yield* failure(true)
          const tree = yield* run(workspace.repositoryRoot, ["write-tree"])
          if (tree.exitCode !== 0) return yield* failure(true)
          const commit = yield* EventWorkGit.run({ directory: workspace.repositoryRoot,
            args: ["commit-tree", tree.stdout.toString().trim(), "-p", workspace.baseCommit, "-m", "DeepAgent Code event node artifact"],
            commitTime: work.updated_at }).pipe(Effect.provideService(EventWorkGit.Current, entry.git))
          const oid = commit.stdout.toString().trim()
          if (commit.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(oid)) return yield* failure(true)
          return { oid, indexBytes: yield* EventWorkGit.indexAllocation }
        })).pipe(Effect.provideService(EventWorkGit.Current, entry.git))
        const oid = built.oid
        const frozen = yield* EventWorkArtifacts.read({ directory: workspace.repositoryRoot, commit: oid,
          scope: entry.root.toolPolicy.fileScope, maxBytes: EventWorkPlacement.CLONE_RESERVATION_BYTES }).pipe(Effect.provideService(EventWorkGit.Current, entry.git))
        if (EventWorkArtifacts.manifest(frozen) !== observed.manifestSha256 || frozen.length !== observed.leaves.length ||
          frozen.reduce((bytes, item) => bytes + item.bytes.byteLength, 0) !== observed.bytes) return yield* failure(true)
        const gitBytes = yield* gitAllocation(workspace.repositoryRoot, workspace.baseCommit, oid, entry.tree, entry.git,
          EventWorkPlacement.WORKSPACE_CUSTODY_RESERVATION_BYTES)
        entry.artifact = yield* Schema.decodeUnknownEffect(EventWorkDagSchema.ArtifactCustody)({ version: 1, commit: oid,
          manifestSha256: observed.manifestSha256, files: observed.leaves.length, bytes: observed.bytes,
          worktreeAllocatedBytes: observed.allocatedBytes + administrationBytes, gitAllocatedBytes: gitBytes, indexAllocatedBytes: built.indexBytes,
          sealedAt: Date.now() }).pipe(Effect.mapError(map))
        yield* database.db.transaction((tx) => EventWorkNodeAuthority.sealArtifact(tx, { workID: work.work_id, witness: value }), { behavior: "immediate" })
          .pipe(Effect.provideService(EventWorkPlacement.Service, placement), Effect.mapError(map))
        const update = yield* run(workspace.repositoryRoot, ["update-ref", `refs/heads/${workspace.branch}`, oid, workspace.baseCommit])
        if (update.exitCode !== 0) return yield* failure(true)
        return { outcome: "known" as const, exitCode: 0, stdout: "", stderr: "", commit: oid, continuationRef: oid }
      }).pipe(Effect.catch((error) => Effect.succeed({ outcome: "unknown" as const, exitCode: 1, stdout: "", stderr: "" }))),
    }
    const settled = yield* TaskWorkspace.settleEvent(database.db, { eventID: description.eventID, taskID: description.nodeID,
      generation: 0 }).pipe(Effect.provideService(TaskWorkspace.EventGit, port), Effect.mapError(map))
    return { commit: settled.continuationRef, continuationRef: settled.continuationRef }
  }).pipe(Effect.mapError(map))
  // The original Root has one physical custody writer per Work. Both operations
  // re-read durable artifact/cleanup facts after acquiring the same lock, so boot
  // GC cannot replace the reader's accounting snapshot during reconciliation.
  const settle = (value: EventWorkPlacement.Witness) => Effect.suspend(() => {
    const entry = entries.get(value)
    return entry ? custody.withLock(entry.description.childWorkID)(settleHeld(value)) : Effect.fail(failure())
  })
  const collectKnown = (workID: string) => custody.withLock(workID)(Effect.gen(function* () {
    const authority = yield* EventWorkNodeAuthority.get(database.db, workID)
    const prior = authority?.artifactCustody
    if (!authority?.placement || !authority.terminal || !prior || prior.cleanup ||
      authority.terminal.settledAt > Date.now() - TaskWorkspace.worktreeRetentionMs()) return false
    const controller = yield* database.db.transaction((tx) => EventWorkController.get(tx, authority.controllerID))
    if (!controller || controller.controller.activeNodeID !== null || !["succeeded", "failed"].includes(controller.controller.state)) return false
    yield* EventWorkResult.prepareTerminal(database.db, workID).pipe(Effect.mapError(map))
    yield* database.db.transaction((tx) => EventWorkResult.requireKnownExecution(tx, workID)).pipe(Effect.mapError(map))
    const witness = byWork.get(workID) ?? (yield* restore(authority.placement, true))
    const entry = entries.get(witness)
    if (!entry) return yield* failure()
    yield* accountingCurrent(witness)
    yield* entry.parent.current
    yield* entry.child.current
    const head = yield* EventWorkGit.run({ directory: authority.placement.workspace.repositoryRoot,
      args: ["rev-parse", `refs/heads/${authority.placement.workspace.branch}`] }).pipe(Effect.provideService(EventWorkGit.Current, entry.git))
    if (head.exitCode !== 0 || head.stdout.toString().trim() !== prior.commit) return yield* failure()
    const frozen = yield* EventWorkArtifacts.read({ directory: authority.placement.workspace.repositoryRoot,
      commit: prior.commit, scope: entry.root.toolPolicy.fileScope, maxBytes: EventWorkPlacement.CLONE_RESERVATION_BYTES })
      .pipe(Effect.provideService(EventWorkGit.Current, entry.git))
    if (EventWorkArtifacts.manifest(frozen) !== prior.manifestSha256 || frozen.length !== prior.files ||
      frozen.reduce((bytes, item) => bytes + item.bytes.byteLength, 0) !== prior.bytes) return yield* failure()
    const administrationBytes = yield* administrationAllocation(authority.placement.workspace.directory, entry.tree, entry.git)
    entry.artifact = prior
    entry.artifact = yield* database.db.transaction((tx) => EventWorkNodeAuthority.transitionCleanup(tx, { workID, witness, action: "prepare" }),
      { behavior: "immediate" }).pipe(Effect.provideService(EventWorkPlacement.Service, placement), Effect.mapError(map))
    return yield* Effect.gen(function* () {
      const emptyBytes = yield* entry.tree.collect({ directory: authority.placement!.workspace.directory,
        identity: wire(authority.placement!.childRootIdentity), files: prior.files, bytes: prior.bytes, manifestSha256: prior.manifestSha256 })
        .pipe(Effect.mapError(map))
      entry.artifact = { ...entry.artifact!, worktreeAllocatedBytes: emptyBytes + administrationBytes }
      entry.artifact = yield* database.db.transaction((tx) => EventWorkNodeAuthority.transitionCleanup(tx, { workID, witness, action: "collected" }),
        { behavior: "immediate" }).pipe(Effect.provideService(EventWorkPlacement.Service, placement), Effect.mapError(map))
      return true
    }).pipe(Effect.tapError(() => {
      entry.artifact = { ...prior, cleanup: entry.artifact!.cleanup }
      return database.db.transaction((tx) => EventWorkNodeAuthority.transitionCleanup(tx, { workID, witness, action: "unknown" }),
        { behavior: "immediate" }).pipe(Effect.provideService(EventWorkPlacement.Service, placement), Effect.catchCause(() => Effect.void))
    }))
  }).pipe(Effect.provideService(Scope.Scope, lifetimeScope), Effect.mapError(map), Effect.ensuring(Effect.gen(function* () {
    const proof = yield* Effect.serviceOption(WorkToolPolicy.LeafProof)
    if (Option.isSome(proof) && proof.value.releaseEventTerminal) yield* proof.value.releaseEventTerminal(workID)
  }))))
  const placement: Context.Service.Shape<typeof EventWorkPlacement.Service> = {
    available: (target, plan) => Effect.gen(function* () {
      const key = hash([target, plan])
      readiness.delete(key)
      if (!lifetime.active || !lifetime.locations || process.platform !== "darwin" && process.platform !== "win32" ||
        !plan.nodes.some((node) => node.requiresWriteIsolation) || !EventWorkDagPolicy.validatePlan(plan, target).ok) return false
      const purpose = yield* native.requirePurpose("event_dag_write_v1")
      const tree = yield* EventWorkTree.make(target.projectScope.helperHash)
      yield* tree.supported
      yield* tree.current
      const git = process.platform === "win32" ? yield* readinessGit : undefined
      if (git) yield* git.current
      if (!lifetime.active || !lifetime.locations || !native.purposeCurrent(purpose.readiness) || git && !EventWorkGit.isCurrent(git)) return false
      if (readiness.size >= 32) readiness.delete(readiness.keys().next().value!)
      // This observes the original installed factory's capabilities. Rule/source approval
      // and every live Native placement/dispatch fence remain separate authorities.
      readiness.set(key, { purpose: purpose.readiness, ...(git ? { git } : {}) })
      return true
    }).pipe(Effect.catch(() => Effect.succeed(false))),
    availableCurrent: (target, plan) => {
      const value = readiness.get(hash([target, plan]))
      return lifetime.active && !!value && native.purposeCurrent(value.purpose) && (!value.git || EventWorkGit.isCurrent(value.git))
    },
    prepare, restore: (description) => restore(description).pipe(Effect.provideService(Scope.Scope, lifetimeScope), Effect.mapError(map)),
    describe: (value) => entries.get(value)?.description,
    accountingCurrent,
    artifact: (value) => entries.get(value)?.artifact,
    forWork: (workID) => byWork.get(workID), current,
    settle,
    settleKnown: (workID) => Effect.gen(function* () {
      const authority = yield* EventWorkNodeAuthority.get(database.db, workID)
      const work = yield* WorkAuthority.get(database.db, workID)
      if (!authority?.placement || !work || work.outcome !== "succeeded" && work.outcome !== "failed") return yield* failure()
      yield* EventWorkResult.prepareTerminal(database.db, workID).pipe(Effect.mapError(map))
      yield* database.db.transaction((tx) => EventWorkResult.requireKnownExecution(tx, workID)).pipe(Effect.mapError(map))
      const value = byWork.get(workID) ?? (yield* restore(authority.placement, true))
      return yield* settle(value)
    }).pipe(Effect.provideService(Scope.Scope, lifetimeScope), Effect.mapError(map)),
    collectKnown,
    collectStale: Effect.gen(function* () {
      if (!lifetime.active || !lifetime.locations) return yield* failure()
      const rows = yield* database.db.all<{ work_id: string }>(sql`SELECT n.work_id FROM event_work_node_authority n
        JOIN event_work_controller c ON c.receipt_id=n.receipt_id JOIN event_task_workspace w
          ON w.event_id=json_extract(n.record,'$.placement.eventID') AND w.task_id=n.node_id AND w.generation=0
        WHERE n.state='terminal' AND c.state IN ('succeeded','failed') AND w.state='retained' AND w.error IS NULL
          AND json_type(n.record,'$.artifactCustody.cleanup') IS NULL
          AND json_extract(n.record,'$.terminal.settledAt')<=${Date.now() - TaskWorkspace.worktreeRetentionMs()}
        ORDER BY w.time_settled,n.work_id LIMIT ${EventWorkPlacement.MAX_WORKSPACES}`)
      yield* Effect.forEach(rows, (row) => collectKnown(row.work_id).pipe(Effect.catch(() => Effect.succeed(false))), { concurrency: 1 })
    }).pipe(Effect.mapError(map)),
  }
  return { placement, configuration, captureLocations, approve, preparePlacement: (workID: string) => EventWorkNodeAuthority.preparePlacement(database.db, { workID }).pipe(
    Effect.provideService(Scope.Scope, lifetimeScope), Effect.provideService(EventWorkPlacement.Service, placement), Effect.mapError(map)) }
})

/** Observation-only custody: the Windows factory compares the original FileID and holds
 * the full NoFollow chain. Its live-object predicate is safe inside SQL; actual namespace
 * checks stay outside SQL and never turn this observer into an execution permit. */
export const retainDirectory = (directory: string, identity: EventWorkPlacement.Description["parentRootIdentity"]) => Effect.gen(function* () {
  const acquire = process.platform === "win32"
    ? identity.kind === "windows" ? EventWorkGit.retain(directory, identity).pipe(Effect.map((lease): DirectoryLease => ({
      isCurrent: lease.isCurrent, current: lease.current.pipe(Effect.mapError(map)), close: lease.close.pipe(Effect.mapError(map)),
    })), Effect.mapError(map)) : Effect.fail(failure())
    : identity.kind !== "posix" ? Effect.fail(failure()) : Effect.gen(function* () {
      const file = yield* Effect.tryPromise({ try: () => fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), catch: map })
      return { isCurrent: () => file.fd >= 0, close: Effect.tryPromise({ try: () => file.close(), catch: map }),
        current: Effect.tryPromise({ try: async () => {
          const held = await file.stat({ bigint: true }); const named = await fs.lstat(directory, { bigint: true })
          if (!held.isDirectory() || !named.isDirectory() || held.dev.toString() !== identity.device || held.ino.toString() !== identity.inode ||
            held.dev !== named.dev || held.ino !== named.ino || await fs.realpath(directory) !== directory) throw failure()
        }, catch: map }) }
    })
  const lease = yield* Effect.acquireRelease(acquire, (lease) => lease.close.pipe(Effect.catchCause(() =>
    Effect.logWarning("event_work_directory_close_unknown"))))
  yield* lease.current
  return lease
})

function configuredDiagnostic(stage: "location" | "model" | "native_approval" | "native_configuration", cause: Cause.Cause<unknown>) {
  const known = cause.reasons.flatMap((reason) => {
    const error = Cause.isFailReason(reason) ? reason.error : Cause.isDieReason(reason) ? reason.defect : undefined
    const decoded = Schema.decodeUnknownOption(Schema.Union([
      Schema.Struct({ _tag: Schema.Literal("NativeRuntimeError"), code: NativeRuntime.Error.fields.code }),
      Schema.Struct({ _tag: Schema.Literal("WorkAuthority.Error"), code: WorkAuthoritySchema.Error.fields.code }),
      Schema.Struct({ _tag: Schema.Literals(["CatalogV2.ProviderNotFound", "CatalogV2.ModelNotFound",
        "SessionRunnerModel.ModelNotSelectedError", "SessionRunnerModel.UnsupportedApiError", "SessionRunnerModel.ModelProtocolDisabledError"]) }),
    ]))(error)
    return Option.isSome(decoded) ? [decoded.value] : []
  })[0]
  return Effect.logWarning(`event_work_placement_configured_refused ${JSON.stringify({ stage,
    tag: known?._tag ?? "UNCLASSIFIED", code: known && "code" in known ? known.code : "UNCLASSIFIED" })}`)
}

function indexTree(run: (directory: string, args: readonly string[], stdin?: Buffer) => ReturnType<typeof EventWorkGit.run>, directory: string,
  baseCommit: string, base: readonly EventWorkArtifacts.Entry[], entries: readonly EventWorkArtifacts.Entry[]) {
  return Effect.gen(function* () {
    // The immutable view contains exactly the approved files. Copying an original full
    // repository index would retain unapproved paths and unbounded index allocation.
    const reset = yield* run(directory, ["read-tree", "--empty"])
    if (reset.exitCode !== 0) return 1
    const records = [...base.filter((entry) => !entries.some((next) => next.relative === entry.relative))
      .map((entry) => `0 ${"0".repeat(baseCommit.length)}\t${entry.relative}\0`),
      ...entries.map((entry) => `${entry.mode} ${entry.object}\t${entry.relative}\0`)].join("")
    const next = yield* run(directory, ["update-index", "-z", "--index-info"], Buffer.from(records))
    return next.exitCode
  })
}

function gitPlan(entries: readonly { readonly relative: string; readonly bytes: Buffer }[], existing: number) {
  return { files: entries.length,
    directories: new Set(entries.flatMap((entry) => entry.relative.split("/").slice(0, -1).map((_, index) => entry.relative.split("/").slice(0, index + 1).join("/")))).size,
    bytes: entries.reduce((bytes, entry) => bytes + entry.bytes.byteLength, 0),
    index_bytes: 1024 + entries.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.relative) + 128, 0), existing_bytes: existing }
}

