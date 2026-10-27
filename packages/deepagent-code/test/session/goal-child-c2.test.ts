import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function captureOutput(child: ReturnType<typeof spawn>) {
  const tail = { stdout: "", stderr: "" }
  const output = Promise.all((["stdout", "stderr"] as const).map((stream) => new Response(
    child[stream].pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        tail[stream] = (tail[stream] + Buffer.from(chunk).toString()).slice(-16_384)
        controller.enqueue(chunk)
      },
    })),
  ).text()))
  return { tail, output }
}

function spawn(root: string, scenario: string) {
  return Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.resolve(import.meta.dir, "../fixture/cli-secret-store.ts"),
      ...(process.platform === "win32"
        ? ["--preload", path.resolve(import.meta.dir, "../fixture/source-empty-settings-preload.ts")]
        : []),
      path.resolve(import.meta.dir, "../fixture/goal-child-c2-host.ts"),
      root,
      scenario,
    ],
    {
      cwd: path.join(root, "project"),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        TMP: path.join(root, "tmp"),
        TEMP: path.join(root, "tmp"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        DEEPAGENT_CODE_TEST_HOME: process.platform === "win32" ? root : path.join(root, "home"),
        DEEPAGENT_CODE_HOME: path.join(root, "data"),
        DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
        DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
        DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
        DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1",
        DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "",
        DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY: "",
        DEEPAGENT_IM_AGENT_RESPONDER: "off",
        NO_COLOR: "1",
      },
    },
  )
}

