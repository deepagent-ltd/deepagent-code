/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import { PlanApproval } from "../../../src/component/plan-approval"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { useOpencodeModeStack } from "../../../src/keymap"
import { Hash } from "@deepagent-code/core/util/hash"
import { mountIM, until } from "../../fixture/im-environment"
import { tmpdir } from "../../fixture/fixture"

for (const scenario of ["question", "approved", "ordinary"] as const) {
  const kind = scenario === "ordinary" ? "question" : scenario
  test(`TUI ${scenario} presents original scope and copies the exact snapshot through its existing clipboard`, async () => {
    await using tmp = await tmpdir()
    const body = JSON.stringify({
      plan_id: "original-plan",
      session_id: "ses-original",
      goal: "Only original.ts",
      assumptions: [],
      steps: [{ step_id: "one", title: "Original step", status: "pending", acceptance: "Original test" }],
      active_step_id: null,
      created_at: "2026-10-14",
    })
    const digest = Hash.sha256(body)
    const text =
      scenario === "ordinary"
        ? "Ordinary exact question"
        : kind === "question"
          ? `Approve plan original-plan, version 1 (${digest})? Approval queues this exact version in the same Session. Later drafts will not replace it.\n\n${body}`
          : `The user approved the exact plan below for execution under the existing permissions. This approved snapshot is the execution request; later drafts are observations, not substitutes for the approved scope.\nPlan: original-plan; version: 1; SHA256: ${digest}\n\n${body}`
    const copied: string[] = []
    const server = Bun.serve({ port: 0, fetch: () => Response.json({}) })
    function View() {
      const modes = useOpencodeModeStack()
      onMount(() => {
        const pop = modes.push("question")
        onCleanup(pop)
      })
      return (
        <ClipboardProvider
          value={{
            write: async (value) => {
              copied.push(value)
            },
          }}
        >
          <PlanApproval
            text={text}
            sessionID="ses-original"
            kind={kind}
            approval={{ documentID: "original-doc", planID: "original-plan", version: 1, hash: digest }}
            fallback={<text>{text}</text>}
          />
        </ClipboardProvider>
      )
    }
    const ui = await mountIM(tmp.path, server.url.toString(), () => <View />)
    try {
      if (scenario === "ordinary") {
        await ui.frame("Ordinary exact question")
        ui.app.mockInput.pressKey("c")
        ui.app.mockInput.pressKey("v")
        await ui.app.renderOnce()
        expect(copied).toEqual([])
        expect(ui.app.captureCharFrame()).toContain("Ordinary exact question")
        return
      }
      const frame = await ui.frame(kind === "question" ? "Review this exact plan" : "Approved plan queued")
      expect(frame).toContain("Only original.ts")
      expect(frame).toContain("Original step")
      expect(frame).toContain("Original test")
      expect(frame).not.toContain('"plan_id"')
      if (kind === "question") {
        ui.app.mockInput.pressKey("PAGEDOWN")
        expect(await ui.frame("SHA256:")).toContain(digest.slice(0, 16))
        ui.app.mockInput.pressKey("c")
      }
      if (kind === "approved") {
        const lines = frame.split("\n")
        const row = lines.findIndex((line) => line.includes("Copy original snapshot"))
        expect(row).toBeGreaterThanOrEqual(0)
        await ui.app.mockMouse.click(lines[row]!.indexOf("Copy original snapshot") + 1, row)
      }
      await until(() => copied.length === 1)
      expect(copied).toEqual([body])
      if (kind === "question") {
        ui.app.mockInput.pressKey("v")
        expect(await ui.frame('"plan_id"')).toContain("Only original.ts")
      }
    } finally {
      ui.app.renderer.destroy()
      server.stop(true)
    }
  })
}
