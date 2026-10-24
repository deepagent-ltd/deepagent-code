import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { request } from "node:http"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { resolveDataPath } from "@deepagent-code/core/global-path"
import type { BrowserSchema } from "@deepagent-code/core/browser/schema"
import type { BrowserProtocol } from "@deepagent-code/core/browser/protocol"
import type { SharedBrowserFileSchema } from "@deepagent-code/core/browser/shared-file-schema"
import type { createManagedBrowserActions } from "./managed-browser-actions"

const MAX_FORM_FIELDS = 65_536
const MAX_FORM_FRAMING = 131_072
export const MAX_FORM_BODY = BrowserFileSchema.MAX_FILE_BYTES * BrowserFileSchema.MAX_FILES + MAX_FORM_FIELDS + MAX_FORM_FRAMING
type Command = Extract<BrowserSchema.Command, { type: "file.upload" | "file.download" }>
type LeafBody<T> = T extends unknown ? Omit<T, "type" | "id" | "executeID" | "actionID" | "controlID" | "digest"> : never
type Ask = (request: LeafBody<BrowserProtocol.FileLeaf>) => Promise<Pick<BrowserProtocol.FileLeafResponse, "error" | "payload" | "publication" | "stage">>
type Upload = { nativeArtifactID?: string; nativeStage?: BrowserProtocol.UploadStage; file: string; identity: string; directory: string; directoryIdentity: string; name: string; bytes: number; sha256: string }
const identity = (value: { dev: number | bigint; ino: number | bigint }) => `${value.dev}:${value.ino}`
export type ManagedBrowserFileDownload = {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: AsyncIterable<Uint8Array>
  readonly complete: boolean
  destroy: () => void
}
type Input = {
  action: Pick<BrowserSchema.Action, "command" | "deadline">
  actions: Pick<ReturnType<typeof createManagedBrowserActions>, "fileTarget" | "selectFiles" | "submitFiles" | "clearFiles">
  current: () => Promise<void>
  ask: Ask
  fail: (code: BrowserSchema.Error["code"]) => never
} & ({
  control: BrowserSchema.Control
  shared?: never
  destroyTarget: () => Promise<boolean>
  files: readonly { grant: BrowserFileSchema.Grant; artifact: BrowserFileSchema.Artifact }[]
} | {
  control?: never
  destroyTarget?: never
  shared: { origin: string; download: (url: URL, signal: AbortSignal) => Promise<ManagedBrowserFileDownload> }
  files: readonly { grant: SharedBrowserFileSchema.Grant; artifact: SharedBrowserFileSchema.Artifact }[]
})

