import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { request } from "node:http"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { resolveDataPath } from "@deepagent-code/core/global-path"
import type { BrowserSchema } from "@deepagent-code/core/browser/schema"
import type { BrowserProtocol } from "@deepagent-code/core/browser/protocol"
import type { createManagedBrowserActions } from "./managed-browser-actions"

const MAX_FORM_FIELDS = 65_536
const MAX_FORM_FRAMING = 131_072
export const MAX_FORM_BODY = BrowserFileSchema.MAX_FILE_BYTES * BrowserFileSchema.MAX_FILES + MAX_FORM_FIELDS + MAX_FORM_FRAMING
type Command = Extract<BrowserSchema.Command, { type: "file.upload" | "file.download" }>
type LeafBody<T> = T extends unknown ? Omit<T, "type" | "id" | "executeID" | "actionID" | "controlID" | "digest"> : never
type Ask = (request: LeafBody<BrowserProtocol.FileLeaf>) => Promise<BrowserProtocol.FileLeafResponse>
type Upload = { file: string; identity: string; directory: string; directoryIdentity: string; name: string; bytes: number; sha256: string }
const identity = (value: { dev: number | bigint; ino: number | bigint }) => `${value.dev}:${value.ino}`

/** One action leaf beneath the original Manager. It owns no debugger, runner, authority or dispatch ledger. */
export function createManagedBrowserFiles(input: {
  action: BrowserSchema.Action; control: BrowserSchema.Control;
  files: readonly { grant: BrowserFileSchema.Grant; artifact: BrowserFileSchema.Artifact }[];
  actions: ReturnType<typeof createManagedBrowserActions>; current: () => Promise<void>;
  ask: Ask; fail: (code: BrowserSchema.Error["code"]) => never; destroyTarget: () => Promise<boolean>;
}) {
  const uploads: Upload[] = []
  const state = { armed: false, dispatched: false, completed: false, closed: false, fields: "", targetPath: "" }
  const submitted = Promise.withResolvers<void>()
  void submitted.promise.catch(() => undefined)
  const command = input.action.command
  const exact = command.type === "file.upload" || command.type === "file.download" ? command : input.fail("BROWSER_SCOPE_DENIED")
  if (input.control.profile !== BrowserFileSchema.PROFILE || input.files.length < 1 || input.files.length > BrowserFileSchema.MAX_FILES)
    input.fail("BROWSER_SCOPE_DENIED")
  const aborters = new Set<AbortController>()
  const streams = new Set<import("node:http").IncomingMessage | import("node:http").ClientRequest>()
  const cleanup: { pending?: Promise<boolean> } = {}
  const current = async () => { if (state.closed) input.fail("BROWSER_CANCELLED"); await input.current() }
  const ask: Ask = async (leaf) => {
    await current()
    const result = await input.ask(leaf)
    if (result.error) input.fail(result.error === "BROWSER_FILE_UNKNOWN" ? "BROWSER_UNKNOWN" : "BROWSER_SCOPE_DENIED")
    await current()
    return result
  }
  const close = () => {
    if (cleanup.pending) return cleanup.pending
    cleanup.pending = (async () => {
      state.closed = true
      aborters.forEach((owned) => owned.abort())
      const stopped = await Promise.all([...streams].map((stream) => new Promise<boolean>((resolve) => {
        if (stream.closed) { resolve(true); return }
        const timer = setTimeout(() => resolve(false), 1000)
        stream.once("close", () => { clearTimeout(timer); resolve(true) })
        stream.destroy()
      })))
      submitted.reject(new Error("Browser file action closed"))
      const cleared = exact.type !== "file.upload" || await input.actions.clearFiles(exact) || await input.destroyTarget()
      const removed = await Promise.allSettled(uploads.map(async (file) => {
        const stat = await fs.lstat(file.file, { bigint: true })
        const parent = await fs.lstat(file.directory, { bigint: true })
        if (!stat.isFile() || stat.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink() ||
          identity(stat) !== file.identity || identity(parent) !== file.directoryIdentity) throw new Error("Browser private stage changed")
        await fs.unlink(file.file)
        await fs.rmdir(file.directory)
      }))
      return cleared && stopped.every(Boolean) && removed.every((result) => result.status === "fulfilled")
    })()
    return cleanup.pending
  }
  return {
    close,
    failPost: () => submitted.reject(new Error("Browser upload outcome unavailable")),
    completePost: () => { state.completed = true; submitted.resolve() },
    async authorizePost(url: URL, headers: Record<string, string | string[] | undefined>, body: Buffer) {
      await current()
      if (exact.type !== "file.upload" || !state.armed || state.dispatched || url.origin !== input.control.origin ||
        url.pathname !== state.targetPath || url.search || body.length > MAX_FORM_BODY) input.fail("BROWSER_NETWORK_DENIED")
      const type = headers["content-type"]
      if (typeof type !== "string") input.fail("BROWSER_NETWORK_DENIED")
      const boundary = /^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=? -]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))$/.exec(type)
      if (!boundary) input.fail("BROWSER_NETWORK_DENIED")
      const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`)
      const between = Buffer.from(`\r\n--${boundary[1] ?? boundary[2]}`)
      const expected = uploads.slice()
      let position = 0
      let fields = 0
      let framing = 0
      let parts = 0
      while (position < body.length) {
        if (++parts > 132 || !body.subarray(position, position + delimiter.length).equals(delimiter)) input.fail("BROWSER_NETWORK_DENIED")
        position += delimiter.length
        if (body.subarray(position, position + 2).equals(Buffer.from("--"))) {
          position += 2
          if (body.subarray(position).equals(Buffer.from("\r\n"))) position += 2
          if (position !== body.length || expected.length) input.fail("BROWSER_NETWORK_DENIED")
          break
        }
        if (!body.subarray(position, position + 2).equals(Buffer.from("\r\n"))) input.fail("BROWSER_NETWORK_DENIED")
        position += 2
        const end = body.indexOf(Buffer.from("\r\n\r\n"), position)
        if (end < position || end - position > 8192) input.fail("BROWSER_NETWORK_DENIED")
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(position, end))
        const lines = raw.split("\r\n")
        if (lines.length < 1 || lines.length > 2 || !/^Content-Disposition: form-data; name="[^"\r\n]{1,512}"(?:; filename="[^"\r\n]{1,768}")?$/i.test(lines[0]!) ||
          lines.length === 2 && !/^Content-Type: [\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/i.test(lines[1]!)) input.fail("BROWSER_NETWORK_DENIED")
        const disposition = /name="([^"]+)"(?:; filename="([^"]+)")?/i.exec(lines[0]!)!
        const start = end + 4
        const next = body.indexOf(between, start)
        if (next < start) input.fail("BROWSER_NETWORK_DENIED")
        const bytes = body.subarray(start, next)
        framing += end - position + delimiter.length + 8
        if (framing > MAX_FORM_FRAMING) input.fail("BROWSER_OUTPUT_LIMIT")
        if (disposition[2] !== undefined) {
          const file = expected.shift()
          const name = disposition[2].replace(/%22/g, '"')
          if (!file || disposition[1] !== state.fields || name !== file.name || bytes.length !== file.bytes ||
            createHash("sha256").update(bytes).digest("hex") !== file.sha256) input.fail("BROWSER_NETWORK_DENIED")
        } else {
          fields += bytes.length
          if (fields > MAX_FORM_FIELDS) input.fail("BROWSER_OUTPUT_LIMIT")
        }
        position = next + 2
      }
      if (position !== body.length || expected.length) input.fail("BROWSER_NETWORK_DENIED")
      await current()
      // Consume the only POST before the original broker creates a socket. No retry on loss.
      state.dispatched = true
    },
    async run() {
      await current()
      const target = await input.actions.fileTarget(exact)
      if (exact.type === "file.download") {
        const entry = input.files[0]!
        const preview = entry.grant.preview
        if (input.files.length !== 1 || target.direction !== "download" || preview.direction !== "download" || target.url !== preview.targetURL)
          input.fail("BROWSER_SCOPE_DENIED")
        const url = new URL(preview.targetURL)
        const owned = new AbortController()
        aborters.add(owned)
        const timer = setTimeout(() => owned.abort(), Math.max(1, input.action.deadline - Date.now()))
        try {
          const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
            const stream = request({ hostname: url.hostname === "[::1]" ? "::1" : url.hostname, port: url.port || 80,
              path: url.pathname + url.search, method: "GET", agent: false, signal: owned.signal, headers: { "accept-encoding": "identity" } }, resolve)
            streams.add(stream); stream.once("close", () => streams.delete(stream))
            stream.once("error", reject); stream.end()
          })
          streams.add(response); response.once("close", () => streams.delete(response))
          if (response.statusCode !== 200 || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity" ||
            response.headers["content-length"] !== undefined && (!/^\d+$/.test(response.headers["content-length"]) ||
              Number(response.headers["content-length"]) > preview.maxBytes)) { response.destroy(); input.fail("BROWSER_NETWORK_DENIED") }
          const digest = createHash("sha256")
          let bytes = 0
          for await (const data of response) {
            const chunk = Buffer.from(data)
            for (let offset = 0; offset < chunk.length; offset += BrowserFileSchema.CHUNK_BYTES) {
              const payload = chunk.subarray(offset, Math.min(chunk.length, offset + BrowserFileSchema.CHUNK_BYTES))
              if (bytes + payload.length > preview.maxBytes) { response.destroy(); input.fail("BROWSER_OUTPUT_LIMIT") }
              await ask({ operation: "download.write", artifactID: entry.artifact.artifactID, offset: bytes, payload: payload.toString("base64") })
              digest.update(payload); bytes += payload.length
            }
          }
          if (!response.complete) input.fail("BROWSER_UNKNOWN")
          const publication = (await ask({ operation: "download.publish", artifactID: entry.artifact.artifactID, bytes, sha256: digest.digest("hex") })).publication
          if (!publication || publication.outcome !== "published") input.fail("BROWSER_UNKNOWN")
          return [publication]
        } finally { clearTimeout(timer); owned.abort(); aborters.delete(owned) }
      }
      if (target.direction !== "upload" || !target.multiple && input.files.length > 1) input.fail("BROWSER_SCOPE_DENIED")
      state.fields = target.field; state.targetPath = target.targetPath
      for (const entry of input.files) {
        const preview = entry.grant.preview
        if (preview.direction !== "upload" || preview.targetPath !== target.targetPath) input.fail("BROWSER_SCOPE_DENIED")
        // Main creates only its own private stage; no caller absolute path reaches CDP.
        if (process.platform === "win32") input.fail("BROWSER_DRIVER_UNAVAILABLE")
        const root = path.join(resolveDataPath(), "tmp")
        await fs.mkdir(root, { recursive: true, mode: 0o700 })
        const directory = await fs.mkdtemp(path.join(await fs.realpath(root), "dac-browser-file-"))
        await fs.chmod(directory, 0o700)
        const destination = path.join(directory, preview.name)
        const file = await fs.open(destination, "wx", 0o600)
        // Record the exact owned stage before reading; a failed seal still needs physical cleanup.
        uploads.push({ file: destination, identity: identity(await file.stat({ bigint: true })), directory,
          directoryIdentity: identity(await fs.lstat(directory, { bigint: true })), name: preview.name, bytes: preview.bytes, sha256: preview.sha256 })
        try {
          const digest = createHash("sha256")
          let bytes = 0
          do {
            const reply = await ask({ operation: "upload.read", artifactID: entry.artifact.artifactID, offset: bytes, length: BrowserFileSchema.CHUNK_BYTES })
            if (reply.payload === undefined) input.fail("BROWSER_UNKNOWN")
            const chunk = Buffer.from(reply.payload, "base64")
            if (chunk.toString("base64") !== reply.payload || chunk.length > BrowserFileSchema.CHUNK_BYTES ||
              chunk.length > preview.bytes - bytes || chunk.length === 0 && preview.bytes !== 0)
              input.fail("BROWSER_UNKNOWN")
            if ((await file.write(chunk, 0, chunk.length, bytes)).bytesWritten !== chunk.length) input.fail("BROWSER_UNKNOWN")
            digest.update(chunk); bytes += chunk.length
          } while (bytes < preview.bytes)
          await file.sync()
          if (digest.digest("hex") !== preview.sha256 || (await file.stat()).size !== preview.bytes) input.fail("BROWSER_UNKNOWN")
        } finally { await file.close() }
      }
      await current()
      for (const [ordinal, entry] of input.files.entries()) {
        const file = uploads[ordinal]!
        await ask({ operation: "upload.seal", artifactID: entry.artifact.artifactID, bytes: file.bytes, sha256: file.sha256 })
      }
      await input.actions.selectFiles(exact, uploads.map((file) => ({ path: file.file, name: file.name, bytes: file.bytes, sha256: file.sha256 })))
      await current()
      state.armed = true
      await input.actions.submitFiles(exact, state.targetPath)
      const timer = setTimeout(() => submitted.reject(new Error("Browser upload outcome unavailable")), Math.max(1, input.action.deadline - Date.now()))
      try { await submitted.promise } finally { clearTimeout(timer) }
      if (!state.dispatched || !state.completed) input.fail("BROWSER_UNKNOWN")
      const publications: BrowserFileSchema.Publication[] = []
      for (const [ordinal, entry] of input.files.entries()) {
        const file = uploads[ordinal]!
        const publication = (await ask({ operation: "upload.observe", artifactID: entry.artifact.artifactID, bytes: file.bytes, sha256: file.sha256 })).publication
        if (!publication || publication.outcome !== "selected") input.fail("BROWSER_UNKNOWN")
        publications.push(publication)
      }
      return publications
    },
  }
}
