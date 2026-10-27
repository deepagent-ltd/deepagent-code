import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"

// Polling observers must see either no packet or a complete packet, including
// when the fixture producer is descheduled between creating and writing a file.
export async function publishImportFixturePacket(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" })
  await fs.rename(temporary, file)
}

export async function importFixtureSourceInventory(directory: string): Promise<Record<string, string>> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  return Object.fromEntries(
    (
      await Promise.all(
        entries
          .sort((left, right) => left.name.localeCompare(right.name))
          .map(async (entry) => {
            const file = path.join(directory, entry.name)
            if (entry.isDirectory())
              return Object.entries(await importFixtureSourceInventory(file)).map(([name, hash]) => [
                `${entry.name}/${name}`,
                hash,
              ])
            if (!entry.isFile()) throw new Error("Unexpected import fixture source entry")
            return [
              [
                entry.name,
                createHash("sha256")
                  .update(await fs.readFile(file))
                  .digest("hex"),
              ],
            ]
          }),
      )
    ).flat(),
  )
}
