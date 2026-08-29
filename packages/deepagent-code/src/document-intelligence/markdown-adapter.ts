import { RepoDocument } from "@deepagent-code/core/document-intelligence/repo-document"
import { Hash } from "@deepagent-code/core/util/hash"
import { Lexer } from "marked"
import type { File } from "../location-index/manifest"

export function indexMarkdown(file: File): readonly RepoDocument.Entry[] {
  const tokens = new Lexer().lex(file.content)
  const headings: { readonly depth: number; readonly text: string; readonly raw: string; readonly offset: number }[] = []
  let offset = 0
  for (const token of tokens) {
    const position = file.content.indexOf(token.raw, offset)
    const start = position === -1 ? offset : position
    if (token.type === "heading") headings.push({ depth: token.depth, text: token.text, raw: token.raw, offset: start })
    offset = start + token.raw.length
  }
  if (headings.length === 0) {
    return [entry(file, "", "root", 0, file.content.length)]
  }
  const ancestry: string[] = []
  return headings.map((heading, index) => {
    ancestry.splice(heading.depth - 1)
    ancestry[heading.depth - 1] = heading.text
    const end = headings[index + 1]?.offset ?? file.content.length
    return entry(file, ancestry.filter(Boolean).join(" / "), slug(heading.text), heading.offset, end)
  })
}

function entry(file: File, headingPath: string, anchor: string, start: number, end: number): RepoDocument.Entry {
  const startLine = lineAt(file.content, start)
  const endLine = Math.max(startLine, lineAt(file.content, Math.max(start, end - 1)))
  return {
    documentId: `repo_document_${Hash.sha256(`markdown-v1:${file.path}:${anchor}:${startLine}`)}`,
    path: file.path,
    contentSha: Hash.sha256(file.content),
    headingPath,
    anchor,
    startLine,
    endLine,
    searchableText: file.content.slice(start, end).slice(0, 64 * 1024),
  }
}

function lineAt(content: string, offset: number) {
  return content.slice(0, offset).split(/\r\n|\r|\n/).length
}

function slug(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "") || "section"
}
