import { describe, expect, test } from "bun:test"
import { CHUNK_THRESHOLD, chunkCacheKey, partChunks, splitPartChunks } from "./message-part-chunk"

const KB = 1024

/** Builds `count` paragraphs of ~4KB each (content + trailing blank line). */
function paragraphs(count: number) {
  return Array.from({ length: count }, (_, i) => `paragraph-${i} ` + "x".repeat(4 * KB) + "\n\n").join("")
}

describe("partChunks (chunk decision)", () => {
  test("does not chunk text at or below the threshold", () => {
    expect(partChunks("x".repeat(CHUNK_THRESHOLD), false)).toBeUndefined()
    expect(partChunks("small text", false)).toBeUndefined()
    expect(partChunks("", false)).toBeUndefined()
  })

  test("chunks completed text above the threshold", () => {
    const chunks = partChunks(paragraphs(100), false)
    expect(chunks).toBeDefined()
    expect(chunks!.length).toBeGreaterThan(1)
  })

  test("never chunks while streaming, even above the threshold", () => {
    expect(partChunks(paragraphs(100), true)).toBeUndefined()
    expect(partChunks("x".repeat(CHUNK_THRESHOLD * 4), true)).toBeUndefined()
  })
})

describe("splitPartChunks", () => {
  test("returns the text untouched when it is a single chunk", () => {
    const text = paragraphs(10)
    expect(splitPartChunks(text)).toEqual([text])
  })

  test("preserves content exactly (join === original)", () => {
    const text = paragraphs(100)
    expect(splitPartChunks(text).join("")).toBe(text)
  })

  test("keeps chunk sizes within 64-256KB", () => {
    const chunks = splitPartChunks(paragraphs(100))
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0)
      expect(chunk.length).toBeLessThanOrEqual(256 * KB)
    }
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.length).toBeGreaterThanOrEqual(64 * KB)
    }
  })

  test("cuts at paragraph boundaries", () => {
    const chunks = splitPartChunks(paragraphs(100))
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.endsWith("\n\n")).toBe(true)
    }
  })

  test("splits an oversized paragraph at newline boundaries", () => {
    const huge = Array.from({ length: 400 }, (_, i) => `line-${i}-` + "y".repeat(1 * KB)).join("\n") + "\n\n"
    const text = huge + paragraphs(10)
    expect(text.length).toBeGreaterThan(CHUNK_THRESHOLD)
    const chunks = splitPartChunks(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join("")).toBe(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(256 * KB)
    }
  })

  test("hard-slices a single line longer than the max chunk size", () => {
    const text = "z".repeat(600 * KB)
    const chunks = splitPartChunks(text)
    expect(chunks.join("")).toBe(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(256 * KB)
    }
  })
})

describe("chunkCacheKey", () => {
  test("is stable and follows the partID:chunk:index format", () => {
    expect(chunkCacheKey("part_1", 0)).toBe("part_1:chunk:0")
    expect(chunkCacheKey("part_1", 3)).toBe("part_1:chunk:3")
    expect(chunkCacheKey("part_1", 0)).toBe(chunkCacheKey("part_1", 0))
  })

  test("produces distinct keys per chunk and per part", () => {
    const keys = new Set([
      chunkCacheKey("part_1", 0),
      chunkCacheKey("part_1", 1),
      chunkCacheKey("part_2", 0),
    ])
    expect(keys.size).toBe(3)
  })
})
