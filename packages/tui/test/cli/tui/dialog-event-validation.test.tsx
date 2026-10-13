/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { mkdtemp } from "node:fs/promises"
import { ProjectProvider } from "../../../src/context/project"
import { createEventValidationOwner, DialogEventValidation } from "../../../src/component/dialog-event-validation"
import { mountIM, until } from "../../fixture/im-environment"

test("actual TUI and generated SDK capture, save disabled, and keep unknown control exact retry separate from reads", async () => {
  const root = await mkdtemp("/tmp/dac-validation-tui-")
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  const recipe = {
    logicalID: "project-tests",
    revision: 1,
    parameters: [{ key: "mode", choices: ["unit", "smoke"] }],
    inputs: ["test.ts"],
    outputs: [],
    argv: [{ kind: "literal", value: "test" }],
    executable: "installed-bun-v1",
    timeoutMs: 1000,
  }
  let saved = false
  let enabled = false
  let unknown = true
  let id = ""
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = request.method === "GET" ? undefined : ((await request.json()) as Record<string, unknown>)
      calls.push({ path, body })
      if (path.endsWith("/candidates"))
        return Response.json({ targets: [{ targetID: "approved-project", recipes: [recipe] }] })
      if (path.endsWith("/capture"))
        return Response.json({
          captureID: "preview-one",
          expiresAt: Date.now() + 60000,
          preview: {
            kind: "test",
            recipe,
            parameters: body?.parameters,
            watch: body?.watch,
            maxRuns: body?.maxRuns,
            ruleExpiresAt: body?.expiresAt,
          },
        })
      if (path.endsWith("/configure-captured")) {
        saved = true
        id = String(body?.ruleID)
        return Response.json({ receipt: { ruleID: id, requestID: body?.requestID, action: "create" }, replayed: false })
      }
      if (path.endsWith("/control")) {
        if (unknown) {
          unknown = false
          return Response.json({ code: "VALIDATION_UNAVAILABLE" }, { status: 503 })
        }
        enabled = true
        return Response.json({
          receipt: { ruleID: id, requestID: body?.requestID, action: body?.action },
          replayed: true,
        })
      }
      if (path.endsWith("/runs")) return Response.json([])
      if (path.endsWith("/rules"))
        return Response.json(
          saved
            ? [
                {
                  ruleID: id,
                  revision: enabled ? 2 : 1,
                  state: enabled ? "enabled" : "disabled",
                  contentRevision: 0,
                  runCount: 0,
                  currentRunID: null,
                  lastReason: "disabled",
                  configuration: {
                    scope: { canonicalRoot: root },
                    recipe,
                    watch: ["test.ts"],
                    maxRuns: 2,
                    expiresAt: Date.now() + 3600000,
                  },
                },
              ]
            : [],
        )
      return Response.json({})
    },
  })
  using rendered = await mountIM(
    root,
    server.url.origin,
    () => (
      <ProjectProvider>
        <DialogEventValidation sessionID="session-one" />
      </ProjectProvider>
    ),
    120,
  )
  const frame = async (text: string) => {
    for (let index = 0; index < 40; index++) rendered.app.mockInput.pressArrow("up", { ctrl: true })
    for (let index = 0; index < 80; index++) {
      await rendered.app.renderOnce()
      if (rendered.app.captureCharFrame().includes(text)) return rendered.app.captureCharFrame()
      rendered.app.mockInput.pressArrow("down", { ctrl: true })
      await Bun.sleep(10)
    }
    return rendered.frame(text)
  }
  const down = async (count: number) => {
    const deadline = Date.now() + 3000
    for (;;) {
      await rendered.app.renderOnce()
      const frame = rendered.app.captureCharFrame()
      if (!frame.includes("Loading current validation state") && !frame.includes("Sending the explicit request")) break
      if (Date.now() > deadline) throw new Error("Validation read remained pending")
      await Bun.sleep(10)
    }
    await Bun.sleep(20)
    for (let index = 0; index < count; index++) rendered.app.mockInput.pressArrow("down")
    await rendered.app.renderOnce()
    rendered.app.mockInput.pressEnter()
  }
  try {
    await rendered.frame("No configured validation rules")
    expect(calls.filter((call) => call.body)).toHaveLength(0)
    await down(1)
    await rendered.frame("approved-project")
    await down(2)
    await rendered.frame("smoke")
    await down(1)
    await rendered.frame("mode: smoke")
    await down(4)
    await rendered.type("2", true)
    rendered.app.mockInput.pressEnter()
    await rendered.frame("Review current project and rule")
    await rendered.frame("mode: smoke")
    await down(5)
    await rendered.type("0.25", true)
    rendered.app.mockInput.pressEnter()
    await rendered.frame("Review current project and rule")
    await down(3)
    await rendered.type("test.ts", true)
    rendered.app.mockInput.pressEnter()
    await rendered.frame("Review current project and rule")
    // Target, recipe, watch, budget, expiry, then explicit preview.
    await down(6)
    await rendered.frame("Save disabled rule")
    expect(calls.find((call) => call.path.endsWith("/capture"))?.body).toMatchObject({
      sessionID: "session-one",
      targetID: "approved-project",
      recipeID: "project-tests",
      parameters: [{ key: "mode", value: "smoke" }],
      watch: ["test.ts"],
      maxRuns: 2,
    })
    expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(0)
    rendered.app.mockInput.pressEnter()
    await rendered.frame("Rule saved disabled")
    expect(calls.find((call) => call.path.endsWith("/configure-captured"))?.body).toMatchObject({
      captureID: "preview-one",
      expectedRevision: 0,
    })
    await rendered.frame("Enable rule")
    await until(() => calls.filter((call) => call.path.endsWith("/runs")).length >= 1)
    await rendered.app.renderOnce()
    await Bun.sleep(20)
    await down(1)
    await frame("Confirm explicit action")
    rendered.app.mockInput.pressEnter()
    await rendered.frame("Retry original request")
    const original = calls.find((call) => call.path.endsWith("/control"))?.body
    // Refresh is read-only even while an explicit operation remains unknown.
    await down(0)
    await until(() => calls.filter((call) => call.path.endsWith("/rules")).length >= 3)
    expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(1)
    await down(1)
    await frame("Request accepted")
    expect(calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body)).toEqual([
      original,
      original,
    ])
    expect(original).toMatchObject({ action: "enable", expectedRevision: 1 })
  } finally {
    server.stop(true)
  }
}, 15000)

