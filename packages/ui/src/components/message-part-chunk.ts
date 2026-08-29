// UX-002: inline chunking for oversized text/reasoning parts. Row-level virtua
// virtualization groups rows by turn, so a single huge part (observed up to ~16MB)
// was mounted and morphdom-diffed as one monolithic Markdown block. We split the
// completed text into 64-256KB pieces at paragraph/newline boundaries and render
// each piece as an independent Markdown instance (see ChunkedText in
// message-part.tsx). Kept as a pure, dependency-free module so the chunk logic is
// unit-testable without pulling Solid component imports into the test runtime.

export const CHUNK_THRESHOLD = 256 * 1024
const CHUNK_MIN = 64 * 1024
const CHUNK_MAX = 256 * 1024

// Deterministic per (part text, index): part text is frozen once the message is
// completed, so cache keys are stable across re-renders and re-mounts.
export function chunkCacheKey(partID: string, index: number) {
  return `${partID}:chunk:${index}`
}

function pushChunk(chunks: string[], buffer: string[]) {
  const value = buffer.join("")
  if (value) chunks.push(value)
  buffer.length = 0
}

// Last-resort splitter for a single line longer than CHUNK_MAX (e.g. minified or
// binary-ish dumps): hard slice; no newline boundary exists to respect.
function pushOversized(chunks: string[], line: string) {
  for (let start = 0; start < line.length; start += CHUNK_MAX) {
    chunks.push(line.slice(start, start + CHUNK_MAX))
  }
}

function flushLines(chunks: string[], block: string) {
  const lines = block.split(/(?<=\n)/)
  let buffer = ""
  for (const line of lines) {
    if (line.length >= CHUNK_MAX) {
      if (buffer) {
        chunks.push(buffer)
        buffer = ""
      }
      pushOversized(chunks, line)
      continue
    }
    if (buffer && buffer.length + line.length > CHUNK_MAX) {
      chunks.push(buffer)
      buffer = ""
    }
    buffer += line
    if (buffer.length >= CHUNK_MIN) {
      chunks.push(buffer)
      buffer = ""
    }
  }
  if (buffer) chunks.push(buffer)
}

// Splits completed part text into 64-256KB chunks. Primary boundaries are blank
// lines (paragraphs); a paragraph larger than CHUNK_MAX is further split at
// newline boundaries. Concatenating all chunks reproduces the input exactly.
export function splitPartChunks(text: string): string[] {
  if (text.length <= CHUNK_THRESHOLD) return [text]

  const chunks: string[] = []
  let buffer: string[] = []
  const size = () => buffer.reduce((sum, item) => sum + item.length, 0)

  const flush = () => pushChunk(chunks, buffer)

  for (const paragraph of text.split(/(?<=\n\n)/)) {
    if (paragraph.length >= CHUNK_MAX) {
      if (size() >= CHUNK_MIN) flush()
      else if (buffer.length > 0) flush()
      flushLines(chunks, paragraph)
      continue
    }
    if (size() + paragraph.length > CHUNK_MAX) flush()
    buffer.push(paragraph)
    if (size() >= CHUNK_MIN) flush()
  }
  flush()
  return chunks
}

// Chunk decision: never split while the part is still streaming (a growing
// buffer would shift chunk boundaries on every update); split only once the
// completed text exceeds the threshold.
export function partChunks(text: string, streaming: boolean): string[] | undefined {
  if (streaming || text.length <= CHUNK_THRESHOLD) return
  return splitPartChunks(text)
}
