import { Database, constants } from "bun:sqlite"
import { pathToFileURL } from "node:url"
export { Database }

export const openImmutableReadOnly = (filename: string) => {
  const uri = pathToFileURL(filename)
  uri.searchParams.set("mode", "ro")
  uri.searchParams.set("immutable", "1")
  return new Database(uri.href, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI)
}
