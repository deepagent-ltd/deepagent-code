const original = await import("../managed-browser-files")

export const fileStages: Array<{ stage: string; event: string; at: number; error?: string; parts?: unknown }> = []
const record = (stage: string, event: string, details: { error?: string; parts?: unknown } = {}) => {
  if (fileStages.length < 256) fileStages.push({ stage, event, at: Date.now(), ...details })
}

/** Fixture-only transparent observation; delegates every original check and result. */
export function createManagedBrowserFiles(input: Parameters<typeof original.createManagedBrowserFiles>[0]) {
  const current = input.current
  const transfer = original.createManagedBrowserFiles({
    ...input,
    current: async () => {
      record("current", "enter")
      try {
        await current()
        record("current", "return")
      } catch (error) {
        record("current", "throw", { error: String(error) })
        throw error
      }
    },
  })
  const uploadData = transfer.uploadData
  const authorizePost = transfer.authorizePost
  const run = transfer.run
  transfer.run = async () => {
    record("run", "enter")
    try {
      const result = await run()
      record("run", "return")
      return result
    } catch (error) {
      record("run", "throw", { error: String(error) })
      throw error
    }
  }
  transfer.uploadData = async (parts) => {
    record("uploadData", "enter", {
      parts: parts.map((part) => ({
        bytes: part.bytes?.length,
        file: part.file?.split(/[\\/]/).at(-1),
        blob: part.blobUUID !== undefined,
      })),
    })
    try {
      const value = await uploadData(parts)
      record("uploadData", "return")
      return value
    } catch (error) {
      record("uploadData", "throw", { error: String(error) })
      throw error
    }
  }
  transfer.authorizePost = async (...args) => {
    record("authorizePost", "enter")
    try {
      await authorizePost(...args)
      record("authorizePost", "return")
    } catch (error) {
      record("authorizePost", "throw", { error: String(error) })
      throw error
    }
  }
  return transfer
}