for (const mode of ["dark", "light"] as const)
  test(`24-row Chinese ${mode} dialog keeps long current scope and unavailable details reachable with actual keyboard`, async () => {
    const root =
      (await mkdtemp("/tmp/dac-validation-tui-small-")) +
      "/project-with-a-long-validation-scope-name-中文目录-and-another-component-for-wrap-check"
    const calls: Array<{ path: string; method: string }> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        calls.push({ path: new URL(request.url).pathname, method: request.method })
        return Response.json({ code: "VALIDATION_AUTH_REQUIRED" }, { status: 403 })
      },
    })
    using rendered = await mountIM(
      root,
      server.url.origin,
      () => (
        <ProjectProvider>
          <DialogEventValidation sessionID="session-small" />
        </ProjectProvider>
      ),
      80,
      undefined,
      { locale: "zh", mode },
    )
    try {
      rendered.app.renderer.resize(80, 24)
      await rendered.frame("项目验证")
      await until(() => calls.some((call) => call.path.endsWith("/rules")))
      await Bun.sleep(20)
      rendered.app.mockInput.pressArrow("down")
      rendered.app.mockInput.pressEnter()
      await until(() => calls.some((call) => call.path.endsWith("/candidates")))
      await Bun.sleep(20)
      const frames: string[] = []
      const colors: Array<{ foreground: string; background: string; intent: string }> = []
      for (let index = 0; index < 40; index++) {
        await rendered.app.renderOnce()
        frames.push(rendered.app.captureCharFrame())
        for (const span of rendered.app.captureSpans().lines.flatMap((line) => line.spans)) {
          if (!span.text.includes("已认证的本机操作者")) continue
          colors.push({
            foreground: span.fg.toInts().slice(0, 3).join(","),
            background: span.bg.toInts().slice(0, 3).join(","),
            intent: span.fg.intent,
          })
        }
        rendered.app.mockInput.pressArrow("down", { ctrl: true })
        await Bun.sleep(5)
      }
      expect(frames.some((frame) => frame.includes("Ctrl+↑/↓"))).toBe(true)
      expect(frames.some((frame) => frame.includes("已认证的本机操作者"))).toBe(true)
      expect(colors.length).toBeGreaterThan(0)
      expect(colors.every((color) => color.intent === "rgb" && color.foreground !== color.background)).toBe(true)
      expect(frames.join("\n")).toContain("component-for-wrap-check")
      expect(frames.join("\n")).not.toContain("没有可用")
      expect(frames.join("\n")).not.toContain("尚未配置验证规则")
      expect(
        calls.filter((call) =>
          ["/capture", "/configure-captured", "/control"].some((path) => call.path.endsWith(path)),
        ),
      ).toHaveLength(0)
      rendered.app.mockInput.pressEscape()
      await rendered.app.renderOnce()
      expect(rendered.app.captureCharFrame()).not.toContain("项目验证")
    } finally {
      server.stop(true)
    }
  }, 10000)

