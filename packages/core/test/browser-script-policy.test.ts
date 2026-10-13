import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { BrowserSchema } from "../src/browser/schema"
import { Hash } from "../src/util/hash"

test("script opt-in binds exact well-formed UTF8 source and parameter bytes and defaults closed", () => {
  const command = { type: "evaluate" as const, tabID: "tab", generation: 1, frameID: "frame", observationRevision: 1,
    source: "return args", scriptHash: Hash.sha256("return args"), argsJSON: '[1,"验证"]' }
  const now = Date.now()
  const control: BrowserSchema.Control = { version: 1, controlID: "control", requestID: "create", requestDigest: "a".repeat(64),
    scope: { principal: "principal", securityNamespaceID: "namespace", locationKey: "location", projectScopeKey: "project-scope",
      namespaceBindingHash: "a".repeat(64), sessionID: "session", projectID: "project", directory: "/private/fixture", workspaceID: null },
    hostID: "host", hostIncarnation: "incarnation", resourceID: "resource", credentialBinding: "a".repeat(64),
    profile: BrowserSchema.INTERACTION_PROFILE, postPaths: [], origin: "http://127.0.0.1:3000", revision: 1, epoch: 1,
    policyRevision: 1, state: "active", expiresAt: now + 60_000, createdAt: now, updatedAt: now, cancel: null, stopConfirmedAt: null }
  expect(BrowserSchema.allowsScript(control, command)).toBe(false)
  const approved = { ...control, scriptGrants: [{ scriptHash: command.scriptHash,
    argsHash: Hash.sha256(command.argsJSON), readOnly: true as const }] }
  expect(BrowserSchema.allowsScript(approved, command)).toBe(true)
  expect(BrowserSchema.allowsScript(approved, { ...command, source: "return 2" })).toBe(false)
  expect(BrowserSchema.allowsScript(approved, { ...command, argsJSON: '[1, "验证"]' })).toBe(false)
  expect(Option.isSome(Schema.decodeUnknownOption(BrowserSchema.Command)(command))).toBe(true)
  for (const change of [{ argsJSON: "invalid" }, { argsJSON: '"\ud800"' }, { source: "\ud800" },
    { source: "🔥".repeat(2049) }])
    expect(Option.isNone(Schema.decodeUnknownOption(BrowserSchema.Command)({ ...command, ...change }))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(BrowserSchema.ScriptGrants)([
    ...approved.scriptGrants, ...approved.scriptGrants,
  ]))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(BrowserSchema.ScriptGrants)([
    { ...approved.scriptGrants[0], readOnly: false },
  ]))).toBe(true)
})
