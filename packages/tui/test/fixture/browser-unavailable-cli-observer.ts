import { appendFileSync } from "node:fs"
import path from "node:path"

const filename = process.env.DAC_BROWSER_UNAVAILABLE_OBSERVER_FILE
const origin = process.env.DAC_BROWSER_UNAVAILABLE_ROOT_URL
if (!filename || !path.isAbsolute(filename) || path.basename(filename) !== "http-observer-private.jsonl" ||
    !origin || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin)) throw new Error("Private unavailable observer descriptor required")
const original = globalThis.fetch
const state = { creates: 0 }
const record = (value: Record<string, unknown>) => appendFileSync(filename, JSON.stringify(value) + "\n", { mode: 0o600 })

// Passive QA observation only: retain the original receiver, arguments,
// response, rejection and lifetime. No credentials, payload or terminal text.
globalThis.fetch = Object.assign(async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  const observed = url.origin === origin && method === "POST" && url.pathname === "/api/v1/browser/controls"
  const ordinal = observed ? ++state.creates : 0
  const body = observed ? typeof init?.body === "string" ? Promise.resolve(init.body) :
    input instanceof Request ? input.clone().text() : Promise.resolve("") : Promise.resolve("")
  if (url.origin === origin && method === "POST" && /\/(?:prompt|resume|execute)$/.test(url.pathname))
    record({ family: "unexpected-execution", pathname: url.pathname })
  const response = await original.call(this, input, init)
  if (observed) void Promise.all([body, response.clone().json()]).then(([body, value]) => {
    if (Buffer.byteLength(body) > 16_384) throw new Error("QA browser approval exceeded its bounded observation")
    record({ family: "browser-create", ordinal, requestBytes: Buffer.byteLength(body),
      requestHash: new Bun.CryptoHasher("sha256").update(body).digest("hex"), status: response.status,
      code: typeof value?.code === "string" && value.code.length <= 80 ? value.code : "" })
  }).catch(() => record({ family: "observer-error" }))
  return response
}, { preconnect: original.preconnect })