// Public protocol fixtures exercise the real renderer and generated SDK, not native authority.
const investigationTarget = {
  targetID: "approved-read-only",
  profile: { id: "event_investigate_v1", version: 1, hash: "approved-profile" },
  provider: { providerID: "approved-provider", modelID: "approved-model", routeID: "approved-route" },
  read: ["test/guard.test.ts"],
  budget: {
    maxTotalTokens: 32768,
    maxInputTokens: 16384,
    maxCompletionTokens: 4096,
    maxProviderDispatches: 8,
    maxToolCalls: 32,
    maxChildren: 0,
    maxDurationMs: 600000,
    hourTokensMax: 32768,
    hourWindowMinutes: 60,
  },
  durationMs: 600000,
}
const investigationRule = (root: string) => ({
  ruleID: "rule-one",
  revision: 1,
  state: "disabled",
  contentRevision: 2,
  runCount: 1,
  currentRunID: null,
  lastReason: "completed",
  configuration: {
    scope: { canonicalRoot: root },
    recipe: { logicalID: "project-tests" },
    watch: ["test/guard.test.ts"],
    maxRuns: 2,
    expiresAt: Date.now() + 3600000,
  },
})

for (const mode of ["dark", "light"] as const)
  test(`80x24 ${mode} investigation keyboard preserves expiry, exact unknown identity, null disable and original Session`, async () => {
    const root = await mkdtemp("/tmp/dac-investigation-tui-")
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
    const opened: string[] = []
    let epoch = 0
    let operatorRevision = 4
    let attempts = 0
    let nativeMissing = false
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        const body = request.method === "GET" ? undefined : ((await request.json()) as Record<string, unknown>)
        calls.push({ path, body })
        if (path.includes("/event-investigation/")) {
          if (path.endsWith("/candidates"))
            return Response.json({
              ruleID: "rule-one",
              ruleRevision: 1,
              epoch,
              operatorRevision,
              maxExpiresAt: Date.now() + 3600000,
              targets: [investigationTarget],
            })
          if (path.endsWith("/reports"))
            return Response.json(
              ["unknown", "pending"].map((outcome, index) => ({
                receiptID: `report-${index}`,
                failureKey: `failure-${index}`,
                runID: `original-run-${index}`,
                contentRevision: 2,
                contentHash: `original-content-${index}`,
                sessionID: `restricted-session-${index}`,
                grantEpoch: 1,
                createdAt: Date.now(),
                deadline: Date.now() + 600000,
                work: { admissionState: "ready", controlState: "active", controlRevision: 1, outcome },
              })),
            )
          if (path.endsWith("/capture")) {
            if (nativeMissing) return Response.json({ code: "VALIDATION_UNAVAILABLE" }, { status: 503 })
            return Response.json({
              captureID: "opaque-investigation-preview",
              expiresAt: Date.now() + 60000,
              preview: {
                ruleID: "rule-one",
                ruleRevision: 1,
                epoch,
                operatorRevision,
                grantExpiresAt: body?.expiresAt,
                target: investigationTarget,
              },
            })
          }
          if (path.endsWith("/control")) {
            if (body?.operation === "enable") {
              attempts++
              if (attempts === 1) return Response.json({ code: "VALIDATION_UNAVAILABLE" }, { status: 503 })
              if (attempts === 2) {
                epoch = 7
                operatorRevision = 99
                return Response.json({ code: "VALIDATION_CONFLICT" }, { status: 409 })
              }
            }
            epoch = Number(body?.expectedEpoch) + 1
            operatorRevision = 5
            return Response.json({
              receipt: {
                ruleID: body?.ruleID,
                requestID: body?.requestID,
                action: "update",
                investigation: { version: 1, operation: body?.operation, epoch },
              },
              replayed: attempts > 1,
            })
          }
        }
        if (path.endsWith("/runs")) return Response.json([])
        return Response.json([investigationRule(root)])
      },
    })
    using rendered = await mountIM(
      root,
      server.url.origin,
      () => (
        <ProjectProvider>
          <DialogEventValidation sessionID="session-current" onOpenSession={(id) => opened.push(id)} />
        </ProjectProvider>
      ),
      80,
      undefined,
      { mode },
    )
    const choose = async (down: number) => {
      await Bun.sleep(30)
      await rendered.app.renderOnce()
      for (let index = 0; index < down; index++) rendered.app.mockInput.pressArrow("down")
      await rendered.app.renderOnce()
      rendered.app.mockInput.pressEnter()
    }
    const scan = async (needle: string) => {
      for (let index = 0; index < 80; index++) rendered.app.mockInput.pressArrow("up", { ctrl: true })
      const colors: Array<{ foreground: string; background: string; intent: string }> = []
      const frames: string[] = []
      for (let index = 0; index < 80; index++) {
        await rendered.app.renderOnce()
        frames.push(rendered.app.captureCharFrame())
        for (const span of rendered.app.captureSpans().lines.flatMap((line) => line.spans))
          if (span.text.includes(needle))
            colors.push({
              foreground: span.fg.toInts().slice(0, 3).join(","),
              background: span.bg.toInts().slice(0, 3).join(","),
              intent: span.fg.intent,
            })
        rendered.app.mockInput.pressArrow("down", { ctrl: true })
        await Bun.sleep(3)
      }
      return { content: frames.join("\n"), colors }
    }
    try {
      rendered.app.renderer.resize(80, 24)
      await rendered.frame("project-tests")
      await choose(2)
      await choose(3)
      await rendered.frame("Capture investigation preview")
      expect(calls.filter((call) => call.body)).toHaveLength(0)
      const candidate = await scan("Investigation OFF")
      expect(candidate.content.includes("Native") && candidate.content.includes("availability")).toBe(true)
      await choose(3)
      await rendered.type("0.25", true)
      rendered.app.mockInput.pressEnter()
      await rendered.frame("Capture investigation preview")
      await choose(2)
      await rendered.frame("approved-read-only")
      await choose(0)
      await rendered.frame("Capture investigation preview")
      const started = Date.now()
      await choose(4)
      await rendered.frame("Enable investigation explicitly")
      const preview = await scan("Approved read scope")
      expect(preview.content).toContain("test/guard.test.ts")
      expect(preview.content).toContain("32768 / 16384 / 4096")
      expect(preview.content).toContain("approved-provider/approved-model")
      expect(preview.colors.length).toBeGreaterThan(0)
      expect(preview.colors.every((color) => color.intent === "rgb" && color.foreground !== color.background)).toBe(
        true,
      )
      const capture = calls.find((call) => call.path.endsWith("/capture"))?.body
      expect(capture).toMatchObject({ ruleID: "rule-one", targetID: "approved-read-only" })
      expect(Number(capture?.expiresAt) - started).toBeGreaterThanOrEqual(900000)
      expect(Number(capture?.expiresAt) - started).toBeLessThan(901000)
      expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(0)
      await choose(0)
      await rendered.frame("Retry original request")
      const original = calls.find((call) => call.path.endsWith("/control"))?.body
      expect(original).toMatchObject({
        operation: "enable",
        expectedEpoch: 0,
        expectedOperatorRevision: 4,
        targetID: "approved-read-only",
        captureID: "opaque-investigation-preview",
        expiresAt: capture?.expiresAt,
      })
      rendered.app.mockInput.pressArrow("up")
      await choose(0)
      await until(() => calls.filter((call) => call.path.endsWith("/candidates")).length >= 3)
      expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(1)
      await choose(1)
      await until(() => calls.filter((call) => call.path.endsWith("/control")).length === 2)
      await rendered.frame("Retry original request")
      await choose(0)
      await until(() => calls.filter((call) => call.path.endsWith("/control")).length === 3)
      await rendered.frame("Capture investigation preview")
      expect(calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body)).toEqual([
        original,
        original,
        original,
      ])
      nativeMissing = true
      await choose(4)
      await until(() => calls.filter((call) => call.path.endsWith("/capture")).length === 2)
      const unavailable = await scan("Investigation preview unavailable")
      expect(unavailable.content).toContain("VALIDATION_UNAVAILABLE")
      expect(unavailable.content).not.toContain("Enable investigation explicitly")
      await choose(1)
      await until(() => calls.filter((call) => call.path.endsWith("/control")).length === 4)
      await rendered.frame("Capture investigation preview")
      expect(calls.filter((call) => call.path.endsWith("/control"))[3]?.body).toMatchObject({
        operation: "disable",
        expectedEpoch: 1,
        expectedOperatorRevision: 5,
        targetID: null,
        expiresAt: null,
        captureID: null,
      })
      await choose(6)
      await rendered.frame("Open original restricted Session")
      const report = await scan("original-content-0")
      expect(report.content).toContain("original-run-0")
      expect(report.content).toContain("Unknown; result unconfirmed")
      await choose(0)
      expect(opened).toEqual(["restricted-session-0"])
      expect(calls.filter((call) => call.body).every((call) => call.path.includes("/event-investigation/"))).toBe(true)
      rendered.app.mockInput.pressEscape()
      await rendered.app.renderOnce()
      expect(rendered.app.captureCharFrame()).not.toContain("Project validation")
    } finally {
      server.stop(true)
    }
  }, 15000)