for (const scenario of [
  "manager-default",
  "manager-tests",
  "manager-status-publish-failure",
  "plain",
  "structured",
  "plan",
  "validation",
  "validation-deny",
  "validation-admin-deny",
  "validation-external-deny",
  "validation-ask-stop",
  "validation-ask-agent",
  "validation-ask-roster",
  "validation-ask-cwd",
  "validation-cancel",
  "validation-control",
  "initialize",
  "initialize-conflict",
  "initial-selection-markdown",
  "initial-selection-stored",
  "initial-selection-active",
  "initial-selection-done",
  "initial-selection-source-conflict",
  "initial-selection-cas-conflict",
  "program",
  "loop",
  "loop-failed",
  "loop-proposal",
  "loop-proposal-two",
  "loop-proposal-two-uncovered",
  "loop-proposal-two-mutated",
  "loop-proposal-two-broad",
  "loop-proposal-two-unknown",
  "loop-capacity",
  "loop-initial-mutated",
  "loop-proposal-only",
  "loop-proposal-diagnostics",
  "loop-proposal-diagnostics-stale",
  "loop-proposal-mutated",
  "loop-unverifiable",
  "loop-stop",
  "loop-missing-usage",
  "steer-valid",
  "steer-unsupported",
  "steer-aba",
]) {
  test(`C2 actual owned role program: ${scenario}`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-c2-host-")))
    await Promise.all(
      ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
    )
    const startedAt = Date.now()
    const child = spawn(root, scenario)
    const captured = ["loop", "loop-failed", "steer-valid", "loop-stop", "loop-proposal-two",
      "loop-proposal-diagnostics-stale"].includes(scenario) ? captureOutput(child) : undefined
    const output = captured?.output ?? Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45000)
    try {
      const status = await child.exited
      const log = (await output).join("\n")
      await Bun.write(path.join(root, "output.log"), log)
      expect({ status, log, root }, captured ? JSON.stringify({ phase: "child-exited", scenario,
        elapsedMs: Date.now() - startedAt, status, pid: child.pid, output: captured.tail }) : undefined)
        .toMatchObject({ status: 0 })
      const result = await Bun.file(path.join(root, "result.json")).json()
      if (scenario.startsWith("initial-selection-")) {
        expect(result.requests).toBe(0)
        expect(result.result.inputs).toEqual([])
        expect(result.result.units).toEqual([])
        expect(result.result.active).toEqual([])
      } else if (scenario === "loop-capacity" || scenario === "loop-initial-mutated") {
        expect(result.requests).toBe(0)
        expect(result.result.inputs).toEqual([])
        expect(result.result.units).toEqual([])
        expect(result.result.checkpoints).toEqual([])
        expect(result.result.active).toEqual([])
      } else if (scenario === "manager-tests" && process.platform !== "darwin") {
        expect(result.requests).toBe(1)
        expect(result.result.inputs).toHaveLength(1)
        expect(result.result.units).toHaveLength(1)
        expect(result.result.units[0].state).toBe("result_recorded")
        expect(result.result.checkpoint.state).toBe("recovery_required")
        expect(result.result.checkpoint.journal.localEffects).toEqual([])
        expect(result.result.checkpoint.journal.nextState).toBeNull()
        expect(result.result.status.recoveryRequired).toBe(true)
        expect(result.result.status.phase).not.toBe("done")
        expect(result.result.failures).toEqual([{ status: "pending", last_error: "Owned validation is unavailable" }])
        expect(result.result.validationCustody).toMatchObject({ live: 0, quarantine: 0 })
        expect(result.result.active).toEqual([])
      } else if (scenario.startsWith("manager")) {
        expect(result.requests).toBe(scenario === "manager-tests" ? 3 : 1)
        expect(result.result.inputs).toHaveLength(scenario === "manager-tests" ? 3 : 1)
        expect(result.result.checkpoint.state).toBe("committed")
        expect(JSON.parse(result.result.checkpoint.journal.nextState).phase).toBe(
          scenario === "manager-tests" ? "done" : "needs_human",
        )
        expect(result.result.active).toEqual([])
      } else if (process.platform !== "darwin" && ["loop", "loop-failed", "steer-valid"].includes(scenario)) {
        expect(result.requests).toBe(1)
        expect(result.result.refusal).toBe("PROFILE_UNAVAILABLE")
        expect(result.result.checkpoint.state).toBe("recovery_required")
        expect(result.result.checkpoint.journal.localEffects).toEqual([])
        expect(result.result.checkpoint.journal.nextState).toBeNull()
        expect(result.result.permit.state).toBe("unknown")
        expect(result.result.status.recoveryRequired).toBe(true)
        expect(result.result.status.phase).not.toBe("done")
        expect(result.result.inputs).toHaveLength(1)
        expect(result.result.units).toHaveLength(1)
        expect(result.result.units[0].state).toBe("result_recorded")
        expect(result.result.validationCustody).toMatchObject({ live: 0, quarantine: 0 })
        expect(result.result.active).toEqual([])
        if (scenario === "steer-valid") {
          expect(result.result.steers).toHaveLength(2)
          expect(result.result.steers.map((row: { id: string }) => row.id)).toEqual(result.result.frozenSteerIDs)
          expect(result.result.checkpoint.journal.parent.steering.rows.map((row: { id: string }) => row.id))
            .toEqual([result.result.steers[0].id])
          expect(result.result.steers[0].consumed_seq).toBeNull()
          expect(result.result.steers[1].consumed_seq).toBeNull()
        }
      } else if (scenario.startsWith("steer")) {
        expect(result.requests).toBe(scenario === "steer-valid" ? 1 : 0)
        expect(result.result.inputs).toHaveLength(scenario === "steer-valid" ? 1 : 0)
        expect(result.result.active).toEqual([])
        expect(result.result.steers[0].consumed_seq === null).toBe(scenario !== "steer-valid")
        if (scenario === "steer-valid") expect(result.result.steers[1].consumed_seq).toBeNull()
      } else if (
        scenario === "loop-stop" ||
        scenario === "loop-missing-usage" ||
        scenario === "loop-proposal-mutated" ||
        scenario === "loop-proposal-two-broad" ||
        scenario === "loop-proposal-two-unknown"
      ) {
        expect(result.requests).toBe(
          scenario === "loop-proposal-mutated" ||
            scenario === "loop-proposal-two-broad" ||
            scenario === "loop-proposal-two-unknown"
            ? 2
            : 1,
        )
        expect(result.result.inputs).toHaveLength(1)
        expect(result.result.checkpoint.state).toBe("recovery_required")
        expect(result.result.checkpoint.journal.results).toHaveLength(scenario === "loop-proposal-two-broad" ? 1 : 0)
        expect(result.result.checkpoint.journal.localEffects).toEqual([])
        expect(result.result.checkpoint.journal.documents).toEqual([])
        expect(result.result.active).toEqual([])
        if (scenario === "loop-stop") expect(result.result.control.requested_phase).toBe("stopped")
      } else if (scenario === "loop-proposal-two-uncovered" || scenario === "loop-proposal-two-mutated") {
        expect(result.requests).toBe(scenario.endsWith("uncovered") ? 2 : 4)
        expect(result.result.inputs).toHaveLength(scenario.endsWith("uncovered") ? 1 : 3)
        expect(result.result.checkpoint.state).toBe("committed")
        expect(result.result.active).toEqual([])
      } else if (scenario === "loop-proposal-two") {
        expect(result.requests).toBe(8)
        expect(result.result.inputs).toHaveLength(6)
        expect(JSON.parse(result.result.first.journal.nextState).phase).toBe("running")
        expect(JSON.parse(result.result.checkpoint.journal.nextState).phase).toBe("done")
        expect(result.result.active).toEqual([])
      } else if (scenario.startsWith("loop-proposal-diagnostics")) {
        expect(result.result.checkpoint.state).toBe("committed")
        const state = JSON.parse(result.result.checkpoint.journal.nextState)
        expect(state.phase).toBe(scenario.endsWith("stale") ? "needs_human" : "done")
        expect(result.requests).toBe(2)
        expect(result.result.inputs).toHaveLength(1)
        const worklog = result.result.checkpoint.journal.documents.find((item: { documentID: string }) =>
          item.documentID.startsWith("doc:worklog:"),
        )
        const diagnostics = JSON.parse(JSON.parse(worklog.payload).body).diagnostics
        expect(diagnostics.scope).toBe("explicit_code_refs")
        expect(diagnostics.sources).toHaveLength(scenario.endsWith("stale") ? 0 : 1)
        expect(diagnostics.state).toBe(scenario.endsWith("stale") ? "unavailable" : "checked")
        expect(result.result.active).toEqual([])
      } else if (
        scenario === "loop-proposal" ||
        scenario === "loop-proposal-only" ||
        scenario === "loop-unverifiable"
      ) {
        expect(result.result.checkpoint.state).toBe("committed")
        const state = JSON.parse(result.result.checkpoint.journal.nextState)
        expect(state.phase).toBe(scenario === "loop-proposal" ? "done" : "needs_human")
        expect(result.requests).toBe(scenario === "loop-proposal" ? 4 : scenario === "loop-proposal-only" ? 2 : 1)
        expect(result.result.inputs).toHaveLength(scenario === "loop-proposal" ? 3 : 1)
        expect(result.result.active).toEqual([])
        if (scenario === "loop-proposal") {
          const input = JSON.parse(result.result.units[0].inputs)[0]
          expect(input.proposal.documentVersion).toBe(2)
          expect(input.proposal.toolCallID).toBe("call_c2_plan")
        } else
          expect(
            state.gaps.some((gap: string) =>
              gap.includes(
                scenario === "loop-proposal-only" ? "independently verifiable" : "no checked content revision",
              ),
            ),
          ).toBeTrue()
      } else if (scenario.startsWith("loop")) {
        expect(result.result.checkpoint.state).toBe("committed")
        const state = JSON.parse(result.result.checkpoint.journal.nextState)
        expect(state.phase).toBe(scenario === "loop" ? "done" : "running")
        expect(result.requests).toBe(scenario === "loop" ? 9 : 1)
        expect(result.result.inputs).toHaveLength(scenario === "loop" ? 9 : 1)
        expect(
          result.result.checkpoint.journal.dispositions.filter((item: { kind: string }) => item.kind === "skipped"),
        ).toHaveLength(scenario === "loop" ? 3 : 7)
        expect(
          result.result.checkpoint.journal.documents.every((item: { state: string }) => item.state === "confirmed"),
        ).toBeTrue()
        expect(result.result.active).toEqual([])
      } else if (scenario.startsWith("initialize")) {
        expect(result.requests).toBe(0)
        expect(result.result.inputs).toEqual([])
        expect(result.result.units).toEqual([])
        expect(result.result.active).toEqual([])
        expect(result.result.initialization.preparation).toBe(scenario === "initialize" ? "ready" : "preparing")
        expect(result.result.initialization.initialization.executionContract).toBe("owned-goal-v2")
      } else if (scenario.startsWith("validation")) {
        expect(result.requests).toBe(0)
        expect(result.result.inputs).toEqual([])
        expect(result.result.units).toEqual([])
        expect(result.result.active).toEqual([])
        if (process.platform !== "darwin") {
          expect(result.result.refusal).toBe("PROFILE_UNAVAILABLE")
          expect(result.result.checkpoint.state).toBe("recovery_required")
          expect(result.result.checkpoint.journal.localEffects).toEqual([])
          expect(result.result.validationCustody).toMatchObject({ live: 0, quarantine: 0 })
          return
        }
        expect(result.result.checkpoint.journal.localEffects).toHaveLength(1)
        const receipt = result.result.checkpoint.journal.localEffects[0]
        expect(receipt.containment).toBe("single-process")
        expect(receipt.state).toBe(
          scenario === "validation"
            ? "exited"
            : ["validation-deny", "validation-admin-deny", "validation-external-deny"].includes(scenario) ||
                scenario.startsWith("validation-ask-")
              ? "cancelled_before_dispatch"
              : "stop_confirmed",
        )
        expect(receipt.outcome).toBe(scenario === "validation" ? "passed" : "cancelled")
        expect(receipt.stopProof).toBe(
          scenario === "validation"
            ? "not_requested"
            : ["validation-deny", "validation-admin-deny", "validation-external-deny"].includes(scenario) ||
                scenario.startsWith("validation-ask-")
              ? "not_started"
              : "owned_process_exit",
        )
        expect(result.result.checkpoint.state).toBe(scenario === "validation" ? "running" : "recovery_required")
      } else {
        expect(result.requests).toBe(scenario === "structured" ? 3 : scenario === "plan" ? 2 : 1)
        expect(result.result.checkpoint.journal.cursor.role).toBe(1)
        expect(result.result.checkpoint.journal.results).toHaveLength(scenario === "structured" ? 3 : 1)
        expect(result.result.inputs).toHaveLength(scenario === "structured" ? 3 : 1)
        expect(result.result.units[0].state).toBe("result_recorded")
        expect(result.result.active).toEqual([])
        if (scenario === "plan") expect(result.result.checkpoint.journal.results[0].tools.count).toBe(1)
      }
      if (process.env.DEEPAGENT_TEST_C2_EVIDENCE)
        await fs.cp(root, path.join(process.env.DEEPAGENT_TEST_C2_EVIDENCE, scenario), { recursive: true })
      await fs.rm(root, { recursive: true, force: true })
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
    }
  }, 50000)
}

