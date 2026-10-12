/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createOpencodeClient } from "@deepagent-code/sdk"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"
import { MediaBatch } from "@deepagent-code/core/im/media-batch"
import { createIMClient, type IMGroup } from "../../../src/component/im-client"
import { DialogIMMedia } from "../../../src/component/dialog-im-media"
import { createMediaBatchStore } from "../../../src/util/im-media-intent"
import { mountIM, until } from "../../fixture/im-environment"
import { tmpdir } from "../../fixture/fixture"
import path from "node:path"

async function fixture(directory: string) {
  const state = {
    lost: true,
    enabled: true,
    multiple: true,
    uploads: [] as MediaIntent.Attachment[],
    protected: false,
    detailEpoch: "current",
    sends: [] as { content: string; attachmentIDs?: string[]; attachmentID?: string; clientRequestID: string }[],
    gate: undefined as Promise<void> | undefined,
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== "Bearer fixture-token") return new Response(null, { status: 403 })
      const url = new URL(request.url)
      if (url.pathname === "/global/capabilities")
        return Response.json({ features: { v4FileUploadEnabled: state.enabled } })
      if (url.pathname.endsWith("/status"))
        return Response.json({
          facade: "disabled",
          identity: null,
          blocked: null,
          kernel: state.protected ? "connected" : null,
          ...(state.protected ? { reader: { state: "ready", displayEpoch: "current", legacyMirrorUnavailable: true } } : {}),
          keyOrigin: "none",
          viewer: { memberID: "viewer" },
          ...(state.multiple
            ? {
                media: {
                  version: 2,
                  enabled: state.enabled,
                  multipleAttachments: true,
                  maxAttachments: 4,
                  maxAttachmentBytes: 10485760,
                  ttlMs: 86400000,
                },
              }
            : {}),
        })
      if (url.pathname.endsWith("/attachments") && request.method === "POST") {
        const form = await request.formData()
        const file = form.get("file")
        if (!file || typeof file === "string") throw new Error("Missing original multipart file")
        const body = new Uint8Array(await file.arrayBuffer())
        const createdAt = Date.now()
        const receipt = MediaIntent.attachment({
          id: `attachment-${state.uploads.length + 1}`,
          workspaceID: directory,
          projectID: null,
          groupID: form.get("groupId"),
          messageID: null,
          uploadedBy: "viewer",
          filename: file.name,
          mime: "application/octet-stream",
          sizeBytes: body.length,
          checksum: await MediaIntent.checksum(body),
          createdAt,
          expiresAt: createdAt + 86400000,
          preview: false,
        })
        state.uploads.push(receipt)
        await state.gate
        return Response.json(receipt)
      }
      if (url.pathname.endsWith("/groups/group")) return Response.json({ version: 1,
        group: { ...group(directory), kernelConvID: "kr1:pending", reader: { mode: "protected", state: "pending", liveUnread: null } },
        reader: { displayEpoch: state.detailEpoch, proofWindowMs: 1000, nextExpiryAt: null } })
      if (url.pathname.endsWith("/messages") && request.method === "POST") {
        const input = (await request.json()) as (typeof state.sends)[number]
        state.sends.push(input)
        if (state.lost) {
          state.lost = false
          return new Response(null, { status: 503 })
        }
        return Response.json({
          id: "message",
          groupID: "group",
          senderID: "viewer",
          senderType: "user",
          type: "file",
          content: input.content,
          metadata: input.attachmentIDs
            ? input.attachmentIDs.map((id) => ({ type: "attachment_ref", attachmentID: id, batch: true }))
            : { type: "attachment_ref", attachmentID: input.attachmentID },
          mentions: null,
          replyToID: null,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        })
      }
      return new Response(null, { status: 404 })
    },
  })
  const sdk = {
    url: server.url.href,
    directory,
    client: createOpencodeClient({ baseUrl: server.url.href, headers: { Authorization: "Bearer fixture-token" } }),
  }
  return {
    state,
    sdk,
    client: createIMClient(sdk),
    async close() {
      await server.stop(true)
    },
  }
}
function group(directory: string): IMGroup {
  return {
    id: "group",
    workspaceID: directory,
    projectID: null,
    type: "group",
    name: "Private",
    createdBy: "viewer",
    kernelConvID: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
}

test("pending history and current send scope allow the first attachment menu without a send", async () => {
  await using dir = await tmpdir()
  const api = await fixture(dir.path)
  api.state.protected = true
  try {
    using ui = await mountIM(dir.path, api.sdk.url, () => <DialogIMMedia client={api.client}
      group={{ ...group(dir.path), kernelConvID: "kr1:pending", reader: { mode: "protected", state: "pending", liveUnread: null } }}
      identity="viewer" back={() => {}} onSent={() => {}} />, 80)
    await ui.frame("Upload a local file")
    expect(api.state.uploads).toHaveLength(0)
    expect(api.state.sends).toHaveLength(0)
  } finally { await api.close() }
})

test("pending media menu rejects a mismatched current reader epoch without upload or send", async () => {
  await using dir = await tmpdir()
  const api = await fixture(dir.path)
  api.state.protected = true
  api.state.detailEpoch = "other"
  try {
    using ui = await mountIM(dir.path, api.sdk.url, () => <DialogIMMedia client={api.client}
      group={{ ...group(dir.path), kernelConvID: "kr1:pending", reader: { mode: "protected", state: "pending", liveUnread: null } }}
      identity="viewer" back={() => {}} onSent={() => {}} />, 80)
    await ui.frame("File sharing is disabled or unsupported here.")
    expect(ui.app.captureCharFrame()).not.toContain("Upload a local file")
    expect(api.state.uploads).toHaveLength(0)
    expect(api.state.sends).toHaveLength(0)
  } finally { await api.close() }
})

test("actual 80-column keyboard draft uploads four files without sending; retry uses one exact ordered request", async () => {
  await using dir = await tmpdir()
  const api = await fixture(dir.path)
  const delivered: string[] = []
  try {
    using ui = await mountIM(
      dir.path,
      api.sdk.url,
      () => (
        <DialogIMMedia
          client={api.client}
          group={group(dir.path)}
          identity="viewer"
          back={() => {}}
          onSent={(message) => delivered.push(message.id)}
        />
      ),
      80,
    )
    await ui.frame("Upload a local file")
    for (const [index, name] of ["one", "two", "three", "four"].entries()) {
      const file = path.join(dir.path, name)
      await Bun.write(file, name)
      await ui.select(index ? "Add another file" : "Upload a local file")
      await ui.frame("Path on this computer")
      await ui.type(file)
      ui.app.mockInput.pressEnter()
      await ui.frame(`Remove from draft · ${name}`)
    }
    expect(api.state.uploads).toHaveLength(0)
    expect(ui.app.captureCharFrame()).not.toContain("Add another file")
    await ui.select("Upload selected files")
    await until(() => api.state.uploads.length === 4, "all original multipart uploads")
    await ui.frame("Send attachments together")
    expect(api.state.uploads).toHaveLength(4)
    expect(api.state.sends).toHaveLength(0)
    await ui.select("Remove from draft · two")
    await ui.frame("Send attachments together · 3")
    await ui.select("Message (optional)")
    await ui.type("exact caption")
    ui.app.mockInput.pressEnter()
    await ui.frame("exact caption")
    await ui.select("Send attachments together")
    await ui.frame("Message result is unknown")
    expect(delivered).toEqual([])
    expect(api.state.sends).toHaveLength(1)
    await ui.select("Retry same message")
    await until(() => delivered.length === 1, "exact retry receipt")
    expect(api.state.sends).toHaveLength(2)
    expect(api.state.sends[1]).toEqual(api.state.sends[0])
    expect(api.state.sends[0].attachmentIDs).toEqual(["attachment-1", "attachment-3", "attachment-4"])
    expect(api.state.sends[0].content).toBe("exact caption")
    expect(api.state.uploads).toHaveLength(4)
    const scope = MediaIntent.scope({
      server: api.client.scope().url,
      directory: dir.path,
      workspaceID: dir.path,
      groupID: "group",
      memberID: "viewer",
    })
    const records = await createMediaBatchStore(path.join(dir.path, "state")).list(scope)
    expect(records).toHaveLength(1)
    expect(records[0].phase).toBe("bound")
    expect(records[0].messageID).toBe("message")
  } finally {
    await api.close()
  }
}, 10000)

test("cold sending reads as unknown without dispatch; the original private store rejects a stale writer", async () => {
  await using dir = await tmpdir()
  const api = await fixture(dir.path)
  try {
    const scope = MediaIntent.scope({
      server: api.client.scope().url,
      directory: dir.path,
      workspaceID: dir.path,
      groupID: "group",
      memberID: "viewer",
    })
    const createdAt = Date.now()
    const record = MediaBatch.create(
      scope,
      {
        intentID: "intent",
        attachment: MediaIntent.attachment({
          id: "attachment",
          workspaceID: dir.path,
          projectID: null,
          groupID: "group",
          messageID: null,
          uploadedBy: "viewer",
          filename: "file",
          mime: "application/octet-stream",
          sizeBytes: 1,
          checksum: "a".repeat(64),
          preview: false,
          createdAt,
          expiresAt: createdAt + 86400000,
        }),
      },
      "batch",
    )
    const store = createMediaBatchStore(path.join(dir.path, "state"))
    await store.put(record)
    await store.put(MediaBatch.change(record, "sending"), record.revision)
    await expect(store.put(MediaBatch.edit(record, { content: "stale" }), record.revision)).rejects.toThrow()
    using ui = await mountIM(
      dir.path,
      api.sdk.url,
      () => (
        <DialogIMMedia
          client={api.client}
          group={group(dir.path)}
          identity="viewer"
          back={() => {}}
          onSent={() => {
            throw new Error("Unexpected automatic resend")
          }}
        />
      ),
      80,
    )
    await ui.frame("Message result is unknown")
    expect(api.state.sends).toHaveLength(0)
    expect(api.state.uploads).toHaveLength(0)
    expect((await store.list(scope))[0].phase).toBe("sending")
  } finally {
    await api.close()
  }
})

test("actual keyboard cancel stops the pending multipart batch and preserves an unknown upload without a message", async () => {
  await using dir = await tmpdir()
  const api = await fixture(dir.path)
  const gate = Promise.withResolvers<void>()
  api.state.gate = gate.promise
  try {
    using ui = await mountIM(
      dir.path,
      api.sdk.url,
      () => (
        <DialogIMMedia
          client={api.client}
          group={group(dir.path)}
          identity="viewer"
          back={() => {}}
          onSent={() => {
            throw new Error("Unexpected send after upload cancel")
          }}
        />
      ),
      80,
    )
    await ui.frame("Upload a local file")
    for (const [index, name] of ["first", "second"].entries()) {
      const file = path.join(dir.path, name)
      await Bun.write(file, name)
      await ui.select(index ? "Add another file" : "Upload a local file")
      await ui.type(file)
      ui.app.mockInput.pressEnter()
      await ui.frame(`Remove from draft · ${name}`)
    }
    await ui.select("Upload selected files")
    await until(() => api.state.uploads.length === 1, "first pending original multipart")
    await ui.select("Cancel upload")
    await ui.frame("Upload result unknown")
    expect(api.state.uploads).toHaveLength(1)
    expect(api.state.sends).toHaveLength(0)
    expect(ui.app.captureCharFrame()).not.toContain("Retry same message")
  } finally {
    gate.resolve()
    await api.close()
  }
})