test("80x24 formal SDK reads retain rules and the original report through history 503, then clear fresh authority on rules 403", async () => {
  const root = await mkdtemp("/tmp/dac-investigation-tui-reads-")
  const calls: Array<{ path: string; method: string }> = []
  const opened: string[] = []
  let rulesForbidden = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      calls.push({ path, method: request.method })
      if (path.endsWith("/rules"))
        return rulesForbidden
          ? Response.json({ code: "VALIDATION_AUTH_REQUIRED" }, { status: 403 })
          : Response.json([investigationRule(root)])
      if (path.endsWith("/runs")) return Response.json({ code: "VALIDATION_CAPACITY" }, { status: 503 })
      if (path.endsWith("/candidates"))
        return Response.json({
          ruleID: "rule-one",
          ruleRevision: 1,
          epoch: 0,
          operatorRevision: 4,
          maxExpiresAt: Date.now() + 3600000,
          targets: [investigationTarget],
        })
      if (path.endsWith("/reports"))
        return Response.json([
          {
            receiptID: "original-report",
            failureKey: "original-failure",
            runID: "original-run",
            contentRevision: 2,
            contentHash: "original-content",
            sessionID: "original-restricted-session",
            grantEpoch: 1,
            createdAt: Date.now(),
            deadline: Date.now() + 600000,
            work: { admissionState: "ready", controlState: "active", controlRevision: 1, outcome: "unknown" },
          },
        ])
      return Response.json({})
    },
  })
  using rendered = await mountIM(
    root,
    server.url.origin,
    () => (
      <ProjectProvider>
        <DialogEventValidation sessionID="session-current" onOpenSession={(id) => opened.push(id)} />
      </ProjectProvider>
    ),
    80,
  )
  const choose = async (down: number) => {
    await Bun.sleep(30)
    await rendered.app.renderOnce()
    for (let index = 0; index < down; index++) rendered.app.mockInput.pressArrow("down")
    await rendered.app.renderOnce()
    rendered.app.mockInput.pressEnter()
  }
  const scan = async () => {
    for (let index = 0; index < 40; index++) rendered.app.mockInput.pressArrow("up", { ctrl: true })
    const frames: string[] = []
    for (let index = 0; index < 40; index++) {
      await rendered.app.renderOnce()
      frames.push(rendered.app.captureCharFrame())
      rendered.app.mockInput.pressArrow("down", { ctrl: true })
      await Bun.sleep(5)
    }
    return frames.join("\n")
  }
  try {
    rendered.app.renderer.resize(80, 24)
    await rendered.frame("project-tests")
    await until(() => calls.some((call) => call.path.endsWith("/reports")))
    await choose(2)
    expect(await scan()).toContain("Validation is unavailable")
    await choose(3)
    await rendered.frame("Capture investigation preview")
    await choose(6)
    await rendered.frame("Open original restricted Session")
    const content = await scan()
    expect(content).toContain("original-content")
    expect(content).toContain("original-run")
    expect(content).toContain("Unknown; result unconfirmed")
    expect(content).not.toContain("No validation runs yet")
    await choose(0)
    expect(opened).toEqual(["original-restricted-session"])
    for (let index = 0; index < 6; index++) rendered.app.mockInput.pressArrow("up")
    await choose(0)
    await choose(0)
    rulesForbidden = true
    const beforeRefusal = calls.length
    await choose(0)
    await until(() => calls.slice(beforeRefusal).some((call) => call.path.endsWith("/rules")))
    await Bun.sleep(30)
    const refused = await scan()
    expect(refused).toContain("Validation is unavailable")
    expect(refused).not.toContain("Capture investigation preview")
    expect(refused).not.toContain("Open original restricted Session")
    expect(refused).not.toContain("No configured validation rules")
    expect(calls.slice(beforeRefusal).map((call) => call.path)).toEqual(["/api/v1/event-validation/rules"])
    expect(calls.every((call) => call.method === "GET")).toBe(true)
    expect(opened).toEqual(["original-restricted-session"])
    rendered.app.mockInput.pressEscape()
    await rendered.app.renderOnce()
    expect(rendered.app.captureCharFrame()).not.toContain("Project validation")
  } finally {
    server.stop(true)
  }
}, 15000)

