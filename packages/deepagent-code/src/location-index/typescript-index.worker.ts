import { parentPort, workerData } from "node:worker_threads"
import { indexWorkspace } from "../code-intelligence/typescript-workspace-adapter"
import type { Request } from "./typescript-index"

// Fixed one-shot compiler asset. Database publication and authority stay in the Host.
const input: Request = workerData
if (
  !parentPort ||
  input?.version !== 1 ||
  typeof input.requestID !== "string" ||
  typeof input.root !== "string" ||
  !Array.isArray(input.files)
)
  throw new Error("Invalid semantic index input")
parentPort.postMessage({ version: 1, requestID: input.requestID, build: indexWorkspace(input) })
parentPort.close()
