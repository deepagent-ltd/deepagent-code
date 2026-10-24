import { Server, BrowserNativeHost } from "../../../src/node"
import { writeFile } from "node:fs/promises"
import path from "node:path"

await BrowserNativeHost.prepare()
const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
try {
  const connect = { attachID: "not-issued", generation: "not-issued", secret: "a".repeat(64) }
  const requests = [
    [
      "pair",
      {
        requestID: "tui-negative",
        challengeHash: "b".repeat(64),
        rootSessionID: "ses_no_authority",
        directory: process.cwd(),
      },
    ],
    ["owner", connect],
    ["reserve", { ...connect, expectedBarrierOrder: 0, inputID: "m", originalSubmissionID: "s", rawInput: "continue" }],
    [
      "seal",
      {
        ...connect,
        stamp: {
          originalSubmissionID: "s",
          inputID: "m",
          rootSessionID: "ses_no_authority",
          rawInputHash: "c".repeat(64),
          sourceKind: "tui_owner",
          sourceBindingHash: "d".repeat(64),
          mainIncarnation: "invented",
          submissionOrder: 1,
        },
        prompt: { text: "continue" },
      },
    ],
    ["detach", connect],
  ] as const
  const results = []
  for (const [route, body] of requests) {
    const response = await fetch(new URL(`/api/v1/browser/shared/tui/${route}`, server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from("operator:private-fixture").toString("base64")}`,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    results.push({ route, status: response.status, body: await response.text() })
  }
  const wrong = await fetch(new URL("/api/v1/browser/shared/tui/pair", server.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from("operator:wrong").toString("base64")}`,
    },
    body: JSON.stringify(requests[0][1]),
    signal: AbortSignal.timeout(10_000),
  })
  await writeFile(
    path.join(process.env.DAC_BROWSER_TEST_ROOT!, "result.json"),
    JSON.stringify({
      results,
      wrongAuth: wrong.status,
      nativeHost: BrowserNativeHost.current() !== undefined,
      externalModels: 0,
      originalDatabaseReads: 0,
    }),
  )
} finally {
  await server.stop()
}
process.exit(0)