test("expiry refresh at 80x24 blocks fresh capture but keeps reports and original unknown enable retry", async () => {
  const root = await mkdtemp("/tmp/dac-investigation-tui-expiry-")
  const deadline = Date.now() + 2200
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  const opened: string[] = []
  let past = true
  let attempts = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = request.method === "GET" ? undefined : ((await request.json()) as Record<string, unknown>)
      calls.push({ path, body })
      if (path.endsWith("/rules"))
        return Response.json([
          {
            ...investigationRule(root),
            configuration: { ...investigationRule(root).configuration, expiresAt: deadline },
          },
        ])
      if (path.endsWith("/runs")) return Response.json([])
      if (path.endsWith("/candidates"))
        return Response.json({
          ruleID: "rule-one",
          ruleRevision: 1,
          epoch: 0,
          operatorRevision: 4,
          maxExpiresAt: past ? Date.now() - 1000 : deadline,
          targets: [investigationTarget],
        })
      if (path.endsWith("/reports"))
        return Response.json([
          {
            receiptID: "expiry-report",
            failureKey: "original-failure",
            runID: "original-run",
            contentHash: "original-content",
            contentRevision: 2,
            grantEpoch: 1,
            createdAt: Date.now() - 3600000,
            deadline,
            sessionID: "original-session",
            work: { admissionState: "ready", controlState: "revoked", controlRevision: 2, outcome: "unknown" },
          },
        ])
      if (path.endsWith("/capture"))
        return Response.json({
          captureID: "original-preview",
          expiresAt: deadline,
          preview: {
            ruleID: "rule-one",
            ruleRevision: 1,
            epoch: 0,
            operatorRevision: 4,
            grantExpiresAt: body?.expiresAt,
            target: investigationTarget,
          },
        })
      if (path.endsWith("/control")) {
        attempts++
        if (attempts === 1) return Response.json({ code: "VALIDATION_UNAVAILABLE" }, { status: 503 })
        return Response.json({
          receipt: {
            ruleID: body?.ruleID,
            requestID: body?.requestID,
            action: "update",
            investigation: { version: 1, operation: "enable", epoch: 1 },
          },
          replayed: true,
        })
      }
      return Response.json({})
    },
  })
  using rendered = await mountIM(
    root,
    server.url.origin,
    () => (
      <ProjectProvider>
        <DialogEventValidation sessionID="session-current" onOpenSession={(id) => opened.push(id)} />
      </ProjectProvider>
    ),
    80,
  )
  const choose = async (down: number, up = 0) => {
    await Bun.sleep(30)
    await rendered.app.renderOnce()
    for (let index = 0; index < up; index++) rendered.app.mockInput.pressArrow("up")
    for (let index = 0; index < down; index++) rendered.app.mockInput.pressArrow("down")
    rendered.app.mockInput.pressEnter()
  }
  const scan = async () => {
    for (let index = 0; index < 40; index++) rendered.app.mockInput.pressArrow("up", { ctrl: true })
    const frames: string[] = []
    for (let index = 0; index < 40; index++) {
      await rendered.app.renderOnce()
      frames.push(rendered.app.captureCharFrame())
      rendered.app.mockInput.pressArrow("down", { ctrl: true })
      await Bun.sleep(3)
    }
    return frames.join("\n")
  }
  try {
    rendered.app.renderer.resize(80, 24)
    await rendered.frame("project-tests")
    await choose(2)
    await choose(3)
    expect(await scan()).toContain("Expired")
    expect(calls.filter((call) => call.body)).toHaveLength(0)
    await choose(3)
    await rendered.frame("Open original restricted Session")
    await choose(0)
    expect(opened).toEqual(["original-session"])
    past = false
    await choose(0, 2)
    await until(() => calls.filter((call) => call.path.endsWith("/candidates")).length >= 2)
    await Bun.sleep(30)
    await choose(3)
    await until(() => calls.some((call) => call.path.endsWith("/capture")))
    await choose(0, 2)
    await rendered.frame("Retry original request")
    const original = calls.find((call) => call.path.endsWith("/control"))?.body
    await Bun.sleep(Math.max(0, deadline - Date.now() + 20))
    await choose(0, 1)
    await until(() => calls.filter((call) => call.path.endsWith("/candidates")).length >= 3)
    expect(await scan()).toContain("Expired")
    expect(calls.filter((call) => call.path.endsWith("/capture"))).toHaveLength(1)
    expect(calls.filter((call) => call.path.endsWith("/control"))).toHaveLength(1)
    await choose(2)
    expect(opened).toEqual(["original-session", "original-session"])
    await choose(0, 1)
    await until(() => calls.filter((call) => call.path.endsWith("/control")).length === 2)
    expect(await scan()).toContain("Investigation control accepted")
    expect(calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body)).toEqual([
      original,
      original,
    ])
  } finally {
    server.stop(true)
  }
}, 10000)

