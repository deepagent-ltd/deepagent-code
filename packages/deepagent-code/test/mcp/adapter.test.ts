import { describe, expect, it } from "bun:test"
import { McpAdapter } from "@/mcp/adapter"

// M7 (S1-v3.4): risk-tier → permission derivation + fail-closed read-only SQL guard.
describe("mcp.adapter", () => {
  it("M7: read_only → allow; write_guarded / external_fetch → ask", () => {
    expect(McpAdapter.defaultPermissionForTier("read_only")).toBe("allow")
    expect(McpAdapter.defaultPermissionForTier("write_guarded")).toBe("ask")
    expect(McpAdapter.defaultPermissionForTier("external_fetch")).toBe("ask")
  })

  it("M7: unknown/undefined risk fails closed to write_guarded (→ ask)", () => {
    expect(McpAdapter.resolveToolRisk(undefined)).toBe("write_guarded")
    expect(McpAdapter.defaultPermissionForTier(McpAdapter.resolveToolRisk(undefined))).toBe("ask")
  })

  describe("M5: read-only SQL guard (fail-closed)", () => {
    const allowed = [
      "SELECT * FROM users",
      "  select id from t where x = 1 ",
      "EXPLAIN SELECT 1",
      "SHOW TABLES",
      "WITH cte AS (SELECT 1) SELECT * FROM cte",
      "SELECT * FROM t;", // trailing semicolon is fine
    ]
    for (const sql of allowed) {
      it(`allows: ${sql.trim().slice(0, 40)}`, () => {
        expect(McpAdapter.assertReadOnlySql(sql).allowed).toBe(true)
      })
    }

    const rejected = [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET x = 1",
      "DELETE FROM t",
      "DROP TABLE t",
      "ALTER TABLE t ADD COLUMN c int",
      "TRUNCATE t",
      "CREATE TABLE t (id int)",
      "GRANT ALL ON t TO u",
      "SELECT 1; DROP TABLE t", // multi-statement injection
      "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", // write hidden in CTE
      "", // empty
      "VACUUM", // not provably read-only
      "SELECT * INTO new_table FROM t", // SELECT…INTO creates a table (Postgres)
      "SELECT pg_sleep(30)", // side-effecting / DoS function
      "SELECT nextval('s')", // mutates a sequence
      "SELECT setval('s', 1)", // mutates a sequence
      "SELECT 1 /* ; DROP TABLE t */ ; DROP TABLE t", // write hidden after a comment + interior ;
      "SELECT 1; -- harmless\nDROP TABLE t", // write on a second line after a comment
      "/* c */ DELETE FROM t", // write hidden behind a leading block comment
    ]
    for (const sql of rejected) {
      it(`rejects: ${sql.slice(0, 40) || "(empty)"}`, () => {
        expect(McpAdapter.assertReadOnlySql(sql).allowed).toBe(false)
      })
    }
  })
})
