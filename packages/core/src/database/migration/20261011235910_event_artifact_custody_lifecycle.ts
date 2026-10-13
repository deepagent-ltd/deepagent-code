import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Hash } from "../../util/hash"
import type { DatabaseMigration } from "../migration"

// These are the already-journaled trigger bytes. The forward contract does not
// import changing runtime schemas or rewrite any historical authority/custody row.
const originals = [
  ["event_work_node_header", "3f1332a10b9106a2b74dcaec1bdac413168fe5d5e1f90328b8e4545acc4bd473"],
  ["event_work_node_identity", "03af6038faf303e66dc11822c1ebaffb2bae9428640e3a6a55256523763c4745"],
  ["event_work_controller_identity", "95df70407655c65e7d068cc99f77c631b5b57dd681b94d338f1f773c43b4b33e"],
] as const

export default {
  id: "20261011235910_event_artifact_custody_lifecycle",
  up(tx) {
    return Effect.gen(function* () {
      if ((yield* tx.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys !== 1 ||
        (yield* tx.get<{ defer_foreign_keys: number }>("PRAGMA defer_foreign_keys"))?.defer_foreign_keys !== 0)
        return yield* Effect.die("Event artifact custody migration requires immediate FK-on storage")
      for (const [name, hash] of originals) {
        const original = yield* tx.get<{ sql: string }>(sql`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=${name}`)
        if (!original || Hash.sha256(original.sql) !== hash)
          return yield* Effect.die("Event artifact custody migration requires the original lifecycle triggers")
      }
      for (const [name] of originals) yield* tx.run(sql.raw(`DROP TRIGGER ${name}`))
      yield* tx.run(`CREATE TRIGGER event_work_node_header BEFORE INSERT ON event_work_node_authority
        WHEN json_extract(NEW.record,'$.kind') IS NOT 'event_dag_node_v1' OR
          json_extract(NEW.record,'$.authorityID') IS NOT NEW.authority_id OR json_extract(NEW.record,'$.receiptID') IS NOT NEW.receipt_id OR
          json_extract(NEW.record,'$.nodeID') IS NOT NEW.node_id OR json_extract(NEW.record,'$.childWorkID') IS NOT NEW.work_id OR
          json_type(NEW.record,'$.terminal') IS NOT NULL OR json_type(NEW.record,'$.artifactCustody') IS NOT NULL OR NEW.state IS NOT 'pending'
        BEGIN SELECT RAISE(ABORT,'event_dag_node_header'); END`)
      // Authority, placement and bindings remain immutable. These are accounting
      // transitions only; the original Core consumers still require Native facts.
      yield* tx.run(sql.raw(`CREATE TRIGGER event_work_node_identity BEFORE UPDATE ON event_work_node_authority
        WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.receipt_id IS NOT OLD.receipt_id OR NEW.node_id IS NOT OLD.node_id OR
          NEW.work_id IS NOT OLD.work_id OR NOT coalesce(
          json_remove(NEW.record,'$.terminal','$.artifactCustody') IS json_remove(OLD.record,'$.terminal','$.artifactCustody') AND (
            (OLD.state='pending' AND NEW.state='bound' AND NEW.record IS OLD.record) OR
            (OLD.state='bound' AND NEW.state='bound' AND json_type(OLD.record,'$.terminal') IS NULL AND json_type(NEW.record,'$.terminal') IS NULL
              AND json_type(OLD.record,'$.artifactCustody') IS NULL AND ${sealed("NEW.record")} AND json_type(NEW.record,'$.artifactCustody.cleanup') IS NULL) OR
            (OLD.state='bound' AND NEW.state='terminal' AND json_type(OLD.record,'$.terminal') IS NULL AND json_type(NEW.record,'$.terminal') IS 'object'
              AND json_extract(NEW.record,'$.artifactCustody') IS json_extract(OLD.record,'$.artifactCustody')) OR
            (OLD.state='terminal' AND NEW.state='terminal' AND json_extract(NEW.record,'$.terminal') IS json_extract(OLD.record,'$.terminal')
              AND json_type(OLD.record,'$.terminal') IS 'object' AND ${sealed("OLD.record")} AND ${sealed("NEW.record")}
              AND json_remove(json_extract(NEW.record,'$.artifactCustody'),'$.cleanup','$.worktreeAllocatedBytes')
                IS json_remove(json_extract(OLD.record,'$.artifactCustody'),'$.cleanup','$.worktreeAllocatedBytes') AND (
                (json_type(OLD.record,'$.artifactCustody.cleanup') IS NULL AND ${cleanup("NEW.record", "preparing")}
                  AND json_extract(NEW.record,'$.artifactCustody.worktreeAllocatedBytes') IS json_extract(OLD.record,'$.artifactCustody.worktreeAllocatedBytes')) OR
                (${cleanup("OLD.record", "preparing")} AND
                  json_extract(NEW.record,'$.artifactCustody.cleanup.startedAt') IS json_extract(OLD.record,'$.artifactCustody.cleanup.startedAt') AND (
                    (${cleanup("NEW.record", "unknown")} AND json_extract(NEW.record,'$.artifactCustody.worktreeAllocatedBytes')
                      IS json_extract(OLD.record,'$.artifactCustody.worktreeAllocatedBytes')) OR
                    (${cleanup("NEW.record", "collected")} AND json_extract(NEW.record,'$.artifactCustody.worktreeAllocatedBytes')
                      <= json_extract(OLD.record,'$.artifactCustody.worktreeAllocatedBytes'))))))),0)
        BEGIN SELECT RAISE(ABORT,'event_dag_node_immutable'); END`))
      const identities = ["controllerID", "receiptID", "rootWorkID", "rootSessionID", "rootInputID", "rootBindingHash", "plan", "planHash", "ruleHash", "epoch", "createdAt", "expiresAt"]
      yield* tx.run(sql.raw(`CREATE TRIGGER event_work_controller_identity BEFORE UPDATE ON event_work_controller
        WHEN NEW.controller_id IS NOT OLD.controller_id OR NEW.receipt_id IS NOT OLD.receipt_id OR NEW.root_work_id IS NOT OLD.root_work_id OR
          NEW.revision IS NOT OLD.revision+1 OR ${identities.map((field) => `json_extract(NEW.record,'$.${field}') IS NOT json_extract(OLD.record,'$.${field}')`).join(" OR ")} OR
          (OLD.state IN ('succeeded','failed') AND NOT coalesce(NEW.state IS OLD.state AND
            json_type(OLD.record,'$.activeNodeID') IS 'null' AND json_type(NEW.record,'$.activeNodeID') IS 'null' AND
            json_type(OLD.record,'$.baseline') IS 'object' AND json_extract(OLD.record,'$.baseline.state') IS 'sealed' AND
            json_type(OLD.record,'$.baseline.settledRetentionAt') IS NULL AND
            json_type(OLD.record,'$.baseline.allocatedBytes') IS 'integer' AND json_extract(OLD.record,'$.baseline.allocatedBytes') BETWEEN 0 AND 268435456 AND
            json_type(NEW.record,'$.baseline.settledRetentionAt') IS 'integer' AND
            json_extract(NEW.record,'$.baseline.settledRetentionAt') BETWEEN json_extract(OLD.record,'$.baseline.sealedAt') AND 9007199254740991 AND
            json_remove(NEW.record,'$.revision','$.baseline.settledRetentionAt') IS json_remove(OLD.record,'$.revision'),0))
        BEGIN SELECT RAISE(ABORT,'event_dag_controller_identity'); END`))
      if (yield* tx.get("SELECT * FROM pragma_foreign_key_check LIMIT 1"))
        return yield* Effect.die("Event artifact custody migration violates retained foreign keys")
    })
  },
} satisfies DatabaseMigration.Migration

function sealed(record: string) {
  const artifact = `json_extract(${record},'$.artifactCustody')`
  const field = (name: string) => `json_extract(${artifact},'$.${name}')`
  return `json_type(${record},'$.artifactCustody') IS 'object' AND
    NOT EXISTS(SELECT 1 FROM json_each(${artifact}) WHERE key NOT IN ('version','commit','manifestSha256','files','bytes','worktreeAllocatedBytes','gitAllocatedBytes','indexAllocatedBytes','sealedAt','cleanup')) AND
    json_type(${artifact},'$.version') IS 'integer' AND ${field("version")} IS 1 AND
    json_type(${artifact},'$.commit') IS 'text' AND length(CAST(${field("commit")} AS BLOB)) IN (40,64) AND ${field("commit")} NOT GLOB '*[^0-9a-f]*' AND
    json_type(${artifact},'$.manifestSha256') IS 'text' AND length(CAST(${field("manifestSha256")} AS BLOB))=64 AND ${field("manifestSha256")} NOT GLOB '*[^0-9a-f]*' AND
    ${["files", "bytes", "worktreeAllocatedBytes", "gitAllocatedBytes", "indexAllocatedBytes"].map((name) =>
      `json_type(${artifact},'$.${name}') IS 'integer' AND ${field(name)} BETWEEN 0 AND ${name === "files" ? 8192 : name === "bytes" ? 67108864 : 536870912}`).join(" AND ")} AND
    ${field("worktreeAllocatedBytes")}+${field("gitAllocatedBytes")}+${field("indexAllocatedBytes")}<=536870912 AND
    json_type(${artifact},'$.sealedAt') IS 'integer' AND ${field("sealedAt")} BETWEEN json_extract(${record},'$.createdAt') AND 9007199254740991`
}

function cleanup(record: string, state: "preparing" | "unknown" | "collected") {
  const value = `json_extract(${record},'$.artifactCustody.cleanup')`
  return `json_type(${record},'$.artifactCustody.cleanup') IS 'object' AND json_extract(${value},'$.state') IS '${state}' AND
    (SELECT count(*) FROM json_each(${value}))=${state === "collected" ? 3 : 2} AND
    json_type(${value},'$.startedAt') IS 'integer' AND json_extract(${value},'$.startedAt')
      BETWEEN json_extract(${record},'$.artifactCustody.sealedAt') AND 9007199254740991 AND
    ${state === "collected" ? `json_type(${value},'$.completedAt') IS 'integer' AND json_extract(${value},'$.completedAt') BETWEEN json_extract(${value},'$.startedAt') AND 9007199254740991`
      : `json_type(${value},'$.completedAt') IS NULL`}`
}