test("real TUI source owner disposal fences a late investigation preview in the independent DialogProvider", async () => {
  const root = await mkdtemp("/tmp/dac-investigation-tui-owner-")
  const calls: string[] = []
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      calls.push(path)
      if (path.endsWith("/candidates"))
        return Response.json({
          ruleID: "rule-one",
          ruleRevision: 1,
          epoch: 0,
          operatorRevision: 4,
          maxExpiresAt: Date.now() + 3600000,
          targets: [investigationTarget],
        })
      if (path.endsWith("/capture")) {
        const body = (await request.json()) as Record<string, unknown>
        await gate
        return Response.json({
          captureID: "late-preview",
          expiresAt: Date.now() + 60000,
          preview: {
            ruleID: "rule-one",
            ruleRevision: 1,
            epoch: 0,
            operatorRevision: 4,
            grantExpiresAt: body.expiresAt,
            target: investigationTarget,
          },
        })
      }
      if (path.endsWith("/runs") || path.endsWith("/reports")) return Response.json([])
      return Response.json([investigationRule(root)])
    },
  })
  const source = createRoot((dispose) => ({ dispose, active: createEventValidationOwner() }))
  using rendered = await mountIM(
    root,
    server.url.origin,
    () => (
      <ProjectProvider>
        <DialogEventValidation sessionID="session-current" active={source.active} />
      </ProjectProvider>
    ),
    80,
  )
  const choose = async (count: number) => {
    await Bun.sleep(30)
    for (let index = 0; index < count; index++) rendered.app.mockInput.pressArrow("down")
    await rendered.app.renderOnce()
    rendered.app.mockInput.pressEnter()
  }
  try {
    rendered.app.renderer.resize(80, 24)
    await rendered.frame("project-tests")
    await choose(2)
    await choose(3)
    await rendered.frame("Capture investigation preview")
    await choose(4)
    await until(() => calls.some((path) => path.endsWith("/capture")))
    source.dispose()
    expect(source.active()).toBe(false)
    release?.()
    await Bun.sleep(30)
    await rendered.app.renderOnce()
    expect(rendered.app.captureCharFrame()).not.toContain("Project validation")
    expect(rendered.app.captureCharFrame()).not.toContain("Enable investigation explicitly")
    expect(calls.some((path) => path.endsWith("/control"))).toBe(false)
  } finally {
    source.dispose()
    release?.()
    server.stop(true)
  }
}, 10000)

