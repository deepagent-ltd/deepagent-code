import { MessagePort, parentPort } from "node:worker_threads"
import { Schema } from "effect"
import { AttentionSchema } from "@deepagent-code/core/attention/schema"
import { TaskHumanControlSchema } from "@deepagent-code/core/session/task-human-control.schema"

if (!parentPort) throw new Error("Controlled Task protocol peer requires a real worker parent")

// This peer supplies typed protocol observations, not a Core Actor or Access mint.
// Actual OS/parentPort/fileDB authority is verified separately by the Host fixture.
const state = {
  item: undefined as AttentionSchema.Item | undefined,
  directory: "",
  mode: "ok",
  reads: 0,
  controls: [] as TaskHumanControlSchema.Input[],
  hold: false,
  ports: new Set<MessagePort>(),
  pending: new Map<number, { port: MessagePort; request: TaskHumanControlSchema.Input }>(),
}

function reply(port: MessagePort, id: number, request: TaskHumanControlSchema.Input) {
  if (state.mode !== "ok") {
    port.postMessage({
      id,
      error: {
        code: state.mode === "unknown" ? "connection_unknown" : "auth_required",
        message: "Controlled private Task response",
      },
    })
    port.postMessage({ id, settled: true })
    return
  }
  const result = Schema.decodeUnknownSync(TaskHumanControlSchema.Result)({
    replayed: state.controls.filter((entry) => entry.requestID === request.requestID).length > 1,
    receipt: {
      contract: "task-human-control-v1",
      receiptID: "controlled-private-receipt",
      requestHash: "d".repeat(64),
      request,
      authority: {
        scope: "implicit-local",
        principal: "controlled-protocol-peer",
        directory: state.directory,
        projectID: "project-private",
        permissionEpoch: 1,
      },
      recordedChildSessionID: "recorded-private-child",
      version: 4,
      state: "recovery_required",
      controlState: "close_requested",
      terminalReceiptID: null,
      affectedRuns: 1,
      time: 2,
    },
  })
  port.postMessage({ id, data: result })
  port.postMessage({ id, settled: true })
}

parentPort.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return
  if ("fixture" in message && typeof message.fixture === "string" && "id" in message) {
    if (
      message.fixture === "init" &&
      "item" in message &&
      "directory" in message &&
      typeof message.directory === "string"
    ) {
      state.item = Schema.decodeUnknownSync(AttentionSchema.Item, { onExcessProperty: "error" })(message.item)
      state.directory = message.directory
      parentPort!.postMessage({ kind: "task-human-bootstrap-ready-v1" })
    }
    if (message.fixture === "mode" && "mode" in message && typeof message.mode === "string") state.mode = message.mode
    if (message.fixture === "hold") state.hold = true
    if (message.fixture === "release") {
      state.hold = false
      state.pending.forEach((entry, id) => reply(entry.port, id, entry.request))
      state.pending.clear()
    }
    parentPort!.postMessage({
      fixtureResult: true,
      id: message.id,
      data: { reads: state.reads, controls: state.controls, pending: state.pending.size },
    })
    return
  }
  if (
    !("kind" in message) ||
    message.kind !== "task-human-bootstrap-v1" ||
    !("port" in message) ||
    !(message.port instanceof MessagePort)
  )
    return
  const port = message.port
  state.ports.add(port)
  port.on("close", () => state.ports.delete(port))
  port.on("message", (value: unknown) => {
    if (!value || typeof value !== "object") return
    if ("kind" in value && value.kind === "close") {
      if (state.pending.size) return
      port.postMessage({ closed: true })
      port.close()
      return
    }
    if (!("id" in value) || typeof value.id !== "number" || !("action" in value) || !("request" in value)) return
    if (value.action === "get") {
      state.reads++
      const query = Schema.decodeUnknownSync(Schema.Struct({ itemID: Schema.String }))(value.request)
      if (state.mode === "read-denied" || query.itemID !== state.item?.id) {
        port.postMessage({ id: value.id, error: { code: "auth_required", message: "Controlled read refusal" } })
        port.postMessage({ id: value.id, settled: true })
        return
      }
      port.postMessage({ id: value.id, data: state.item })
      port.postMessage({ id: value.id, settled: true })
      return
    }
    if (value.action !== "control") return
    const request = Schema.decodeUnknownSync(TaskHumanControlSchema.Input, { onExcessProperty: "error" })(value.request)
    state.controls.push(request)
    if (state.hold) {
      state.pending.set(value.id, { port, request })
      return
    }
    reply(port, value.id, request)
  })
  port.start()
  port.postMessage({ ready: true, directory: state.directory })
})
