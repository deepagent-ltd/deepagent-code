import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
)
let mode = process.argv[2] ?? "push"
let opened: { uri: string; text: string; version: number } | undefined
let changes = 0
const publish = () => {
  if (!opened || mode === "hold" || mode === "pull") return
  return connection.sendNotification("textDocument/publishDiagnostics", {
    uri: opened.uri,
    ...(mode === "unversioned" ? {} : { version: mode === "stale" ? opened.version - 1 : opened.version }),
    diagnostics: [],
  })
}
connection.onRequest("initialize", () => ({
  capabilities: { textDocumentSync: { change: 1 }, ...(mode === "pull" ? { diagnosticProvider: {} } : {}) },
}))
connection.onNotification("textDocument/didOpen", (params: { textDocument: NonNullable<typeof opened> }) => {
  opened = params.textDocument
  changes++
  return publish()
})
connection.onNotification(
  "textDocument/didChange",
  (params: { textDocument: { uri: string; version: number }; contentChanges: { text: string }[] }) => {
    opened = { ...params.textDocument, text: params.contentChanges[0].text }
    changes++
    return publish()
  },
)
connection.onNotification("textDocument/didClose", (params: { textDocument: { uri: string } }) => {
  if (opened?.uri === params.textDocument.uri) opened = undefined
})
connection.onRequest("fixture/push", (params: { uri: string }) =>
  connection
    .sendNotification("textDocument/publishDiagnostics", {
      uri: params.uri,
      version: 0,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          message: "original project diagnostic",
          severity: 1,
        },
      ],
    })
    .then(() => true),
)
connection.onRequest("fixture/current", () => ({ opened, changes }))
connection.onRequest("fixture/release", async () => {
  mode = "push"
  await publish()
  return true
})
connection.onRequest("textDocument/diagnostic", () => ({ kind: "full", items: [] }))
connection.onRequest("shutdown", () => null)
connection.onNotification("exit", () => process.exit(0))
connection.listen()
