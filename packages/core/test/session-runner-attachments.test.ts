import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Model } from "@deepagent-code/llm"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { FileAttachment } from "@deepagent-code/core/session/prompt"
import { normalizeAttachments } from "@deepagent-code/core/session/runner/attachments"
import { toLLMMessages } from "@deepagent-code/core/session/runner/to-llm-message"
import { testEffect } from "./lib/effect"

const it = testEffect(FSUtil.defaultLayer)

const created = DateTime.makeUnsafe(0)
const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })

const user = (files: FileAttachment[], text = "inspect this") =>
  new SessionMessage.User({
    id: SessionMessage.ID.make("msg_attachments"),
    type: "user",
    text,
    files,
    time: { created },
  })

const withTmpdir = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "attachments-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
    return yield* use(directory)
  })

const asUser = (message: SessionMessage.Message | undefined) => {
  if (message?.type !== "user") throw new Error("expected a user message")
  return message
}

describe("normalizeAttachments", () => {
  it.effect("inlines a directory attachment as a listing block and drops the file part", () =>
    withTmpdir((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(join(directory, "src")))
        yield* Effect.promise(() => writeFile(join(directory, "a.txt"), "hello"))
        yield* Effect.promise(() => symlink(join(directory, "src"), join(directory, "link")))
        const file = new FileAttachment({
          uri: pathToFileURL(directory).href,
          mime: "application/x-directory",
          name: "root",
        })

        const [message] = yield* normalizeAttachments([user([file])], ["text"])

        expect(message?.type).toBe("user")
        const normalized = asUser(message)
        expect(normalized.files).toEqual([])
        expect(normalized.text).toBe(
          [
            "inspect this",
            `<attached-directory name="root">\n${[
              `<path>${directory}</path>`,
              `<type>directory</type>`,
              `<entries>`,
              `a.txt\nlink/\nsrc/`,
              `\n(3 entries)`,
              `</entries>`,
            ].join("\n")}\n</attached-directory>`,
          ].join("\n\n"),
        )
      }),
    ),
  )

  it.effect("degrades an unreadable directory attachment to a note instead of failing", () =>
    Effect.gen(function* () {
      const file = new FileAttachment({
        uri: "file:///nonexistent-attachments-dir",
        mime: "application/x-directory",
        name: "missing",
      })

      const [message] = yield* normalizeAttachments([user([file])], ["text"])

      const normalized = asUser(message)
      expect(normalized.files).toEqual([])
      expect(normalized.text).toBe("inspect this\n\n[Attached directory missing could not be read]")
    }),
  )

  it.effect("materializes a pdf file: attachment into a base64 data URL when the model declares pdf input", () =>
    withTmpdir((directory) =>
      Effect.gen(function* () {
        const bytes = Buffer.from("%PDF-1.4 fake pdf body")
        yield* Effect.promise(() => writeFile(join(directory, "doc.pdf"), bytes))
        const file = new FileAttachment({
          uri: pathToFileURL(join(directory, "doc.pdf")).href,
          mime: "application/pdf",
          name: "doc.pdf",
        })

        const [message] = yield* normalizeAttachments([user([file])], ["text", "pdf"])

        const normalized = asUser(message)
        expect(normalized.text).toBe("inspect this")
        expect(normalized.files).toHaveLength(1)
        expect(normalized.files?.[0]).toMatchObject({
          uri: `data:application/pdf;base64,${bytes.toString("base64")}`,
          mime: "application/pdf",
          name: "doc.pdf",
        })
        // The materialized shape is what the canonical protocol layer accepts on the wire.
        const wire = toLLMMessages([normalized], model)
        expect(wire[0]?.content).toEqual([
          { type: "text", text: "inspect this" },
          {
            type: "media",
            mediaType: "application/pdf",
            data: `data:application/pdf;base64,${bytes.toString("base64")}`,
            filename: "doc.pdf",
          },
        ])
      }),
    ),
  )

  it.effect("degrades a pdf attachment to the V1 error text when the model lacks pdf input", () =>
    withTmpdir((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(join(directory, "doc.pdf"), "%PDF-1.4"))
        const file = new FileAttachment({
          uri: pathToFileURL(join(directory, "doc.pdf")).href,
          mime: "application/pdf",
          name: "doc.pdf",
        })

        const [message] = yield* normalizeAttachments([user([file])], ["text"])

        const normalized = asUser(message)
        expect(normalized.files).toEqual([])
        expect(normalized.text).toBe(
          'inspect this\n\nERROR: Cannot read "doc.pdf" (this model does not support pdf input). Inform the user.',
        )
      }),
    ),
  )

  it.effect("degrades an image attachment when the model lacks image input", () =>
    Effect.gen(function* () {
      const file = new FileAttachment({
        uri: "data:image/png;base64,aGVsbG8=",
        mime: "image/png",
        name: "hello.png",
      })

      const [message] = yield* normalizeAttachments([user([file])], ["text"])

      const normalized = asUser(message)
      expect(normalized.files).toEqual([])
      expect(normalized.text).toBe(
        'inspect this\n\nERROR: Cannot read "hello.png" (this model does not support image input). Inform the user.',
      )
    }),
  )

  it.effect("keeps a supported image attachment data URL unchanged", () =>
    Effect.gen(function* () {
      const file = new FileAttachment({
        uri: "data:image/png;base64,aGVsbG8=",
        mime: "image/png",
        name: "hello.png",
      })

      const [message] = yield* normalizeAttachments([user([file])], ["text", "image"])

      const normalized = asUser(message)
      expect(normalized.text).toBe("inspect this")
      expect(normalized.files).toEqual([file])
    }),
  )

  it.effect("materializes binary attachments without a capability gate when model capabilities are unknown", () =>
    withTmpdir((directory) =>
      Effect.gen(function* () {
        const bytes = Buffer.from("%PDF-1.4 fake pdf body")
        yield* Effect.promise(() => writeFile(join(directory, "doc.pdf"), bytes))
        const file = new FileAttachment({
          uri: pathToFileURL(join(directory, "doc.pdf")).href,
          mime: "application/pdf",
          name: "doc.pdf",
        })

        const [message] = yield* normalizeAttachments([user([file])], undefined)

        const normalized = asUser(message)
        expect(normalized.files?.[0]?.uri).toBe(`data:application/pdf;base64,${bytes.toString("base64")}`)
      }),
    ),
  )

  it.effect("degrades an unreadable binary file to a note instead of failing", () =>
    Effect.gen(function* () {
      const file = new FileAttachment({
        uri: "file:///nonexistent-attachments-doc.pdf",
        mime: "application/pdf",
        name: "doc.pdf",
      })

      const [message] = yield* normalizeAttachments([user([file])], ["text", "pdf"])

      const normalized = asUser(message)
      expect(normalized.files).toEqual([])
      expect(normalized.text).toBe("inspect this\n\n[Attached file doc.pdf could not be read]")
    }),
  )

  it.effect("rejects non-data non-file attachment URIs with a typed InvalidRequest error", () =>
    Effect.gen(function* () {
      const file = new FileAttachment({
        uri: "https://example.com/doc.pdf",
        mime: "application/pdf",
        name: "doc.pdf",
      })

      const failure = yield* normalizeAttachments([user([file])], ["text", "pdf"]).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "LLM.Error",
        module: "SessionRunner",
        method: "normalizeAttachments",
        reason: { _tag: "InvalidRequest" },
      })
      expect(failure.reason.message).toContain("https://example.com/doc.pdf")
      expect(failure.reason.message).toContain("application/pdf")
    }),
  )

  it.effect("keeps unknown-modality binaries on the wire for the protocol layer to judge", () =>
    withTmpdir((directory) =>
      Effect.gen(function* () {
        const bytes = Buffer.from("PK zip-ish")
        yield* Effect.promise(() => writeFile(join(directory, "bundle.zip"), bytes))
        const file = new FileAttachment({
          uri: pathToFileURL(join(directory, "bundle.zip")).href,
          mime: "application/zip",
          name: "bundle.zip",
        })

        const [message] = yield* normalizeAttachments([user([file])], ["text"])

        const normalized = asUser(message)
        expect(normalized.text).toBe("inspect this")
        expect(normalized.files?.[0]?.uri).toBe(`data:application/zip;base64,${bytes.toString("base64")}`)
      }),
    ),
  )

  it.effect("still inlines text attachments and mixes them with kept binary media", () =>
    withTmpdir((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeFile(join(directory, "notes.txt"), "text body"))
        const bytes = Buffer.from("%PDF-1.4 fake pdf body")
        yield* Effect.promise(() => writeFile(join(directory, "doc.pdf"), bytes))
        const text = new FileAttachment({
          uri: pathToFileURL(join(directory, "notes.txt")).href,
          mime: "text/plain",
          name: "notes.txt",
        })
        const pdf = new FileAttachment({
          uri: pathToFileURL(join(directory, "doc.pdf")).href,
          mime: "application/pdf",
          name: "doc.pdf",
        })

        const [message] = yield* normalizeAttachments([user([text, pdf])], ["text", "pdf"])

        const normalized = asUser(message)
        expect(normalized.files).toHaveLength(1)
        expect(normalized.files?.[0]?.uri).toBe(`data:application/pdf;base64,${bytes.toString("base64")}`)
        expect(normalized.text).toBe(
          'inspect this\n\n<attached-file name="notes.txt" mime="text/plain">\ntext body\n</attached-file>',
        )
      }),
    ),
  )
})
