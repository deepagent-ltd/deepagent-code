import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { managedBrowserInputFixtureDefine } from "./fixture/managed-browser-input-build"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserControl } from "@deepagent-code/core/browser/control"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { PermissionRequestView } from "../../../server/src/groups/permission"
import { Hash } from "@deepagent-code/core/util/hash"

const actual = process.env.DAC_BROWSER_API_POST_CANONICAL_ACTUAL === "1" ? test : test.skip

actual("original canonical Session runner binds both API once permissions to one physical POST and preserves cancelled unknown custody", async () => {
  const replay = process.env.DAC_BROWSER_API_POST_CANONICAL_REPLAY
  const root = await fs.realpath(replay ?? (await fs.mkdtemp("/tmp/dac-browser-api-post-canonical-")))
  if (replay && !root.startsWith("/private/tmp/dac-browser-api-post-canonical-"))
    throw new Error("Replay is limited to the private artifact from this fixture")
  if (!replay) {
    await fs.chmod(root, 0o700)
    await Promise.all(["home", "tmp", "project", "config", "data", "cache", "state"].map((name) =>
      fs.mkdir(path.join(root, name), { mode: 0o700 })))
    await fs.symlink(path.resolve(import.meta.dir, "../../../deepagent-code/node_modules"), path.join(root, "node_modules"), "dir")
    const bin = path.join(root, "home/.deepagent/code/cache/bin")
    await fs.mkdir(bin, { recursive: true })
    const rg = Bun.which("rg")
    expect(rg).not.toBeNull()
    await fs.copyFile(rg!, path.join(bin, "rg"))
    // The owned peer has a private QA certificate; neither production resolver
    // policy nor the original Main TLS validation is bypassed by this wrapper.
    for (const args of [
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca-key.pem", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Private Browser Canonical CA"],
      ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server-key.pem", "-out", "server.csr", "-subj", "/CN=positive.example.com"],
    ]) {
      const command = Bun.spawnSync(["openssl", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" })
      expect(command.exitCode).toBe(0)
    }
    await fs.writeFile(path.join(root, "server.ext"), "subjectAltName=DNS:positive.example.com,DNS:cloudflare-dns.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
    const certificate = Bun.spawnSync(["openssl", "x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca-key.pem",
      "-CAcreateserial", "-out", "server.pem", "-days", "1", "-extfile", "server.ext"], { cwd: root, stdout: "ignore", stderr: "pipe" })
    expect(certificate.exitCode).toBe(0)
    await Promise.all(["ca-key.pem", "server-key.pem"].map((name) => fs.chmod(path.join(root, name), 0o600)))
    const main = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-api-post-canonical.ts")],
      outdir: root, target: "node", conditions: ["node"], splitting: true,
      external: ["electron", "jsonc-parser", "@lydell/node-pty", "bun"], naming: "main.mjs", sourcemap: "external",
      define: await managedBrowserInputFixtureDefine(root),
    })
    const child = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "../../../deepagent-code/test/browser/fixture/native-api-post-canonical-child.ts")],
      outdir: root, target: "node", conditions: ["node"], splitting: true,
      external: ["electron", "jsonc-parser", "@lydell/node-pty", "bun"], naming: "child.mjs",
      define: { DEEPAGENT_CODE_VERSION: '"0.0.0-browser-api-post-canonical-dev"', DEEPAGENT_CODE_CHANNEL: '"dev"' },
      files: { "deepagent-code-web-ui.gen.ts": "" }, sourcemap: "external",
    })
    expect(main.logs).toEqual([])
    expect(child.logs).toEqual([])
    expect(main.success && child.success).toBe(true)
    const repository = path.resolve(import.meta.dir, "../../../..")
    const sources = new Map<string, string>()
    const maps = Schema.Struct({ sources: Schema.Array(Schema.String), sourcesContent: Schema.Array(Schema.NullOr(Schema.String)) })
    for (const build of [main, child]) {
      for (const map of build.outputs.filter((value) => value.path.endsWith(".map"))) {
        const parsed = Schema.decodeUnknownSync(maps)(await Bun.file(map.path).json())
        parsed.sources.forEach((value, index) => {
          const absolute = path.resolve(path.dirname(map.path), value)
          const contents = parsed.sourcesContent[index]
          if (!absolute.startsWith(repository + "/packages/") || absolute.includes("/node_modules/") || contents == null) return
          sources.set(absolute, Hash.sha256(contents))
        })
      }
    }
    const snapshot = await Promise.all(Array.from(sources, async ([filename, hash]) => ({
      path: path.relative(repository, filename), sha256: hash, current: Hash.sha256(await fs.readFile(filename)),
    })))
    const drift = snapshot.filter((value) => value.sha256 !== value.current)
    expect(drift).toEqual([])
    await fs.writeFile(path.join(root, "source-cohort.json"), JSON.stringify({ evidence: "actual compiled sourcemap sourcesContent",
      checked: snapshot.length, drift, sources: snapshot }, null, 2), { mode: 0o600 })
    console.log("API_CANONICAL_SOURCE_CAPTURED", root)
    const process = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"),
      main.outputs.find((value) => value.path.endsWith("main.mjs"))!.path], {
      cwd: root, env: { PATH: globalThis.process.env.PATH, HOME: root, TMPDIR: root,
        XDG_DATA_HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root,
        DAC_BROWSER_API_CANONICAL_ROOT: root,
        DAC_BROWSER_API_CANONICAL_CHILD: child.outputs.find((value) => value.path.endsWith("child.mjs"))!.path },
      stdout: "pipe", stderr: "pipe",
    })
    const timeout = setTimeout(() => process.kill(), 80_000)
    const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
    clearTimeout(timeout)
    await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
    expect(code, stderr.slice(-3000)).toBe(0)
    const finalDrift = (await Promise.all(snapshot.map(async (value) => ({ path: value.path,
      before: value.sha256, after: Hash.sha256(await fs.readFile(path.join(repository, value.path))),
    })))).filter((value) => value.before !== value.after)
    const browserPaths = new Set([
      "packages/core/src/browser/schema.ts", "packages/core/src/browser/control.ts", "packages/core/src/tool/browser.ts",
      "packages/desktop/src/main/managed-browser.ts", "packages/desktop/src/main/managed-browser-network.ts",
      "packages/desktop/src/main/managed-browser-api.ts", "packages/deepagent-code/src/browser/native-host.ts",
      "packages/desktop/src/main/fixture/managed-browser-api-post-canonical.ts",
      "packages/desktop/src/main/managed-browser-api-post-canonical.test.ts",
      "packages/deepagent-code/test/browser/fixture/native-api-post-canonical-child.ts",
    ])
    const browserDrift = finalDrift.filter((value) => browserPaths.has(value.path))
    // Keep every successor change as evidence. Other writers do not invalidate the
    // immutable modules already captured; only this browser slice is frozen here.
    await fs.writeFile(path.join(root, "source-successor.json"), JSON.stringify({ checked: snapshot.length,
      drift: finalDrift, browserDrift }, null, 2), { mode: 0o600 })
    expect(browserDrift).toEqual([])
  }
  console.log("BROWSER_API_POST_CANONICAL_EVIDENCE", root)
  const result = await Bun.file(path.join(root, "child-result.json")).json()
  expect({ stage: result.stage, error: result.error }).toEqual({ stage: "complete", error: undefined })
  const factsCodec = Schema.Struct({
    actions: Schema.Array(BrowserSchema.Action),
    admissions: Schema.Array(Schema.Struct({ admission_id: Schema.String, receipt_id: Schema.String,
      provider_attempt_id: Schema.String, owner_token: Schema.String, session_id: Schema.String,
      tool_call_id: Schema.String, tool_name: Schema.String })),
    effects: Schema.Array(Schema.Struct({ receipt_id: Schema.String, tool_call_id: Schema.String, state: Schema.String,
      effect_kind: Schema.String, error_code: Schema.NullOr(Schema.String) })),
    providers: Schema.Array(Schema.Struct({ attempt_id: Schema.String, session_id: Schema.String, selection_id: Schema.String,
      state: Schema.String, execution_claim_token: Schema.Int, owner_token: Schema.String, error_code: Schema.NullOr(Schema.String) })),
    receipts: Schema.Array(Schema.Struct({ receipt_id: Schema.String, session_id: Schema.String,
      provider_attempt_id: Schema.String, owner_token: Schema.String, state: Schema.String })),
    selections: Schema.Array(Schema.Struct({ selection_id: Schema.String, session_id: Schema.String,
      security_namespace_id: Schema.String, location_key: Schema.String, project_scope_key: Schema.String })),
    owners: Schema.Array(Schema.Struct({ owner_token: Schema.String, released_at: Schema.NullOr(Schema.Number) })),
    inputs: Schema.Array(Schema.Struct({ id: Schema.String, session_id: Schema.String, delivery: Schema.String, promoted_seq: Schema.Number })),
    activities: Schema.Array(Schema.Struct({ activity_id: Schema.String, session_id: Schema.String, state: Schema.String })),
    messages: Schema.Array(Schema.Struct({ id: Schema.String, type: Schema.String, data: Schema.String })),
    work: Schema.Array(Schema.Unknown), counts: Schema.Array(Schema.Unknown), saved: Schema.Array(Schema.Unknown),
  })
  const facts = Schema.decodeUnknownSync(factsCodec)(result.facts)
  const positive = Schema.decodeUnknownSync(factsCodec)(result.positive)
  const control = Schema.decodeUnknownSync(BrowserSchema.Control)(result.control)
  const permissions = Schema.decodeUnknownSync(Schema.Array(PermissionRequestView))(result.permissions)
  const asked = Schema.decodeUnknownSync(Schema.Array(PermissionRequestView))(result.asked)
  const beforeAPI = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ action: Schema.String, url: Schema.String,
    apiActions: Schema.Int, source: Schema.Unknown, metadata: Schema.Record(Schema.String, Schema.Unknown) })))(result.beforeAPI)
  const origin = "https://positive.example.com"
  expect(control).toMatchObject({ profile: BrowserSchema.API_POST_PROFILE, origin, approvedOrigins: [origin],
    resolverPolicy: "cloudflare_doh_v1", pageMode: "static", apiPostTargets: [origin + "/api?request=canonical", origin + "/held"].map((url) => ({
      url, contentTypes: ["application/json"], maxBodyBytes: 65536,
    })) })
  expect(["postPaths", "postTargets", "scriptGrants", "programGrants", "fileGrants", "clipboard"].some((key) => key in control)).toBe(false)
  expect(facts.saved).toEqual([])
  expect(facts.work).toEqual([])
  expect(facts.counts).toEqual([])
  expect(positive.actions).toHaveLength(4)
  expect(facts.actions).toHaveLength(5)
  expect(facts.admissions).toHaveLength(5)
  expect(facts.effects).toHaveLength(4)
  expect(facts.admissions.every((value) => value.tool_name === "browser")).toBe(true)
  expect(facts.actions.filter((value) => value.outcome === "pending")).toEqual([])
  expect(facts.inputs.map((value) => value.id)).toEqual(["msg_api_canonical_held", "msg_api_canonical_positive"])
  expect(facts.inputs.every((value) => value.session_id === result.session && value.delivery === "steer")).toBe(true)
  expect(result.retry.unchanged).toBe(true)
  expect(result.retry.after).toEqual(result.retry.before)
  expect(Schema.decodeUnknownSync(factsCodec)(result.retry.before)).toEqual(positive)
  const posts = facts.actions.filter((value) => value.command.type === "api.post")
  expect(posts).toHaveLength(2)
  for (const action of posts) {
    if (action.command.type !== "api.post") throw new Error("Expected actual API action")
    const command = action.command
    const callID = command.url.endsWith("/held") ? "api_canonical_call_6" : "api_canonical_call_4"
    expect(action.toolCallID).toBe(callID)
    expect(action.command).toMatchObject({ actionTag: BrowserSchema.API_POST_ACTION_TAG, profileVersion: 1,
      contentType: "application/json", body: '{"value":"canonical Unicode 原请求"}' })
    expect(action.commandDigest).toBe(BrowserControl.hash(action.command))
    const approvals = permissions.filter((value) => value.source?.callID === callID)
    expect(approvals.map((value) => value.action)).toEqual(["browser", "browser-api-post"])
    expect(asked.filter((value) => value.source?.callID === callID)).toEqual(approvals)
    expect(beforeAPI.filter((value) => value.url === command.url).map((value) => [value.action, value.apiActions]))
      .toEqual([["browser", 0], ["browser-api-post", 0]])
    const admission = facts.admissions.find((value) => value.admission_id === action.admissionID)!
    expect(admission).toMatchObject({ receipt_id: action.providerReceiptID, provider_attempt_id: action.providerAttemptID,
      session_id: action.sessionID, tool_call_id: action.toolCallID })
    const receipt = facts.receipts.find((value) => value.receipt_id === action.providerReceiptID)!
    const provider = facts.providers.find((value) => value.attempt_id === action.providerAttemptID)!
    expect(receipt).toMatchObject({ state: "settled", owner_token: admission.owner_token, provider_attempt_id: provider.attempt_id })
    expect(provider).toMatchObject({ state: "settled", owner_token: admission.owner_token, session_id: action.sessionID })
    const selection = facts.selections.find((value) => value.selection_id === provider.selection_id)!
    expect(selection).toMatchObject({ session_id: action.sessionID, security_namespace_id: control.scope.securityNamespaceID,
      location_key: control.scope.locationKey, project_scope_key: control.scope.projectScopeKey })
    const terminal = facts.effects.find((value) => value.receipt_id === action.providerReceiptID && value.tool_call_id === callID)!
    // Decode the original projected tool terminal, without constructing a tool result.
    const messages = facts.messages.filter((value) => value.type === "assistant").map((row) => ({ id: row.id,
      content: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ content: Schema.Array(Schema.Unknown) })))(row.data).content,
    }))
    const source = approvals[0]!.source!
    expect(source.type).toBe("tool")
    const message = messages.find((value) => value.id === source.messageID)!
    expect(message).toBeDefined()
    const projected = message.content.flatMap((value) => {
      const header = Schema.decodeUnknownSync(Schema.Struct({ type: Schema.String }))(value)
      if (header.type !== "tool") return []
      const tool = Schema.decodeUnknownSync(SessionMessage.AssistantTool)(value)
      return tool.id === callID ? [tool] : []
    })
    expect(projected).toHaveLength(1)
    const tool = projected[0]!
    if (command.url.endsWith("/held")) {
      expect(action).toMatchObject({ outcome: "unknown", result: null, errorCode: "BROWSER_UNKNOWN" })
      expect(tool.state.status).toBe("error")
      if (tool.state.status !== "error") throw new Error("Unknown API requires the real error terminal")
      // The original runner deliberately leaves unknown mutating admission in
      // recovery custody. It must not synthesize a failed/settled tool receipt.
      expect(tool.state.error.type).toBe("unknown")
      expect(terminal).toBeUndefined()
      expect(await Bun.file(path.join(root, "process.log")).text()).toContain("V2ToolEffect.RecoveryRequiredError")
    } else {
      expect(action.outcome).toBe("completed")
      expect(action.result?.apiPost).toEqual({ version: 1, status: 200, contentType: "application/json",
        bytes: Buffer.byteLength('{"accepted":true}'), sha256: Hash.sha256('{"accepted":true}'), text: '{"accepted":true}' })
      expect(tool.state.status).toBe("completed")
      expect(terminal).toMatchObject({ state: "settled", effect_kind: "mutating", error_code: null })
    }
  }
  expect(facts.providers.every((value) => facts.owners.some((owner) => owner.owner_token === value.owner_token))).toBe(true)
  expect(result.unknownIdle).toEqual({ outcome: "success" })
  // awaitIdle confirms no live runner, not that the quarantined activity settled.
  expect(facts.activities.map((value) => value.state)).toEqual(["settled", "active"])
  expect(result.stopped).toMatchObject({ stopConfirmed: true, control: { state: "stopped" } })
  const physical = Schema.decodeUnknownSync(Schema.Struct({
    providerCalls: Schema.Array(Schema.Struct({ ordinal: Schema.Int, tool: Schema.NullOr(Schema.String) })),
    providerArrivals: Schema.Array(Schema.Struct({ method: Schema.String, url: Schema.String })),
    requests: Schema.Array(Schema.Struct({ method: Schema.String, url: Schema.String, bytes: Schema.Int, sha256: Schema.String })),
    pending: Schema.Array(Schema.Struct({ action: Schema.String, url: Schema.String, posts: Schema.Int })),
    authLeak: Schema.Boolean, cleanup: Schema.Struct({ childStopped: Schema.Boolean, serversStopped: Schema.Boolean,
      windows: Schema.Int, peerSockets: Schema.Int }),
  }))(await Bun.file(path.join(root, "main-result.json")).json())
  expect(physical.providerCalls.slice(0, 6)).toEqual([
    { ordinal: 1, tool: "tabs.list" }, { ordinal: 2, tool: "navigate" }, { ordinal: 3, tool: "snapshot" },
    { ordinal: 4, tool: "api.post" }, { ordinal: 5, tool: null }, { ordinal: 6, tool: "api.post" },
  ])
  expect([6, 7]).toContain(physical.providerCalls.length)
  if (physical.providerCalls.length === 7) expect(physical.providerCalls[6]).toEqual({ ordinal: 7, tool: null })
  expect(physical.providerArrivals).toHaveLength(physical.providerCalls.length)
  expect(physical.providerArrivals.every((value) => value.method === "POST" && value.url === "/v1/chat/completions")).toBe(true)
  expect(physical.pending).toEqual(["/api?request=canonical", "/held"].flatMap((url) =>
    ["browser", "browser-api-post"].map((action) => ({ action, url, posts: 0 }))))
  expect(physical.requests).toEqual([
    { method: "GET", url: "/canonical-page", bytes: 0, sha256: Hash.sha256("") },
    ...["/api?request=canonical", "/held"].map((url) => ({ method: "POST", url,
      bytes: Buffer.byteLength('{"value":"canonical Unicode 原请求"}'), sha256: Hash.sha256('{"value":"canonical Unicode 原请求"}') })),
  ])
  expect(physical.authLeak).toBe(false)
  expect(physical.cleanup).toEqual({ childStopped: true, serversStopped: true, windows: 0, peerSockets: 0 })
  // All actual owners have exited. This immutable cold read performs no recovery,
  // starts no second Root and cannot retransmit either known or unknown API request.
  const filename = path.join(root, "authority.sqlite")
  const beforeBytes = Hash.sha256(await fs.readFile(filename))
  const cold = new Database(`file:${filename}?mode=ro&immutable=1`, { readonly: true, create: false })
  try {
    const before = cold.query("SELECT total_changes() changes").get()
    const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ record: Schema.String })))(
      cold.query("SELECT record FROM browser_action ORDER BY created_at,action_id").all())
    expect(rows.map((row) => Schema.decodeUnknownSync(Schema.fromJsonString(BrowserSchema.Action))(row.record))).toEqual([...facts.actions])
    expect(cold.query("SELECT id FROM session WHERE execution_claim_token IS NOT NULL").all()).toEqual([])
    expect(cold.query("SELECT owner_token FROM session_provider_owner_lease WHERE released_at IS NULL").all()).toEqual([])
    const pending = cold.query("SELECT a.admission_id,a.tool_call_id,a.effect_kind FROM session_v2_tool_effect_admission a LEFT JOIN session_v2_tool_effect e ON e.receipt_id=a.receipt_id AND e.tool_call_id=a.tool_call_id WHERE e.effect_id IS NULL").all()
    expect(pending).toEqual([{ admission_id: posts.find((value) => value.toolCallID === "api_canonical_call_6")!.admissionID,
      tool_call_id: "api_canonical_call_6", effect_kind: "mutating" }])
    expect(cold.query("SELECT total_changes() changes").get()).toEqual(before)
  } finally { cold.close() }
  expect(Hash.sha256(await fs.readFile(filename))).toBe(beforeBytes)
}, 90_000)
