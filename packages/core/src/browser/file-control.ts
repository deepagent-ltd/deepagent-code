export * as BrowserFileControl from "./file-control"

import { and, eq, isNull, sql } from "drizzle-orm"
import { Effect, Option } from "effect"
import type { Database } from "../database/database"
import { SecurityNamespaceTable, LocationIdentityTable, ProjectScopeIdentityTable } from "../context-federation/sql"
import { SessionTable } from "../session/sql"
import { SessionSchema } from "../session/schema"
import { BrowserControlTable } from "./browser.sql"
import { BrowserControl } from "./control"
import type { BrowserHost } from "./host"
import type { BrowserSchema } from "./schema"
import type { SharedBrowserSchema } from "./shared-schema"
import { SharedBrowserControl } from "./shared-control"
import { SharedBrowserFileBinding } from "./shared-file-binding"

type Db = Database.Interface["db"]
type Reader = Db | Parameters<Parameters<Db["transaction"]>[0]>[0]
type Host = Pick<BrowserHost.Interface, "hostID" | "hostIncarnation" | "credentialBinding" | "alive" | "verify">
declare const lease: unique symbol
export type Lease = { readonly [lease]: true }
type Entry = {
  kind: "browser-v1"
  active: boolean
  control: BrowserSchema.Control
  host: Host
  row: typeof BrowserControlTable.$inferSelect
}
type SharedEntry = { kind: "shared-v2"; active: boolean; resource: SharedBrowserSchema.Resource;
  lease: SharedBrowserSchema.Lease; host: BrowserHost.Interface; db: Db }
const leases = new WeakMap<Lease, Entry | SharedEntry>()
const denied = () => BrowserControl.failure("BROWSER_STALE_TARGET")

/** Host control custody only. The caller retains its independent per-file
 * permission, canonical tool frame, grant, helper and FD checks. */
export const capture = Effect.fn("BrowserFileControl.capture")(function* (db: Db, control: BrowserSchema.Control, host: Host) {
  const entry = yield* db.transaction((tx) => Effect.gen(function* () {
    if (!nativeCurrent({ control, host })) return yield* denied()
    const current = yield* BrowserControl.requireActive(tx, control.controlID, control.scope, host)
    if (BrowserControl.hash(current) !== BrowserControl.hash(control)) return yield* denied()
    const row = yield* tx.select().from(BrowserControlTable).where(eq(BrowserControlTable.control_id, control.controlID)).get()
    if (!row || !nativeCurrent({ control: current, host })) return yield* denied()
    // The strict DB decoder produced this separate object. Do not retain the
    // caller's mutable scope/expiry object as the captured identity.
    return { kind: "browser-v1" as const, active: true, control: current, host, row }
  }), { behavior: "immediate" })
  return yield* Effect.acquireRelease(Effect.sync(() => {
    const handle = Object.freeze({}) as Lease
    leases.set(handle, entry)
    return handle
  }), (handle) => Effect.sync(() => {
    entry.active = false
    leases.delete(handle)
  }))
})

/** One indexed joined current probe; no control JSON decode or policy reload.
 * The short writer fence closes before any helper/FD/network operation. */
export const requireCurrent = Effect.fn("BrowserFileControl.requireCurrent")(function* (db: Reader, handle: Lease) {
  if (leases.get(handle)?.kind === "shared-v2") return yield* requireSharedCurrent(db, handle)
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const entry = leases.get(handle)
    if (entry?.kind !== "browser-v1" || !entry.active || !nativeCurrent(entry)) return yield* denied()
    const scope = entry.control.scope
    const found = yield* tx.select({ controlID: BrowserControlTable.control_id }).from(BrowserControlTable)
      .innerJoin(SessionTable, eq(SessionTable.id, SessionSchema.ID.make(scope.sessionID)))
      .innerJoin(SecurityNamespaceTable, eq(SecurityNamespaceTable.id, scope.securityNamespaceID))
      .innerJoin(LocationIdentityTable, and(eq(LocationIdentityTable.security_namespace_id, SecurityNamespaceTable.id),
        eq(LocationIdentityTable.location_key, scope.locationKey)))
      .innerJoin(ProjectScopeIdentityTable, and(eq(ProjectScopeIdentityTable.security_namespace_id, SecurityNamespaceTable.id),
        eq(ProjectScopeIdentityTable.project_scope_key, scope.projectScopeKey)))
      .where(and(
        ...Object.entries(entry.row).map(([name, value]) => sql`${sql.identifier("browser_control")}.${sql.identifier(name)} IS ${value}`),
        sql`${SessionTable.project_id} IS ${scope.projectID}`, eq(SessionTable.directory, scope.directory),
        isNull(SessionTable.workspace_id), eq(SessionTable.v2_authority, true),
        eq(SecurityNamespaceTable.kind, "implicit_local"), eq(SecurityNamespaceTable.binding_hash, scope.namespaceBindingHash),
        isNull(SecurityNamespaceTable.retired_at), isNull(LocationIdentityTable.retired_at), isNull(ProjectScopeIdentityTable.retired_at),
        eq(LocationIdentityTable.project_scope_key, scope.projectScopeKey), eq(LocationIdentityTable.canonical_root, scope.directory),
        isNull(LocationIdentityTable.workspace_binding),
        sql`${LocationIdentityTable.observed_project_id} IS ${ProjectScopeIdentityTable.observed_project_id}`,
      )).get()
    // Check after the SQL await: a late stop, native replacement or expiry must
    // not be accepted merely because it was current before the probe.
    if (!found || !entry.active || !nativeCurrent(entry)) return yield* denied()
  }), { behavior: "immediate" }).pipe(Effect.mapError(() => denied()))
})

