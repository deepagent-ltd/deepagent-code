import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { FSUtil } from "../src/fs-util"
import { LocationIdentity } from "../src/context-federation/identity"
import { SecurityNamespaceTable } from "../src/context-federation/sql"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { BrowserControl } from "../src/browser/control"
import { BrowserSchema } from "../src/browser/schema"

const profiles = [
  { profile: BrowserSchema.PUBLIC_READONLY_PROFILE },
  { profile: BrowserSchema.PUBLIC_INTERACTION_PROFILE, pageMode: "static", postTargets: [] },
  { profile: BrowserSchema.API_POST_PROFILE, pageMode: "static", apiPostTargets: [] },
] as const
const request = (index: number) => ({ requestID: `alidns-${index}`, sessionID: "ses_alidns",
  origin: "https://example.com", approvedOrigins: ["https://example.com"], resolverPolicy: "alidns_doh_v1",
  expiresAt: Date.now() + 60_000, ...profiles[index] })

test("AliDNS is an explicit fixed policy for all public profiles, without endpoint or fallback fields", () => {
  const decode = Schema.decodeUnknownOption(BrowserSchema.Create, { onExcessProperty: "error" })
  for (const index of [0, 1, 2]) {
    expect(Option.isSome(decode(request(index)))).toBeTrue()
    for (const change of [
      { resolverPolicy: undefined }, { resolverPolicy: "automatic" },
      { resolverPolicy: "https://dns.alidns.com/dns-query" },
      { resolverEndpoint: "https://other.example/dns-query" }, { fallbackResolver: "system" },
    ]) expect(Option.isNone(decode({ ...request(index), ...change }))).toBeTrue()
  }
})

test("original file-backed controls retain AliDNS across exact retry, resolver conflict and cold read-only reopen", async () => {
  const directory = await fs.realpath(await fs.mkdtemp("/tmp/dac-alidns-core-"))
  const filename = path.join(directory, "control.sqlite")
  const layer = () => LocationIdentity.layer.pipe(Layer.provideMerge(Database.layerFromPath(filename)),
    Layer.provide(FSUtil.defaultLayer))
  try {
    const records = await Effect.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: SessionSchema.ID.make("ses_alidns"), project_id: Project.ID.global,
        slug: "alidns", title: "AliDNS policy", directory, version: "fixture", v2_authority: true }).run()
      const identity = yield* (yield* LocationIdentity.Service).resolve({ boundary: { kind: "implicit_local" },
        directory: AbsolutePath.make(directory), project: { kind: "registered_root", observedProjectId: "project_alidns_root" } })
      const namespace = yield* db.select().from(SecurityNamespaceTable).where(eq(SecurityNamespaceTable.id, identity.securityNamespaceId)).get()
      const scope: BrowserSchema.Scope = { principal: "operator", securityNamespaceID: identity.securityNamespaceId,
        namespaceBindingHash: namespace!.binding_hash, locationKey: identity.locationKey, projectScopeKey: identity.projectScopeKey,
        projectID: Project.ID.global, sessionID: "ses_alidns", directory: identity.canonicalRoot, workspaceID: null }
      const output: BrowserSchema.Control[] = []
      for (const index of [0, 1, 2]) {
        const input = { request: Schema.decodeUnknownSync(BrowserSchema.Create)(request(index)), scope, hostID: "host",
          hostIncarnation: "incarnation", credentialBinding: "a".repeat(64) }
        const created = yield* BrowserControl.create(db, input)
        const control = yield* BrowserControl.observeControl(db, created.record, "active")
        expect("resolverPolicy" in control && control.resolverPolicy).toBe("alidns_doh_v1")
        expect((yield* BrowserControl.create(db, input)).created).toBeFalse()
        const changed = yield* BrowserControl.create(db, { ...input,
          request: Schema.decodeUnknownSync(BrowserSchema.Create)({ ...input.request, resolverPolicy: "system" }) }).pipe(Effect.exit)
        expect(Exit.isFailure(changed)).toBeTrue()
        if (Exit.isFailure(changed)) expect(Option.getOrUndefined(Cause.findErrorOption(changed.cause))?.code).toBe("BROWSER_CONFLICT")
        output.push(control)
      }
      return output
    }).pipe(Effect.provide(layer()), Effect.scoped))
    await Effect.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const before = yield* db.all("SELECT total_changes() AS n")
      for (const record of records) expect(yield* BrowserControl.get(db, record.controlID)).toEqual(record)
      expect(yield* db.all("SELECT total_changes() AS n")).toEqual(before)
      expect(yield* db.all("SELECT action_id FROM browser_action")).toEqual([])
    }).pipe(Effect.provide(layer()), Effect.scoped))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)
