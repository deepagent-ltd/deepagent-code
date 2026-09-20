import type { StructuredOutputReceipt } from "@/tool/task-run"

const degradedRawResultMaxChars = 80_000

export function boundDegradedRawResult(raw: string) {
  return Array.from(raw).slice(0, degradedRawResultMaxChars).join("")
}

export function makeDegradedStructuredOutput(
  raw: string,
  receipt: Extract<StructuredOutputReceipt, { readonly transport: "degraded_text" }>,
) {
  return JSON.stringify({
    _degraded: true,
    _reason: receipt.reason,
    _attempts: receipt.attempt,
    _raw: boundDegradedRawResult(raw),
  })
}
