// Fixed physical diagnostic entry. The private publisher signs these actual bytes together
// with the production source inventory and the original installed native file helper.
import { NativeBootstrap } from "../../../../deepagent-code/src/runtime/native-bootstrap"
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import type { Effect } from "effect"

NativeBootstrap.install()
const root = process.env.DAC_BROWSER_FILES_ROOT!

async function utility() {
  const { Effect, Layer, Option, Exit, Cause } = await import("effect")
  const { Database } = await import("@deepagent-code/core/database/database")
  const { FSUtil } = await import("@deepagent-code/core/fs-util")
  const { LocationIdentity } = await import("@deepagent-code/core/context-federation/identity")
  const { SecurityNamespaceTable } = await import("@deepagent-code/core/context-federation/sql")
  const { Project } = await import("@deepagent-code/core/project")
  const { ProjectTable } = await import("@deepagent-code/core/project/sql")
  const { AbsolutePath } = await import("@deepagent-code/core/schema")
  const { SessionSchema } = await import("@deepagent-code/core/session/schema")
  const { SessionTable } = await import("@deepagent-code/core/session/sql")
  const { BrowserControl } = await import("@deepagent-code/core/browser/control")
  const { BrowserSchema } = await import("@deepagent-code/core/browser/schema")
  const { BrowserFileCapability } = await import("@deepagent-code/core/browser/file-capability")
  const { BrowserFileExchange } = await import("@deepagent-code/core/browser/file-exchange")
  const { BrowserFileCapacityTable } = await import("@deepagent-code/core/browser/browser-file.sql")
  const { BrowserHost } = await import("@deepagent-code/core/browser/host")
  const { BrowserNativeHost } = await import("../../../../deepagent-code/src/browser/native-host")
  const { BrowserFiles } = await import("../../../../deepagent-code/src/browser/file-exchange")
  const { SharedBrowserControl } = await import("@deepagent-code/core/browser/shared-control")
  const { SharedBrowserSchema } = await import("@deepagent-code/core/browser/shared-schema")
  const { LocalAuthority } = await import("../../../../deepagent-code/src/installation/local-authority")
  const parent = Reflect.get(process, "parentPort") as {
    postMessage(value: unknown): void
    on(event: "message", listener: (event: { data: { type?: string } }) => void): void
    removeListener(event: "message", listener: (event: { data: { type?: string } }) => void): void
  }
  await BrowserNativeHost.prepare()
  BrowserNativeHost.captureServerConfiguration({
    username: "deepagent-code",
    password: Option.some("private-files-module"),
  })
  const host = BrowserNativeHost.current()
  assert.ok(host)
  const directory = await fs.realpath(path.join(root, "project"))
  if (process.env.DAC_BROWSER_FILES_SHARED_UPLOAD_ONLY === "1") {
    const { createHash } = await import("node:crypto")
    const { BrowserFileAuthorityFixture } = await import("../../../../core/test/fixture/browser-file-authority")
    const { CurrentToolExecution } = await import("@deepagent-code/core/session/runner/current-tool-execution")
    const { SharedBrowserTool } = await import("@deepagent-code/core/tool/browser-shared")
    const { V2ToolEffect } = await import("@deepagent-code/core/session/runner/v2-tool-effect")
    assert.ok(host.shared?.files?.ready)
    const originalShared = host.shared
    const timings: Array<{ phase: string; startedAt: number; elapsedMs: number; outcome: string; error?: string }> = []
    const currentFailureSnapshots: Array<{
      at: number
      command: string
      expectedResource: string
      actualResource: string | null
      expectedLease: string
      actualLease: string | null
    }> = []
    const timed = <A, E, R>(phase: string, body: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const startedAt = Date.now()
        return body.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (timings.length < 1024)
                timings.push({
                  phase,
                  startedAt,
                  elapsedMs: Date.now() - startedAt,
                  outcome: Exit.isSuccess(exit) ? "return" : "throw",
                  ...(Exit.isFailure(exit) ? { error: Cause.pretty(exit.cause) } : {}),
                })
            }),
          ),
        )
      })
    const result = await BrowserFileAuthorityFixture.isolated((fixture) =>
      Effect.gen(function* () {
        const db = fixture.db
        const location = fixture.captureInput.location
        yield* Effect.promise(() =>
          fs.copyFile(path.join(directory, "source.bin"), path.join(location.directory, "source.bin")),
        )
        const scope = { ...fixture.captureInput.control.scope, principal: host.principal }
        const actualDatabase = yield* Database.Service
        const fileLayer = BrowserFiles.layer.pipe(
          Layer.provide(LocationIdentity.layer),
          Layer.provide(Layer.succeed(Database.Service, actualDatabase)),
          Layer.provide(FSUtil.defaultLayer),
          Layer.provide(Layer.succeed(BrowserHost.Current, host)),
        )
        return yield* Effect.gen(function* () {
          const api = yield* BrowserFiles.Service
          const cap = yield* BrowserFileCapability.Service
          assert.ok(cap.shared)
          const permission = fixture.captureInput.permission
          assert.ok(permission.checkAction)
          const checkedPermission = {
            ...permission,
            checkAction: (
              permit: Parameters<NonNullable<typeof permission.checkAction>>[0],
              request: Parameters<NonNullable<typeof permission.checkAction>>[1],
            ) => timed(`Permission.${request.action}`, permission.checkAction!(permit, request)),
          }
          const observedHost = {
            ...host,
            shared: {
              ...originalShared,
              execute: (
                resource: typeof SharedBrowserSchema.Resource.Type,
                lease: typeof SharedBrowserSchema.Lease.Type,
                action: typeof SharedBrowserSchema.Action.Type,
                current: Effect.Effect<void, typeof BrowserSchema.Error.Type>,
              ) =>
                originalShared.execute(
                  resource,
                  lease,
                  action,
                  timed(
                    "Canonical.current",
                    current.pipe(
                      Effect.onExit((exit) => {
                        if (Exit.isSuccess(exit) || currentFailureSnapshots.length) return Effect.void
                        return Effect.gen(function* () {
                          const actualResource = yield* SharedBrowserControl.get(db, resource.resourceID)
                          const actualLease = yield* SharedBrowserControl.lease(db, lease.leaseID)
                          currentFailureSnapshots.push({
                            at: Date.now(),
                            command: action.command.type,
                            expectedResource: SharedBrowserControl.hash(resource),
                            actualResource: actualResource ? SharedBrowserControl.hash(actualResource) : null,
                            expectedLease: SharedBrowserControl.hash(lease),
                            actualLease: actualLease ? SharedBrowserControl.hash(actualLease) : null,
                          })
                        }).pipe(Effect.catchCause(() => Effect.void))
                      }),
                    ),
                  ),
                ),
            },
          }
          const origin = process.env.DAC_BROWSER_FILES_ORIGIN!
          const made = yield* SharedBrowserControl.create(db, {
            scope,
            mainIncarnation: originalShared.mainIncarnation,
            sidecarIncarnation: host.hostIncarnation,
            request: {
              version: 2,
              requestID: "shared-upload-diagnostic",
              sessionID: scope.sessionID,
              profile: SharedBrowserSchema.PROFILE,
              inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
              expiresAt: Date.now() + 90_000,
              policy: {
                origin,
                approvedOrigins: [origin],
                manualApprovedOrigins: [origin],
                resolverPolicy: "system",
                postGrants: [],
                filePolicy: { upload: true, download: true },
              },
            },
          })
          const resource = yield* SharedBrowserControl.observeCreated(
            db,
            made.resource,
            yield* originalShared.create(made.resource, made.lease),
          )
          yield* originalShared.syncProjection(resource)
          const lease = yield* SharedBrowserControl.lease(db, made.lease.leaseID)
          assert.ok(lease)
          const effects = yield* V2ToolEffect.Service
          const execute = Effect.fnUntraced(function* (command: typeof BrowserSchema.Command.Type, id: string) {
            const input = { operation: "execute" as const, resourceID: resource.resourceID, command }
            const admission = yield* effects.admit({
              sessionId: fixture.session.id,
              providerAttemptId: fixture.admission.providerAttemptId,
              receiptId: fixture.receipt.receiptId,
              toolCallId: id,
              toolName: "browser",
              effectKind: "mutating",
              ownerToken: fixture.receipt.ownerToken,
              now: Date.now(),
            })
            const context = { ...fixture.captureInput.context, toolCallID: id }
            const body = SharedBrowserTool.execute(
              { db, host: observedHost, location, permission: checkedPermission, files: cap },
              input,
              context,
            )
            const output = yield* timed(
              command.type,
              CurrentToolExecution.withAdmission(
                db,
                { admission, context, location, input, provider: fixture.turns },
                body,
              ),
            )
            assert.ok("result" in output && output.result)
            return output.result
          })
          const initial = (yield* execute({ type: "tabs.list" }, "shared-upload-tabs")).tabs[0]!
          const tab = (yield* execute(
            { type: "navigate", tabID: initial.tabID, generation: initial.generation, url: origin },
            "shared-upload-navigate",
          )).tabs[0]!
          const snapshot = yield* execute(
            { type: "snapshot", tabID: tab.tabID, generation: tab.generation },
            "shared-upload-snapshot",
          )
          const reference = snapshot.refs?.find((ref) => /Upload file/.test(ref.name))
          assert.ok(reference && snapshot.observationRevision)
          const preview = yield* api.shared.preview({
            resourceID: resource.resourceID,
            scope,
            request: { direction: "upload", relative: "source.bin", targetURL: `${origin}/upload` },
          })
          const approved = yield* api.shared.approve({
            resourceID: resource.resourceID,
            scope,
            command: {
              requestID: "shared-upload-approved",
              previewID: preview.previewID,
              expectedResourceRevision: resource.revision,
              expectedLeaseID: lease.leaseID,
              expectedLeaseEpoch: lease.leaseEpoch,
              expectedManualEpoch: lease.manualEpoch,
              expiresAt: Math.min(lease.expiresAt, Date.now() + 60_000),
            },
          })
          assert.ok(approved.grant)
          const outcome = yield* execute(
            {
              type: "file.upload",
              tabID: tab.tabID,
              generation: tab.generation,
              frameID: reference.frameID,
              observationRevision: snapshot.observationRevision,
              ref: reference.ref,
              grantIDs: [approved.grant.grantID],
            },
            "shared-upload-once",
          ).pipe(Effect.exit)
          assert.ok(Exit.isSuccess(outcome), Exit.isFailure(outcome) ? Cause.pretty(outcome.cause) : "")
          const downloadTab = (yield* execute({ type: "tabs.list" }, "shared-download-tabs")).tabs[0]!
          const downloadPage = yield* execute(
            { type: "snapshot", tabID: downloadTab.tabID, generation: downloadTab.generation },
            "shared-download-snapshot",
          )
          const link = downloadPage.refs?.find((ref) => ref.role === "link" && ref.name === "Download file")
          assert.ok(link && downloadPage.observationRevision)
          const downloadPreview = yield* api.shared.preview({
            resourceID: resource.resourceID,
            scope,
            request: {
              direction: "download",
              relative: "download.bin",
              targetURL: `${origin}/download`,
              maxBytes: 65536,
            },
          })
          const downloadGrant = yield* api.shared.approve({
            resourceID: resource.resourceID,
            scope,
            command: {
              requestID: "shared-download-approved",
              previewID: downloadPreview.previewID,
              expectedResourceRevision: resource.revision,
              expectedLeaseID: lease.leaseID,
              expectedLeaseEpoch: lease.leaseEpoch,
              expectedManualEpoch: lease.manualEpoch,
              expiresAt: Math.min(lease.expiresAt, Date.now() + 60_000),
            },
          })
          assert.ok(downloadGrant.grant)
          const downloaded = yield* execute(
            {
              type: "file.download",
              tabID: downloadTab.tabID,
              generation: downloadTab.generation,
              frameID: link.frameID,
              observationRevision: downloadPage.observationRevision,
              ref: link.ref,
              grantID: downloadGrant.grant.grantID,
            },
            "shared-download-once",
          )
          assert.equal(downloaded.files?.[0]?.state, "published")
          const downloadedBytes = yield* Effect.promise(() =>
            fs.readFile(path.join(location.directory, "download.bin")),
          )
          assert.deepEqual(
            downloadedBytes,
            yield* Effect.promise(() => fs.readFile(path.join(location.directory, "source.bin"))),
          )
          const closing = {
            resourceID: resource.resourceID,
            requestID: "shared-upload-close",
            expectedRevision: resource.revision,
          }
          const refusalPreview = yield* api.shared.preview({
            resourceID: resource.resourceID,
            scope,
            request: { direction: "upload", relative: "source.bin", targetURL: `${origin}/upload` },
          })
          const context = yield* Effect.context<never>()
          const revocation =
            Promise.withResolvers<Effect.Success<ReturnType<typeof SharedBrowserControl.prepareClose>>>()
          const onDecision = (event: { data: { type?: string } }) => {
            if (event.data.type !== "files-revoke-before-decision") return
            parent.removeListener("message", onDecision)
            // The real Core reducing operation retires the SQL lease while Main still
            // owns the dialog. Its next private permit must observe that new authority.
            void Effect.runPromiseWith(context)(SharedBrowserControl.prepareClose(db, resource, closing)).then(
              (prepared) => {
                revocation.resolve(prepared)
                parent.postMessage({ type: "files-permission-revoked", revoked: true })
              },
              (error) => {
                revocation.reject(error)
                parent.postMessage({ type: "files-permission-revoked", revoked: false })
              },
            )
          }
          parent.on("message", onDecision)
          const refused = yield* api.shared
            .approve({
              resourceID: resource.resourceID,
              scope,
              command: {
                requestID: "shared-upload-permission-retired",
                previewID: refusalPreview.previewID,
                expectedResourceRevision: resource.revision,
                expectedLeaseID: lease.leaseID,
                expectedLeaseEpoch: lease.leaseEpoch,
                expectedManualEpoch: lease.manualEpoch,
                expiresAt: Math.min(lease.expiresAt, Date.now() + 60_000),
              },
            })
            .pipe(Effect.exit, Effect.ensuring(Effect.sync(() => parent.removeListener("message", onDecision))))
          const prepared = yield* Effect.promise(() => revocation.promise)
          assert.ok(Exit.isFailure(refused))
          const grantsAfterRefusal = (yield* api.shared.list({ resourceID: resource.resourceID, scope })).grants
          assert.equal(grantsAfterRefusal.length, 2)
          assert.deepEqual(
            grantsAfterRefusal.map((grant) => grant.grantID).sort(),
            [approved.grant.grantID, downloadGrant.grant.grantID].sort(),
          )
          const closed = yield* SharedBrowserControl.observeClose(
            db,
            prepared.resource,
            closing.requestID,
            yield* originalShared.close(prepared.resource, closing),
          )
          return {
            mode: "shared-upload-diagnostic",
            actualInstalled: true,
            canonicalAdmissionAndPermissions: true,
            controlledAdmission: false,
            physicalNativeApprovalAcceptance: false,
            modelRequests: 0,
            controlledProviderAttemptRows: (yield* db.all<{ n: number }>(
              "SELECT count(*) AS n FROM session_provider_attempt",
            ))[0]!.n,
            timings,
            currentFailureSnapshots,
            inputs: (yield* db.all<{ n: number }>("SELECT count(*) AS n FROM session_input"))[0]!.n,
            outcome: Exit.isSuccess(outcome) ? "completed" : "failed",
            error: Exit.isFailure(outcome) ? Cause.pretty(outcome.cause) : "",
            selected: Exit.isSuccess(outcome) ? outcome.value.files : null,
            downloaded: {
              state: downloaded.files?.[0]?.state,
              bytes: downloadedBytes.length,
              sha256: createHash("sha256").update(downloadedBytes).digest("hex"),
            },
            permissionRefusal: {
              rejected: Exit.isFailure(refused),
              originalGrantsOnly: grantsAfterRefusal.length === 2,
              retiredLease: prepared.resource.liveLeaseID === null && prepared.resource.agentAccessFenced,
              state: prepared.resource.state,
            },
            closed: closed.state,
          }
        }).pipe(Effect.provide(fileLayer))
      }),
    )
    parent.postMessage({ type: "files-result", result })
    return
  }
  const database = Database.layerFromPath(path.join(root, "files.sqlite"))
  const graph = Layer.mergeAll(LocationIdentity.layer, BrowserFiles.layer).pipe(
    Layer.provideMerge(database),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Layer.succeed(BrowserHost.Current, host)),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const api = yield* BrowserFiles.Service
      const cap = yield* BrowserFileCapability.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionSchema.ID.make("ses_browser_files_fixture"),
          project_id: Project.ID.global,
          slug: "files",
          title: "Installed file exchange module",
          directory,
          version: "fixture",
          v2_authority: true,
        })
        .run()
      const identity = yield* (yield* LocationIdentity.Service).resolve({
        boundary: { kind: "implicit_local" },
        directory: AbsolutePath.make(directory),
        project: { kind: "registered_root", observedProjectId: "project_browser_files_fixture" },
      })
      const namespace = (yield* db.select().from(SecurityNamespaceTable).all()).find(
        (row) => row.id === identity.securityNamespaceId,
      )
      assert.ok(namespace)
      const scope: typeof BrowserSchema.Scope.Type = {
        principal: host.principal,
        securityNamespaceID: identity.securityNamespaceId,
        namespaceBindingHash: namespace.binding_hash,
        locationKey: identity.locationKey,
        projectScopeKey: identity.projectScopeKey,
        projectID: Project.ID.global,
        sessionID: "ses_browser_files_fixture",
        directory,
        workspaceID: null,
      }
      const origin = process.env.DAC_BROWSER_FILES_ORIGIN!
      if (process.env.DAC_BROWSER_FILES_FRESH_SHARED_ONLY === "1") {
        assert.ok(host.shared?.files?.ready)
        const installationPath = LocalAuthority.installationPath()
        const missingIdentity = () =>
          Effect.promise(() =>
            fs.lstat(installationPath).then(
              () => false,
              (error: unknown) => {
                if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
                  return true
                throw error
              },
            ),
          )
        assert.equal(yield* missingIdentity(), true)
        const made = yield* SharedBrowserControl.create(db, {
          scope,
          mainIncarnation: host.shared.mainIncarnation,
          sidecarIncarnation: host.hostIncarnation,
          request: {
            version: 2,
            requestID: "fresh-shared-file",
            sessionID: scope.sessionID,
            profile: SharedBrowserSchema.PROFILE,
            inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
            expiresAt: Date.now() + 60_000,
            policy: {
              origin,
              approvedOrigins: [origin],
              manualApprovedOrigins: [origin],
              resolverPolicy: "system",
              postGrants: [],
              filePolicy: { upload: true, download: true },
            },
          },
        })
        const resource = yield* SharedBrowserControl.observeCreated(
          db,
          made.resource,
          yield* host.shared.create(made.resource, made.lease),
        )
        yield* host.shared.syncProjection(resource)
        const lease = yield* SharedBrowserControl.lease(db, made.lease.leaseID)
        assert.ok(lease)
        assert.equal(yield* host.shared.files.ready(resource, lease), true)
        yield* api.shared.list({ resourceID: resource.resourceID, scope })
        yield* api.shared.status({ resourceID: resource.resourceID, scope, requestID: "not-approved" })
        assert.equal(yield* missingIdentity(), true)
        const request = { direction: "upload" as const, relative: "source.bin", targetURL: `${origin}/upload` }
        for (const rejected of [
          api.shared
            .preview({ resourceID: resource.resourceID, scope: { ...scope, sessionID: "ses_unrelated" }, request })
            .pipe(Effect.asVoid),
          api.shared
            .preview({
              resourceID: resource.resourceID,
              scope,
              request: { ...request, targetURL: "https://example.com/upload" },
            })
            .pipe(Effect.asVoid),
          cap
            .shared!.preview({ resource: { ...resource, revision: resource.revision + 1 }, lease, request })
            .pipe(Effect.asVoid),
        ]) {
          assert.equal(Exit.isFailure(yield* rejected.pipe(Effect.exit)), true)
          assert.equal(yield* missingIdentity(), true)
        }
        const preview = yield* api.shared.preview({ resourceID: resource.resourceID, scope, request })
        assert.equal(preview.preview.direction, "upload")
        assert.equal(preview.preview.direction === "upload" && preview.preview.bytes, 32_768)
        const identityFile = yield* Effect.promise(() => fs.lstat(installationPath))
        const identityDirectory = yield* Effect.promise(() => fs.lstat(path.dirname(installationPath)))
        assert.equal(identityFile.mode & 0o777, 0o600)
        assert.equal(identityDirectory.mode & 0o777, 0o700)
        assert.equal(identityFile.nlink, 1)
        assert.equal(identityFile.uid, process.getuid!())
        const repeated = yield* api.shared.preview({
          resourceID: resource.resourceID,
          scope,
          request: {
            direction: "download",
            relative: "fresh-download.bin",
            targetURL: `${origin}/download`,
            maxBytes: 65536,
          },
        })
        assert.equal(preview.preview.instanceID, repeated.preview.instanceID)
        assert.equal((yield* Effect.promise(() => fs.lstat(installationPath))).ino, identityFile.ino)
        const command = {
          resourceID: resource.resourceID,
          requestID: "close-fresh-shared",
          expectedRevision: resource.revision,
        }
        const prepared = yield* SharedBrowserControl.prepareClose(db, resource, command)
        const closed = yield* SharedBrowserControl.observeClose(
          db,
          prepared.resource,
          command.requestID,
          yield* host.shared.close(prepared.resource, command),
        )
        assert.equal(closed.state, "closed")
        assert.equal(closed.resourceAlive, false)
        assert.equal((yield* db.all<{ n: number }>("SELECT count(*) AS n FROM browser_file_grant"))[0]?.n, 0)
        assert.equal((yield* db.all<{ n: number }>("SELECT count(*) AS n FROM local_operator_authority"))[0]?.n, 0)
        return {
          mode: "fresh-shared-preview",
          node: process.versions.node,
          electron: process.versions.electron,
          actualInstalled: true,
          freshIdentityBefore: true,
          readsLeaveIdentityAbsent: true,
          deniedPreviews: 3,
          identityFileMode: identityFile.mode & 0o777,
          identityDirectoryMode: identityDirectory.mode & 0o777,
          sameInstance: preview.preview.instanceID === repeated.preview.instanceID,
          previews: 2,
          grantCount: 0,
          operatorCount: 0,
          providers: 0,
          inputs: 0,
          closed: closed.state,
        }
      }
      yield* LocalAuthority.initializeInstallation()
      const create = Effect.fnUntraced(function* (id: string) {
        const made = yield* BrowserControl.create(db, {
          request: {
            requestID: id,
            sessionID: scope.sessionID,
            profile: BrowserSchema.FILE_EXCHANGE_PROFILE,
            origin,
            postPaths: ["/upload"],
            filePolicy: { upload: true, download: true },
            expiresAt: Date.now() + 240_000,
          },
          scope,
          hostID: host.hostID,
          hostIncarnation: host.hostIncarnation,
          credentialBinding: host.credentialBinding,
        })
        yield* host.create(made.record)
        return yield* BrowserControl.observeControl(db, made.record, "active")
      })
      const execute = Effect.fnUntraced(function* (
        control: typeof BrowserSchema.Control.Type,
        command: typeof BrowserSchema.Command.Type,
        id: string,
      ) {
        const current = () => BrowserControl.requireActive(db, control.controlID, scope, host).pipe(Effect.asVoid)
        const action = yield* BrowserControl.prepareAction(
          db,
          {
            control,
            command,
            timeoutMs: 30_000,
            // Store admission witness only. No model/provider/Work or canonical ToolEffect is minted.
            admission: {
              admissionId: id,
              sessionId: scope.sessionID,
              providerAttemptId: "controlled-files",
              receiptId: "controlled-files",
              toolCallId: id,
              toolName: "browser",
              effectKind: "mutating",
              ownerToken: "controlled-files",
              timeCreated: Date.now(),
            },
          },
          (tx) => BrowserControl.requireActive(tx, control.controlID, scope, host).pipe(Effect.asVoid),
        )
        const response = yield* host.execute(control, action, current())
        yield* BrowserControl.observeAction(db, action, { outcome: "completed", result: response.result })
        if (command.type === "file.upload" || command.type === "file.download") {
          assert.ok(cap.finishAction)
          yield* cap.finishAction(action.actionID)
        }
        return response.result
      })
      const open = Effect.fnUntraced(function* (control: typeof BrowserSchema.Control.Type, id: string) {
        const initial = yield* execute(control, { type: "tabs.list" }, `${id}-tabs`)
        const first = initial.tabs[0]!
        const page = yield* execute(
          control,
          { type: "navigate", tabID: first.tabID, generation: first.generation, url: `${origin}/` },
          `${id}-navigate`,
        )
        const tab = page.tabs[0]!
        const snapshot = yield* execute(
          control,
          { type: "snapshot", tabID: tab.tabID, generation: tab.generation },
          `${id}-snapshot`,
        )
        return { tab, snapshot }
      })
      const uploadControl = yield* create("upload-control")
      const page = yield* open(uploadControl, "upload")
      const upload = yield* api.preview({
        controlID: uploadControl.controlID,
        scope,
        request: { direction: "upload", relative: "source.bin", targetPath: "/upload" },
      })
      parent.postMessage({ type: "files-native-confirm", name: "upload" })
      const command = {
        previewID: upload.previewID,
        requestID: "upload-grant",
        expectedControlRevision: uploadControl.revision,
        expiresAt: Date.now() + 120_000,
      }
      const approved = yield* Effect.all(
        [
          api.approve({ controlID: uploadControl.controlID, scope, command }),
          api.approve({ controlID: uploadControl.controlID, scope, command }),
        ],
        { concurrency: 2 },
      )
      assert.equal(approved[0].grant.grantID, approved[1].grant.grantID)
      assert.equal(approved[0].grant.state, "approved")
      const prior = yield* db.all("SELECT total_changes() AS n")
      assert.equal((yield* api.approve({ controlID: uploadControl.controlID, scope, command })).replayed, true)
      assert.deepEqual(yield* db.all("SELECT total_changes() AS n"), prior)
      const reference = page.snapshot.refs?.find((ref) => ref.role === "button" && /file/i.test(ref.name))
      assert.ok(reference)
      const selected = yield* execute(
        uploadControl,
        {
          type: "file.upload",
          tabID: page.tab.tabID,
          generation: page.tab.generation,
          frameID: reference.frameID,
          observationRevision: page.snapshot.observationRevision!,
          ref: reference.ref,
          grantIDs: [approved[0].grant.grantID],
        },
        "upload-once",
      )
      assert.equal(selected.files?.[0]?.state, "selected")
      const downloadControl = yield* create("download-control")
      const downloadPage = yield* open(downloadControl, "download")
      const destination = yield* api.preview({
        controlID: downloadControl.controlID,
        scope,
        request: { direction: "download", relative: "download.bin", targetURL: `${origin}/download`, maxBytes: 65536 },
      })
      parent.postMessage({ type: "files-native-confirm", name: "download" })
      const granted = yield* api.approve({
        controlID: downloadControl.controlID,
        scope,
        command: {
          previewID: destination.previewID,
          requestID: "download-grant",
          expectedControlRevision: downloadControl.revision,
          expiresAt: Date.now() + 120_000,
        },
      })
      const link = downloadPage.snapshot.refs?.find((ref) => ref.role === "link" && ref.name === "Download file")
      assert.ok(link)
      const downloaded = yield* execute(
        downloadControl,
        {
          type: "file.download",
          tabID: downloadPage.tab.tabID,
          generation: downloadPage.tab.generation,
          frameID: link.frameID,
          observationRevision: downloadPage.snapshot.observationRevision!,
          ref: link.ref,
          grantID: granted.grant.grantID,
        },
        "download-once",
      )
      assert.equal(downloaded.files?.[0]?.state, "published")
      assert.deepEqual(
        yield* Effect.promise(() => fs.readFile(path.join(directory, "download.bin"))),
        yield* Effect.promise(() => fs.readFile(path.join(directory, "source.bin"))),
      )
      const meter = yield* db.select().from(BrowserFileCapacityTable).get()
      assert.ok(meter)
      assert.equal(meter.reserved_bytes, meter.metadata_bytes)
      const census = yield* db.all("SELECT total_changes() AS n")
      const list = yield* api.list({ controlID: downloadControl.controlID, scope })
      assert.equal(list.grants[0]?.state, "used")
      assert.equal(list.files[0]?.state, "published")
      yield* api.status({ controlID: downloadControl.controlID, scope, requestID: "download-grant" })
      assert.deepEqual(yield* db.all("SELECT total_changes() AS n"), census)
      const cancelled = yield* BrowserControl.cancel(db, downloadControl.controlID, scope, {
        requestID: "close-download",
        expectedRevision: downloadControl.revision,
      })
      assert.equal(yield* host.cancel(cancelled.record), true)
      yield* BrowserControl.observeControl(db, cancelled.record, "stopped")
      assert.equal((yield* db.all<{ n: number }>("SELECT count(*) AS n FROM session_input"))[0]?.n, 0)
      assert.equal((yield* db.all<{ n: number }>("SELECT count(*) AS n FROM work_count_acquisition"))[0]?.n, 0)
      return {
        node: process.versions.node,
        electron: process.versions.electron,
        selected: selected.files,
        downloaded: downloaded.files,
        instanceID: upload.preview.instanceID,
        confirms: 2,
        grantCount: (yield* db.all<{ n: number }>("SELECT count(*) AS n FROM browser_file_grant"))[0]?.n,
        artifactCount: meter.artifact_count,
        reservedBytes: meter.reserved_bytes,
        metadataBytes: meter.metadata_bytes,
        list,
        inputs: 0,
        providers: 0,
        actualInstalled: true,
        controlledAdmission: true,
      }
    }).pipe(Effect.provide(graph), Effect.scoped),
  )
  parent.postMessage({ type: "files-result", result })
}

void utility().then(
  () => process.exit(0),
  async (error) => {
    await fs.writeFile(
      path.join(root, "utility-failure.json"),
      JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : "" }),
      { mode: 0o600 },
    )
    process.exit(1)
  },
)
