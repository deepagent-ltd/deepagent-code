export { expect, mock } from "bun:test"

type Body = () => unknown | Promise<unknown>
type Options = number | { timeout?: number }
const cases: { name: string; body: Body; milliseconds: number }[] = []
const finalizers: { body: Body; milliseconds: number }[] = []
const preparations: Body[] = []
const afterEachBodies: Body[] = []
const setups: Body[] = []
const state = { running: false }

// This is only test scheduling. Assertions are Bun's actual expect, and the
// original case bodies still construct and retire their original Effect layers.
export function test(name: string, body: Body, options?: Options) {
  if (state.running || !name || cases.some((entry) => entry.name === name))
    throw new Error("Compiled test registration is invalid")
  const milliseconds = typeof options === "number" ? options : options?.timeout ?? 30_000
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 30_000)
    throw new Error("Compiled test budget exceeds the original package budget")
  cases.push({ name, body, milliseconds })
}

const unsupported = () => { throw new Error("Compiled Native cases must not use test selection or skipping") }
test.only = unsupported
test.skip = unsupported

export function afterAll(body: Body, milliseconds = 30_000) {
  if (state.running || !Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 30_000)
    throw new Error("Compiled test finalizer registration is invalid")
  finalizers.push({ body, milliseconds })
}

export function beforeAll(body: Body) {
  if (state.running) throw new Error("Compiled test setup registration is invalid")
  setups.push(body)
}

export function beforeEach(body: Body) {
  if (state.running) throw new Error("Compiled test preparation registration is invalid")
  preparations.push(body)
}

export function afterEach(body: Body) {
  if (state.running) throw new Error("Compiled test cleanup registration is invalid")
  afterEachBodies.push(body)
}

async function bounded(body: Body, milliseconds: number) {
  const timeout = { fired: false }
  const timer = { value: undefined as ReturnType<typeof setTimeout> | undefined }
  try {
    await Promise.race([
      Promise.resolve().then(body),
      new Promise<never>((_, reject) => {
        timer.value = setTimeout(() => {
          timeout.fired = true
          reject(new Error("COMPILED_TEST_ORIGINAL_BUDGET_EXPIRED"))
        }, milliseconds)
      }),
    ])
    return { ok: true, timedOut: false }
  } catch (error) {
    return { ok: false, timedOut: timeout.fired,
      error: (error instanceof Error ? error.stack ?? error.message : String(error)).slice(-16_384) }
  } finally {
    clearTimeout(timer.value)
  }
}

export async function runCompiledTests(expected: number) {
  const pattern = process.env.DAC_COMPILED_TEST_NAME_PATTERN
  const selected = pattern ? cases.filter((entry) => new RegExp(pattern).test(entry.name)) : cases
  if (state.running || selected.length !== expected || new Set(selected.map((entry) => entry.name)).size !== expected)
    throw new Error("Original compiled case inventory does not match")
  state.running = true
  const startup = await bounded(async () => {
    for (const setup of setups) await setup()
  }, 30_000)
  const rows: { name: string; milliseconds: number; ok: boolean; timedOut: boolean; error?: string }[] = []
  if (startup.ok) {
    for (const entry of selected) {
      const started = performance.now()
      const result = await bounded(async () => {
        try {
          for (const prepare of preparations) await prepare()
          return await entry.body()
        } finally {
          for (const cleanup of afterEachBodies) await cleanup()
        }
      }, entry.milliseconds)
      rows.push({ name: entry.name, milliseconds: performance.now() - started, ...result })
      console.info("WINDOWS_MCP_ORIGINAL_CASE", JSON.stringify(rows.at(-1)))
      // The original Native parent retires and joins this process tree. Do not
      // execute another body while a timed-out body might still own its scope.
      if (result.timedOut) break
    }
  }
  const cleanup: Awaited<ReturnType<typeof bounded>>[] = []
  for (const entry of finalizers.toReversed()) cleanup.push(await bounded(entry.body, entry.milliseconds))
  return { expected, registered: selected.length, executed: rows.length, rows, startup, cleanup,
    pass: startup.ok && rows.length === expected && rows.every((row) => row.ok) && cleanup.every((row) => row.ok) }
}
