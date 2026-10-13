export * as BrowserCanonicalViewport from "./browser-canonical-viewport"

import path from "node:path"
import assert from "node:assert/strict"

// This parser is QA-only and installed in a private directory. It is never a
// production dependency or a source of terminal input.
const version = "6.0.0"
const sha256 = "17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed"

type Screen = {
  rows: number
  buffer: { active: { viewportY: number; getLine(index: number): { translateToString(trimRight: boolean): string } | undefined } }
  write(input: string, callback: () => void): void
  onTitleChange(callback: (title: string) => void): { dispose(): void }
  dispose(): void
}

export async function create(packageDirectory = process.env.DAC_BROWSER_TUI_XTERM_QA_ROOT) {
  assert(packageDirectory && path.isAbsolute(packageDirectory), "Fixed private xterm QA package directory is required")
  const metadata = await Bun.file(path.join(packageDirectory, "package.json")).json()
  assert.equal(metadata.name, "@xterm/headless")
  assert.equal(metadata.version, version)
  assert.equal(metadata.main, "lib-headless/xterm-headless.js")
  const entry = path.join(packageDirectory, "lib-headless/xterm-headless.js")
  assert.equal(new Bun.CryptoHasher("sha256").update(await Bun.file(entry).arrayBuffer()).digest("hex"), sha256)
  const { Terminal } = await import(entry) as { Terminal: new (options: {
    cols: number; rows: number; allowProposedApi: boolean; scrollback: number
  }) => Screen }
  const terminal = new Terminal({ cols: 100, rows: 40, allowProposedApi: true, scrollback: 0 })
  const state = { title: "", pending: Promise.resolve() }
  const listener = terminal.onTitleChange((title) => { state.title = title })
  return {
    version, sha256,
    feed(input: string) {
      state.pending = state.pending.then(() => new Promise<void>((resolve) => terminal.write(input, resolve)))
    },
    async current() {
      await state.pending
      const buffer = terminal.buffer.active
      return { title: state.title, text: Array.from({ length: terminal.rows }, (_, index) =>
        buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? "").join("\n") }
    },
    async dispose() { await state.pending; listener.dispose(); terminal.dispose() },
  }
}

if (import.meta.main) {
  const screen = await create()
  const input = await Bun.file(process.argv[2]).text()
  const labels = ["QA test model", "Approve and connect", "Configure bounded page changes", "Read-only verification", "Page validation code"]
  const seen = new Set<string>()
  for (const chunk of input.match(/.{1,512}/gs) ?? []) {
    screen.feed(chunk)
    const view = await screen.current()
    labels.filter((label) => view.text.includes(label)).forEach((label) => seen.add(label))
  }
  console.log(JSON.stringify({ parser: "@xterm/headless", version: screen.version, sha256: screen.sha256,
    currentViewport: true, labels: labels.map((label) => ({ label, observed: seen.has(label) })) }))
  await screen.dispose()
}