/** Same opaque lease registry and factory. A real nonreducing Main probe brackets the
 * SQL capture; a durable resource row or reducing status cannot create live custody. */
export const captureShared = Effect.fn("BrowserFileControl.captureShared")(function* (
  db: Db, resource: SharedBrowserSchema.Resource, lease: SharedBrowserSchema.Lease, host: BrowserHost.Interface,
) {
  yield* requireOutsideTransaction(db)
  const original: SharedEntry = { kind: "shared-v2", active: true, resource, lease, host, db }
  yield* nativeSharedCurrent(original)
  const entry = yield* db.transaction((tx) => Effect.gen(function* () {
    yield* BrowserControl.requireScope(tx, resource.scope)
    const current = yield* SharedBrowserControl.requireActive(tx, resource.resourceID, resource.scope)
    if (SharedBrowserFileBinding.hash(current.resource) !== SharedBrowserFileBinding.hash(resource) ||
      SharedBrowserFileBinding.hash(current.lease) !== SharedBrowserFileBinding.hash(lease)) return yield* denied()
    return { ...original, resource: current.resource, lease: current.lease }
  }), { behavior: "immediate" })
  yield* nativeSharedCurrent(entry)
  return yield* Effect.acquireRelease(Effect.sync(() => {
    const handle = Object.freeze({}) as Lease
    leases.set(handle, entry)
    return handle
  }), (handle) => Effect.sync(() => { entry.active = false; leases.delete(handle) }))
})

function requireSharedCurrent(db: Reader, handle: Lease) {
  return Effect.gen(function* () {
    const entry = leases.get(handle)
    if (entry?.kind !== "shared-v2" || entry.db !== db) return yield* denied()
    yield* requireOutsideTransaction(db)
    yield* nativeSharedCurrent(entry)
    yield* db.transaction((tx) => Effect.gen(function* () {
      yield* BrowserControl.requireScope(tx, entry.resource.scope)
      const current = yield* SharedBrowserControl.requireActive(tx, entry.resource.resourceID, entry.resource.scope)
      if (!entry.active || leases.get(handle) !== entry ||
        SharedBrowserFileBinding.hash(current.resource) !== SharedBrowserFileBinding.hash(entry.resource) ||
        SharedBrowserFileBinding.hash(current.lease) !== SharedBrowserFileBinding.hash(entry.lease)) return yield* denied()
    }), { behavior: "immediate" })
    yield* nativeSharedCurrent(entry)
  }).pipe(Effect.mapError(() => denied()))
}

function requireOutsideTransaction(db: Reader) {
  return Effect.gen(function* () {
    if (!("$client" in db) || Option.isSome(yield* Effect.serviceOption(db.$client.transactionService)))
      return yield* denied()
  })
}

function nativeSharedCurrent(entry: SharedEntry) {
  return Effect.gen(function* () {
    const files = entry.host.shared?.files
    const current = () => entry.active && entry.host.alive() && entry.host.shared?.files === files &&
      entry.host.shared?.mainIncarnation === entry.resource.mainIncarnation &&
      entry.host.hostIncarnation === entry.lease.sidecarIncarnation && entry.host.principal === entry.resource.scope.principal &&
      entry.lease.resourceID === entry.resource.resourceID && entry.lease.mainIncarnation === entry.resource.mainIncarnation &&
      entry.resource.liveLeaseID === entry.lease.leaseID && entry.resource.manualEpoch === entry.lease.manualEpoch &&
      entry.resource.state === "agent_owned" && entry.lease.state === "active" && entry.resource.resourceAlive &&
      !entry.resource.agentAccessFenced && !entry.resource.manualEnabled &&
      Math.min(entry.resource.expiresAt, entry.lease.expiresAt) > Date.now()
    if (!files || !current()) return yield* denied()
    yield* files.current(entry.resource, entry.lease).pipe(Effect.mapError(() => denied()))
    if (!current()) return yield* denied()
  })
}

function nativeCurrent(entry: Pick<Entry, "control" | "host">) {
  if (!entry.host.alive() || entry.host.hostID !== entry.control.hostID ||
    entry.host.hostIncarnation !== entry.control.hostIncarnation || entry.host.credentialBinding !== entry.control.credentialBinding ||
    entry.control.state !== "active" || entry.control.cancel !== null || entry.control.expiresAt <= Date.now()) return false
  const current = entry.host.verify(entry.control)
  return current.matched && !current.stopped && entry.host.alive() &&
    entry.host.hostID === entry.control.hostID && entry.host.hostIncarnation === entry.control.hostIncarnation &&
    entry.host.credentialBinding === entry.control.credentialBinding && entry.control.expiresAt > Date.now()
}
