import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

const start = Date.UTC(2026, 9, 6, 23, 30)
const due = Date.UTC(2026, 9, 7, 6)

test("quiet defer survives SIGKILL and separate file-DB processes before and after the logical deadline", async () => {
  await using rig = await fixture()
  const p1 = await rig.launch("seed", start)
  expect(rig.snapshot()).toMatchObject({
    events: 1,
    probes: 0,
    receipts: 0,
    inputs: 0,
    sessions: 0,
    providers: 0,
    delivery: { status: "pending", attempts: 0, next_attempt_at: due, claim_token: null },
  })
  const eventID = rig.snapshot().eventID
  p1.kill("SIGKILL")
  await p1.exited
  expect(p1.signalCode).toBe("SIGKILL")

  const p2 = await rig.launch("resume", due - 1)
  expect(rig.snapshot()).toMatchObject({
    eventID,
    events: 1,
    probes: 0,
    receipts: 0,
    delivery: { status: "pending", next_attempt_at: due },
  })
  p2.kill("SIGKILL")
  await p2.exited

  const p3 = await rig.launch("resume", due)
  expect(rig.snapshot()).toMatchObject({
    eventID,
    events: 1,
    probes: 1,
    probeRows: [{ goal_id: "goal-defer", seq: 0 }],
    receipts: 1,
    inputs: 0,
    sessions: 0,
    providers: 0,
    delivery: { status: "delivered", attempts: 0, next_attempt_at: null },
  })
  p3.kill("SIGKILL")
  await p3.exited

  const p4 = await rig.launch("resume", due + 1)
  expect(rig.snapshot()).toMatchObject({
    eventID,
    events: 1,
    probes: 1,
    receipts: 1,
    delivery: { status: "delivered", attempts: 0 },
  })
  console.log(
    "GOAL_DEFER_SIGKILL_PASS",
    JSON.stringify({
      clock: "injected logical UTC millis",
      database: "real isolated file DB",
      processes: [p1.pid, p2.pid, p3.pid, p4.pid],
      snapshot: rig.snapshot(),
    }),
  )
}, 60_000)

for (const phase of ["claim", "failure"] as const) {
  test(`${phase} before defer commit survives SIGKILL, respects the old lease and recovers the same obligation`, async () => {
    await using rig = await fixture()
    const p1 = await rig.launch(phase, start)
    const snapshot = rig.snapshot()
    expect(snapshot).toMatchObject({
      events: 1,
      probes: 0,
      receipts: 0,
      delivery: { status: "pending", attempts: 0, next_attempt_at: start, lease_expires_at: start + 1_000 },
    })
    expect(snapshot.delivery?.claim_token).toBeString()
    p1.kill("SIGKILL")
    await p1.exited
    expect(p1.signalCode).toBe("SIGKILL")
    const p2 = await rig.launch("resume", start + 999)
    expect(rig.snapshot()).toMatchObject({
      eventID: snapshot.eventID,
      probes: 0,
      receipts: 0,
      delivery: { claim_token: snapshot.delivery?.claim_token, next_attempt_at: start },
    })
    p2.kill("SIGKILL")
    await p2.exited
    const p3 = await rig.launch("resume", start + 1_000)
    expect(rig.snapshot()).toMatchObject({
      eventID: snapshot.eventID,
      events: 1,
      probes: 0,
      receipts: 0,
      delivery: { status: "pending", attempts: 0, next_attempt_at: due, claim_token: null },
    })
    p3.kill("SIGKILL")
    await p3.exited
    const p4 = await rig.launch("resume", due)
    expect(rig.snapshot()).toMatchObject({
      eventID: snapshot.eventID,
      events: 1,
      probes: 1,
      probeRows: [{ goal_id: "goal-defer", seq: 0 }],
      receipts: 1,
      inputs: 0,
      sessions: 0,
      providers: 0,
      delivery: { status: "delivered", attempts: 0 },
    })
    console.log(
      "GOAL_DEFER_PRECOMMIT_SIGKILL_PASS",
      JSON.stringify({
        phase,
        clock: "injected logical UTC millis",
        processes: [p1.pid, p2.pid, p3.pid, p4.pid],
        snapshot: rig.snapshot(),
      }),
    )
  }, 60_000)
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "goal-defer-process-"))
  await mkdir(path.join(root, "tmp"))
  const children: ReturnType<typeof Bun.spawn>[] = []
  const snapshot = () => {
    const db = new Database(path.join(root, "goal.sqlite"), { readonly: true })
    try {
      const count = (table: string) =>
        db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count
      return {
        eventID: db.query<{ id: string }, []>("SELECT id FROM deepagent_event").get()!.id,
        events: count("deepagent_event"),
        probes: count("goal_defer_probe"),
        receipts: count("deepagent_consumer_receipt"),
        probeRows: db.query<{ goal_id: string; seq: number }, []>("SELECT goal_id, seq FROM goal_defer_probe").all(),
        inputs: count("session_input"),
        sessions: count("session"),
        providers: count("session_provider_attempt"),
        delivery: db
          .query<
            {
              status: string
              attempts: number
              next_attempt_at: number | null
              claim_token: string | null
              lease_expires_at: number | null
            },
            []
          >(
            "SELECT status, attempts, next_attempt_at, claim_token, lease_expires_at FROM deepagent_event_delivery WHERE subscription_group = 'goal-tick-consumer'",
          )
          .get(),
      }
    } finally {
      db.close()
    }
  }
  return {
    snapshot,
    launch: async (phase: string, now: number) => {
      const ready = path.join(root, `ready-${children.length}.json`)
      const child = Bun.spawn(
        [
          process.execPath,
          path.resolve(import.meta.dir, "../fixture/goal-tick-defer-runtime.ts"),
          root,
          phase,
          String(now),
          ready,
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            TMPDIR: path.join(root, "tmp"),
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_STATE_HOME: path.join(root, "state"),
            DEEPAGENT_CODE_TEST_HOME: root,
            DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
            DEEPAGENT_IM_AGENT_RESPONDER: "off",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      children.push(child)
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      const deadline = performance.now() + 15_000
      while (!(await Bun.file(ready).exists())) {
        if (child.exitCode !== null) throw new Error(`Goal defer fixture exited: ${await stdout}\n${await stderr}`)
        if (performance.now() > deadline) {
          child.kill("SIGKILL")
          await child.exited
          throw new Error(`Goal defer fixture timed out: ${await stdout}\n${await stderr}`)
        }
        await Bun.sleep(20)
      }
      const signal: { pid: number; now: number } = await Bun.file(ready).json()
      expect(signal).toMatchObject({ pid: child.pid, now })
      console.log(
        "GOAL_DEFER_RUNTIME_STAGE",
        JSON.stringify({ phase, pid: child.pid, logicalClock: now, snapshot: snapshot() }),
      )
      return child
    },
    [Symbol.asyncDispose]: async () => {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL")
      await Promise.all(children.map((child) => child.exited))
      await rm(root, { recursive: true, force: true })
    },
  }
}