test("deterministic expiry at 80x24 labels past ready and blocks Verify while preserving Pause and original reports", async () => {
  const root = await mkdtemp("/tmp/dac-rule-expiry-tui-")
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  const opened: string[] = []
  let paused = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = request.method === "GET" ? undefined : ((await request.json()) as Record<string, unknown>)
      calls.push({ path, body })
      if (path.endsWith("/rules"))
        return Response.json([
          {
            ...investigationRule(root),
            state: paused ? "paused" : "enabled",
            lastReason: "ready",
            configuration: { ...investigationRule(root).configuration, expiresAt: Date.now() - 1000 },
          },
        ])
      if (path.endsWith("/runs")) return Response.json([])
      if (path.endsWith("/candidates"))
        return Response.json({
          ruleID: "rule-one",
          ruleRevision: 1,
          epoch: 0,
          operatorRevision: 1,
          maxExpiresAt: Date.now() + 3600000,
          targets: [],
        })
      if (path.endsWith("/reports"))
        return Response.json([
          {
            receiptID: "past-report",
            runID: "original-run",
            sessionID: "original-session",
            work: { outcome: "unknown" },
          },
        ])
      if (path.endsWith("/control")) {
        paused = true
        return Response.json({
          receipt: { ruleID: "rule-one", requestID: body?.requestID, action: body?.action },
          replayed: false,
        })
      }
      return Response.json({}, { status: 404 })
    },
  })
  using rendered = await mountIM(
    root,
    server.url.origin,
    () => (
      <ProjectProvider>
        <DialogEventValidation sessionID="session-current" onOpenSession={(id) => opened.push(id)} />
      </ProjectProvider>
    ),
    80,
  )
  const choose = async (down: number, up = 0) => {
    await Bun.sleep(30)
    await rendered.app.renderOnce()
    for (let index = 0; index < up; index++) rendered.app.mockInput.pressArrow("up")
    for (let index = 0; index < down; index++) rendered.app.mockInput.pressArrow("down")
    rendered.app.mockInput.pressEnter()
  }
  const scan = async () => {
    for (let index = 0; index < 40; index++) rendered.app.mockInput.pressArrow("up", { ctrl: true })
    const frames: string[] = []
    for (let index = 0; index < 40; index++) {
      await rendered.app.renderOnce()
      frames.push(rendered.app.captureCharFrame())
      rendered.app.mockInput.pressArrow("down", { ctrl: true })
      await Bun.sleep(3)
    }
    return frames.join("\n")
  }
  try {
    rendered.app.renderer.resize(80, 24)
    await rendered.frame("project-tests")
    await choose(2)
    const past = await scan()
    expect(past).toContain("Expired · Historical")
    expect(past).toContain("does not replace current state: Ready")
    expect(past).not.toContain("Validate now")
    expect(past).toContain("Pause")
    expect(calls.filter((call) => call.body)).toHaveLength(0)
    await choose(1)
    await choose(0)
    await until(() => calls.filter((call) => call.body).length === 1)
    expect(calls.find((call) => call.body)?.body).toMatchObject({ action: "pause", expectedRevision: 1 })
    await Bun.sleep(30)
    expect(await scan()).not.toContain("Enable rule")
    await choose(2)
    await Bun.sleep(30)
    await choose(3)
    await rendered.frame("Open original restricted Session")
    await choose(0)
    expect(opened).toEqual(["original-session"])
    expect(calls.filter((call) => call.body)).toHaveLength(1)
  } finally {
    server.stop(true)
  }
}, 10000)

