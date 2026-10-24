import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Option, Schema } from "effect"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"

const Descriptor = Schema.Struct({
  peers: Schema.Struct({ A: Schema.Struct({ url: Schema.String, directory: Schema.String, authorizationFile: Schema.String }) }),
  groups: Schema.Struct({ A: Schema.Struct({ id: Schema.String }) }),
  files: Schema.Array(Schema.Struct({ path: Schema.String, filename: Schema.String, bytes: Schema.Number, sha256: Schema.String, mime: Schema.String })),
})
export type Input = typeof Descriptor.Type
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

/** The CLI has exactly one producer. Every HTTP result is the generated SDK's
 * original result; fixed diagnostic output never includes an error payload. */
export async function run(input: Input, root: string, attachments: 1 | 4 = 4) {
  assert(root.startsWith("/tmp/dac-im-media-product-") || root.startsWith(path.join(os.tmpdir(), "dac-im-media-product-lanes-")))
  assert(new URL(input.peers.A.url).hostname === "127.0.0.1")
  assert(input.peers.A.directory.startsWith(path.join(root, "A") + path.sep))
  assert(input.peers.A.authorizationFile.startsWith(path.join(root, "A") + path.sep))
  assert(input.files.length === attachments && input.files.every((file) => file.path.startsWith(path.join(root, "files") + path.sep)))
  const auth = await Bun.file(input.peers.A.authorizationFile).text()
  assert(auth.startsWith("Basic ") && !auth.includes("\n"))
  const facts: object[] = []
  const client = createDeepAgentCodeClient({ baseUrl: input.peers.A.url, directory: input.peers.A.directory, headers: { authorization: auth },
    fetch: Object.assign(async (request: Parameters<typeof fetch>[0]) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      assert(url.origin === input.peers.A.url && url.searchParams.get("directory") === input.peers.A.directory)
      const response = await fetch(request)
      facts.push({ stage: "http", status: response.status, at: Date.now(), upload: url.pathname === "/api/v1/im/attachments", send: url.pathname.endsWith("/messages") })
      return response
    }, { preconnect: fetch.preconnect }),
  })
  const ids: string[] = []
  for (const [index, file] of input.files.entries()) {
    const bytes = new Uint8Array(await Bun.file(file.path).arrayBuffer())
    assert(bytes.byteLength === file.bytes && createHash("sha256").update(bytes).digest("hex") === file.sha256)
    const response = await client.im.attachments.upload({ directory: input.peers.A.directory, groupId: input.groups.A.id, file: new File([bytes], file.filename, { type: file.mime }) },
      { responseStyle: "fields", throwOnError: false, signal: AbortSignal.timeout(120000) })
    facts.push({ stage: "upload", index, status: response.response?.status ?? 0, expectedBytes: file.bytes, success: !!response.data, at: Date.now() })
    const refusal = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.optional(Schema.String), data: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String) })) }))(response.error)
    assert(response.response?.status === 200 && response.data && response.data.sizeBytes === file.bytes,
      JSON.stringify({ stage: "owned-sdk-upload", status: response.response?.status ?? 0, ...(Option.isSome(refusal) ? { name: refusal.value.name, code: refusal.value.data?.code } : {}) }))
    ids.push(response.data.id)
    await fs.writeFile(path.join(root, "cli-safe.json"), JSON.stringify({ facts, sendCalls: 0 }, null, 2), { mode: 0o600 })
  }
  const clientRequestID = "qa-cli-" + randomUUID()
  await fs.writeFile(path.join(root, "cli-call-private.json"), JSON.stringify({ clientRequestID, attachmentIDs: ids, groupID: input.groups.A.id }), { mode: 0o600, flag: "wx" })
  const summary = { clientRequestIDHash: hash("im/clientRequestID\0" + clientRequestID), sendCalls: 1, facts }
  await fs.writeFile(path.join(root, "cli-safe.json"), JSON.stringify({ ...summary, terminal: "started" }, null, 2), { mode: 0o600 })
  return client.im.messages.create({ directory: input.peers.A.directory, groupId: input.groups.A.id, senderType: "user", type: "file", content: "private original ordered four-file diagnostic", attachmentIDs: ids, clientRequestID },
    { responseStyle: "fields", throwOnError: false, signal: AbortSignal.timeout(120000) }).then(async (response) => {
      const error = response.error as { code?: unknown } | undefined
      const code = typeof error?.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : undefined
      const safe = { ...summary, terminal: response.data ? "success" : "typed-error", status: response.response?.status ?? 0, ...(code ? { code } : {}),
        ...(response.data ? { messageHash: hash(response.data.id), groupMatched: response.data.groupID === input.groups.A.id, type: response.data.type } : {}) }
      await fs.writeFile(path.join(root, "cli-safe.json"), JSON.stringify(safe, null, 2), { mode: 0o600 })
      return { response, safe }
    }, async (error: unknown) => {
      await fs.writeFile(path.join(root, "cli-safe.json"), JSON.stringify({ ...summary, terminal: "unsettled-transport", status: 0,
        kind: error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? error.name : "transport" }, null, 2), { mode: 0o600 })
      throw new Error("Private onceSend did not settle")
    })
}

if (import.meta.main) {
  const file = path.resolve(process.argv[2] ?? "")
  assert(file.startsWith("/tmp/dac-im-media-product-") && path.basename(file) === "descriptor-private.json")
  const input = Schema.decodeUnknownSync(Descriptor)(await Bun.file(file).json())
  if (process.argv.includes("--dry")) {
    assert(input.files.length === 4 && input.files.map((item) => item.bytes).join(",") === "52428800,0,2432,70")
    assert(input.files.every((item) => item.path.startsWith(path.dirname(file) + "/files/")))
    console.log(JSON.stringify({ dry: true, producers: 0, calls: 0, files: 4, bytes: input.files.map((item) => item.bytes) }))
  } else {
    const result = await run(input, path.dirname(file))
    console.log(JSON.stringify({ terminal: result.safe.terminal, status: result.safe.status, sendCalls: 1 }))
  }
}

export * as MediaSdkOnce from "./kernel-media-sdk-once"
