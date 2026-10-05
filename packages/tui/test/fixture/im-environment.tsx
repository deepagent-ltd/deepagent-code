/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount, type JSX } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { TestTuiContexts } from "./tui-environment"
import { createTuiResolvedConfig } from "./tui-runtime"
import { eventSource } from "./tui-sdk"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { SDKProvider } from "../../src/context/sdk"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { ToastProvider } from "../../src/ui/toast"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"

export async function until(predicate: () => boolean, message = "condition", timeout = 3000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${message}`)
    await Bun.sleep(10)
  }
}

export async function mountIM(root: string, url: string, component: () => JSX.Element, width = 100) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), '{"tui_locale":"en","animations_enabled":false}')

  function Open() {
    const dialog = useDialog()
    onMount(() => dialog.replace(component))
    return <box />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <SDKProvider
                    url={url}
                    directory={root}
                    events={eventSource()}
                    headers={{ Authorization: "Bearer fixture-token" }}
                  >
                    <DialogProvider>
                      <Open />
                    </DialogProvider>
                  </SDKProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width, height: 40, kittyKeyboard: true })
  return {
    app,
    async frame(text: string) {
      const start = Date.now()
      for (;;) {
        await app.renderOnce()
        if (app.captureCharFrame().includes(text)) {
          await Bun.sleep(10)
          await app.renderOnce()
          return app.captureCharFrame()
        }
        if (Date.now() - start > 3000) throw new Error(`Missing frame text: ${text}\n${app.captureCharFrame()}`)
        await Bun.sleep(10)
      }
    },
    async select(text: string) {
      await until(
        () =>
          app.renderer.currentFocusedEditor instanceof TextareaRenderable &&
          !app.renderer.currentFocusedEditor.isDestroyed &&
          app.renderer.currentFocusedEditor.focused,
        "menu focus",
      )
      const editor = app.renderer.currentFocusedEditor
      if (!(editor instanceof TextareaRenderable)) throw new Error("No focused menu input")
      editor.clear()
      await app.mockInput.typeText(text)
      await app.renderOnce()
      app.mockInput.pressEnter()
      await Bun.sleep(20)
      await app.renderOnce()
    },
    async type(text: string, clear = false) {
      await until(
        () =>
          app.renderer.currentFocusedEditor instanceof TextareaRenderable &&
          !app.renderer.currentFocusedEditor.isDestroyed &&
          app.renderer.currentFocusedEditor.focused,
        "form focus",
      )
      const editor = app.renderer.currentFocusedEditor
      if (!(editor instanceof TextareaRenderable)) throw new Error("No focused form input")
      if (clear) editor.clear()
      await app.mockInput.typeText(text)
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
    },
  }
}