test("deterministic expiry future confirmation at 80x24 rejects fresh Enable at click time", async () => {
  const root = await mkdtemp("/tmp/dac-rule-confirm-tui-")
  const deadline = Date.now() + 800
  const posts: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (request.method !== "GET") posts.push(path)
      if (path.endsWith("/rules"))
        return Response.json([
          {
            ...investigationRule(root),
            lastReason: "ready",
            configuration: { ...investigationRule(root).configuration, expiresAt: deadline },
          },
        ])
      if (path.endsWith("/runs") || path.endsWith("/reports")) return Response.json([])
      if (path.endsWith("/candidates"))
        return Response.json({
          ruleID: "rule-one",
          ruleRevision: 1,
          epoch: 0,
          operatorRevision: 1,
          maxExpiresAt: deadline,
          targets: [],
        })
      return Response.json({}, { status: 404 })
    },
  })
  using rendered = await mountIM(
    root,
    server.url.origin,
    () => (
      <ProjectProvider>
        <DialogEventValidation sessionID="session-current" />
      </ProjectProvider>
    ),
    80,
  )
  const choose = async (down: number) => {
    await Bun.sleep(30)
    await rendered.app.renderOnce()
    for (let index = 0; index < down; index++) rendered.app.mockInput.pressArrow("down")
    rendered.app.mockInput.pressEnter()
  }
  try {
    rendered.app.renderer.resize(80, 24)
    await rendered.frame("project-tests")
    await choose(2)
    await choose(1)
    await rendered.frame("Confirm")
    await Bun.sleep(Math.max(0, deadline - Date.now() + 20))
    await choose(0)
    const frames: string[] = []
    for (let index = 0; index < 30; index++) {
      await rendered.app.renderOnce()
      frames.push(rendered.app.captureCharFrame())
      rendered.app.mockInput.pressArrow("down", { ctrl: true })
    }
    expect(frames.join("\n")).toContain("Expired")
    expect(posts).toEqual([])
    expect(rendered.app.captureCharFrame()).not.toContain("Confirm explicit action")
  } finally {
    server.stop(true)
  }
}, 10000)

test("deterministic expiry refresh at 80x24 retains unknown Verify exact identity after the deadline", async () => {
  const root = await mkdtemp("/tmp/dac-rule-retry-tui-")
  const deadline = Date.now() + 900
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  let attempts = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = request.method === "GET" ? undefined : ((await request.json()) as Record<string, unknown>)
      calls.push({ path, body })
      if (path.endsWith("/rules"))
        return Response.json([
          {
            ...investigationRule(root),
            state: "enabled",
            lastReason: "ready",
            configuration: { ...investigationRule(root).configuration, expiresAt: deadline },
          },
        ])
      if (path.endsWith("/runs") || path.endsWith("/reports")) return Response.json([])
      if (path.endsWith("/candidates"))
        return Response.json({
          ruleID: "rule-one",
          ruleRevision: 1,
          epoch: 0,
          operatorRevision: 1,
          maxExpiresAt: deadline,
          targets: [],
        })
      if (path.endsWith("/control")) {
        attempts++
        if (attempts === 1) return Response.json({ code: "VALIDATION_UNAVAILABLE" }, { status: 503 })
        return Response.json({
          receipt: { ruleID: "rule-one", requestID: body?.requestID, action: body?.action },
          replayed: true,
        })
      }
      return Response.json({}, { status: 404 })
    },
  })
  using rendered = await mountIM(
    root,
    server.url.origin,
    () => (
      <ProjectProvider>
        <DialogEventValidation sessionID="session-current" />
      </ProjectProvider>
    ),
    80,
  )
  const choose = async (down: number, up = 0) => {
    await Bun.sleep(30)
    await rendered.app.renderOnce()
    for (let index = 0; index < up; index++) rendered.app.mockInput.pressArrow("up")
    for (let index = 0; index < down; index++) rendered.app.mockInput.pressArrow("down")
    rendered.app.mockInput.pressEnter()
  }
  try {
    rendered.app.renderer.resize(80, 24)
    await rendered.frame("project-tests")
    await choose(2)
    await choose(1)
    await choose(0)
    await rendered.frame("Retry original request")
    const original = calls.find((call) => call.path.endsWith("/control"))?.body
    expect(original).toMatchObject({ action: "verify", expectedRevision: 1 })
    await Bun.sleep(Math.max(0, deadline - Date.now() + 20))
    await choose(0)
    await until(() => calls.filter((call) => call.path.endsWith("/rules")).length >= 3)
    await choose(1)
    await until(() => calls.filter((call) => call.path.endsWith("/control")).length === 2)
    expect(calls.filter((call) => call.path.endsWith("/control")).map((call) => call.body)).toEqual([
      original,
      original,
    ])
  } finally {
    server.stop(true)
  }
}, 10000)
