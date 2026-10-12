export * as BrowserClientWindow from "./browser-client-window-descriptor"

import { Schema } from "effect"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192),
  Schema.makeFilter((value: string) => value.isWellFormed()))
const Loopback = Text.check(Schema.makeFilter((value: string) => /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(value)))
const PrivatePath = Text.check(Schema.makeFilter((value: string) => value.startsWith("/") && !value.includes("\0")))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Descriptor = Schema.Struct({
  version: Schema.Literal(1),
  evidence: Schema.Literal("source-runtime-canonical-client-hold-window"),
  rootURL: Loopback,
  appOrigin: Loopback,
  authorizationFile: PrivatePath,
  directory: PrivatePath,
  output: PrivatePath,
  deadlineAt: Schema.Int.check(Schema.isGreaterThan(0)),
  sessions: Schema.Struct({ gui: Text, tui: Text }),
  pageOrigin: Loopback,
  postPath: Schema.Literal("/program-submit"),
  program: Schema.Struct({ source: Text, argsJSON: Schema.Literal("null"), scriptHash: Hash, argsHash: Hash,
    operations: Schema.Tuple([Schema.Literal("fill"), Schema.Literal("select"), Schema.Literal("click")]), maxSteps: Schema.Literal(3) }),
  model: Schema.Struct({ providerID: Schema.Literal("fixture"), modelID: Schema.Literal("test-model") }),
  expectedProviderTurnsPerClient: Schema.Literal(5),
  stopFile: PrivatePath,
})
export type Descriptor = typeof Descriptor.Type

/** Coordinates are QA observations, never a permission, Native grant, control or
 * admission. Each client must obtain the original formal control/current view. */
export function decode(value: unknown) {
  const input = Schema.decodeUnknownSync(Descriptor)(value)
  if (input.sessions.gui === input.sessions.tui || ![input.sessions.gui, input.sessions.tui].every((id) => id.startsWith("ses")))
    throw new Error("Each original client requires its own real V2 Session")
  if (new URL(input.rootURL).origin === new URL(input.appOrigin).origin || new URL(input.rootURL).origin === new URL(input.pageOrigin).origin)
    throw new Error("Actual Root, App and controlled page require independent loopback listeners")
  if (createHash("sha256").update(input.program.source).digest("hex") !== input.program.scriptHash ||
      createHash("sha256").update(input.program.argsJSON).digest("hex") !== input.program.argsHash)
    throw new Error("Exact approved program bytes changed")
  return input
}

export async function read(filename: string, live = false) {
  const input = decode(await Bun.file(filename).json())
  const stat = await fs.lstat(input.authorizationFile)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 8192)
    throw new Error("Private original Basic credential required")
  const authorization = await fs.readFile(input.authorizationFile, "utf8")
  if (!/^Basic [A-Za-z0-9+/]+=*$/.test(authorization)) throw new Error("Canonical Basic credential required")
  if (live && Date.now() >= input.deadlineAt) throw new Error("The original Native window has ended")
  return { input, authorization }
}
