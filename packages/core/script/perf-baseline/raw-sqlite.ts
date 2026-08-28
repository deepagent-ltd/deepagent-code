import { Database } from "bun:sqlite"

export interface PopulatePlan {
  readonly sessions: number
  readonly messages_per_session: number
}

/**
 * Bulk population of the real migrated `session` / `session_message` tables at
 * SQLite level. This module intentionally avoids importing the core Database
 * Effect service so the plain bun:sqlite driver binding stays unaliased.
 */
export const populateSessionTables = (file: string, plan: PopulatePlan) => {
  const sqlite = new Database(file)
  try {
    sqlite.exec("PRAGMA journal_mode = WAL")
    sqlite.exec("PRAGMA synchronous = OFF")
    sqlite.exec(
      "INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('proj_perf', '/tmp/perf-fixture-project', '[]', 1, 1)",
    )
    sqlite.exec("BEGIN")
    const insertSession = sqlite.prepare(
      "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    const insertMessage = sqlite.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    for (let s = 0; s < plan.sessions; s++) {
      const sessionId = `ses_perf_${s}`
      insertSession.run(sessionId, "proj_perf", `perf-${s}`, "/tmp/perf-fixture-project", `fixture session ${s}`, "2.0.0-alpha.0", 1, 1)
      // Half user turns, half assistant replies; payload size mirrors typical small messages.
      for (let m = 0; m < plan.messages_per_session; m++) {
        const role = m % 2 === 0 ? "user" : "assistant"
        insertMessage.run(`msg_${s}_${m}`, sessionId, role, m, 1 + m, 1 + m, JSON.stringify({ text: `fixture message ${m}`, tokens: { input: 10, output: 10 } }))
      }
    }
    sqlite.exec("COMMIT")
  } finally {
    sqlite.close()
  }
}

export interface TableCounts {
  readonly sessions: number
  readonly messages: number
  readonly integrity: string
}

export const countFixtureTables = (file: string): TableCounts => {
  const sqlite = new Database(file)
  try {
    const sessions = (sqlite.query("SELECT COUNT(*) AS n FROM session").get() as unknown as { n: number }).n
    const messages = (sqlite.query("SELECT COUNT(*) AS n FROM session_message").get() as unknown as { n: number }).n
    const integrity = (sqlite.query("PRAGMA integrity_check").get() as unknown as Record<string, string>).integrity_check
    return { sessions, messages, integrity }
  } finally {
    sqlite.close()
  }
}
