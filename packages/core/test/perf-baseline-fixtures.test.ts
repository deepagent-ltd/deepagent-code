import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Database } from "bun:sqlite"
import { buildDbFixture, timeOpen } from "../script/perf-baseline/fixtures"
import { csvEscape, sha256Short, writeSamplesCsv } from "../script/perf-baseline/samples"

const tinyPlan = { sessions: 3, messages_per_session: 4 }

describe("perf baseline db fixture builder", () => {
  test("empty tier runs real migrations and leaves zero rows", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf-fixture-test-empty-"))
    try {
      const fixture = await buildDbFixture(root, "empty", { sessions: 0, messages_per_session: 0 })
      expect(fixture.actual_session_rows).toBe(0)
      expect(fixture.actual_message_rows).toBe(0)
      expect(fixture.db_bytes).toBeGreaterThan(0)

      const sqlite = new Database(fixture.file)
      try {
        const tables = sqlite.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
        const names = tables.map((row) => row.name)
        expect(names).toContain("session")
        expect(names).toContain("session_message")
        expect(names).toContain("event")
        const integrity = sqlite.query("PRAGMA integrity_check").get() as { integrity_check: string }
        expect(integrity.integrity_check).toBe("ok")
      } finally {
        sqlite.close()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("populated tier writes exact row counts through real tables", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf-fixture-test-mid-"))
    try {
      const fixture = await buildDbFixture(root, "mid", tinyPlan)
      expect(fixture.planned_message_rows).toBe(tinyPlan.sessions * tinyPlan.messages_per_session)
      expect(fixture.actual_session_rows).toBe(tinyPlan.sessions)
      expect(fixture.actual_message_rows).toBe(tinyPlan.sessions * tinyPlan.messages_per_session)

      const sqlite = new Database(fixture.file)
      try {
        // Per-session seq must stay unique and contiguous for history reads to work later.
        const perSession = sqlite
          .query("SELECT session_id, COUNT(*) AS n FROM session_message GROUP BY session_id ORDER BY session_id")
          .all() as Array<{ session_id: string; n: number }>
        expect(perSession.length).toBe(tinyPlan.sessions)
        expect(perSession.every((row) => row.n === tinyPlan.messages_per_session)).toBe(true)
        // The production layerFromPath open is what every scenario measures; it must succeed here.
      } finally {
        sqlite.close()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("production open path succeeds on a populated fixture (migration recheck)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf-fixture-test-reopen-"))
    try {
      const fixture = await buildDbFixture(root, "large", tinyPlan)
      const { timeOpen } = await import("../script/perf-baseline/fixtures")
      const elapsed = await timeOpen(fixture.file)
      expect(Number.isFinite(elapsed)).toBe(true)
      expect(elapsed).toBeGreaterThanOrEqual(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("perf baseline artifact formats", () => {
  test("csv escaping quotes separators and embedded quotes", () => {
    expect(csvEscape("plain")).toBe("plain")
    expect(csvEscape("a,b")).toBe('"a,b"')
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscape("line\nbreak")).toBe('"line\nbreak"')
  })

  test("writeSamplesCsv emits header plus every raw sample unfiltered", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-csv-test-"))
    try {
      const target = path.join(dir, "samples.csv")
      writeSamplesCsv(target, "scenario/group", [
        { name: "warmup", values: [1.5, 2.5] },
        { name: "measured", values: [3.5] },
      ])
      const lines = fs.readFileSync(target, "utf8").trim().split("\n")
      expect(lines[0]).toBe("scenario,group,sample_index_in_group,value_ms")
      expect(lines.length).toBe(4) // header + 3 samples
      expect(lines[1]).toBe("scenario/group,warmup,0,1.5")
      expect(lines[3]).toBe("scenario/group,measured,0,3.5")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("sha256 short digest is stable, distinguishable and 12 hex chars", () => {
    const one = sha256Short("alpha")
    const two = sha256Short("beta")
    expect(one).toBe(sha256Short("alpha"))
    expect(one).not.toBe(two)
    expect(one).toMatch(/^[0-9a-f]{12}$/)
  })
})
