// Minimal fake Debug Adapter Protocol (DAP) adapter over stdio.
//
// Speaks the DAP base protocol wire format — Content-Length headers + JSON body,
// identical framing to LSP — but with DAP message shapes:
//   request:  { seq, type:"request",  command, arguments }
//   response: { seq, type:"response", request_seq, success, command, body }
//   event:    { seq, type:"event",    event, body }
//
// It implements just enough of a real adapter (debugpy/delve/lldb) for D1's
// client + DebugService tests: initialize / launch / attach / setBreakpoints /
// configurationDone / threads / stackTrace / scopes / variables / evaluate /
// continue / next|stepIn|stepOut / terminate / disconnect, and emits the
// `initialized`, `stopped`, `output`, `terminated`, `exited` events.

let outSeq = 1
let readBuffer = Buffer.alloc(0)
let stepCount = 0

function encode(message) {
  const json = JSON.stringify(message)
  const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`
  return Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(json, "utf8")])
}

function decodeFrames(buffer) {
  const results = []
  let idx
  while ((idx = buffer.indexOf("\r\n\r\n")) !== -1) {
    const header = buffer.slice(0, idx).toString("utf8")
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    const length = match ? parseInt(match[1], 10) : 0
    const bodyStart = idx + 4
    const bodyEnd = bodyStart + length
    if (buffer.length < bodyEnd) break
    results.push(buffer.slice(bodyStart, bodyEnd).toString("utf8"))
    buffer = buffer.slice(bodyEnd)
  }
  return { messages: results, rest: buffer }
}

function write(message) {
  process.stdout.write(encode(message))
}

function respond(request, body, success = true) {
  write({
    seq: outSeq++,
    type: "response",
    request_seq: request.seq,
    success,
    command: request.command,
    body,
  })
}

function event(name, body) {
  write({ seq: outSeq++, type: "event", event: name, body })
}

function handle(raw) {
  let req
  try {
    req = JSON.parse(raw)
  } catch {
    return
  }
  if (req.type !== "request") return

  switch (req.command) {
    case "initialize":
      respond(req, {
        supportsConfigurationDoneRequest: true,
        supportsConditionalBreakpoints: true,
        supportsEvaluateForHovers: true,
      })
      // A real adapter signals readiness for configuration via `initialized`.
      // We send it on launch/attach (below) so the client's waiter is already
      // registered; sending here would race the client's subscription.
      break

    case "launch":
    case "attach":
      // Signal the client to send breakpoints + configurationDone.
      event("initialized", {})
      respond(req, {})
      event("output", { category: "stdout", output: "fake adapter started\n" })
      break

    case "setBreakpoints": {
      const bps = (req.arguments && req.arguments.breakpoints) || []
      respond(req, { breakpoints: bps.map((b, i) => ({ id: i + 1, verified: true, line: b.line })) })
      break
    }

    case "configurationDone":
      respond(req, {})
      // Program runs and immediately hits a breakpoint.
      event("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true })
      break

    case "threads":
      respond(req, { threads: [{ id: 1, name: "main" }] })
      break

    case "stackTrace":
      respond(req, {
        stackFrames: [
          { id: 1, name: "main", line: 10, column: 1, source: { path: "/repro/main.py" } },
          { id: 2, name: "caller", line: 4, column: 1, source: { path: "/repro/main.py" } },
        ],
        totalFrames: 2,
      })
      break

    case "scopes":
      respond(req, { scopes: [{ name: "Locals", variablesReference: 100, expensive: false }] })
      break

    case "variables":
      respond(req, {
        variables: [
          { name: "x", value: "42", type: "int", variablesReference: 0 },
          { name: "items", value: "[1, 2, 3]", type: "list", variablesReference: 101 },
        ],
      })
      break

    case "evaluate":
      respond(req, { result: `evaluated(${req.arguments && req.arguments.expression})`, variablesReference: 0 })
      break

    case "next":
    case "stepIn":
    case "stepOut":
      respond(req, {})
      stepCount += 1
      // Stepping pauses again on the next line.
      event("stopped", { reason: "step", threadId: 1, allThreadsStopped: true })
      break

    case "continue":
      respond(req, { allThreadsContinued: true })
      // Resume to completion: program ends.
      event("output", { category: "stdout", output: "done\n" })
      event("terminated", {})
      event("exited", { exitCode: 0 })
      break

    case "terminate":
      respond(req, {})
      event("terminated", {})
      break

    case "disconnect":
      respond(req, {})
      setTimeout(() => process.exit(0), 10)
      break

    default:
      // Unknown command: respond unsuccessfully, like a real adapter would.
      respond(req, undefined, false)
      break
  }
}

process.stdin.on("data", (chunk) => {
  readBuffer = Buffer.concat([readBuffer, chunk])
  const { messages, rest } = decodeFrames(readBuffer)
  readBuffer = rest
  for (const message of messages) handle(message)
})
