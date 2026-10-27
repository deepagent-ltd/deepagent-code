import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import os from "node:os"
import { Effect, Schema } from "effect"
import { IMDeviceRuntimeFixture } from "../server/im-device-runtime.fixture"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"

// The receiver remains alive across both original SDK processes, so realm,
// device custody and the physical SQLite authority never change on cold restart.
test("actual SDK + sync + repository keep ACK-loss and ACK-SQL-failure unknown across same-inode cold restart", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "im-kernel-delivery-cold-")))
  const children = new Set<ReturnType<typeof Bun.spawn>>()
  const deadline = performance.now() + 59000
  const watchdog = setTimeout(() => children.forEach((child) => child.kill("SIGKILL")), 59000)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        for (const scenario of ["lost", "ack-write", "success", "identity", "denied", "missing-identity"]) {
          const directory = path.join(root, scenario)
          yield* Effect.promise(() => fs.mkdir(path.join(directory, "home"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(directory, "tmp")))
          const phase = { stage: "p1", pid: 0 }
          const native = yield* IMDeviceRuntimeFixture.make({
            directory: path.join(directory, "platform"),
            uuid: "receiver",
            protectedPath: (pathname) => pathname.startsWith("/navigator/"),
            listen: (transport) =>
              KernelLiveFirstSeenFixture.make({
                tls: transport.tls,
                device: {
                  publicJwk: transport.identity.publicJwk,
                  appkey: "delivery-cold-owned",
                  token: "daim2.delivery-cold-original",
                },
                secondIdentity: { token: "daim2.delivery-cold-rebound", userID: "receiver" },
                fetch(request) {
                  const pathname = new URL(request.url).pathname
                  return pathname === "/health" || pathname === "/im" ? undefined : transport.fetch(request)
                },
                response(topic, request, original) {
                  if (topic === "qry_delivery_capabilities")
                    return {
                      name: "DeliveryCapabilities",
                      value: {
                        version: 1,
                        profile: "mysql-receipt-v1",
                        maxLifetimeMs: 259200000,
                        maxContentBytes: 65536,
                        eventualDelivery: false,
                      },
                    }
                  if (topic === "qry_delivery_receipt")
                    return { name: "DeliveryReceiptResult", value: { version: 1, state: "not_found" } }
                  if (!original || !topic.startsWith("qry_delivery_")) return original
                  return {
                    ...original,
                    value: {
                      ...original.value,
                      version: 2,
                      ...(topic === "qry_delivery_changes" ? { items: [], scanProjectionKey: "" } : {}),
                    },
                  }
                },
                outboundPublish(request, message) {
                  const body = Schema.decodeUnknownSync(
                    Schema.fromJsonString(Schema.Struct({ content: Schema.String })),
                  )(new TextDecoder().decode(message.msgContent as Uint8Array))
                  const database = new Database(path.join(directory, "authority.sqlite"), { readonly: true })
                  const original = database
                    .query<
                      { message_id: string },
                      [string]
                    >("SELECT message_id FROM im_kernel_delivery WHERE wire_id=?")
                    .get(String(message.clientUid))
                  database.close()
                  if (!original) throw new Error("Original publish has no durable wire identity")
                  // UpMsg carries the wire ID. The local ID stays in the original SDK;
                  // join the actual readonly ledger instead of inventing a wire tid.
                  const wire = {
                    stage: phase.stage,
                    localMessageID: original.message_id,
                    clientMsgId: String(message.clientUid),
                    text: body.content,
                  }
                  appendFileSync(path.join(directory, "receiver.jsonl"), JSON.stringify(wire) + "\n")
                  if (scenario === "lost" && phase.stage === "p1") {
                    const stat = statSync(path.join(directory, "authority.sqlite"))
                    writeFileSync(
                      path.join(directory, "ready.json"),
                      JSON.stringify({
                        pid: phase.pid,
                        file: { path: path.join(directory, "authority.sqlite"), dev: stat.dev, inode: stat.ino },
                        wire: [wire],
                        state: "remote_captured_ack_not_returned",
                      }),
                    )
                  }
                  const expiresAt = Number(String(message.deliveryExpiresAt))
                  const deliveryRequestHash = createHash("sha256")
                    .update(
                      JSON.stringify([
                        "dac.delivery.request.v1",
                        request.topic === "p_msg" ? 1 : 2,
                        request.targetId,
                        message.clientUid,
                        "jg:text",
                        body.content,
                        10,
                        expiresAt,
                      ]).replace(
                        /[<>&\u2028\u2029]/g,
                        (value) => "\\u" + value.charCodeAt(0).toString(16).padStart(4, "0"),
                      ),
                    )
                    .digest("hex")
                  return {
                    code: 0,
                    msgId: "kernel-original-ack",
                    timestamp: Date.now(),
                    msgIndex: 1,
                    clientMsgId: message.clientUid,
                    deliveryVersion: 1,
                    deliveryExpiresAt: expiresAt,
                    deliveryRequestHash,
                  }
                },
                afterOutboundPublish: () => (scenario === "lost" && phase.stage === "p1" ? "drop_ack" : undefined),
              }).server,
            fetch(request): Response {
              if (new URL(request.url).pathname === "/navigator/general")
                return Response.json(
                  { code: 0, data: { user_id: "receiver", servers: [native.server.url.origin] } },
                  { headers: { "cache-control": "no-store" } },
                )
              return new Response(null, { status: 404 })
            },
          })
          yield* Effect.promise(async () => {
            await Bun.write(
              path.join(directory, "connection.json"),
              JSON.stringify({
                origin: native.url,
                publicJwk: native.publicIdentity.publicJwk,
                jkt: native.publicIdentity.jkt,
                deviceDirectory: native.directory,
                backendFile: native.backendFile,
              }),
            )
            const run = (stage: string) => {
              if (performance.now() >= deadline) throw new Error("Owned delivery child budget elapsed")
              phase.stage = stage
              const child = Bun.spawn(
                [
                  process.execPath,
                  "--preload",
                  path.resolve(import.meta.dir, "../fixture/cli-secret-store.ts"),
                  "--conditions=browser",
                  path.join(import.meta.dir, "kernel-delivery-process.fixture.ts"),
                  stage,
                  scenario,
                ],
                {
                  cwd: path.join(import.meta.dir, "../.."),
                  env: {
                    ...process.env,
                    IM_DELIVERY_ORACLE_ROOT: directory,
                    NODE_EXTRA_CA_CERTS: native.certificatePath,
                    HOME: path.join(directory, "home"),
                    TMPDIR: path.join(directory, "tmp"),
                    DEEPAGENT_CODE_TEST_HOME: path.join(directory, "home"),
                    XDG_CONFIG_HOME: path.join(directory, "config"),
                    XDG_DATA_HOME: path.join(directory, "data"),
                    XDG_CACHE_HOME: path.join(directory, "cache"),
                    XDG_STATE_HOME: path.join(directory, "state"),
                    DEEPAGENT_IM_AGENT_RESPONDER: "off",
                  },
                  stdout: "pipe",
                  stderr: "pipe",
                },
              )
              children.add(child)
              phase.pid = child.pid
              return child
            }
            const finish = async (child: ReturnType<typeof run>, stage: string) => {
              const [output, errors, code] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
              ])
              await Bun.write(path.join(directory, stage + ".stdout.log"), output)
              await Bun.write(path.join(directory, stage + ".stderr.log"), errors)
              expect(code, `${output}\n${errors}`).toBe(0)
              return JSON.parse(
                output
                  .split("\n")
                  .find((line) => line.startsWith("KERNEL_DELIVERY_RESULT "))!
                  .slice(23),
              )
            }
            const first = run("p1")
            const p1 =
              scenario === "lost"
                ? await (async () => {
                    for (const attempt of Array.from({ length: 400 }, (_, index) => index)) {
                      if (
                        (await Bun.file(path.join(directory, "ready.json")).exists()) ||
                        first.exitCode !== null ||
                        first.signalCode !== null
                      )
                        break
                      await Bun.sleep(25)
                    }
                    if (!(await Bun.file(path.join(directory, "ready.json")).exists())) {
                      first.kill("SIGKILL")
                      await first.exited
                      throw new Error(await new Response(first.stderr).text())
                    }
                    const ready = JSON.parse(readFileSync(path.join(directory, "ready.json"), "utf8"))
                    first.kill("SIGKILL")
                    const [output, errors] = await Promise.all([
                      new Response(first.stdout).text(),
                      new Response(first.stderr).text(),
                      first.exited,
                    ])
                    await Bun.write(path.join(directory, "p1.stdout.log"), output)
                    await Bun.write(path.join(directory, "p1.stderr.log"), errors)
                    return ready
                  })()
                : await finish(first, "p1")
            const p2 = await finish(run("p2"), "p2")
            expect(p2.pid).not.toBe(p1.pid)
            expect(p2.file).toEqual(p1.file)
            expect(p2.wire).toEqual([])
            expect(p2.before).toEqual(p2.after)
            expect(p2.status.state).toBe(
              scenario === "success" ? "acknowledged" : scenario === "denied" ? "prepared" : "unknown",
            )
            expect(p2.messages).toHaveLength(1)
            expect(p2.networks).toBe(0)
            expect(p2.sessionInputs).toEqual({ n: 0 })
            expect(p2.providerAttempts).toEqual({ n: 0 })
            expect(p1.wire).toHaveLength(["identity", "denied", "missing-identity"].includes(scenario) ? 0 : 1)
            if (scenario === "ack-write") expect(p1.ackSQLFailureObserved).toBe(true)
            if (scenario === "denied") expect(p2.deniedInspections).toBeGreaterThan(0)
            if (scenario === "missing-identity") expect(p2.readerAdmitted).toBe(false)
            expect(p2.clockAdvanceMS).toBe(["lost", "ack-write"].includes(scenario) ? 660_000 : 0)
            if (p1.wire[0]) {
              expect(p1.wire[0].localMessageID).toBe(p2.messages[0].id)
              expect(p1.wire[0].clientMsgId).toBe(p2.before[0].wire_id)
            }
            await Bun.write(path.join(directory, "oracle.json"), JSON.stringify({ p1, p2 }, null, 2))
            console.info(
              "owned-cold-delivery-safe",
              JSON.stringify({
                scenario,
                status: p2.status,
                p1Publishes: p1.wire.length,
                p2Publishes: p2.wire.length,
                file: p2.file,
                clockAdvanceMS: p2.clockAdvanceMS,
              }),
            )
          })
        }
      }).pipe(Effect.scoped),
    )
    console.log(`KERNEL_DELIVERY_ARTIFACT ${root}`)
  } finally {
    clearTimeout(watchdog)
    await Promise.all(
      Array.from(children, async (child) => {
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
      }),
    )
  }
}, 60000)
