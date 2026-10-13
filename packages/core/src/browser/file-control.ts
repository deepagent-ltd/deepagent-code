export * as BrowserFileControl from "./file-control"

import { and, eq, isNull, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { SecurityNamespaceTable, LocationIdentityTable, ProjectScopeIdentityTable } from "../context-federation/sql"
import { SessionTable } from "../session/sql"
import { SessionSchema } from "../session/schema"
import { BrowserControlTable } from "./browser.sql"
import { BrowserControl } from "./control"
import type { BrowserHost } from "./host"
import type { BrowserSchema } from "./schema"

type Db = Database.Interface["db"]
type Reader = Db | Parameters<Parameters<Db["transaction"]>[0]>[0]
type Host = Pick<BrowserHost.Interface, "hostID" | "hostIncarnation" | "credentialBinding" | "alive" | "verify">
declare const lease: unique symbol
export type Lease = { readonly [lease]: true }
type Entry = {
  active: boolean
  control: BrowserSchema.Control
  host: Host
  row: typeof BrowserControlTable.$inferSelect
}
const leases = new WeakMap<Lease, Entry>()
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
    return { active: true, control: current, host, row }
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
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const entry = leases.get(handle)
    if (!entry?.active || !nativeCurrent(entry)) return yield* denied()
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

function nativeCurrent(entry: Pick<Entry, "control" | "host">) {
  if (!entry.host.alive() || entry.host.hostID !== entry.control.hostID ||
    entry.host.hostIncarnation !== entry.control.hostIncarnation || entry.host.credentialBinding !== entry.control.credentialBinding ||
    entry.control.state !== "active" || entry.control.cancel !== null || entry.control.expiresAt <= Date.now()) return false
  const current = entry.host.verify(entry.control)
  return current.matched && !current.stopped && entry.host.alive() &&
    entry.host.hostID === entry.control.hostID && entry.host.hostIncarnation === entry.control.hostIncarnation &&
    entry.host.credentialBinding === entry.control.credentialBinding && entry.control.expiresAt > Date.now()
}
