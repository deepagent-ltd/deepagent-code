import { expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { Multipart } from "effect/unstable/http"

const captured = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      source: Schema.String,
      bodyBase64: Schema.String,
      bodyUtf8: Schema.String,
      contentType: Schema.String,
    }),
  ),
)(await Bun.file(new URL("../fixture/multipart/chrome-utf8-filename.json", import.meta.url)).text())

const parse = (body: Uint8Array, contentType: string, chunkSize: number) =>
  Stream.fromIterable(
    Array.from({ length: Math.ceil(body.length / chunkSize) }, (_, index) =>
      body.subarray(index * chunkSize, (index + 1) * chunkSize),
    ),
  ).pipe(
    Stream.pipeThroughChannel(Multipart.makeChannel<never>({ "content-type": contentType })),
    Stream.mapEffect((part) =>
      Effect.gen(function* () {
        if (Multipart.isFile(part))
          return { kind: "file" as const, key: part.key, name: part.name, bytes: [...(yield* part.contentEffect)] }
        return { kind: "field" as const, key: part.key, value: part.value }
      }),
    ),
    Stream.runCollect,
    Effect.scoped,
  )

test("parses a real Chrome UTF-8 filename without losing the file field or bytes", async () => {
  expect(captured.source).toContain("Chrome FormData")
  const bytes = Uint8Array.from(Buffer.from(captured.bodyBase64, "base64"))
  expect(new TextDecoder().decode(bytes)).toBe(captured.bodyUtf8)
  for (const chunkSize of [1, 17, bytes.length]) {
    expect(await Effect.runPromise(parse(bytes, captured.contentType, chunkSize))).toEqual([
      { kind: "file", key: "file", name: "中文.bin", bytes: [1, 2, 3] },
      { kind: "field", key: "groupId", value: "img_safe_fixture" },
    ])
  }
})

test("preserves ASCII, emoji, combining text and RFC extended filename behavior", async () => {
  for (const name of ["file.bin", "文件😀.bin", "é.bin"]) {
    const body = new TextEncoder().encode(captured.bodyUtf8.replace('filename="中文.bin"', `filename="${name}"`))
    const parts = await Effect.runPromise(parse(body, captured.contentType, 1))
    expect(parts[0]).toEqual({ kind: "file", key: "file", name, bytes: [1, 2, 3] })
    expect(parts[1]).toEqual({ kind: "field", key: "groupId", value: "img_safe_fixture" })
  }
  const extended = new TextEncoder().encode(
    captured.bodyUtf8.replace(
      'filename="中文.bin"',
      "filename=\"fallback.bin\"; filename*=UTF-8''%E4%B8%AD%E6%96%87.bin",
    ),
  )
  expect((await Effect.runPromise(parse(extended, captured.contentType, 1)))[0]).toEqual({
    kind: "file",
    key: "file",
    name: "中文.bin",
    bytes: [1, 2, 3],
  })
})

test("retains actual parser limits and rejects line breaks in disposition values", async () => {
  const bytes = new TextEncoder().encode(captured.bodyUtf8)
  for (const limits of [{ maxParts: 1 }, { maxFileSize: 2 }, { maxTotalSize: bytes.length - 1 }, { maxFieldSize: 4 }]) {
    for (const chunkSize of [1, 17, bytes.length]) {
      expect(
        (
          await Effect.runPromise(
            parse(bytes, captured.contentType, chunkSize).pipe(
              Effect.provideContext(Multipart.limitsServices(limits)),
              Effect.exit,
            ),
          )
        )._tag,
      ).toBe("Failure")
    }
  }
  const malformed = new TextEncoder().encode(
    captured.bodyUtf8.replace('filename="中文.bin"', 'filename="broken\r\nvalue.bin"'),
  )
  expect((await Effect.runPromise(parse(malformed, captured.contentType, 1).pipe(Effect.exit)))._tag).toBe("Failure")
  const invalidEncoding = new TextEncoder().encode(
    captured.bodyUtf8.replace('filename="中文.bin"', "filename*=UTF-8''%E4%invalid"),
  )
  expect((await Effect.runPromise(parse(invalidEncoding, captured.contentType, 1).pipe(Effect.exit)))._tag).toBe(
    "Failure",
  )
})

test("accepts exactly the allowed file-body bytes without charging its disposition headers", async () => {
  const bytes = new TextEncoder().encode(captured.bodyUtf8.replace("\u0001\u0002\u0003", "a".repeat(1024)))
  for (const chunkSize of [1, 17, bytes.length]) {
    const parts = await Effect.runPromise(
      parse(bytes, captured.contentType, chunkSize).pipe(
        Effect.provideContext(
          Multipart.limitsServices({ maxParts: 2, maxFileSize: 1024, maxTotalSize: 8192, maxFieldSize: 1024 }),
        ),
      ),
    )
    expect(parts[0]?.kind).toBe("file")
    expect(parts[0]?.kind === "file" && parts[0].name).toBe("中文.bin")
    expect(parts[0]?.kind === "file" && parts[0].bytes).toEqual(Array.from({ length: 1024 }, () => 97))
  }
})
