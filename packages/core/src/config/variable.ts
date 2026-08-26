export * as ConfigVariable from "./variable"

import os from "os"
import path from "path"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"

export function substitute(input: {
  text: string
  path: string
  filesystem: FSUtil.Interface
  environment?: Readonly<Record<string, string | undefined>>
}) {
  const text = input.text.replace(/\{env:([^}]+)\}/g, (_, name) => input.environment?.[name] ?? process.env[name] ?? "")
  const matches = Array.from(text.matchAll(/\{file:[^}]+\}/g))
  if (!matches.length) return Effect.succeed(text)

  return Effect.gen(function* () {
    let output = ""
    let cursor = 0
    for (const match of matches) {
      const token = match[0]
      const index = match.index
      output += text.slice(cursor, index)

      const lineStart = text.lastIndexOf("\n", index - 1) + 1
      if (text.slice(lineStart, index).trimStart().startsWith("//")) {
        output += token
        cursor = index + token.length
        continue
      }

      const file = token.slice("{file:".length, -1)
      const resolved = path.isAbsolute(file)
        ? file
        : file.startsWith("~/")
          ? path.join(os.homedir(), file.slice(2))
          : path.resolve(path.dirname(input.path), file)
      output += JSON.stringify((yield* input.filesystem.readFileString(resolved)).trim()).slice(1, -1)
      cursor = index + token.length
    }
    return output + text.slice(cursor)
  })
}