for (const cold of ["mirror", "verified-step"])
  test(process.platform !== "darwin" && cold === "mirror"
    ? "C2 source mirror profile refusal remains blocked in a new host"
    : `C2 SIGKILL ${cold} recovers only committed evidence in a new host`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-c2-cold-")))
    await Promise.all(
      ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
    )
    const startedAt = Date.now()
    const first = spawn(root, cold === "mirror" ? "loop-cold" : "loop-proposal-two-cold")
    const firstCaptured = captureOutput(first)
    const firstOutput = firstCaptured.output
    if (process.platform !== "darwin" && cold === "mirror") {
      const firstTimeout = setTimeout(() => first.kill("SIGKILL"), 30000)
      try {
        const code = await first.exited
        clearTimeout(firstTimeout)
        const log = (await firstOutput).join("\n")
        await Bun.write(path.join(root, "first.log"), log)
        expect({ code, log, root }).toMatchObject({ code: 0 })
        const refused = await Bun.file(path.join(root, "result.json")).json()
        expect(refused.requests).toBe(1)
        expect(refused.result.refusal).toBe("PROFILE_UNAVAILABLE")
        expect(refused.result.checkpoint.state).toBe("recovery_required")
        expect(refused.result.checkpoint.journal.localEffects).toEqual([])
        expect(refused.result.checkpoint.journal.nextState).toBeNull()
        expect(refused.result.permit.state).toBe("unknown")
        expect(refused.result.status.recoveryRequired).toBe(true)
        expect(refused.result.status.phase).not.toBe("done")
        expect(refused.result.inputs).toHaveLength(1)
        expect(refused.result.units).toHaveLength(1)
        expect(refused.result.units[0].state).toBe("result_recorded")
        expect(refused.result.validationCustody).toMatchObject({ live: 0, quarantine: 0 })
        expect(refused.result.active).toEqual([])
        expect(refused.result.noMirrorCAS).toBe(true)
        expect(await Bun.file(path.join(root, "cold-window.json")).exists()).toBe(false)
        const second = spawn(root, "loop-cold-recover")
        const secondCaptured = captureOutput(second)
        const timeout = setTimeout(() => second.kill("SIGKILL"), 30000)
        try {
          const code = await second.exited
          const log = (await secondCaptured.output).join("\n")
          await Bun.write(path.join(root, "second.log"), log)
          expect({ code, log, root }).toMatchObject({ code: 0 })
          const result = await Bun.file(path.join(root, "result.json")).json()
          expect(second.pid).not.toBe(first.pid)
          expect(result.requests).toBe(0)
          expect(result.result.refusal).toBe("recovery_required")
          expect(result.result.checkpoint.state).toBe("recovery_required")
          expect(result.result.checkpoint.journal.localEffects).toEqual([])
          expect(result.result.checkpoint.journal.nextState).toBeNull()
          expect(result.result.permit.state).toBe("unknown")
          expect(result.result.inputs).toHaveLength(1)
          expect(result.result.units).toHaveLength(1)
          expect(result.result.units[0].state).toBe("result_recorded")
          expect(result.result.validationCustody).toMatchObject({ live: 0, quarantine: 0 })
          expect(result.result.active).toEqual([])
          expect(result.result.noMirrorCAS).toBe(true)
          expect(result.result.durableState).toEqual(refused.result.durableState)
        } finally {
          clearTimeout(timeout)
          if (second.exitCode === null && second.signalCode === null) second.kill("SIGKILL")
          await second.exited
          await secondCaptured.output
        }
        if (process.env.DEEPAGENT_TEST_C2_EVIDENCE)
          await fs.cp(root, path.join(process.env.DEEPAGENT_TEST_C2_EVIDENCE, "loop-cold-mirror"), { recursive: true })
        await fs.rm(root, { recursive: true, force: true })
      } finally {
        clearTimeout(firstTimeout)
        if (first.exitCode === null && first.signalCode === null) first.kill("SIGKILL")
        await first.exited
        await firstOutput
      }
      return
    }
    try {
      for (let n = 0; !(await Bun.file(path.join(root, "cold-window.json")).exists()); n++) {
        if (first.exitCode !== null || n >= 3000) throw new Error(`Cold window unavailable: ${root}; ${JSON.stringify({
          phase: "waiting-first-cold-window", cold, elapsedMs: Date.now() - startedAt, pid: first.pid,
          code: first.exitCode, signal: first.signalCode, output: firstCaptured.tail,
        })}`)
        await Bun.sleep(10)
      }
      const window = await Bun.file(path.join(root, "cold-window.json")).json()
      expect(window.pid).toBe(first.pid)
      first.kill("SIGKILL")
      await first.exited
      await Bun.write(path.join(root, "first.log"), (await firstOutput).join("\n"))
      const second = spawn(root, cold === "mirror" ? "loop-cold-recover" : "loop-proposal-two-recover")
      const secondCaptured = captureOutput(second)
      const secondOutput = secondCaptured.output
      const timeout = setTimeout(() => second.kill("SIGKILL"), 30000)
      const code = await second.exited
      clearTimeout(timeout)
      const log = (await secondOutput).join("\n")
      await Bun.write(path.join(root, "second.log"), log)
      expect({ code, log, root }, JSON.stringify({ phase: "cold-recovery-exited", cold,
        elapsedMs: Date.now() - startedAt, pid: second.pid, code, output: secondCaptured.tail }))
        .toMatchObject({ code: 0 })
      const result = await Bun.file(path.join(root, "result.json")).json()
      expect(result.requests).toBe(0)
      expect(result.result.checkpoint.state).toBe("committed")
      expect(result.result.inputs).toHaveLength(cold === "mirror" ? 9 : 3)
      expect(result.result.active).toEqual([])
      if (process.env.DEEPAGENT_TEST_C2_EVIDENCE)
        await fs.cp(root, path.join(process.env.DEEPAGENT_TEST_C2_EVIDENCE, `loop-cold-${cold}`), { recursive: true })
      await fs.rm(root, { recursive: true, force: true })
    } finally {
      if (first.exitCode === null) {
        first.kill("SIGKILL")
        await first.exited
      }
    }
  }, 60000)