/** One action leaf beneath the original Manager. It owns no debugger, runner, authority or dispatch ledger. */
export function createManagedBrowserFiles(input: Input) {
  const uploads: Upload[] = []
  const state = { armed: false, dispatched: false, completed: false, closed: false, selectionCleared: false, authorizePending: false, fields: "", targetPath: "", targetURL: "" }
  const submitted = Promise.withResolvers<void>()
  void submitted.promise.catch(() => undefined)
  const selection = Promise.withResolvers<void>()
  void selection.promise.catch(() => undefined)
  const command = input.action.command
  const exact = command.type === "file.upload" || command.type === "file.download" ? command : input.fail("BROWSER_SCOPE_DENIED")
  if ((!input.shared && input.control.profile !== BrowserFileSchema.PROFILE) || input.files.length < 1 || input.files.length > BrowserFileSchema.MAX_FILES)
    input.fail("BROWSER_SCOPE_DENIED")
  const origin = input.shared ? input.shared.origin : input.control.origin
  const aborters = new Set<AbortController>()
  const streams = new Set<import("node:http").IncomingMessage | import("node:http").ClientRequest>()
  const responses = new Set<ManagedBrowserFileDownload>()
  const readings = new Set<Promise<Buffer>>()
  const preparing: { pending?: Promise<void> } = {}
  const unconfirmedStages = new Set<string>()
  const downloading: { pending?: Promise<void> } = {}
  const unlinked = new Set<Upload>()
  const removedStages = new Set<Upload>()
  const cleanup: { pending?: Promise<boolean>; settled?: boolean; confirmed?: boolean } = {}
  const current = async () => { if (state.closed) input.fail("BROWSER_CANCELLED"); await input.current(); if (input.shared && state.closed) input.fail("BROWSER_CANCELLED") }
  const ask: Ask = async (leaf) => {
    await current()
    const result = await input.ask(leaf)
    if (result.error) input.fail(result.error === "BROWSER_FILE_UNKNOWN" ? "BROWSER_UNKNOWN" : "BROWSER_SCOPE_DENIED")
    await current()
    return result
  }
  const fence = () => {
    state.closed = true
    aborters.forEach((owned) => owned.abort())
    responses.forEach((response) => response.destroy())
    submitted.reject(new Error("Browser file action closed"))
    selection.reject(new Error("Browser file selection unavailable"))
  }
  const close = () => {
    if (cleanup.pending && (!input.shared || !cleanup.settled || cleanup.confirmed)) return cleanup.pending
    cleanup.settled = false
    cleanup.pending = (async () => {
      fence()
      const stopped = await Promise.all([...streams].map((stream) => new Promise<boolean>((resolve) => {
        if (stream.closed) { resolve(true); return }
        const timer = setTimeout(() => resolve(false), 1000)
        stream.once("close", () => { clearTimeout(timer); resolve(true) })
        stream.destroy()
      })))
      await Promise.allSettled([...readings, ...(preparing.pending ? [preparing.pending] : []),
        ...(downloading.pending ? [downloading.pending] : [])])
      const cleared = exact.type !== "file.upload" || (input.shared
        ? state.selectionCleared || await input.actions.clearFiles(exact).catch(() => false)
        : await input.actions.clearFiles(exact) || await input.destroyTarget())
      // A shared page remains human-owned on failed cleanup. Keep selected stages
      // and the exact failed cleanup available; never destroy that original page.
      if (input.shared && !cleared) return false
      const removed = await Promise.allSettled(uploads.map(async (file) => {
        // The original Host factory owns Windows native handles. After the
        // actual FileList/network join, complete() performs its known cleanup.
        if (file.nativeArtifactID) return
        if (input.shared && removedStages.has(file)) return
        if (input.shared && unlinked.has(file)) {
          const parent = await fs.lstat(file.directory, { bigint: true })
          if (!parent.isDirectory() || parent.isSymbolicLink() || identity(parent) !== file.directoryIdentity)
            throw new Error("Browser private stage changed")
          await fs.rmdir(file.directory)
          removedStages.add(file)
          return
        }
        const stat = await fs.lstat(file.file, { bigint: true })
        const parent = await fs.lstat(file.directory, { bigint: true })
        if (!stat.isFile() || stat.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink() ||
          identity(stat) !== file.identity || identity(parent) !== file.directoryIdentity) throw new Error("Browser private stage changed")
        await fs.unlink(file.file)
        if (input.shared) unlinked.add(file)
        await fs.rmdir(file.directory)
        if (input.shared) removedStages.add(file)
      }))
      return cleared && stopped.every(Boolean) && removed.every((result) => result.status === "fulfilled") && unconfirmedStages.size === 0
    })()
    if (input.shared) void cleanup.pending.then((confirmed) => {
      cleanup.confirmed = confirmed; cleanup.settled = true
    }, () => { cleanup.settled = true })
    return cleanup.pending
  }
  return {
    fence,
    close,
    failPost: () => submitted.reject(new Error("Browser upload outcome unavailable")),
    completePost: () => { state.completed = true; submitted.resolve() },
    async uploadData(parts: { bytes?: Buffer; file?: string; blobUUID?: string }[]) {
      await current()
      if (exact.type !== "file.upload" || !state.armed || input.shared && (state.dispatched || state.authorizePending) ||
        !Array.isArray(parts) || parts.length < 1 || parts.length > 1024)
        input.fail("BROWSER_NETWORK_DENIED")
      const operation = (async () => {
        const chunks: Buffer[] = []
        let bytes = 0
        for (const part of parts) {
          await current()
          if (!part || part.blobUUID !== undefined || (part.bytes === undefined) === (part.file === undefined))
            input.fail("BROWSER_NETWORK_DENIED")
          if (part.bytes !== undefined) {
            if (!Buffer.isBuffer(part.bytes) || bytes + part.bytes.length > MAX_FORM_BODY) input.fail("BROWSER_OUTPUT_LIMIT")
            chunks.push(part.bytes); bytes += part.bytes.length
            continue
          }
          // Chrome paths are not file authority. Only an exact stage created and
          // sealed by this leaf may be opened, never an arbitrary file or blob.
          const staged = uploads.find((value) => value.file === part.file)
          if (!staged || bytes + staged.bytes > MAX_FORM_BODY) input.fail("BROWSER_NETWORK_DENIED")
          if (staged.nativeArtifactID) {
            const stage = (await ask({ operation: "upload.stage", artifactID: staged.nativeArtifactID })).stage
            if (!stage || JSON.stringify(stage) !== JSON.stringify(staged.nativeStage)) input.fail("BROWSER_UNKNOWN")
            // Only the Native factory's exact held presentation is recognized.
            // No lowercasing, prefix stripping or untrusted path canonicalization.
            const file = await fs.open(stage.path, constants.O_RDONLY)
            try {
              const opened = await file.stat({ bigint: true })
              if (!opened.isFile() || opened.size !== BigInt(staged.bytes)) input.fail("BROWSER_UNKNOWN")
              const data = Buffer.alloc(staged.bytes)
              const hash = createHash("sha256")
              let offset = 0
              while (offset < data.length) {
                await current()
                const read = await file.read(data, offset, Math.min(BrowserFileSchema.CHUNK_BYTES, data.length - offset), offset)
                if (read.bytesRead <= 0) input.fail("BROWSER_UNKNOWN")
                hash.update(data.subarray(offset, offset + read.bytesRead)); offset += read.bytesRead
              }
              if (hash.digest("hex") !== staged.sha256 ||
                JSON.stringify((await ask({ operation: "upload.stage", artifactID: staged.nativeArtifactID })).stage) !== JSON.stringify(stage))
                input.fail("BROWSER_UNKNOWN")
              await current()
              chunks.push(data); bytes += data.length
            } finally { await file.close() }
            continue
          }
          const parent = await fs.lstat(staged.directory, { bigint: true })
          const before = await fs.lstat(staged.file, { bigint: true })
          if (!parent.isDirectory() || parent.isSymbolicLink() || identity(parent) !== staged.directoryIdentity ||
            await fs.realpath(staged.directory) !== staged.directory || !before.isFile() || before.isSymbolicLink() ||
            identity(before) !== staged.identity || before.size !== BigInt(staged.bytes)) input.fail("BROWSER_UNKNOWN")
          const file = await fs.open(staged.file, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const opened = await file.stat({ bigint: true })
            if (!opened.isFile() || identity(opened) !== staged.identity || opened.size !== before.size ||
              opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) input.fail("BROWSER_UNKNOWN")
            const data = Buffer.alloc(staged.bytes)
            const hash = createHash("sha256")
            let offset = 0
            while (offset < data.length) {
              await current()
              const read = await file.read(data, offset, Math.min(BrowserFileSchema.CHUNK_BYTES, data.length - offset), offset)
              if (read.bytesRead <= 0) input.fail("BROWSER_UNKNOWN")
              hash.update(data.subarray(offset, offset + read.bytesRead)); offset += read.bytesRead
            }
            const after = await file.stat({ bigint: true })
            const named = await fs.lstat(staged.file, { bigint: true })
            const directory = await fs.lstat(staged.directory, { bigint: true })
            if (!named.isFile() || named.isSymbolicLink() || identity(named) !== staged.identity ||
              !directory.isDirectory() || directory.isSymbolicLink() || identity(directory) !== staged.directoryIdentity ||
              after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
              named.size !== after.size || named.mtimeNs !== after.mtimeNs || named.ctimeNs !== after.ctimeNs ||
              hash.digest("hex") !== staged.sha256) input.fail("BROWSER_UNKNOWN")
            await current()
            chunks.push(data); bytes += data.length
          } finally { await file.close() }
        }
        await current()
        return Buffer.concat(chunks, bytes)
      })()
      readings.add(operation)
      try { return await operation } finally { readings.delete(operation) }
    },
    async authorizePost(url: URL, headers: Record<string, string | string[] | undefined>, body: Buffer) {
      if (input.shared) {
        if (state.authorizePending || state.dispatched) input.fail("BROWSER_NETWORK_DENIED")
        // Reserve synchronously before any permission/cleanup wait. A second
        // candidate POST cannot share this action, including after a refusal.
        state.authorizePending = true
      }
      await current()
      if (exact.type !== "file.upload" || !state.armed || state.dispatched || url.origin !== origin ||
        (input.shared ? url.href !== state.targetURL : url.pathname !== state.targetPath || url.search) || body.length > MAX_FORM_BODY) input.fail("BROWSER_NETWORK_DENIED")
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
      if (input.shared) {
        // The original submit leaf clears the selection synchronously in its
        // formdata event. Do not issue CDP commands while navigation headers are
        // held: only join that already-started leaf's exact clear receipt.
        await selection.promise
        await current()
      }
      // Consume the only POST before the original broker creates a socket. No retry on loss.
      state.dispatched = true
    },
    async run() {
      const prepared = Promise.withResolvers<void>()
      if (input.shared && exact.type === "file.upload") preparing.pending = prepared.promise
      try {
        await current()
        const target = await input.actions.fileTarget(exact)
        if (exact.type === "file.download") {
          const entry = input.files[0]!
          const preview = entry.grant.preview
          if (
            input.files.length !== 1 ||
            target.direction !== "download" ||
            preview.direction !== "download" ||
            target.url !== preview.targetURL
          )
            input.fail("BROWSER_SCOPE_DENIED")
          const url = new URL(preview.targetURL)
          const owned = new AbortController()
          aborters.add(owned)
          const timer = setTimeout(() => owned.abort(), Math.max(1, input.action.deadline - Date.now()))
          const settled = Promise.withResolvers<void>()
          if (input.shared) downloading.pending = settled.promise
          try {
            const response = input.shared
              ? await input.shared.download(url, owned.signal)
              : await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
                  const stream = request(
                    {
                      hostname: url.hostname === "[::1]" ? "::1" : url.hostname,
                      port: url.port || 80,
                      path: url.pathname + url.search,
                      method: "GET",
                      agent: false,
                      signal: owned.signal,
                      headers: { "accept-encoding": "identity" },
                    },
                    resolve,
                  )
                  streams.add(stream)
                  stream.once("close", () => streams.delete(stream))
                  stream.once("error", reject)
                  stream.end()
                })
            if ("body" in response) responses.add(response)
            else {
              streams.add(response)
              response.once("close", () => streams.delete(response))
            }
            if (
              response.statusCode !== 200 ||
              (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") ||
              (response.headers["content-length"] !== undefined &&
                (typeof response.headers["content-length"] !== "string" ||
                  !/^\d+$/.test(response.headers["content-length"]) ||
                  Number(response.headers["content-length"]) > preview.maxBytes))
            ) {
              response.destroy()
              input.fail("BROWSER_NETWORK_DENIED")
            }
            const digest = createHash("sha256")
            let bytes = 0
            for await (const data of "body" in response ? response.body : response) {
              const chunk = Buffer.from(data)
              for (let offset = 0; offset < chunk.length; offset += BrowserFileSchema.CHUNK_BYTES) {
                const payload = chunk.subarray(offset, Math.min(chunk.length, offset + BrowserFileSchema.CHUNK_BYTES))
                if (bytes + payload.length > preview.maxBytes) {
                  response.destroy()
                  input.fail("BROWSER_OUTPUT_LIMIT")
                }
                await ask({
                  operation: "download.write",
                  artifactID: entry.artifact.artifactID,
                  offset: bytes,
                  payload: payload.toString("base64"),
                })
                digest.update(payload)
                bytes += payload.length
              }
            }
            if (!response.complete) input.fail("BROWSER_UNKNOWN")
            const publication = (
              await ask({
                operation: "download.publish",
                artifactID: entry.artifact.artifactID,
                bytes,
                sha256: digest.digest("hex"),
              })
            ).publication
            if (!publication || publication.outcome !== "published") input.fail("BROWSER_UNKNOWN")
            return [publication]
          } finally {
            clearTimeout(timer)
            owned.abort()
            aborters.delete(owned)
            settled.resolve()
          }
        }
        if (target.direction !== "upload" || (!target.multiple && input.files.length > 1))
          input.fail("BROWSER_SCOPE_DENIED")
        state.fields = target.field
        state.targetPath = target.targetPath
        if (input.shared) {
          if (
            !("targetURL" in target) ||
            typeof target.targetURL !== "string" ||
            !URL.canParse(target.targetURL) ||
            new URL(target.targetURL).origin !== origin ||
            new URL(target.targetURL).href !== target.targetURL
          )
            input.fail("BROWSER_SCOPE_DENIED")
          state.targetURL = target.targetURL
        }
        for (const entry of input.files) {
          const preview = entry.grant.preview
          if (
            preview.direction !== "upload" ||
            (input.shared
              ? preview.version !== 2 || preview.targetURL !== state.targetURL
              : preview.version !== 1 || preview.targetPath !== target.targetPath)
          )
            input.fail("BROWSER_SCOPE_DENIED")
          // Main creates only its own private stage; no caller absolute path reaches CDP.
          if (process.platform === "win32") {
            // The helper fills its own private DACL/FD stage. Main verifies the
            // original bytes but never creates a POSIX-mode Windows temp file.
            const digest = createHash("sha256")
            let bytes = 0
            do {
              const reply = await ask({ operation: "upload.read", artifactID: entry.artifact.artifactID,
                offset: bytes, length: BrowserFileSchema.CHUNK_BYTES })
              if (reply.payload === undefined) input.fail("BROWSER_UNKNOWN")
              const chunk = Buffer.from(reply.payload, "base64")
              if (chunk.toString("base64") !== reply.payload || chunk.length > BrowserFileSchema.CHUNK_BYTES ||
                chunk.length > preview.bytes - bytes || chunk.length === 0 && preview.bytes !== 0) input.fail("BROWSER_UNKNOWN")
              digest.update(chunk); bytes += chunk.length
            } while (bytes < preview.bytes)
            if (digest.digest("hex") !== preview.sha256) input.fail("BROWSER_UNKNOWN")
            uploads.push({ nativeArtifactID: entry.artifact.artifactID, file: "", directory: "", identity: "", directoryIdentity: "",
              name: preview.name, bytes: preview.bytes, sha256: preview.sha256 })
            continue
          }
          const root = path.join(resolveDataPath(), "tmp")
          await fs.mkdir(root, { recursive: true, mode: 0o700 })
          const directory = await fs.mkdtemp(path.join(await fs.realpath(root), "dac-browser-file-"))
          if (input.shared) unconfirmedStages.add(directory)
          await fs.chmod(directory, 0o700)
          const destination = path.join(directory, preview.name)
          const file = await fs.open(destination, "wx", 0o600)
          try {
            // Allocation is joined before cleanup can release custody. Keep an
            // unconfirmed directory on failure rather than forgetting an orphan.
            uploads.push({
              file: destination,
              identity: identity(await file.stat({ bigint: true })),
              directory,
              directoryIdentity: identity(await fs.lstat(directory, { bigint: true })),
              name: preview.name,
              bytes: preview.bytes,
              sha256: preview.sha256,
            })
            unconfirmedStages.delete(directory)
            const digest = createHash("sha256")
            let bytes = 0
            do {
              const reply = await ask({
                operation: "upload.read",
                artifactID: entry.artifact.artifactID,
                offset: bytes,
                length: BrowserFileSchema.CHUNK_BYTES,
              })
              if (reply.payload === undefined) input.fail("BROWSER_UNKNOWN")
              const chunk = Buffer.from(reply.payload, "base64")
              if (
                chunk.toString("base64") !== reply.payload ||
                chunk.length > BrowserFileSchema.CHUNK_BYTES ||
                chunk.length > preview.bytes - bytes ||
                (chunk.length === 0 && preview.bytes !== 0)
              )
                input.fail("BROWSER_UNKNOWN")
              if ((await file.write(chunk, 0, chunk.length, bytes)).bytesWritten !== chunk.length)
                input.fail("BROWSER_UNKNOWN")
              digest.update(chunk)
              bytes += chunk.length
            } while (bytes < preview.bytes)
            await file.sync()
            if (digest.digest("hex") !== preview.sha256 || (await file.stat()).size !== preview.bytes)
              input.fail("BROWSER_UNKNOWN")
          } finally {
            await file.close()
          }
        }
        await current()
        for (const [ordinal, entry] of input.files.entries()) {
          const file = uploads[ordinal]!
          const sealed = await ask({
            operation: "upload.seal",
            artifactID: entry.artifact.artifactID,
            bytes: file.bytes,
            sha256: file.sha256,
          })
          if (file.nativeArtifactID) {
            const stage = sealed.stage
            if (!stage || stage.artifactID !== file.nativeArtifactID || stage.bytes !== file.bytes || stage.sha256 !== file.sha256 ||
              stage.fileIdentity.kind !== "windows" || stage.stageIdentity.kind !== "windows" ||
              !path.isAbsolute(stage.path) || path.basename(stage.path) !== file.name) input.fail("BROWSER_UNKNOWN")
            file.nativeStage = stage
            file.file = stage.path; file.directory = path.dirname(stage.path)
            file.identity = JSON.stringify(stage.fileIdentity); file.directoryIdentity = JSON.stringify(stage.stageIdentity)
          }
        }
        await input.actions.selectFiles(
          exact,
          uploads.map((file) => ({ path: file.file, name: file.name, bytes: file.bytes, sha256: file.sha256 })),
        )
        await current()
        state.armed = true
        // The real synchronous formdata proof must release the held POST before
        // CDP remote-object cleanup can join navigation. Cleanup remains awaited.
        const cleared = await input.actions
          .submitFiles(
            exact,
            state.targetPath,
            input.shared ? state.targetURL : undefined,
            input.shared
              ? () => {
                  state.selectionCleared = true
                  selection.resolve()
                }
              : undefined,
          )
          .catch((error) => {
            selection.reject(error)
            throw error
          })
        if (input.shared) {
          if (cleared !== true) {
            selection.reject(new Error("Browser file selection unavailable"))
            input.fail("BROWSER_UNKNOWN")
          }
          state.selectionCleared = true
          selection.resolve()
        }
        // Only preparation is joined by close, not the POST completion wait which
        // itself needs the original network gate to be released or cancelled.
        prepared.resolve()
        const timer = setTimeout(
          () => submitted.reject(new Error("Browser upload outcome unavailable")),
          Math.max(1, input.action.deadline - Date.now()),
        )
        try {
          await submitted.promise
        } finally {
          clearTimeout(timer)
        }
        if (!state.dispatched || !state.completed) input.fail("BROWSER_UNKNOWN")
        const publications: BrowserFileSchema.Publication[] = []
        for (const [ordinal, entry] of input.files.entries()) {
          const file = uploads[ordinal]!
          const publication = (
            await ask({
              operation: "upload.observe",
              artifactID: entry.artifact.artifactID,
              bytes: file.bytes,
              sha256: file.sha256,
            })
          ).publication
          if (!publication || publication.outcome !== "selected") input.fail("BROWSER_UNKNOWN")
          publications.push(publication)
        }
        return publications
      } finally { prepared.resolve() }
    },
  }
}
