import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit } from "effect"
import { DurablePublish } from "@deepagent-code/core/database/durable-publish"

export * as DurablePublishEnvironment from "./durable-publish-environment"

/** The candidate changes exactly two expressions; reversing them and logging restores the bridge. */
export function instrument(source: string, candidate = false) {
  assert(!source.includes("DAC_TEST_PS_TRACE"))
  const original = "New-Object System.Text.UTF8Encoding($false)"
  const constructor = "[System.Text.UTF8Encoding]::new($false)"
  assert.equal(source.split(original).length, 3, "The original bridge must contain exactly two encoding expressions")
  assert(!source.includes(constructor))
  const encoding = candidate ? constructor : original
  const prepared = candidate ? source.replaceAll(original, constructor) : source
  const inserted: string[] = []
  const log = (phase: string) => {
    const text =
      "\n# DAC_TEST_PS_TRACE\n[Console]::Error.WriteLine('DAC_DURABLE_PUBLISH_PHASE:" +
      phase +
      ":'+([long]([System.Diagnostics.Stopwatch]::GetTimestamp()*1000.0/[System.Diagnostics.Stopwatch]::Frequency)))\n# DAC_TEST_PS_TRACE_END\n"
    inserted.push(text)
    return text
  }
  const listener = [
    "\n/* DAC_TEST_PS_TRACE */",
    '        const phaseOutput = { pending: "", started: performance.now() }',
    '        child.stderr.on("data", (chunk: Buffer) => {',
    '          phaseOutput.pending = (phaseOutput.pending + chunk.toString("utf8")).slice(-4096)',
    "          const lines = phaseOutput.pending.split(/\\r?\\n/)",
    '          phaseOutput.pending = lines.pop() ?? ""',
    "          for (const line of lines) {",
    "            const match = /^DAC_DURABLE_PUBLISH_PHASE:(process-entry|encoding-start|input-encoding|output-encoding|language-checked|input-wait|input-read|compile-start|compile-done|publish-start|publish-done):(\\d{1,15})$/.exec(line)",
    "            if (!match) continue",
    '            process.stderr.write("DURABLE_PUBLISH_PS_PHASE " + JSON.stringify({ phase: match[1], atMs: Number(match[2]), receivedMs: Math.round(performance.now() - phaseOutput.started) }) + "\\n")',
    "          }",
    "        })",
    "/* DAC_TEST_PS_TRACE_END */\n",
  ].join("\n")
  inserted.push(listener)
  const points = [
    { anchor: "$ErrorActionPreference='Stop'", before: log("process-entry"), after: "" },
    {
      anchor: "[Console]::InputEncoding=" + encoding,
      before: log("encoding-start"),
      after: log("input-encoding"),
    },
    {
      anchor: "[Console]::OutputEncoding=" + encoding,
      before: "",
      after: log("output-encoding"),
    },
    {
      anchor: "  if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){throw 'unsupported_language_mode'}",
      before: "",
      after: log("language-checked"),
    },
    {
      anchor: "  $inputValue=[Console]::In.ReadToEnd() | ConvertFrom-Json",
      before: log("input-wait"),
      after: log("input-read"),
    },
    { anchor: "  Add-Type -TypeDefinition @'", before: log("compile-start"), after: "" },
    { anchor: "\n'@\n", before: "", after: log("compile-done") },
    {
      anchor:
        "  $identity=[DacDurablePublish]::Publish([string]$inputValue.source,[string]$inputValue.target,$inputValue.replace)",
      before: log("publish-start"),
      after: log("publish-done"),
    },
    { anchor: '        child.stderr.on("data", () => {', before: listener, after: "" },
  ]
  const contents = points.reduce((value, point) => {
    assert.equal(value.split(point.anchor).length, 2, "Durable publish phase anchor must occur exactly once")
    return value.replace(point.anchor, point.before + point.anchor + point.after)
  }, prepared)
  const stripped = inserted.reduce((value, text) => value.replace(text, ""), contents)
  if (candidate) assert.equal(stripped.split(constructor).length, 3)
  assert.equal(
    candidate ? stripped.replaceAll(constructor, original) : stripped,
    source,
    "Phase logging must preserve the original bridge bytes",
  )
  return contents
}

if (import.meta.main) {
  const root = await fs.realpath(process.argv[2]!)
  assert.equal(process.platform, "win32")
  assert.equal(path.win32.parse(root).root.toUpperCase(), "D:\\")
  const source = path.join(root, "source.tmp")
  const target = path.join(root, "target.db")
  const bytes = Buffer.alloc(1024, 0x5a)
  await fs.writeFile(source, bytes, { flag: "wx", mode: 0o600 })
  await fs.writeFile(path.join(root, "ready.json.tmp"), JSON.stringify({ phase: "ready", pid: process.pid }))
  await fs.rename(path.join(root, "ready.json.tmp"), path.join(root, "ready.json"))
  console.info("DURABLE_PUBLISH_ENV_PHASE", JSON.stringify({ phase: "ready" }))
  assert.equal(await Bun.stdin.text(), "GO\n")
  const started = performance.now()
  console.info("DURABLE_PUBLISH_ENV_PHASE", JSON.stringify({ phase: "bridge-start" }))
  // Both test builds keep the original 30s watchdog and nonce receipt.
  const result = await Effect.runPromiseExit(DurablePublish.windows(source, target, false))
  const receipt = {
    pid: process.pid,
    bridgeReceipt: Exit.isSuccess(result),
    sourceGone: !(await fs.exists(source)),
    targetEqual: await fs.readFile(target).then(
      (value) => value.equals(bytes),
      () => false,
    ),
    elapsedMs: Math.round(performance.now() - started),
  }
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify(receipt), { flag: "wx", mode: 0o600 })
  console.info("DURABLE_PUBLISH_ENV_PHASE", JSON.stringify({ phase: "bridge-returned", elapsedMs: receipt.elapsedMs }))
  process.exitCode = receipt.bridgeReceipt && receipt.sourceGone && receipt.targetEqual ? 0 : 2
}
