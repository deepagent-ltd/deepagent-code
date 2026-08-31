import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

/**
 * Stream a file through sha256 instead of buffering it. Node's fs.readFile
 * rejects files larger than 2 GiB (ERR_FS_FILE_TOO_LARGE), which would break
 * backup/verify/restore digests for large stores under the desktop node
 * sidecar; the same bound does not exist under bun.
 */
export const sha256File = (filename: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(filename)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve(hash.digest("hex")))
  })
