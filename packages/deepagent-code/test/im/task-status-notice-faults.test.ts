import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"

const zero = { sessions: 0, inputs: 0, work: 0, grants: 0, providers: 0, counts: 0, dispatches: 0 }
const Publication = Schema.Struct({ targetId: Schema.String, index: Schema.Number })
const Message = Schema.Struct({ msgType: Schema.String, deliveryVersion: Schema.Number, msgContent: Schema.Uint8Array,
  clientUid: Schema.String, deliveryExpiresAt: Schema.Unknown })

test.each(["pub-no-ack", "ack-before-outbox"] as const)(
  "status notice cold recovery preserves original transport receipt at %s",
  async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-task-status-notice-fault-")))
    await Promise.all(["home", "data", "config", "cache", "state", "tmp", "project"].map((name) => fs.mkdir(path.join(root, name))))
    const physical = { publications: 0, acknowledgements: 0, connections: 0, textHash: "" }
    const peer = KernelLiveFirstSeenFixture.make({
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/_fixture/publish-source" && request.method === "POST") {
          assert.equal(peer.messages.length, 0)
          peer.add("status-fault-source")
          return Response.json({ published: true })
        }
        if (url.pathname !== "/api/im/conversations/inspect") return
        assert.equal(request.method, "POST")
        assert.equal(request.headers.get("authorization"), "Bearer private-witness-key")
        return Response.json({ success: true, data: { conversation_type: 1, conversation_id: "sender",
          org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"] } })
      },
      response(topic, request, original) {
        if (topic === "qry_user_info") physical.connections++
        if (topic === "qry_delivery_capabilities") return { name: "DeliveryCapabilities", value: {
          version: 1, profile: "mysql-receipt-v1", maxLifetimeMs: 259200000, maxContentBytes: 65536, eventualDelivery: false } }
        if (topic === "qry_delivery_read_cut") return { name: "DeliveryReadCutResult", value: {
          version: 1, scopeKey: request.scopeKey, projectionKey: request.projectionKey, projectionRevision: request.projectionRevision,
          throughOrdinal: "0", targetAdmittedOrdinal: String(peer.messages.length), readOrdinal: "0",
          liveUnread: String(peer.messages.length), storedUnread: String(peer.messages.length), complete: false, serverNow: Date.now() } }
        return original
      },
      outboundPublish(request, message) {
        const publication = Schema.decodeUnknownSync(Publication)(request)
        const original = Schema.decodeUnknownSync(Message)(message)
        const text = Schema.decodeUnknownSync(Schema.Struct({ content: Schema.String }))(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(original.msgContent)),
        ).content
        assert.equal(publication.targetId, "sender")
        assert.equal(original.msgType, "jg:text")
        assert.equal(original.deliveryVersion, 1)
        const expiresAt = Number(String(original.deliveryExpiresAt))
        assert(Number.isSafeInteger(expiresAt) && expiresAt > Date.now())
        physical.publications++
        physical.textHash = createHash("sha256").update(text).digest("hex")
        if (mode === "ack-before-outbox") physical.acknowledgements++
        return { code: 0, msgId: "status-original-ack", timestamp: Date.now(), msgIndex: 2,
          clientMsgId: original.clientUid, deliveryVersion: 1, deliveryExpiresAt: expiresAt,
          deliveryRequestHash: createHash("sha256").update(JSON.stringify(["dac.delivery.request.v1", 1,
            publication.targetId, original.clientUid, "jg:text", text, 10, expiresAt])
            .replace(/[<>&\u2028\u2029]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"))).digest("hex") }
      },
      afterOutboundPublish(close) {
        if (mode !== "pub-no-ack") return
        close()
        return "drop_ack"
      },
    })
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: path.join(root, "home"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_HOME: path.join(root, "data"),
      DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"), TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_SERVER_USERNAME: "status-fault-operator", DEEPAGENT_CODE_SERVER_PASSWORD: "private-status-fault-password", NO_COLOR: "1" }
    const processes: ReturnType<typeof Bun.spawn>[] = []
    const start = (phase: string) => {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/task-status-notice-faults.ts"), root, phase, peer.server.url.origin],
        { cwd: path.join(root, "project"), env, stdout: "pipe", stderr: "pipe" })
      processes.push(child)
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
        .then(([stdout, stderr]) => fs.writeFile(path.join(root, `${phase}.log`), stdout + stderr, { mode: 0o600 }))
      return { child, output }
    }
    const deadline = setTimeout(() => processes.forEach((child) => child.kill("SIGKILL")), 45_000)
    try {
      const first = start(mode)
      for (const attempt of Array.from({ length: 1000 }, (_, index) => index)) {
        if (await Bun.file(path.join(root, "ready.json")).exists()) break
        if (first.child.exitCode !== null || attempt === 999) {
          first.child.kill("SIGKILL")
          await first.child.exited
          await first.output
          throw new Error(`Original caller failed before frontier; private evidence: ${root}`)
        }
        await Bun.sleep(20)
      }
      const ready = await Bun.file(path.join(root, "ready.json")).json()
      expect(ready.zeroExecution).toEqual(zero)
      expect(ready.outbox).toEqual({ status: "delivering", attempts: 1 })
      expect(ready.deliveryState).toBe(mode === "pub-no-ack" ? "unknown" : "acknowledged")
      expect(ready.kernelMessageID).toBe(mode === "pub-no-ack" ? null : "status-original-ack")
      expect([physical.publications, physical.acknowledgements]).toEqual([1, mode === "pub-no-ack" ? 0 : 1])
      const inode = await fs.stat(path.join(root, "authority.sqlite"), { bigint: true })
      first.child.kill("SIGKILL")
      await first.child.exited
      await first.output
      const second = start("cold")
      expect(await second.child.exited).toBe(0)
      await second.output
      const current = await fs.stat(path.join(root, "authority.sqlite"), { bigint: true })
      expect([current.dev, current.ino]).toEqual([inode.dev, inode.ino])
      const result = await Bun.file(path.join(root, "cold.json")).json()
      expect(result.zeroExecution).toEqual(zero)
      expect(result.outbox).toEqual({ status: "delivered", attempts: 2 })
      expect(result.state).toBe(ready.deliveryState)
      expect(result.kernelMessageID).toBe(ready.kernelMessageID)
      expect([physical.publications, physical.acknowledgements]).toEqual([1, mode === "pub-no-ack" ? 0 : 1])
      expect(physical.connections).toBeGreaterThanOrEqual(2)
      expect(result.immutableNoticeSame && result.originalDeliverySame).toBe(true)
      await fs.writeFile(path.join(root, "safe.json"), JSON.stringify({ mode,
        evidenceClass: "actual formal SDK protobuf peer and original source/operator/notice/outbox/fileDB chain; controlled peer, not deployed Go or Native provider",
        physical, ready: { state: ready.deliveryState, outbox: ready.outbox }, cold: result,
        sameInode: true, originalCallerSIGKILL: true, privateResourcesClosed: true }), { mode: 0o600 })
      console.info("TASK_STATUS_NOTICE_FAULT_EVIDENCE", root)
    } finally {
      clearTimeout(deadline)
      processes.forEach((child) => child.kill("SIGKILL"))
      await Promise.all(processes.map((child) => child.exited))
      peer.server.stop(true)
    }
  }, 50_000,
)
